"""Feature-table catalog: schema, fetch, parse, validate, SWR cache.

The catalog is a **directory of per-file feature-table YAMLs** referenced by
the datastack YAML's ``feature_explorer.manifest_uri``. Each file is one
``FeatureTableSpec`` at the top level; the filename basename MUST equal the
file's ``id`` field. Adding a new feature table = drop a new ``.yaml`` into
the directory.

A single-file URI (path ending in ``.yaml``) is also accepted as a
convenience for one-table dev setups — the file's contents are parsed as
one ``FeatureTableSpec`` exactly the same way.

The older monolithic schema (``schema_version: 2``/``3`` with a top-level
``feature_tables:`` list plus manifest-wide ``knn:`` and ``datastacks:``
blocks) is **no longer supported**. Migrate by splitting each entry into
its own file, moving ``knn`` fields onto each table, and moving any
``datastacks:`` override onto each table.

Schema v1 (current): each FeatureTableSpec is self-contained. It owns:
- the data pointer (``source``, ``id_column``, ``cell_id_source_table``)
- the column layout (``feature_columns``, ``categorical_columns``,
  ``spatial_pre_columns``, ``spatial_post_columns``, ``depth_columns``,
  optional ``audit``, ``categories``)
- the embedding views (``embeddings``)
- the similarity controls (``scaling``, ``clip_percentiles``,
  ``standardize``) — moved from the old manifest-level ``knn`` block so
  one table can be zscored while another is raw
- the optional ``datastacks`` list (multi-datastack participation)

Caching strategy:

- Cache key is ``(datastack, manifest_uri)``. Two datastacks pointing at the
  same directory get independent cache entries — useful for the
  ``cache_alias`` flow where two datastacks share underlying data but route
  cache reads separately.
- SWR semantics via ``services.swr.SwrCache``. Soft TTL ~5 min: stale
  entries are served immediately while a background thread refetches.
  Hard TTL ~1 h bounds how long we'll serve stale data if refresh keeps
  failing — after that, the next caller pays a synchronous fetch and any
  error surfaces loudly.
- Validation is layered: directory-level / single-file structural errors
  (bad YAML, missing schema_version) raise hard for the failing file;
  per-FT validation failures are soft — invalid files are dropped with a
  logged warning, valid ones surface. One bad file should not take down
  the whole catalog.
"""

from __future__ import annotations

import logging
import re
import threading
from typing import Literal

import yaml
from flask import current_app
from pydantic import BaseModel, Field, ValidationError

from .uri import fetch_bytes, list_yaml_uris

logger = logging.getLogger(__name__)

# v1 is the current shape: each per-file FeatureTableSpec self-contained,
# scaling/clip/cell_id_source_table/datastacks moved off the (removed)
# top-level manifest. Older schema versions are not supported — migrate.
SUPPORTED_SCHEMA_VERSIONS: frozenset[int] = frozenset({1})


def resolve_manifest_uri(base_uri: str, datastack: str) -> str:
    """Compute the feature-table catalog directory URI for ``datastack``.

    The deployment-wide base URI (``CDV_FEATURE_TABLES_BASE_URI``,
    read once at boot into ``app.config["FEATURE_TABLES_BASE_URI"]``)
    is joined with the convention path ``feature_tables/<datastack>/``.

    Defensive trailing-slash normalization: callers should pass a
    URI already ending in ``/``, but we tolerate the missing slash
    rather than producing a malformed URI downstream.
    """
    if not base_uri.endswith("/"):
        base_uri = base_uri + "/"
    return f"{base_uri}feature_tables/{datastack}/"

# Filename basename allowlist for per-file feature-table YAMLs in a
# directory. Same shape as the recipe-registry id pattern: lowercase
# alphanumerics + underscore/dash, 3-64 chars, no leading hyphen.
_FT_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")


