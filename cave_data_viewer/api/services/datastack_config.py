import logging
import time as _time
from pathlib import Path
from typing import Annotated, Any, Literal, Union

import yaml
from cachetools import LRUCache
from pydantic import BaseModel, Field

from flask import current_app

from .timing import record_stage, timer

logger = logging.getLogger(__name__)


def _warn_unknown_fields(model_class: type[BaseModel], data: Any, source: Path) -> None:
    """Walk `data` against `model_class`'s schema and warn about unknown keys.

    Pydantic defaults to ``extra="ignore"`` so a typo'd field name silently
    falls through to the default. This recursive check surfaces those typos at
    load time without changing validation semantics — the operator hears about
    `cell_id_lookup_tabl` instead of debugging why their lookup never works.

    Recursion follows the *annotation shape*: ``list[Model]`` walks each item,
    ``dict[K, Model]`` walks each value (NOT each key — dict keys are
    user-named, not schema fields), unions try each arm.
    """
    if not isinstance(data, dict):
        return
    fields = model_class.model_fields
    known = set(fields)
    for key, value in data.items():
        if key not in known:
            logger.warning(
                "config %s: ignoring unknown field %r (known: %s)",
                source, key, sorted(known),
            )
            continue
        _walk_annotation(fields[key].annotation, value, source)


def _arm_matches_kind(arm: Any, kind: str) -> bool:
    """True when `arm` is a BaseModel subclass whose `kind` field is a
    Literal that includes `kind`. Used by the union-walker so the
    discriminator picks the right arm and we don't log false "unknown
    field" warnings against the wrong one."""
    import typing
    if not (isinstance(arm, type) and issubclass(arm, BaseModel)):
        return False
    kind_field = arm.model_fields.get("kind")
    if kind_field is None:
        return False
    ann = kind_field.annotation
    if typing.get_origin(ann) is typing.Literal:
        return kind in typing.get_args(ann)
    return False


def _walk_annotation(annotation: Any, value: Any, source: Path) -> None:
    """Descend `value` according to `annotation`'s structure.

    Plain ``BaseModel`` annotations recurse via ``_warn_unknown_fields``;
    container types (list/tuple/set/dict) and unions iterate their members.
    Anything else (primitive types, str, etc.) is a leaf — return without
    recursing.
    """
    import types
    import typing

    origin = typing.get_origin(annotation)
    args = typing.get_args(annotation)
    if origin is None:
        if isinstance(annotation, type) and issubclass(annotation, BaseModel):
            _warn_unknown_fields(annotation, value, source)
        return
    if origin in (typing.Union, types.UnionType):
        # Discriminated-union path: if the value carries a `kind` field
        # whose value matches a union arm's `kind` Literal, walk ONLY
        # that arm. Without this, an explorer recipe walked against the
        # connectivity arm (or vice versa) would log a stream of spurious
        # "unknown field" warnings about fields that legitimately belong
        # to the other arm.
        if isinstance(value, dict):
            kind = value.get("kind")
            if isinstance(kind, str):
                for arg in args:
                    if _arm_matches_kind(arg, kind):
                        _walk_annotation(arg, value, source)
                        return
        for arg in args:
            _walk_annotation(arg, value, source)
        return
    if origin in (list, tuple, set, frozenset):
        if not isinstance(value, (list, tuple, set, frozenset)):
            return
        for item in value:
            for arg in args:
                _walk_annotation(arg, item, source)
        return
    if origin is dict:
        if not isinstance(value, dict) or len(args) < 2:
            return
        # Dict keys are user-named (the rule's nickname); only the values
        # are schema-shaped, so recurse into values only.
        for v in value.values():
            _walk_annotation(args[1], v, source)
        return


# Bundled YAMLs live in the top-level `config/` directory at the repo root,
# kept out of the Python package so config and code don't intermingle. For
# wheel installs, hatch's `force-include` in pyproject.toml copies the same
# tree to `<package>/_bundled_config/`. Both locations are searched (source
# install first); missing directories are silently skipped, so a deployment
# can ship with no bundled YAMLs at all and rely entirely on the
# `CDV_DATASTACK_CONFIG_DIR` / `CDV_ALIGNED_VOLUME_CONFIG_DIR` overrides.
_REPO_ROOT_CONFIG = Path(__file__).resolve().parents[3] / "config"
_PACKAGED_CONFIG = Path(__file__).resolve().parents[2] / "_bundled_config"