class FeatureTableSourceRef(BaseModel):
    """How the backend finds a feature table's underlying data.

    v1 only ships ``kind: parquet``. A future catalog service would
    add ``kind: catalog`` (or similar) without changing this file's
    downstream consumers — the loader dispatches on ``kind``.

    ``uri`` is optional in the YAML: when omitted, the loader fills
    it in with ``<yaml-prefix>/<id>.parquet`` so a co-located
    parquet doesn't need to be named. When set explicitly, that
    wins — this is the escape hatch for parquets in a shared bucket
    or a different storage class than the YAML.
    """

    kind: Literal["parquet"]
    uri: str | None = None


class FeatureTableAudit(BaseModel):
    """Names of optional audit columns in the parquet.

    When set, the SPA's cell-detail tooltip surfaces ``source_root_id`` and
    ``source_mat_version`` so a user can see which root_id the features
    were computed against — useful when the parquet is months older than
    the materialization the user is currently looking at.
    """

    source_root_column: str | None = None
    source_mat_version_column: str | None = None


class FeatureCategorySpec(BaseModel):
    """A named subset of a feature table's columns, used purely for UI
    organization (channel-picker optgroups, "+ add plot" menus, bulk
    select/deselect).

    ``columns`` references bare parquet column names — the same namespace
    ``feature_columns`` and ``categorical_columns`` live in. A column may
    appear in multiple categories (overlap is allowed and useful: a depth
    column can sit in both ``morphology`` and ``spatial``). Columns not
    listed in any category render under an implicit "Uncategorized" group
    on the frontend; categories that reference columns not present in
    the parquet are pruned at the picker layer with a warning.

    No backend semantics depend on categories — they're projected through
    ``_feature_table_summary`` and consumed by the SPA's picker UI. That
    keeps the manifest one-way: edit categories in GCS, reload the
    catalog, organization updates without a redeploy.
    """

    id: str
    title: str
    description: str | None = None
    columns: list[str] = Field(default_factory=list)


class EmbeddingSpec(BaseModel):
    """One ``embeddings:`` entry under a feature table. Describes a single
    2D scatter view onto the table's rows.

    Multiple embeddings per table are supported: one feature dataframe can
    have a whole-population UMAP + an inhibitory-only UMAP + a t-SNE, all
    sharing rows, features, and decorations.

    Display-level only — the data (id column, feature columns, source
    parquet) lives on the parent ``FeatureTableSpec``.

    ``axes`` must be exactly two columns (2D scatter). Cells with null
    values in either axis column are dropped from the scatter naturally
    by plotly; that's the mechanism for subset embeddings like
    "inhibitory only" (non-inhibitory cells get null axes in the
    parquet).

    ``depth_axis`` names which axis (if any) is depth-shaped so plots.py
    can flip the axis + add layer markers automatically. Typically null —
    UMAP axes aren't depth-shaped — but a scatter binding the user picks
    over a real depth column will surface depth-axis treatment through
    the same machinery the connectivity plots use.
    """

    id: str
    title: str
    description: str | None = None
    axes: list[str] = Field(min_length=2, max_length=2)
    default_color_by: str | None = None
    depth_axis: Literal["x", "y", None] = None


class DatastackEntry(BaseModel):
    """One datastack participating in a feature-table's catalog.

    Bare-name form is allowed in YAML (``datastacks: [foo, bar]``); the
    loader coerces strings via :func:`_coerce_datastacks`.

    ``cell_id_source_table``, when set, overrides the feature table's
    own ``cell_id_source_table`` for THIS datastack only. Used in joint
    manifests where one parquet spans datastacks with different source-table
    conventions and a single per-table value can't represent every row.
    """

    name: str
    cell_id_source_table: str | None = None