def _bundled_config_paths(subdir: str, filename: str) -> list[Path]:
    return [
        _REPO_ROOT_CONFIG / subdir / filename,
        _PACKAGED_CONFIG / subdir / filename,
    ]


# Schema-level default for `SynapseConfig.columns`. Limited to fields that
# are truly universal across CAVE synapse tables: every synapse row has an
# `id`, the two partner roots, and a position column for the configured
# `position_prefix`. `size` is *common* but not guaranteed (BANC happens to
# have it; some tables don't), so it lives in aligned-volume / datastack
# YAMLs that have actually verified the table schema, not here. Aggregation
# rules referencing `size` (or any other non-default column) are also
# absent from the schema-level default for the same reason.
DEFAULT_SYNAPSE_COLUMNS = ["id", "pre_pt_root_id", "post_pt_root_id", "ctr_pt_position"]


class AggregationRule(BaseModel):
    column: str
    agg: str  # any string accepted by pandas .agg() — "mean", "sum", "max", etc.


class SpatialConfig(BaseModel):
    """SpatialProvider selection + provider-specific parameters.

    Lives on the aligned-volume YAML so multiple datastacks of the same volume
    (e.g. `minnie65_public` and `minnie65_phase3_v1`) share the same coordinate
    frame without duplicating config.

    `provider` names a registered SpatialProvider (`cortex`, `null`, or
    something registered by `provider_module`). Defaults to `cortex` when
    `params` carries a `transform`, else `null` — so an aligned_volume with
    no spatial config gets the no-op provider and emits no spatial columns.

    `provider_module` is a dotted Python path imported at request time so the
    module's top-level code can call `register_provider(...)`. Use this to
    plug in an out-of-tree anatomy without editing the registry.

    `params` is the provider-specific parameter dict. The cortex provider
    consumes `{transform, depth_range, layer_boundaries, layer_names}`; a
    thalamus provider would define its own keys (e.g. `nucleus_center_nm`).
    Each provider validates its own params at construction.
    """
    provider: str | None = None
    provider_module: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)


class SynapseConfig(BaseModel):
    """Synapse-table column conventions.

    Layered loading:

    - aligned_volume YAML supplies the defaults — the segmentation pipeline
      typically drives these and they're shared across every datastack
      mounted on the same volume (different mat versions of the same
      proofreading effort all see the same synapse columns).
    - per-datastack YAML overrides individual fields. A datastack that
      omits the `synapse:` block entirely inherits everything; one that
      sets only `synapse: {position_prefix: foo}` inherits `columns` /
      `aggregation_rules` and overrides only the prefix.

    The override is field-by-field, so callers don't have to re-state the
    full list of columns just to change one field.

    `position_prefix` is the column-name stem for the synapse-position
    triple (`<prefix>_position_x/y/z`). Most CAVE synapse tables use
    `ctr_pt`; some pipelines use other points (anchor, post-anchor) and
    set this accordingly.

    `columns` is the column projection for synapse queries. Setting it to
    `null` (YAML `~`) pulls every column — good for ad-hoc exploration,
    bad for production because it bloats the cached DataFrame. The default
    list keeps the synapse cache compact while still carrying the columns
    needed for aggregation rules below.

    `aggregation_rules` are the per-partner summary stats run on the
    synapse DataFrame: each entry adds a column to the partner table by
    grouping synapses on partner root_id and applying `agg` to `column`.
    Common pattern: `{mean_size: {column: size, agg: mean}}` to add a
    mean-synapse-size column.
    """
    position_prefix: str = "ctr_pt"
    columns: list[str] | None = Field(default_factory=lambda: list(DEFAULT_SYNAPSE_COLUMNS))
    aggregation_rules: dict[str, AggregationRule] = Field(default_factory=dict)

    def merged_columns(self) -> list[str] | None:
        """Effective column projection, including any columns referenced by
        aggregation rules but not in the explicit `columns` list. Returns
        None when `columns` is None, which signals "select every column" to
        the synapse-query layer."""
        if self.columns is None:
            return None
        cols = list(self.columns)
        for rule in self.aggregation_rules.values():
            if rule.column not in cols:
                cols.append(rule.column)
        return cols

    def aggregation_rules_for_neuron_query(self) -> dict[str, dict]:
        """Plain-dict view of the aggregation rules for `NeuronQuery`, which
        accepts `{name: {column, agg}}` rather than the validated AggregationRule
        instances."""
        return {name: rule.model_dump() for name, rule in self.aggregation_rules.items()}


class AlignedVolumeConfig(BaseModel):
    """Per-aligned-volume configuration.

    Carries the spatial transform (the original motivation — datastacks of
    the same volume share a coordinate system) and synapse defaults
    (segmentation-pipeline-driven, also typically shared across the volume's
    datastacks). Per-datastack YAMLs can override either.

    Left as its own model so further aligned-volume-scoped settings (shared
    color palettes, default Neuroglancer image layers, etc.) can land here
    without touching every datastack YAML.
    """
    spatial: SpatialConfig = Field(default_factory=SpatialConfig)
    synapse: SynapseConfig = Field(default_factory=SynapseConfig)


class SynapseWarmupSource(BaseModel):
    """Where the warming script finds cells to warm.

    Queries `table` (typically a proofreading-status table) with the
    given `filters`, then collects the unique values of `root_id_column`
    as the warm-set. Static config — describes *how* to find cells, not
    *which* version to warm. The version is supplied at script
    invocation time.
    """
    table: str
    root_id_column: str = "pt_root_id"
    filters: dict = Field(default_factory=dict)


class SynapseWarmup(BaseModel):
    """Per-datastack warming configuration. Read by `cdv-warm-cache`;
    the running service ignores this block.

    `max_cells` is the default cap if `--max-cells` isn't passed on the
    CLI. `parallel_workers` is the default for `--workers`.
    """
    source: SynapseWarmupSource | None = None
    max_cells: int = 2000
    parallel_workers: int = 8


class DecorationWarmup(BaseModel):
    """Periodic warming for whole-table decoration caches.

    Each registered job fetches `(datastack, latest_valid_mat_version, table)`
    on a periodic schedule. The latest version is resolved at every fire (not
    pinned at config time) so the cache rolls forward as new mat versions are
    published. Live mode is never warmed.

    `startup_delay_seconds` defers the first run after pod boot — set to a few
    minutes in autoscaling deployments so a scale-up event doesn't thunder into
    CAVE the moment new pods come up. Random jitter up to 60s is added on top.

    `enabled` must be true to register any jobs from this config; off by default
    so the dev server doesn't warm anything unless explicitly opted in.
    """
    enabled: bool = False
    # `tables` is the canonical list of annotation tables the warmer
    # should fetch and cache. Cell-type tables, status tables, anything
    # — they all use the same in-process generic-decoration cache (per
    # the cell_type / table cache merger).
    tables: list[str] = Field(default_factory=list)
    # Legacy field, retained for backward compatibility with existing
    # YAMLs. The loader at `_register_warmup_jobs` reads `tables` first
    # and falls back to this. New configs should use `tables`.
    cell_type_tables: list[str] = Field(default_factory=list)
    warm_soma_table: bool = False  # warms the datastack info's default soma_table
    interval_seconds: float = 3600.0
    startup_delay_seconds: float = 0.0


class CellIdLookup(BaseModel):
    """Forward cell_id → root_id lookup target.

    CAVE exposes two distinct resources that can answer this query — an
    annotation *table* via ``client.materialize.query_table`` and a
    materialized *view* via ``client.materialize.query_view``. The two
    have different API signatures, so the consuming code dispatches on
    ``kind``.

    Carried as a discriminated block (rather than two top-level XOR
    fields) so the kind and name can't drift apart at edit time, and so
    Pydantic enforces "both present or neither" structurally without a
    model-level validator. Omit the whole ``cell_id_lookup:`` block to
    disable cell-id lookup — the SPA hides the cell-id input when the
    config is absent.
    """

    kind: Literal["view", "table"]
    name: str


class FeatureExplorerConfig(BaseModel):
    """Per-datastack Feature Explorer enablement.

    The embedding catalog itself lives at the convention path
    ``<CDV_FEATURE_TABLES_BASE_URI>/feature_tables/<datastack>/``,
    one subdir per datastack. There is no per-datastack
    ``manifest_uri`` — the URI is a deterministic function of the
    deploy-time base + the datastack name.

    ``cell_id_source_table`` names the CAVE table that defines the
    cell_id namespace used by every parquet under this datastack's
    feature_tables subdir. Optional at this layer: a per-FT YAML can
    set its own ``cell_id_source_table`` and override this fallback.
    When neither is set, downstream resolver paths surface a clean
    422 at resolve time.

    Kept as a distinct field from ``root_id_lookup_main_table`` so a
    future datastack with a multi-table reverse-lookup chain doesn't
    ambiguate which table anchors the embedding namespace. In practice
    they will usually point at the same table.
    """

    enabled: bool = False
    cell_id_source_table: str | None = None