class FeatureTableSpec(BaseModel):
    """One per-file feature-table YAML. Owns the data (a parquet keyed
    by cell_id), the columns the explorer can plot / filter / kNN over,
    the embeddings declared over those columns, AND the similarity-pipeline
    controls.

    Schema v1: each FeatureTableSpec is the entire YAML file — no wrapper.
    Multiple feature tables = multiple files in the same directory.

    ``feature_columns`` are numeric columns eligible for kNN + range
    filtering (None → infer at load time from non-axis non-audit
    numerics). ``categorical_columns`` are usable for color and equality
    filters but are excluded from kNN by default.

    ``spatial_pre_columns`` and ``spatial_post_columns`` together
    declare which numeric columns have a spatial interpretation —
    coordinates, depths, distances, radial offsets — split by whether
    they live BEFORE the aligned-volume's spatial transform (raw
    coords in the original volume frame) or AFTER it (biological-
    space coords). Both overlap with ``feature_columns`` the way
    ``depth_columns`` does — a spatial column is still a feature and
    participates in kNN / range filtering.

    Why both matter:
    - **Pre-transform** is what Neuroglancer needs in URLs: the
      volume's native frame is where image data + segmentation live.
      The cell_id source table also carries pre-transform coords for
      every row by convention; bundling them in the feature parquet
      is a static cache of that lookup so the explorer doesn't pay
      the join cost at query time.
    - **Post-transform** is what's biologically meaningful: cortical
      depth, layer-aware distances, anything that respects the
      anatomy the transform encodes.
    - They're not interchangeable — a feature table that wants to
      support both Neuroglancer cross-nav AND biological analysis
      bundles columns in both lists.

    ``depth_columns`` is a *strict subset* of
    ``spatial_post_columns``: depth is what the aligned-volume
    transform produces along the cortical axis, so a depth column is
    necessarily post-transform. The renderer special-cases depth —
    when a depth column is bound to a plot's axis, the axis
    auto-flips and cortical layer boundary markers overlay (the same
    machinery the connectivity-side plots use via
    ``services/plots.py::_is_depth_column``). The loader doesn't
    enforce the subset invariant today but consumers may rely on it.

    ``cell_id_source_table`` names the CAVE table whose row ids the
    ``id_column`` references. The composite
    ``(cell_id_source_table, id_column)`` is the stable identity for
    each row — necessary because not every object gets a universal id;
    the source table is part of the key. Overrides the datastack-level
    ``feature_explorer.cell_id_source_table`` fallback.

    ``scaling``, ``standardize``, and ``clip_percentiles`` control the
    feature-matrix standardization pipeline. Per-table because different
    feature sets benefit from different transforms — a morphology dataset
    generated with robust scaling should set ``scaling: robust``; a
    pre-standardized embedding parquet should set ``scaling: raw``.
    """

    # Per-file schema version. v1 is the only supported version today;
    # the field is OPTIONAL on the wire (defaults to 1) so the most-common
    # hand-authored file doesn't need to repeat boilerplate. Future schema
    # changes bump per-file so files in the same directory can evolve
    # independently.
    schema_version: int = 1

    id: str
    title: str
    description: str | None = None

    source: FeatureTableSourceRef
    # Column in the parquet that holds the row identifier.
    id_column: str = "cell_id"
    # CAVE table whose row ids the `id_column` references. Optional at
    # the file level: when null, the datastack-level
    # `feature_explorer.cell_id_source_table` is used (resolved via
    # :func:`effective_cell_id_source_table`). Required when no
    # datastack-level fallback is set.
    cell_id_source_table: str | None = None

    feature_columns: list[str] | None = None
    categorical_columns: list[str] = Field(default_factory=list)
    spatial_pre_columns: list[str] = Field(default_factory=list)
    spatial_post_columns: list[str] = Field(default_factory=list)
    depth_columns: list[str] = Field(default_factory=list)
    audit: FeatureTableAudit | None = None
    categories: list[FeatureCategorySpec] = Field(default_factory=list)
    embeddings: list[EmbeddingSpec] = Field(default_factory=list)

    # Similarity-pipeline controls. Moved here from the old manifest-level
    # `knn:` block. See the class docstring for the per-table-vs-global
    # rationale.
    scaling: Literal["zscore", "robust", "percentile", "raw"] = "zscore"
    # Legacy boolean. When `scaling` is left at its default ("zscore")
    # and this is `false`, callers translate to `scaling: raw`. Otherwise
    # `scaling` wins. Retained so older manifests authored with just
    # `standardize: false` keep validating after migration.
    standardize: bool = True
    clip_percentiles: tuple[float, float] | None = (0.1, 99.9)

    # Multi-datastack participation. When empty (the typical case), the
    # feature table belongs to whichever datastack pointed at this
    # directory via `feature_explorer.manifest_uri`. When populated, the
    # table is shared across the listed datastacks.
    datastacks: list[DatastackEntry] = Field(default_factory=list)