class TourPlotBindings(BaseModel):
    """Plot bindings on a tour entry — direct passthrough of the SPA's
    `PlotBindings` shape (frontend/src/api/queries.ts). Field names match
    the wire contract so the SPA can JSON-encode this dict straight into
    the `?viz_<id>=` URL key without any reshaping.

    No fields are required. An empty bindings object is a valid 'configure
    me' panel; users will see the panel mount with an empty editor.
    """
    x: str | None = None
    y: str | None = None
    hue: str | None = None
    size: str | None = None
    weight: str | None = None
    scope: str | None = None
    show_cell_depth: bool | None = None


class TourPlot(BaseModel):
    """One panel in a tour's `plots:` list.

    Three flavours, mutually exclusive:
      - `summary_kind` set → adds a summary panel (e.g. synapse depth profile);
        the SPA generates a `sum-<kind>-<rand>` panel id and reads the data
        from the bundle.
      - `bindings` set → adds a bindings-driven dynamic panel; the SPA
        generates a `dyn-<rand>` id and seeds the `?viz_<id>=` URL key.
      - Neither set → adds a blank dynamic panel for the user to configure.

    `id` is YAML-author-facing (handy for diff readability); the SPA does
    NOT use it as the panel id — fresh random panel ids are minted on apply
    so opening the same tour twice doesn't collide on URL keys.

    `unfiltered: true` opts this panel out of the tour's global `cells:`
    filter. Useful when a tour ships e.g. an "all partners" reference
    histogram alongside filtered analytic panels — the user gets context
    on the unfiltered population while the rest of the rail honors the
    filter. Maps to a panel id in the `?unfilter=` URL list at apply time.
    Defaults to false (panel respects the cell filter).
    """
    id: str | None = None
    summary_kind: str | None = None
    bindings: TourPlotBindings | None = None
    unfiltered: bool = False


class ScopePredicate(BaseModel):
    """One scope-filter predicate. References a stable feature-table or
    decoration-table column by name; the column must be expected to outlive
    cell_id churn (no runtime check — operator/PR review enforces).

    Operators:
      - `in`         — value must be a list; matches column ∈ list
      - `eq` / `ne`  — scalar equality / inequality
      - `gt` / `gte` / `lt` / `lte` — numeric ordering
    """
    column: str
    op: Literal["in", "eq", "ne", "gt", "gte", "lt", "lte"]
    value: Any = None
    values: list[Any] = Field(default_factory=list)


class Scope(BaseModel):
    """Filter Scope predicate group on a recipe. Common to connectivity
    and explorer recipes."""
    predicates: list[ScopePredicate] = Field(default_factory=list)


class TourBase(BaseModel):
    """Fields common to Examples and connectivity Recipes. Kept as the
    parent for Example (still single-shape) and ConnectivityRecipe (the
    discriminated-union arm for `kind: connectivity`).

    Explorer recipes do NOT inherit from TourBase — their payload has
    almost nothing in common (no plots/hide/show/coll), so composition
    via ExplorerState keeps the on-disk YAML cleaner than dragging
    connectivity fields onto a class that doesn't use them."""
    id: str
    title: str
    description: str | None = None
    decoration_tables: list[str] = Field(default_factory=list)
    plots: list[TourPlot] = Field(default_factory=list)
    # Raw `?cells=` URL value. Shape: `<table>.<col>:<op>:<val>[,...]`.
    # Plumbed through verbatim so the existing CellFilter parser is the
    # single source of truth for syntax — see services/plots.py::_parse_cells_param.
    cells: str | None = None
    # Pass-throughs to the existing URL state from feature D.
    hide: list[str] = Field(default_factory=list)
    show: list[str] = Field(default_factory=list)
    coll: list[str] = Field(default_factory=list)
    scope: Scope | None = None


class Example(TourBase):
    """Fully-specified workspace state. Loads onto a real cell at a real
    materialization version. The CTA is "Open" — clicking lands the user
    on a configured workspace looking at this neuron.

    `mat_version` is integer-only; "live" examples don't make sense
    operator-curated (they'd drift). `root` is a stringified int64 root id
    (root ids exceed JS Number precision).

    Examples are connectivity-flavored only in v1 — operator-curated
    explorer landings aren't supported. If a future need arises, add an
    `ExplorerExample` and lift Example into a discriminated union the
    same way Recipe was."""
    mat_version: int
    root: str


class ConnectivityRecipe(TourBase):
    """Connectivity-shaped recipe overlay. The CTA is "Apply", which
    merges the recipe's decorations + plots + filters onto the user's
    currently-loaded cell in /neuron. By construction has no
    `mat_version` or `root` (that'd be an Example).

    The `kind` literal is the discriminator for the Recipe union below —
    every connectivity recipe carries `kind: connectivity`."""
    kind: Literal["connectivity"] = "connectivity"


class ExplorerState(BaseModel):
    """Saved /explore workspace state.

    Captures the explorer's URL params (which round-trip through the URL
    today) plus its Selection bag (which does NOT — the bag can run
    thousands of cell_ids long and a URL won't carry it). Persisting the
    bag here is the whole reason explorer recipes exist: without it, a
    user with a hand-curated lasso + Cell-ID-Search selection has no
    durable way to come back to that selection later.

    Grouped into nested sub-objects so the on-disk YAML reads well; the
    SPA's explorerAdapter flattens these into URL params at apply time
    (and pulls Selection out separately to push into the selection-bag
    store, since it's not URL-backed)."""
    # Identity: which feature table + which embedding view within it.
    ft: str | None = None
    emb: str | None = None
    # Shared with connectivity (same URL keys; same meaning). Adapters on
    # both sides write these identically so cross-view continuity holds.
    decoration_tables: list[str] = Field(default_factory=list)
    cells: str | None = None
    # Explorer-only.
    scope_mode: Literal["ghost", "hide"] | None = None
    sel_filters: list[str] = Field(default_factory=list)
    # Scatter bindings.
    x: str | None = None
    y: str | None = None
    color: str | None = None
    size: str | None = None
    cmap: str | None = None
    color_min: float | None = None
    color_max: float | None = None
    color_center: float | None = None
    size_min: float | None = None
    size_max: float | None = None
    size_data_min: float | None = None
    size_data_max: float | None = None
    # Selection-growth controls (similarity probe).
    growth_space: str | None = None
    growth_variance: float | None = None
    growth_reduction: str | None = None
    growth_threshold: float | None = None
    growth_features: list[str] = Field(default_factory=list)
    growth_topn: int | None = None
    # The Selection bag — list of cell_ids accumulated from row
    # checkboxes, lasso, and Cell-ID Search. NOT a URL param (would
    # exceed practical URL length); persisted here so a saved recipe
    # can restore the user's hand-curated set. Capped via _FIELD_LIMITS
    # in services/recipes.py (10_000 ids, 32 chars each).
    selection: list[str] = Field(default_factory=list)


class ExplorerRecipe(BaseModel):
    """Explorer-shaped recipe. The CTA is "Apply", which navigates the
    user to /explore (or merges state if already there) and restores
    feature-table / embedding / scatter bindings / decorations / scope /
    selection bag.

    Doesn't inherit from TourBase — explorer has its own field set with
    no plots/hide/show/coll. Common metadata fields (id/title/...) are
    mirrored explicitly to keep the model self-contained."""
    id: str
    title: str
    description: str | None = None
    kind: Literal["explorer"] = "explorer"
    explorer: ExplorerState = Field(default_factory=ExplorerState)
    scope: Scope | None = None


# Discriminated union. Pydantic picks the arm by the value of `kind`;
# anything missing/unknown raises a validation error at model_validate
# time — which is exactly the "hard cutover on missing kind" behavior
# the design calls for. Operator-recipe entries in datastack YAMLs and
# personal recipes loaded via services/recipes.py both flow through this.
Recipe = Annotated[
    Union[ConnectivityRecipe, ExplorerRecipe],
    Field(discriminator="kind"),
]