class Manifest(BaseModel):
    """Parsed + validated feature-table catalog.

    Schema v1 retires the manifest-level fields (``schema_version``,
    ``datastacks``, ``knn``) — those moved onto each FeatureTableSpec.
    The Manifest is now a simple wrapper around a list of validated
    feature tables so callers can pass it around as one object.
    """

    feature_tables: list[FeatureTableSpec]


def effective_datastacks(
    ft: FeatureTableSpec, parent_datastack: str
) -> list[DatastackEntry]:
    """Return the datastacks for ``ft``, defaulting to the parent.

    Single-datastack feature tables omit the ``datastacks:`` block; this
    helper fills in the implicit single-element list so downstream code
    can treat every feature table as having an explicit datastack set.
    """
    if ft.datastacks:
        return ft.datastacks
    return [DatastackEntry(name=parent_datastack)]


def effective_cell_id_source_table(
    ft: FeatureTableSpec, datastack: str, fallback: str | None
) -> str | None:
    """Pick the cell_id source table for ``ft`` in ``datastack``.

    Precedence:
      1. Per-datastack override on the feature table
         (``ft.datastacks[X].cell_id_source_table``).
      2. The feature table's own ``cell_id_source_table``.
      3. The datastack YAML's ``feature_explorer.cell_id_source_table``
         (passed in as ``fallback``).

    Returns None when no source table is declared anywhere — downstream
    consumers (e.g. the resolver) surface a 422 in that case.
    """
    for entry in ft.datastacks:
        if entry.name == datastack and entry.cell_id_source_table:
            return entry.cell_id_source_table
    if ft.cell_id_source_table:
        return ft.cell_id_source_table
    return fallback


def fetch_and_parse_manifest(uri: str, *, project: str | None = None) -> Manifest:
    """Load the feature-table catalog at ``uri`` into a Manifest.

    ``uri`` may point at:
      - a single ``.yaml`` file → parsed as one ``FeatureTableSpec``;
      - a directory (``file://`` path / ``gs://`` prefix) → every
        ``*.yaml`` under it is parsed as a ``FeatureTableSpec``.

    Per-file validation rules:

      - YAML must parse and be a top-level mapping.
      - ``schema_version`` (default 1 if absent) must be in
        ``SUPPORTED_SCHEMA_VERSIONS``.
      - For directory-loaded files: the filename basename must match
        the file's ``id`` field, and ``id`` must match
        ``_FT_ID_PATTERN``. Single-file URIs skip the filename check.

    Failures on an individual file are logged warnings and skipped; the
    overall load returns the valid feature tables. A hard failure only
    happens when the URI itself can't be reached.
    """
    # Single file: end-of-path is `.yaml`.
    if uri.endswith(".yaml") or uri.endswith(".yml"):
        ft = _fetch_and_validate_ft(uri, project=project, check_filename_basename=False)
        return Manifest(feature_tables=[ft] if ft is not None else [])

    # Directory / prefix: list children.
    child_uris = list_yaml_uris(uri, project=project)
    if not child_uris:
        logger.warning(
            "manifest dir %s contained no .yaml feature-table files", uri
        )
        return Manifest(feature_tables=[])

    seen_ids: set[str] = set()
    out: list[FeatureTableSpec] = []
    for child in sorted(child_uris):
        ft = _fetch_and_validate_ft(child, project=project, check_filename_basename=True)
        if ft is None:
            continue
        if ft.id in seen_ids:
            logger.warning(
                "manifest dir %s: duplicate feature_table id %r in %s, keeping first",
                uri, ft.id, child,
            )
            continue
        seen_ids.add(ft.id)
        out.append(ft)
    return Manifest(feature_tables=out)