class DatastackConfig(BaseModel):
    # Per-datastack synapse override. Field-by-field: any field explicitly set
    # in the YAML's `synapse:` block wins over the aligned_volume's defaults;
    # fields omitted inherit. Omit the `synapse:` key entirely (or set to null)
    # to inherit everything — the common case when a datastack uses the same
    # synapse table conventions as the rest of its aligned_volume.
    synapse: SynapseConfig | None = None
    decoration_warmup: DecorationWarmup | None = None
    synapse_warmup: SynapseWarmup | None = None
    # Whether to expose the "live" query mode to the SPA. CAVE always *can* serve
    # live queries against any datastack, but for public datasets users effectively
    # only have the released materializations — surfacing "live" is misleading and
    # can drift from what's published. Set false for public/release datastacks.
    live_mode: bool = True

    # Cache-namespace alias. When set, every L2 read/write and marker-file
    # lookup made on behalf of this datastack substitutes the alias target
    # as the cache namespace component. Use case: `minnie65_public` is a
    # view of `minnie65_phase3_v1` filtered to long-lived materializations,
    # so the bucket should hold one shared copy of the cache values. The
    # CAVE call still uses *this* datastack — the alias only redirects
    # cache pathing.
    cache_alias: str | None = None

    # ---- cell-id lookup -------------------------------------------------------
    # Cell ids (typically nucleus ids) are persistent identifiers that survive
    # proofreading splits/merges; root ids are not. The forward direction
    # (cell_id → current root_id) uses one CAVE resource — either a
    # materialized view OR an annotation table, depending on the datastack.
    # The two need separate CAVE API calls (`query_view` vs `query_table`),
    # so the config carries the resource as a discriminated block with a
    # `kind` field and the consuming code dispatches on it.
    #
    # The reverse direction (root_id → cell_id) walks one or more annotation
    # tables — those don't have a view counterpart in this codebase.
    #
    # Datastacks without these resources omit the `cell_id_lookup:` block; the
    # SPA hides the cell-id input when the config is absent.
    cell_id_lookup: CellIdLookup | None = None
    root_id_lookup_main_table: str | None = None # primary table: pt_root_id → id
    root_id_lookup_alt_tables: list[str] = Field(default_factory=list)

    # ---- feature explorer -----------------------------------------------------
    # Optional. When omitted (or `enabled: false`) the SPA hides the /explore
    # route for this datastack. The embedding catalog itself lives in a GCS
    # manifest referenced from this block — see FeatureExplorerConfig.
    feature_explorer: FeatureExplorerConfig | None = None

    def cell_id_lookup_resource(self) -> tuple[str, Literal["view", "table"]] | None:
        """Return ``(name, kind)`` for the configured cell-id forward
        lookup, or ``None`` when the block is absent. Callers use ``kind``
        to pick the right CAVE API path (``query_view`` vs ``query_table``).
        """
        if self.cell_id_lookup is None:
            return None
        return (self.cell_id_lookup.name, self.cell_id_lookup.kind)



# Cache stores `(cfg, signature)` so we can invalidate when a watched YAML
# changes mtime — without this, the dev workflow needs a server restart for
# every YAML edit because Flask's debug reloader only watches .py files.
_config_cache: LRUCache = LRUCache(maxsize=64)


def _yaml_signature(paths: list[Path]) -> tuple:
    """Stable mtime signature across the (possibly two) YAML sources for a
    given datastack. Files that don't exist contribute -1 so creation is
    detected too."""
    return tuple((str(p), p.stat().st_mtime) if p.is_file() else (str(p), -1.0) for p in paths)


def _validate_tour_ids(cfg: DatastackConfig, datastack: str) -> None:
    """No-op placeholder: inline examples/recipes fields were removed from
    DatastackConfig in Task 2.3. Operator recipes are now loaded via
    RecipeRegistry from per-file YAMLs under config/recipes/<ds>/; examples
    live under config/examples/<ds>/. The RecipeRegistry performs its own
    id validation at load time.
    """


def load_datastack_config(datastack: str) -> DatastackConfig:
    """Resolve `<datastack>.yaml`. Bundled `config/datastacks/` is always
    checked; `CDV_DATASTACK_CONFIG_DIR` is checked last and wins on conflict,
    letting operators ship deployment-specific overrides without forking the
    package. Datastacks with no YAML in any location fall back to schema
    defaults.

    Cached per `(bundled.yaml mtime, override.yaml mtime)`, so editing a YAML
    in dev invalidates the entry on the next request — no server restart.
    """
    extra_dir = current_app.config.get("DATASTACK_CONFIG_DIR")
    paths = _bundled_config_paths("datastacks", f"{datastack}.yaml")
    if extra_dir:
        paths.append(Path(extra_dir) / f"{datastack}.yaml")

    signature = _yaml_signature(paths)
    cached = _config_cache.get(datastack)
    if cached is not None and cached[1] == signature:
        return cached[0]

    cfg = DatastackConfig()
    for path in paths:
        if path.is_file():
            data: dict[str, Any] = yaml.safe_load(path.read_text()) or {}
            _warn_unknown_fields(DatastackConfig, data, path)
            cfg = DatastackConfig.model_validate(data)
    _validate_tour_ids(cfg, datastack)
    _config_cache[datastack] = (cfg, signature)
    return cfg


def clear_datastack_config_cache() -> None:
    _config_cache.clear()
    _aligned_volume_config_cache.clear()
    # `dcv_datastack_info_cache` is an app extension keyed off the live
    # Flask app; clear it when an app context is available. Outside a
    # request context (e.g. unit tests calling this helper directly) it's
    # a no-op — there's nothing to clear.
    try:
        cache = current_app.extensions.get("dcv_datastack_info_cache")
        if cache is not None:
            cache.clear()
    except RuntimeError:
        pass


# Same caching pattern as `_config_cache` — stash mtime for hot-reload in dev,
# but key by aligned_volume name (e.g. "minnie65_phase3") rather than datastack.
_aligned_volume_config_cache: LRUCache = LRUCache(maxsize=64)


def load_aligned_volume_config(aligned_volume: str | None) -> AlignedVolumeConfig:
    """Resolve `aligned_volumes/<aligned_volume>.yaml`. Same bundled+override
    pattern as `load_datastack_config`: bundled `config/aligned_volumes/` is
    checked first, `CDV_ALIGNED_VOLUME_CONFIG_DIR` last and wins on conflict.

    Aligned volumes with no YAML in any location fall back to schema
    defaults — i.e. no transform, no depth axis, no layer guides. That's the
    right behavior for any volume the deployment hasn't characterized yet
    (typical for non-cortex datasets), so callers don't have to special-case
    "is there a YAML for this volume."
    """
    if not aligned_volume:
        return AlignedVolumeConfig()

    extra_dir = current_app.config.get("ALIGNED_VOLUME_CONFIG_DIR")
    paths = _bundled_config_paths("aligned_volumes", f"{aligned_volume}.yaml")
    if extra_dir:
        paths.append(Path(extra_dir) / f"{aligned_volume}.yaml")

    signature = _yaml_signature(paths)
    cached = _aligned_volume_config_cache.get(aligned_volume)
    if cached is not None and cached[1] == signature:
        return cached[0]

    cfg = AlignedVolumeConfig()
    for path in paths:
        if path.is_file():
            data: dict[str, Any] = yaml.safe_load(path.read_text()) or {}
            _warn_unknown_fields(AlignedVolumeConfig, data, path)
            cfg = AlignedVolumeConfig.model_validate(data)
    _aligned_volume_config_cache[aligned_volume] = (cfg, signature)
    return cfg


def cached_datastack_info(datastack: str, client, *, stages=None) -> dict | None:
    """Long-TTL cache around `client.info.get_datastack_info()`.

    The dict it returns — aligned_volume, soma_table, synapse_table,
    viewer_resolution_*, viewer_site — is a stable property of the
    datastack: it does not shift with mat_version, and operator-level
    reassignments (e.g. moving a datastack to a different aligned_volume)
    are extremely rare. A 24h TTL turns the per-request CAVE info round-
    trip (~150–300ms cold) into a single fetch per pod per datastack per
    day.

    Caches `None` on exception too. A misconfigured datastack would
    otherwise hammer the info service every request and stack hundreds
    of ms onto `cave_ms` for no useful effect.

    Routes through the `dcv_datastack_info_cache` SwrCache so the lookup
    cost is visible per-request as `datastack_info_l1_hit` (warm) or
    `datastack_info_query` (cold CAVE round-trip).
    """
    cache = current_app.extensions.get("dcv_datastack_info_cache")
    if cache is not None:
        t0 = _time.perf_counter()
        hit_layer = cache.get_with_layer(datastack)
        elapsed_ms = (_time.perf_counter() - t0) * 1000.0
        if hit_layer is not None:
            value, _freshness, layer = hit_layer
            record_stage(
                f"datastack_info_{layer}_hit", elapsed_ms, stages=stages,
            )
            return value
    with timer("datastack_info_query", stages=stages):
        try:
            info = client.info.get_datastack_info()
        except Exception:
            info = None
    if info is not None and not isinstance(info, dict):
        info = None
    if cache is not None:
        cache.set(datastack, info)
    return info


def resolve_aligned_volume_name(datastack: str, client) -> str | None:
    """Look up the aligned_volume name for `datastack` via the cached
    datastack-info dict.

    `client.info.get_datastack_info()` returns a dict whose `aligned_volume`
    key is itself a `{"name": "minnie65_phase3", ...}` dict — that's where
    the volume name lives. (`InfoServiceClient` has no standalone
    `get_aligned_volume()` method; calling it would silently fail back
    here and the spatial transform would never load.) Backed by
    `cached_datastack_info` so the info-service round-trip happens at
    most once per datastack per 24h per pod.
    """
    info = cached_datastack_info(datastack, client)
    if not isinstance(info, dict):
        return None
    av = info.get("aligned_volume")
    if isinstance(av, dict):
        raw = av.get("name")
        if isinstance(raw, str) and raw:
            return raw
    return None