def _fetch_and_validate_ft(
    uri: str, *, project: str | None, check_filename_basename: bool
) -> FeatureTableSpec | None:
    """Fetch one per-file YAML and validate it as a FeatureTableSpec.
    Returns None (with a warning log) on any per-file failure so a sibling
    bad file doesn't sink the whole load."""
    try:
        body = fetch_bytes(uri, project=project)
    except Exception as e:
        logger.warning("feature_table file %s: fetch failed: %s", uri, e)
        return None
    try:
        data = yaml.safe_load(body)
    except yaml.YAMLError as e:
        logger.warning("feature_table file %s: YAML parse failed: %s", uri, e)
        return None
    if not isinstance(data, dict):
        logger.warning(
            "feature_table file %s: top-level must be a mapping (got %s)",
            uri, type(data).__name__,
        )
        return None

    sv = data.get("schema_version", 1)
    if sv not in SUPPORTED_SCHEMA_VERSIONS:
        logger.warning(
            "feature_table file %s: unsupported schema_version=%r (supported: %s)",
            uri, sv, sorted(SUPPORTED_SCHEMA_VERSIONS),
        )
        return None

    if check_filename_basename:
        basename = _basename_of(uri)
        body_id = data.get("id")
        if body_id != basename:
            logger.warning(
                "feature_table file %s: id %r doesn't match filename basename %r; skipping",
                uri, body_id, basename,
            )
            return None
        if not isinstance(body_id, str) or not _FT_ID_PATTERN.match(body_id):
            logger.warning(
                "feature_table file %s: id %r doesn't match %s; skipping",
                uri, body_id, _FT_ID_PATTERN.pattern,
            )
            return None

    # Datastacks block accepts bare-name strings; coerce before validation.
    if "datastacks" in data:
        data["datastacks"] = _coerce_datastacks(data["datastacks"], uri=uri)

    # Validate the parent shape (without embeddings/categories) so per-entry
    # failures don't sink the file; attach the validated nested lists after.
    raw_embeddings = data.get("embeddings") or []
    raw_categories = data.get("categories") or []
    skeleton = {k: v for k, v in data.items() if k not in ("embeddings", "categories")}
    try:
        parent = FeatureTableSpec.model_validate(
            {**skeleton, "embeddings": [], "categories": []}
        )
    except ValidationError as e:
        logger.warning("feature_table file %s: validation failed: %s", uri, e)
        return None

    valid_categories: list[FeatureCategorySpec] = []
    seen_cat_ids: set[str] = set()
    for j, raw in enumerate(raw_categories):
        try:
            cat = FeatureCategorySpec.model_validate(raw)
        except ValidationError as e:
            logger.warning(
                "feature_table file %s: skipping categories entry %d (%s)",
                uri, j, e,
            )
            continue
        if cat.id in seen_cat_ids:
            logger.warning(
                "feature_table file %s: duplicate category id %r, keeping first",
                uri, cat.id,
            )
            continue
        seen_cat_ids.add(cat.id)
        valid_categories.append(cat)

    valid_embeddings: list[EmbeddingSpec] = []
    seen_emb_ids: set[str] = set()
    for j, raw in enumerate(raw_embeddings):
        try:
            emb = EmbeddingSpec.model_validate(raw)
        except ValidationError as e:
            logger.warning(
                "feature_table file %s: skipping embeddings entry %d (%s)",
                uri, j, e,
            )
            continue
        if emb.id in seen_emb_ids:
            logger.warning(
                "feature_table file %s: duplicate embedding id %r, keeping first",
                uri, emb.id,
            )
            continue
        seen_emb_ids.add(emb.id)
        valid_embeddings.append(emb)

    ft = parent.model_copy(
        update={"embeddings": valid_embeddings, "categories": valid_categories}
    )

    # Default-fill source.uri from the YAML's prefix when absent.
    # The convention is <yaml-prefix>/<id>.parquet, where the prefix
    # is the URI up to and including the trailing slash before the
    # filename. file:// and gs:// alike are handled because we
    # operate on the URI string, not the filesystem.
    if ft.source.uri is None:
        last_slash = uri.rfind("/")
        yaml_prefix = uri[: last_slash + 1] if last_slash >= 0 else ""
        default_uri = f"{yaml_prefix}{ft.id}.parquet"
        ft = ft.model_copy(
            update={
                "source": FeatureTableSourceRef(
                    kind=ft.source.kind, uri=default_uri,
                )
            }
        )

    return ft