def aligned_volume_config_for(datastack: str, client) -> AlignedVolumeConfig:
    """Convenience: resolve aligned_volume name and load its config in one
    call. Endpoints use this immediately after building the CAVE client,
    then read `cfg.spatial.*` for transform / depth_range / layer guides."""
    return load_aligned_volume_config(resolve_aligned_volume_name(datastack, client))


def resolve_synapse_config(
    av_cfg: AlignedVolumeConfig, ds_cfg: DatastackConfig
) -> SynapseConfig:
    """Effective synapse config = aligned_volume defaults with per-datastack
    overrides applied field-by-field.

    Datastacks that omit a `synapse:` block inherit everything from the
    aligned_volume. Datastacks that set only a subset of fields (e.g.
    `synapse: {position_prefix: anchor_pt}`) inherit the rest. The
    aligned_volume YAML is the right place to put conventions shared by
    every datastack on the volume; the per-datastack YAML carries
    exceptions.

    Pydantic's `model_fields_set` distinguishes "explicitly set" from
    "default-constructed" so a per-datastack `synapse: {columns: ~}`
    legitimately overrides to "select every column" without us mistaking
    the explicit-None for an absent field.
    """
    if ds_cfg.synapse is None:
        return av_cfg.synapse
    base = av_cfg.synapse.model_dump()
    for field in ds_cfg.synapse.model_fields_set:
        base[field] = getattr(ds_cfg.synapse, field)
    return SynapseConfig.model_validate(base)


def synapse_config_for(datastack: str, client) -> SynapseConfig:
    """Convenience: resolve aligned_volume + datastack synapse configs and
    return the merged result. Endpoints use this to drive `NeuronQuery`'s
    `synapse_position_prefix` / `synapse_columns` / aggregation arguments."""
    av_cfg = aligned_volume_config_for(datastack, client)
    ds_cfg = load_datastack_config(datastack)
    return resolve_synapse_config(av_cfg, ds_cfg)


def latest_valid_mat_version(client) -> int | None:
    """Pick the freshest valid materialization version for a datastack, or
    None when the datastack has no valid versions.

    Used by endpoints that want to substitute a "live" request with a
    real materialization — table listing / row queries fall back to this
    so the user can pick "live" in the picker and still get views and
    cached responses (live mode has neither). Failures of the upstream
    versions-metadata call return None so the caller can degrade rather
    than refuse the page.
    """
    try:
        metadata = client.materialize.get_versions_metadata()
    except Exception:
        return None
    valid = [int(m["version"]) for m in metadata if m.get("valid", True)]
    return max(valid) if valid else None


def version_timestamp(client, mat_version: int | str | None):
    """Return the datetime the given materialization version was frozen at,
    or None when unavailable (live mode, missing version, upstream error).

    Used by `suggest_latest_root` callers so the chunkedgraph lookup happens
    at the version's snapshot time — for materialized requests, the
    "current" root_id at that frozen time is what should appear.

    Live mode returns None — callers should pass the request's pinned
    consistency timestamp instead. Caching: this hits the cached
    `get_versions_metadata` (table_meta_cache via the existing pattern),
    so repeated calls within a request are essentially free.
    """
    from .keys import is_live
    if mat_version is None or is_live(mat_version):
        return None
    try:
        metadata = client.materialize.get_versions_metadata()
    except Exception:
        return None
    target = int(mat_version)
    for entry in metadata:
        if int(entry["version"]) == target:
            ts = entry.get("time_stamp") or entry.get("timestamp")
            return ts
    return None


def check_live_allowed(datastack: str, mat_version: int | str | None) -> None:
    """Raise ValueError if `mat_version` requests live but the datastack disallows it.

    Endpoints catch this and translate to a 422. Defense in depth: the SPA already
    hides 'live' from the version picker for these datastacks, but a direct API
    caller bypassing the SPA still gets a clean refusal.
    """
    # Local import keeps this helper available without forcing a `keys` dep cycle.
    from .keys import is_live

    if not is_live(mat_version):
        return
    cfg = load_datastack_config(datastack)
    if not cfg.live_mode:
        raise ValueError(
            f"Datastack {datastack!r} disallows live mode; "
            f"pass an explicit ?mat_version=<int>."
        )