def _basename_of(uri: str) -> str:
    """Strip the path and the `.yaml`/`.yml` extension from a URI."""
    last_slash = uri.rfind("/")
    name = uri[last_slash + 1:] if last_slash >= 0 else uri
    for ext in (".yaml", ".yml"):
        if name.endswith(ext):
            return name[: -len(ext)]
    return name


def _coerce_datastacks(raw, *, uri: str) -> list:
    """Allow bare-name strings in the YAML datastacks block. Returns a
    list of dicts ready for Pydantic to validate as ``DatastackEntry``."""
    if not isinstance(raw, list):
        logger.warning(
            "feature_table file %s: `datastacks` must be a list, got %s; ignoring",
            uri, type(raw).__name__,
        )
        return []
    out: list = []
    for i, item in enumerate(raw):
        if isinstance(item, str):
            out.append({"name": item})
        elif isinstance(item, dict):
            out.append(item)
        else:
            logger.warning(
                "feature_table file %s: skipping datastacks entry %d "
                "(expected str or mapping, got %s)",
                uri, i, type(item).__name__,
            )
    return out


def get_manifest(
    datastack: str, uri: str, *, project: str | None = None
) -> Manifest:
    """Return the manifest, cached.

    Cache key is ``(datastack,)`` — the manifest URI is a
    deterministic function of the deploy-time base + the datastack
    name (both immutable for the lifetime of the process), so adding
    it to the key would just be redundant. The ``uri`` argument is
    retained as the fetch target.

    Cache hit, fresh: return immediately. Cache hit, stale: return
    immediately and schedule a background refresh. Cache miss:
    synchronous fetch; first-fetch errors propagate so a
    misconfigured manifest_uri is obvious from the very first request.

    When no cache is registered on the app (e.g. unit-test context
    with no full app-context setup), falls through to a direct fetch
    every time.
    """
    cache = current_app.extensions.get("dcv_embedding_manifest_cache")
    if cache is None:
        return fetch_and_parse_manifest(uri, project=project)

    key = (datastack,)
    hit = cache.get(key)
    if hit is None:
        manifest = fetch_and_parse_manifest(uri, project=project)
        cache.set(key, manifest)
        return manifest

    value, freshness = hit
    if freshness == "stale":
        _schedule_refresh(cache, key, uri, project=project)
    return value


def _schedule_refresh(cache, key, uri: str, *, project: str | None) -> None:
    """Refresh a stale manifest entry in a daemon thread."""

    def _refresh() -> None:
        try:
            manifest = fetch_and_parse_manifest(uri, project=project)
            cache.set(key, manifest)
        except Exception as e:
            logger.warning(
                "manifest %s: background refresh failed (%s); keeping stale entry",
                uri, e,
            )

    threading.Thread(
        target=_refresh, daemon=True, name="cdv-manifest-refresh"
    ).start()
