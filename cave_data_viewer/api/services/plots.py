"""Server-side plot rendering.

Plot recipes are declarative `PlotSpec` objects (loaded from YAML templates).
Server materializes the requested data slice from a `NeuronQuery`, applies any
optional decoration (cell_type / num_soma), passes through a `kind`-specific
builder that produces a Plotly figure, and returns its JSON to the client.

The PlotSpec abstraction is the seam where a future Bokeh / HoloViews backend
could plug in — the spec stays, the builders swap.
"""

import json
import logging
import re
from pathlib import Path
from typing import Literal

import pandas as pd
import plotly.graph_objects as go
import yaml
from flask import current_app
from pydantic import BaseModel, ConfigDict, Field, ValidationError

logger = logging.getLogger(__name__)

from .categorical import (
    NULL_COLOR,
    NULL_LABEL,
    categorical_palette as _categorical_palette,
    get_unique_values,
    greyscale_ramp as _greyscale_ramp,
    resolve_categorical_color_map,
)
from .neuron import NeuronQuery
from .timing import timer


# ----- schema -----------------------------------------------------------------

class DataQuery(BaseModel):
    """`source` selects the dataframe the plot draws from:
      - `partners_in`  — input partners only.
      - `partners_out` — output partners only.
      - `partners_both` — unified frame: one row per unique partner root_id,
        synapse counts and aggregations split into _in / _out columns
        (mirrors the SPA's "Both" tab; computed by `_build_unified_frame`).
    """
    source: Literal["partners_in", "partners_out", "partners_both"]


# ----- cell filter ------------------------------------------------------------

# Operators applied row-wise against a decoration column. Strings vs numerics
# are kept loose: comparisons coerce to float when both sides parse, otherwise
# string-compare. `in` / `notin` use `|`-separated values inside the URL.
CellFilterOp = Literal[
    "eq", "ne", "gt", "gte", "lt", "lte", "in", "notin", "nonnull", "null",
]


class CellFilter(BaseModel):
    """One predicate against a decoration column. Predicates AND together."""
    table: str          # decoration table name (or cell-type table)
    column: str         # bare column name on that table
    op: CellFilterOp
    value: str | None = None   # null for nonnull/null ops; pipe-split for in/notin


def _parse_cells_param(raw: str | None) -> list[CellFilter]:
    """Parse the `cells=<table>.<col>:<op>:<val>[,...]` URL param into filters.

    Tolerates leading/trailing whitespace and empty entries. Bad clauses raise
    ValueError so the endpoint returns a 422 the user can fix from the URL.

    Clauses prefixed with `~` are disabled (the SPA's "off" toggle). They're
    skipped silently — the backend only sees the active filter set, so it
    doesn't have to track enable/disable state. Disabled clauses still need
    to parse cleanly so a typo'd disabled predicate is caught the moment the
    user toggles it back on.
    """
    if not raw:
        return []
    out: list[CellFilter] = []
    for clause in raw.split(","):
        clause = clause.strip()
        if not clause:
            continue
        disabled = clause.startswith("~")
        if disabled:
            clause = clause[1:].strip()
            if not clause:
                continue
        # Split on the first two colons only — values may legitimately contain
        # colons (e.g. ISO timestamps in the future).
        head, _, rest = clause.partition(":")
        op_str, _, value = rest.partition(":")
        if not head or not op_str:
            raise ValueError(f"cells clause {clause!r} must be 'table.col:op:val'")
        if "." not in head:
            raise ValueError(f"cells clause {clause!r} must qualify column as table.col")
        table, _, column = head.partition(".")
        if not table or not column:
            raise ValueError(f"cells clause {clause!r} has empty table or column")
        if op_str not in ("eq", "ne", "gt", "gte", "lt", "lte", "in", "notin", "nonnull", "null"):
            raise ValueError(f"cells clause {clause!r} has unknown op {op_str!r}")
        if disabled:
            continue  # parsed for validation, then dropped
        out.append(CellFilter(
            table=table.strip(),
            column=column.strip(),
            op=op_str,  # type: ignore[arg-type]
            value=value if value != "" else None,
        ))
    return out


# Truthy-ish strings that map to True for boolean-coerced comparisons. The
# proofreading_status_and_strategy.status_axon column lands on the SPA as
# Python booleans, but in the URL the user types "t" or "true". The
# vectorized comparator below uses these to coerce the rhs to a real bool
# when the lhs column is boolean-typed.
_BOOL_TRUE = {"true", "t", "1", "yes", "y"}
_BOOL_FALSE = {"false", "f", "0", "no", "n"}

# Pandas vector method names for each ordered/equality op. The values are
# the dataframe-element op names (`series.eq`, `series.gt`, ...) used by
# `_comparison_mask`. Centralised so any future op additions touch one
# place — and so the dispatch dict acts as the canonical op enumeration
# matching `CellFilterOp`.
_VEC_OP: dict[str, str] = {
    "eq": "eq", "ne": "ne",
    "gt": "gt", "gte": "ge",
    "lt": "lt", "lte": "le",
}


def _is_boolish_series(series: pd.Series) -> bool:
    """True when the column is bool-shaped enough to deserve bool-coercion
    of the rhs. Covers `bool` / nullable `boolean` dtypes directly, plus
    object-dtype columns whose first non-null value is a Python bool —
    decoration tables (e.g. `proofreading_status_and_strategy.status_axon`)
    arrive as `object` since the underlying CAVE return preserves None,
    so a strict `is_bool_dtype` check would miss them.
    """
    if pd.api.types.is_bool_dtype(series):
        return True
    if series.dtype == object:
        sample = series.dropna()
        if len(sample) > 0:
            return isinstance(sample.iloc[0], bool)
    return False


def _comparison_mask(series: pd.Series, op: str, rhs: str) -> pd.Series:
    """Vectorized eq/ne/gt/gte/lt/lte mask for a single decoration column.

    Coercion rules mirror the legacy per-row `_coerce_pair` logic:
      - Bool-shaped column (incl. object-with-bools) → coerce rhs against
        `_BOOL_TRUE` / `_BOOL_FALSE`.
      - Numeric-coercible rhs and at least one numeric value in series →
        cast both sides to float, comparison via pandas vector ops.
      - Otherwise → string compare via `astype(str)`.

    NaN / NA values fail every comparison (including `ne`, matching the
    legacy `if a is None: return False` branch). Implemented with
    `.fillna(False)` on the result mask.
    """
    method = _VEC_OP[op]
    # NA short-circuit: legacy `_cmp` returned False whenever the value
    # normalized to None, including for `ne`. Pandas vector comparisons
    # don't preserve that semantics — `pd.NA != x` evaluates to True for
    # numeric NaN and `None != True` is True at the Python level. We AND
    # every result with `notna()` to enforce "NA fails every op".
    not_na = series.notna()

    # Boolean column path. The rhs comes in as a URL string; coerce it to
    # a real bool when it's a known truthy/falsy token, else short-circuit
    # to an empty mask (the legacy impl would TypeError on bool vs str
    # and the per-row catch returned False).
    if _is_boolish_series(series):
        rl = rhs.strip().lower()
        if rl in _BOOL_TRUE:
            rhs_v: object = True
        elif rl in _BOOL_FALSE:
            rhs_v = False
        else:
            return pd.Series(False, index=series.index)
        cmp = getattr(series, method)(rhs_v).fillna(False).astype(bool)
        return cmp & not_na

    # Numeric path. Try to parse rhs as a float; if that succeeds and the
    # column has at least one numeric value, do the whole comparison in
    # the numeric domain. Non-numeric cells become NaN; we mask them out
    # via `coerced.notna()` (a column with mixed numerics + strings has
    # the strings excluded — they wouldn't have compared meaningfully
    # anyway). At least one numeric value is required to avoid silently
    # coercing an all-string column to NaN and producing an empty mask
    # when the user clearly meant a string compare.
    try:
        rhs_f = float(rhs)
    except (TypeError, ValueError):
        rhs_f = None
    if rhs_f is not None:
        coerced = pd.to_numeric(series, errors="coerce")
        if coerced.notna().any():
            cmp = getattr(coerced, method)(rhs_f).fillna(False).astype(bool)
            return cmp & coerced.notna()

    # String fallback. NaN cells become "nan" via astype(str), but we still
    # mask them out so a user filter `ne:"foo"` doesn't accidentally match
    # NA rows (NaN's stringified form != "foo" → True without the mask).
    cmp = getattr(series.astype(str), method)(rhs).astype(bool)
    return cmp & not_na


def _apply_cell_filters(df: pd.DataFrame, filters: list[CellFilter]) -> pd.DataFrame:
    """Apply each predicate as a row mask. Missing columns raise ValueError so
    the user gets a clear 422 instead of an empty plot.

    Operates on the *materialized* dataframe — by the time we get here the
    decoration columns have been merged on as `<table>.<column>` keys.

    Vectorized — every op resolves to a pandas vector op (`series.eq`,
    `series.gt`, etc.) so a 10K-row partner frame filters in microseconds
    rather than the millisecond range the per-row `series.map(_cmp)` cost.
    """
    if not filters:
        return df
    if df.empty:
        return df
    for f in filters:
        col = f"{f.table}.{f.column}"
        if col not in df.columns:
            raise ValueError(
                f"cells filter references column {col!r} which is not loaded — "
                f"add the table to decoration_tables, or remove the predicate."
            )
        series = df[col]
        if f.op == "nonnull":
            mask = series.notna()
        elif f.op == "null":
            mask = series.isna()
        elif f.op in ("in", "notin"):
            # `|`-separated value list. Stringify both sides for comparison
            # so the numeric cell `5` matches the URL token `"5"`. NaN
            # cells become "nan" — won't match any user-typed token, which
            # matches the legacy impl's effective behavior.
            wanted = [v.strip() for v in (f.value or "").split("|") if v.strip()]
            mask = series.astype(str).isin(wanted)
            if f.op == "notin":
                mask = ~mask
        else:
            if f.value is None:
                raise ValueError(f"cells op {f.op!r} requires a value")
            mask = _comparison_mask(series, f.op, f.value)
        df = df[mask]
    return df


class LayoutOverrides(BaseModel):
    title: str | None = None
    xaxis_title: str | None = None
    yaxis_title: str | None = None
    width: int | None = None
    height: int | None = None
    showlegend: bool | None = None


class PlotSpec(BaseModel):
    """A plot recipe.

    `kind` is the *primary* chart type. When `dynamic=True`, the resolver may
    override `kind` at request time based on which axes the caller binds:
    one axis → histogram (numeric x) or bar (non-numeric x / weight bound),
    two axes → scatter. Static specs (`dynamic=False`) keep `kind` exactly.

    `hue` and `size` are runtime channels for scatter / colored histogram.
    `color` is kept as a deprecated alias for `hue` so existing YAMLs that
    grouped bars by color continue to work; the resolver normalizes to `hue`.

    `weight` applies only on bar plots: when set, the implicit-count `groupby
    .size()` is replaced with `groupby[weight].sum()` so the bars show
    "synapses by cell type" rather than "partners per cell type".

    `color_map` is internal scratch space. The resolver fills it with a
    `{value: hex}` mapping for cell-type-table-backed hues so colors are
    deterministic and consistent across plots; builders apply it to
    `marker.color` directly. Excluded from JSON and not user-settable.
    """
    model_config = ConfigDict(arbitrary_types_allowed=True)

    name: str
    description: str = ""
    kind: Literal["bar", "histogram", "scatter", "stripplot"]
    data_query: DataQuery
    x: str | None = None       # column name on the source frame
    y: str | None = None       # column name; bar implies count if omitted
    hue: str | None = None     # column name for color/group split
    color: str | None = None   # deprecated alias for `hue` (back-compat)
    size: str | None = None    # numeric column → marker size for scatter
    weight: str | None = None  # numeric column to sum on bar; replaces row-count
    bins: int | None = None    # histogram only
    dynamic: bool = False      # accept runtime `bindings` overrides + auto-pick kind
    layout: LayoutOverrides = Field(default_factory=LayoutOverrides)
    color_map: dict | None = Field(default=None, exclude=True)
    # Full universe of distinct values for `x` when x is categorical and
    # provenance traces back to a cell-type / decoration table. Used by
    # `_build_bar` and `_build_stripplot` to render every category — even
    # ones with zero observations — as an explicit x-axis slot, so the
    # user can see true zeros (e.g. "this neuron has no PV partners")
    # rather than silently-missing buckets. None when x is intrinsic /
    # numeric / synthetic — fall back to observed-only ordering.
    x_universe: list | None = Field(default=None, exclude=True)


# ----- loader -----------------------------------------------------------------

def load_plot_specs() -> dict[str, PlotSpec]:
    """Reload templates fresh on every call — they're tiny YAMLs."""
    out: dict[str, PlotSpec] = {}
    bundled_dir = Path(__file__).parent.parent / "templates" / "plots"
    _load_dir(bundled_dir, out)
    extra_dir = current_app.config.get("PLOT_TEMPLATE_DIR")
    if extra_dir:
        _load_dir(Path(extra_dir), out)
    return out


def _load_dir(path: Path, out: dict[str, PlotSpec]) -> None:
    if not path.is_dir():
        return
    for yaml_path in sorted(path.glob("*.yaml")):
        try:
            data = yaml.safe_load(yaml_path.read_text()) or {}
        except yaml.YAMLError as exc:
            logger.warning("skipping plot template %s: YAML parse error: %s", yaml_path, exc)
            continue
        if "name" not in data:
            data["name"] = yaml_path.stem
        try:
            spec = PlotSpec.model_validate(data)
        except ValidationError as exc:
            logger.warning("skipping plot template %s: validation error: %s", yaml_path, exc)
            continue
        out[spec.name] = spec


# ----- builders ---------------------------------------------------------------

def _format_label(col: str | None) -> str | None:
    """Render a bound-column reference for human-facing labels.

    Decoration-table columns ship as `<table>.<col>` (the dot is the
    internal join key — see `_provenance_for`). For axis titles and
    the colorbar header the dot is hard to read at small font sizes
    (`/` reads as a separator more clearly than `.`, which fights with
    the period as sentence punctuation). Bare-column references pass
    through unchanged. Weight-summed bars and synthetic columns
    (`direction`, `count`) have no dot to begin with.
    """
    if col is None:
        return None
    return col.replace(".", "/", 1) if "." in col else col


def _apply_auto_titles(fig: go.Figure, spec: PlotSpec) -> None:
    """Auto-fill axis titles from the bound columns when not already set.

    Plotly doesn't derive axis titles from explicitly-supplied trace data
    (only for `plotly.express` shorthand), so without this the SPA's
    collapsed picker chip would have to show every binding verbatim to
    convey what's plotted. With auto-titles, the chart self-documents:
    x-axis = `spec.x`, y-axis = `spec.y` / `spec.weight` / "count" depending
    on what the builder produced. Called *after* `_apply_layout` so any
    explicit override on the spec still wins.

    Decoration columns are rendered as `<table>/<col>` (slash form) rather
    than the internal `<table>.<col>` join key — see `_format_label`.
    """
    layout = fig.layout
    current_x = (
        layout.xaxis.title.text
        if layout.xaxis and layout.xaxis.title
        else None
    )
    current_y = (
        layout.yaxis.title.text
        if layout.yaxis and layout.yaxis.title
        else None
    )

    updates: dict = {}
    if not current_x and spec.x:
        updates["xaxis_title"] = _format_label(spec.x)
    if not current_y:
        if spec.y:
            updates["yaxis_title"] = _format_label(spec.y)
        elif spec.kind == "bar":
            # Implicit-count or weight-sum bars — name the y-axis after
            # what the bars are summing so the user reads "n_syn_in" or
            # "count" directly off the chart.
            updates["yaxis_title"] = _format_label(spec.weight) or "count"
        elif spec.kind == "histogram":
            updates["yaxis_title"] = "count"
    if updates:
        fig.update_layout(**updates)


def _apply_layout(fig: go.Figure, layout: LayoutOverrides) -> None:
    update: dict = {}
    if layout.title is not None:
        update["title"] = layout.title
    if layout.xaxis_title is not None:
        update["xaxis_title"] = layout.xaxis_title
    if layout.yaxis_title is not None:
        update["yaxis_title"] = layout.yaxis_title
    if layout.width is not None:
        update["width"] = layout.width
    if layout.height is not None:
        update["height"] = layout.height
    if layout.showlegend is not None:
        update["showlegend"] = layout.showlegend
    if update:
        fig.update_layout(**update)


def _resolve_hue(spec: PlotSpec) -> str | None:
    """`hue` wins over the deprecated `color` alias."""
    return spec.hue or spec.color


def _provenance_for(col: str) -> tuple[str | None, str]:
    """Return `(table, bare_column)` for a column reference.

    Decoration-table columns ship as `<table>.<col>` after `lookup_decorations`
    merges them in — this branch returns `(table, col)`. Bare names
    (synapse columns like `n_syn_in`/`num_syn`, synthetic columns like
    `direction`, soma columns like `num_soma`/`cell_id`) return
    `(None, col)`; the caller falls back to plotly's default colorway.
    """
    if "." in col:
        tbl, _, bare = col.partition(".")
        return tbl, bare
    return None, col


def _customdata(data: pd.DataFrame) -> list[str] | None:
    """Per-point root_id payload so the SPA can map plot-event picks back to
    table rows (drives the brushing feature). Always emitted when the column
    is present; consumers ignore it if they don't need it."""
    if "root_id" not in data.columns:
        return None
    return data["root_id"].astype(str).tolist()


def _build_bar(data: pd.DataFrame, spec: PlotSpec) -> go.Figure:
    if spec.x is None:
        raise ValueError("bar plot requires `x`")
    hue = _resolve_hue(spec)

    # Explicit-y path takes whatever the dataframe says; weight is a no-op
    # here because the user already chose what the bars should add up to.
    if spec.y is not None:
        fig = go.Figure([go.Bar(
            x=data[spec.x], y=data[spec.y],
            customdata=_customdata(data), showlegend=False,
        )])
        return fig

    # Implicit-aggregation path. Weight column (when set) replaces the
    # row-count: `groupby(...)[weight].sum()` instead of `.size()`. Lets the
    # user plot "synapses by cell type" by binding `x=cell_type, weight=n_syn_in`
    # rather than the default "partners per cell type".
    use_weight = bool(spec.weight) and spec.weight in data.columns
    group_cols = [spec.x] + ([hue] if hue else [])
    if use_weight:
        # `dropna=False` on groupby so null x/hue still produces a bar; the
        # weight `.sum()` of an all-null bin is 0 (pandas skips NaN in sum).
        agg = (
            data.groupby(group_cols, dropna=False)[spec.weight]
                .sum()
                .reset_index(name=spec.weight)
        )
        y_col = spec.weight
    else:
        agg = data.groupby(group_cols, dropna=False).size().reset_index(name="count")
        y_col = "count"

    agg[spec.x] = agg[spec.x].fillna(NULL_LABEL).astype(str)

    # X-axis ordering. Categorical x goes case-folded alphabetical with the
    # null bucket pinned to the end — so "BC" sits in the same x-position
    # whether the user is looking at neuron A or neuron B, which is the
    # whole point of having shareable per-neuron plots: visual comparison
    # across views relies on stable axis layout. Numeric x keeps the
    # legacy "tallest bars first" sort (useful for a top-N read on a
    # discrete-numeric axis like num_soma).
    x_is_categorical = not pd.api.types.is_numeric_dtype(data[spec.x])
    x_categoryarray: list[str] | None = (
        _categorical_x_order(agg[spec.x], spec.x_universe) if x_is_categorical else None
    )

    if hue:
        agg[hue] = agg[hue].fillna(NULL_LABEL).astype(str)
        fig = go.Figure()
        # When the resolver computed a universe-pinned color_map, apply it
        # per trace so bar colors line up with the same hue value's color
        # in any scatter plot on the rail. Without a color_map we fall back
        # to plotly's colorway, which the SPA's theme injects from `--cat-*`.
        for hue_value, sub in agg.groupby(hue, dropna=False):
            label = NULL_LABEL if pd.isna(hue_value) else str(hue_value)
            marker = None
            if spec.color_map is not None:
                marker = {"color": spec.color_map.get(label, NULL_COLOR)}
            fig.add_trace(go.Bar(x=sub[spec.x], y=sub[y_col], name=label, marker=marker))
        fig.update_layout(barmode="stack")
        if x_categoryarray is not None:
            # categoryorder=array forces plotly to honor our explicit ordering
            # even when individual traces only contribute a subset of the x
            # values (the typical hue-split case).
            fig.update_xaxes(categoryorder="array", categoryarray=x_categoryarray)
        return fig

    # No hue: one trace. Sort by alphabetical x for categorical, otherwise
    # legacy y-descending. Per-bar colors still come from `color_map` when
    # the resolver populated one — keeps cell-type colors consistent even
    # without a hue binding.
    if x_categoryarray is not None:
        # `reindex` orders the bars to match `x_categoryarray`. When
        # `spec.x_universe` is set, the array also contains universe-only
        # values (cell types not present in this neuron's data). Filling
        # those missing rows with **explicit zeros** is the whole point of
        # the universe path — the user reads "this neuron has zero PV
        # partners" rather than "PV is missing from the chart". Hover shows
        # "0", which is the correct signal.
        agg = (
            agg.set_index(spec.x)
               .reindex(x_categoryarray)
               .reset_index()
        )
        agg[y_col] = agg[y_col].fillna(0)
    else:
        agg = agg.sort_values(y_col, ascending=False)
    # `showlegend=False` on the single-trace path so plotly doesn't render a
    # legend with an auto-named "trace 0" entry — there's no hue split to
    # disambiguate, the bar speaks for itself. Multi-trace branches above
    # keep the legend (each trace is a hue value).
    bar_kwargs: dict = {"x": agg[spec.x], "y": agg[y_col], "showlegend": False}
    if spec.color_map is not None:
        bar_kwargs["marker"] = {
            "color": [spec.color_map.get(v, NULL_COLOR) for v in agg[spec.x]],
        }
    fig = go.Figure([go.Bar(**bar_kwargs)])
    if x_categoryarray is not None:
        fig.update_xaxes(categoryorder="array", categoryarray=x_categoryarray)
    return fig


def _build_histogram(data: pd.DataFrame, spec: PlotSpec) -> go.Figure:
    """Histogram of `x` (default) or `y`. The resolver picks `kind=histogram`
    when only one of x/y is bound on a dynamic spec — this builder honors
    whichever side is set. `showlegend=False` because there's only one trace
    and plotly's default "trace 0" label adds no information.
    """
    if spec.x is None and spec.y is None:
        raise ValueError("histogram requires `x` or `y`")
    if spec.x is not None:
        fig = go.Figure([go.Histogram(x=data[spec.x], nbinsx=spec.bins, showlegend=False)])
    else:
        fig = go.Figure([go.Histogram(y=data[spec.y], nbinsy=spec.bins, showlegend=False)])
    return fig


# --- scatter + hue rules --------------------------------------------------

# Three-tier hue convention. Backend-side enforcement keeps the policy in one
# place, and the resolver can return a clean 422 when the user binds a hue
# column with too many distinct non-numeric values to be meaningfully colored.
# `_HUE_PALETTE_MAX` is 10 to align with `frontend/src/styles.css`'s
# `--cat-*` tokens (and matplotlib's tab10) so plotly's colorway and our
# explicit-color path produce identical hexes for ≤10 distinct values.
_HUE_PALETTE_MAX = 10         # ≤10 → split per category, distinct hues
_HUE_GREYSCALE_MAX = 30       # 11–30 → split per category, greyscale ramp / HSL
_VIRIDIS_NAME = "Viridis"     # >30 numeric → continuous colorscale


def _scale_size(values: pd.Series, lo_px: float = 4.0, hi_px: float = 20.0) -> pd.Series:
    """Scale a numeric column linearly into [lo_px, hi_px] for marker.size.
    NaN / non-numeric → median size. Constant column → all rows at hi_px so
    the dimension still renders distinctly."""
    s = pd.to_numeric(values, errors="coerce")
    finite = s.dropna()
    if finite.empty:
        return pd.Series([hi_px] * len(values), index=values.index)
    lo, hi = float(finite.min()), float(finite.max())
    if hi <= lo:
        return pd.Series([hi_px] * len(values), index=values.index)
    fill = lo  # NaN → smallest size
    return ((s.fillna(fill) - lo) * (hi_px - lo_px) / (hi - lo)) + lo_px


def _build_scatter(data: pd.DataFrame, spec: PlotSpec) -> go.Figure:
    if spec.x is None or spec.y is None:
        raise ValueError("scatter plot requires both `x` and `y`")
    hue = _resolve_hue(spec)
    customdata_all = _customdata(data)

    # Default radius matches `_build_stripplot`'s `POINT_SIZE` so the analytics
    # rail's two density-style plots read with a consistent dot weight.
    # Bound `size` swaps the scalar for a per-point series via `_scale_size`.
    marker_size: pd.Series | float = 4.0
    if spec.size and spec.size in data.columns:
        marker_size = _scale_size(data[spec.size])

    fig = go.Figure()
    if hue is None or hue not in data.columns:
        marker = {"size": marker_size if not isinstance(marker_size, float) else marker_size}
        # Single trace with no hue split → no legend (auto-named "trace 0"
        # otherwise). Hue branches below keep the legend per-trace.
        fig.add_trace(go.Scatter(
            x=data[spec.x], y=data[spec.y],
            mode="markers", marker=marker,
            customdata=customdata_all,
            showlegend=False,
        ))
        return fig

    hue_col = data[hue]
    n_unique = int(hue_col.nunique(dropna=False))
    is_numeric = pd.api.types.is_numeric_dtype(hue_col)

    # When the resolver populated a universe-pinned color_map (cell-type
    # column case), every tier below uses it for `marker.color`. The map's
    # NULL_LABEL key is NULL_COLOR, so missing-bucket coloring is automatic.
    color_map = spec.color_map

    if n_unique <= _HUE_PALETTE_MAX:
        # Categorical palette. Without color_map we let plotly cycle through
        # the SPA's `--cat-*` colorway. With color_map we override per trace
        # so the same hue value lands on the same color across every plot.
        for value, sub in data.groupby(hue_col.fillna(NULL_LABEL), dropna=False):
            label = NULL_LABEL if pd.isna(value) else str(value)
            sub_marker_size = marker_size.loc[sub.index] if hasattr(marker_size, "loc") else marker_size
            marker: dict = {"size": sub_marker_size}
            if color_map is not None:
                marker["color"] = color_map.get(label, NULL_COLOR)
            fig.add_trace(go.Scatter(
                x=sub[spec.x], y=sub[spec.y],
                mode="markers", name=label,
                marker=marker,
                customdata=sub["root_id"].astype(str).tolist() if "root_id" in sub.columns else None,
            ))
        return fig

    if n_unique <= _HUE_GREYSCALE_MAX:
        # 11-30 distinct values. Numeric values keep a sequential greyscale
        # ramp — preserves visual ordering, useful for discrete-numeric hue
        # like num_soma (0, 1, 2, ...). Non-numeric (e.g. cell_type with 18
        # labels) gets either the universe-pinned color_map (for cell-type
        # hues) or an HSL-rotation palette (for everything else) so labels
        # don't read as an ordered gradient.
        ramp = _greyscale_ramp(n_unique) if is_numeric else _categorical_palette(n_unique)
        for i, (value, sub) in enumerate(data.groupby(hue_col.fillna(NULL_LABEL), dropna=False)):
            label = NULL_LABEL if pd.isna(value) else str(value)
            sub_marker_size = marker_size.loc[sub.index] if hasattr(marker_size, "loc") else marker_size
            color = (
                color_map.get(label, NULL_COLOR)
                if (color_map is not None and not is_numeric)
                else ramp[i]
            )
            fig.add_trace(go.Scatter(
                x=sub[spec.x], y=sub[spec.y],
                mode="markers", name=label,
                marker={"size": sub_marker_size, "color": color},
                customdata=sub["root_id"].astype(str).tolist() if "root_id" in sub.columns else None,
            ))
        return fig

    if not is_numeric:
        # >30 distinct non-numeric: nothing useful to show. The resolver
        # converts ValueError into a 422 with a hint pointing the user
        # toward a numeric / lower-cardinality column.
        raise ValueError(
            f"hue column {hue!r} has {n_unique} distinct non-numeric values "
            f"— pick a numeric column for a continuous colorscale, or a "
            f"categorical column with ≤{_HUE_GREYSCALE_MAX} distinct values."
        )

    # >30 numeric: single trace, continuous colorscale. The colorbar handles
    # the hue legend visually, so no need for a per-trace legend entry.
    marker = {
        "size": marker_size,
        "color": pd.to_numeric(hue_col, errors="coerce"),
        "colorscale": _VIRIDIS_NAME,
        "showscale": True,
        "colorbar": {"title": {"text": _format_label(hue), "font": {"size": 10}}},
    }
    fig.add_trace(go.Scatter(
        x=data[spec.x], y=data[spec.y],
        mode="markers", marker=marker, showlegend=False,
        customdata=customdata_all,
    ))
    return fig


def _categorical_x_order(x_str: pd.Series, universe: list | None = None) -> list[str]:
    """Case-folded alphabetical order for the x-axis, with the null bucket
    pinned to the end (only when null is actually observed).

    When `universe` is given, every value in it occupies an x-axis slot —
    cell types not present in the current neuron's data still appear as
    empty buckets so the user reads "true zero" instead of "missing data".
    Observed-only values that aren't in the universe are still kept too:
    proofreading drift between the cached universe and the current frame
    shouldn't make a row vanish from the chart.

    When `universe` is None (intrinsic / numeric / synthetic x), only the
    observed values are listed — the universe path doesn't apply.
    """
    observed = list(dict.fromkeys(x_str.tolist()))
    has_null = NULL_LABEL in observed
    if universe:
        keys = {str(v) for v in universe if v is not None and str(v) != NULL_LABEL}
        keys.update(v for v in observed if v != NULL_LABEL)
        ordered = sorted(keys, key=lambda s: s.casefold())
    else:
        ordered = sorted((v for v in observed if v != NULL_LABEL), key=lambda s: s.casefold())
    if has_null:
        ordered.append(NULL_LABEL)
    return ordered


def _build_stripplot(data: pd.DataFrame, spec: PlotSpec) -> go.Figure:
    """Categorical-x by numeric-y rendered as a jittered point cloud per
    bucket.

    The user binds `x=cell_type, y=net_size_out` and gets one strip per cell
    type — same x-axis ordering as the bar plot, so a stripplot of synapse
    sizes can sit alongside a bar of synapse counts and the columns line up
    one-to-one. Hue gets the universe-pinned color_map and renders side-by-
    side strips within each x bucket via `boxmode='group'`. Without hue,
    each x bucket is its own trace so the universe color_map maps cleanly
    bucket → color (mirrors `_build_bar`'s no-hue branch).

    Implemented on `go.Box` with the box itself made transparent — this is
    the documented plotly idiom for a stripplot. `boxpoints='all'` renders
    every underlying row; `jitter` spreads them horizontally so dense
    clusters don't overlap.
    """
    if spec.x is None or spec.y is None:
        raise ValueError("stripplot requires both `x` and `y`")
    hue = _resolve_hue(spec)

    HIDDEN_BOX = dict(
        fillcolor="rgba(0,0,0,0)",
        line=dict(color="rgba(0,0,0,0)"),
    )
    # Tuned for dense connectomics distributions: heavy stacking happens at
    # the low end of `net_size` etc., so we lean on transparency + spread to
    # let the density read visually.
    #   - jitter 0.7 (≈ 70% of the bucket width) so points fill the column
    #   - marker.size 4 — small enough that 50+ overlapping dots still
    #     reveal individual contributors
    #   - marker.opacity 0.55 — ~3 stacked dots saturate to ~90% opacity, so
    #     the user can tell "a few" from "many" by darkness alone
    POINT_JITTER = 0.7
    POINT_SIZE = 4
    POINT_OPACITY = 0.55

    x_str = data[spec.x].fillna(NULL_LABEL).astype(str)

    fig = go.Figure()
    if hue is None or hue not in data.columns:
        # No hue → one trace per x bucket so the color_map maps cleanly
        # bucket → color. Legend is suppressed because each trace is just
        # a redundant copy of the x-axis label.
        for label, sub in data.assign(_x=x_str).groupby("_x", dropna=False, sort=False):
            color = (
                spec.color_map.get(label, NULL_COLOR)
                if spec.color_map is not None
                else None
            )
            marker: dict = {"size": POINT_SIZE, "opacity": POINT_OPACITY}
            if color is not None:
                marker["color"] = color
            fig.add_trace(go.Box(
                x=[label] * len(sub),
                y=sub[spec.y],
                name=label,
                showlegend=False,
                boxpoints="all",
                jitter=POINT_JITTER,
                pointpos=0,
                marker=marker,
                customdata=sub["root_id"].astype(str).tolist() if "root_id" in sub.columns else None,
                **HIDDEN_BOX,
            ))
    else:
        # Hue → one trace per hue value. `boxmode='group'` side-by-sides them
        # within each x bucket so direction=pre and direction=post for the
        # same cell type sit next to each other rather than overlapping.
        hue_str = data[hue].fillna(NULL_LABEL).astype(str)
        for value, sub in data.assign(_x=x_str, _hue=hue_str).groupby("_hue", dropna=False, sort=False):
            label = NULL_LABEL if pd.isna(value) else str(value)
            color = (
                spec.color_map.get(label, NULL_COLOR)
                if spec.color_map is not None
                else None
            )
            marker = {"size": POINT_SIZE, "opacity": POINT_OPACITY}
            if color is not None:
                marker["color"] = color
            fig.add_trace(go.Box(
                x=sub["_x"],
                y=sub[spec.y],
                name=label,
                boxpoints="all",
                jitter=POINT_JITTER,
                pointpos=0,
                marker=marker,
                customdata=sub["root_id"].astype(str).tolist() if "root_id" in sub.columns else None,
                **HIDDEN_BOX,
            ))
        fig.update_layout(boxmode="group")

    # Pin every universe value as an x-axis slot — empty buckets show as
    # labels with no points (the "true zero" signal mirrored from bars).
    fig.update_xaxes(
        categoryorder="array",
        categoryarray=_categorical_x_order(x_str, spec.x_universe),
    )
    return fig


_BUILDERS = {
    "bar": _build_bar,
    "histogram": _build_histogram,
    "scatter": _build_scatter,
    "stripplot": _build_stripplot,
}


def _empty_figure_with_message(message: str) -> go.Figure:
    """Placeholder figure when a bound axis has no data to render.

    Why this isn't a 422: the panel is configured correctly — the user
    picked columns, the spec resolved — there's just nothing to show
    because this neuron happens to have no values for the bound column.
    A red error banner is the wrong affordance for "expected absence";
    the placeholder slots into the rail so cross-neuron comparisons stay
    visually intact.
    """
    fig = go.Figure()
    fig.add_annotation(
        text=message,
        xref="paper", yref="paper",
        x=0.5, y=0.5,
        showarrow=False,
        font={"size": 13, "color": "#888"},
        align="center",
    )
    fig.update_xaxes(visible=False)
    fig.update_yaxes(visible=False)
    return fig


# --- depth-axis auto-reversal -------------------------------------------------

# Match column names whose bare suffix carries `depth` as a discrete word —
# e.g. `soma_depth`, `depth`, `pia_depth_um`. Avoids false-positives like
# `depth_class` (still depth-like, ok) or `width` (not a match).
_DEPTH_PATTERN = re.compile(r'(?:^|_)depth(?:$|_)', re.IGNORECASE)


def _is_depth_column(name: str | None) -> bool:
    if not name:
        return False
    bare = name.rsplit(".", 1)[-1]
    return bool(_DEPTH_PATTERN.search(bare))


def _maybe_flip_depth(fig: go.Figure, spec: PlotSpec) -> None:
    """Reverse the y-axis when y is bound to a depth-shaped column so pia
    sits at the top, matching the anatomical convention. Only the y-axis
    flips — flipping the x-axis would just reverse reading order without
    aiding interpretation, so a horizontal histogram of `soma_depth` keeps
    its natural left-to-right (pia → white matter) layout.
    """
    if _is_depth_column(spec.y):
        fig.update_yaxes(autorange="reversed")


# Depth-guide styling. Subtle gray lines + slightly stronger labels so the
# guides read as background context — the data points should remain the
# visual focus. `dash="dot"` distinguishes layer boundaries from a chart's
# normal axis gridlines (solid).
_DEPTH_LINE_COLOR = "rgba(120, 120, 120, 0.45)"
_DEPTH_LABEL_COLOR = "rgba(120, 120, 120, 0.95)"


def _target_oriented_position(
    nq: NeuronQuery, spatial_provider
) -> dict[str, float] | None:
    """Compute the target (root) neuron's soma position in oriented coords.

    Returns `{soma_depth, soma_x, soma_z}` (all µm) or None when either the
    soma position isn't available (soma table missing / target not in the
    soma table) or the provider doesn't expose an oriented frame. Callers
    degrade silently — the marker is a nicety, not load-bearing.

    Delegates to the provider's `target_oriented_position` when available
    (cortex defines one); other providers don't have a depth/tangential
    triple, so the marker isn't rendered for them.
    """
    target_fn = getattr(spatial_provider, "target_oriented_position", None)
    if target_fn is None:
        return None
    pos = nq.soma_summary().get("soma_pt_position")
    if pos is None:
        return None
    return target_fn(pos)


# Reference-marker styling for the cell-position glyph. Black on light
# backgrounds, semi-transparent so it reads as a guide rather than a
# data point. `circle-open` keeps the inside transparent so it doesn't
# obscure data points sitting at the same coordinate.
_CELL_MARKER_COLOR = "rgba(0, 0, 0, 0.85)"
_CELL_MARKER_SIZE = 14
_CELL_MARKER_LINE_WIDTH = 1.2


def _axis_target_value(
    col: str | None, target_pos: dict[str, float] | None
) -> tuple[float | None, str | None]:
    """Return `(value, kind)` for a bound axis when the target neuron has
    an analogue in the oriented frame.

    `kind` is the column family — `"depth"` for any depth-shaped column
    (`soma_depth`, `median_syn_depth_out`, ...), `"soma_x"` / `"soma_z"`
    for the tangential axes. Used by the marker code to label its hover
    string and by the SPA-side gate to decide whether to show the toggle.

    Decoration columns (`<table>.<col>`) are stripped to their bare name
    before classification — same convention as `_is_depth_column`.
    """
    if not col or not target_pos:
        return None, None
    bare = col.rsplit(".", 1)[-1]
    if _is_depth_column(bare):
        return target_pos["soma_depth"], "depth"
    if bare == "soma_x":
        return target_pos["soma_x"], "soma_x"
    if bare == "soma_z":
        return target_pos["soma_z"], "soma_z"
    return None, None


def _apply_cell_position_marker(
    fig: go.Figure,
    spec: PlotSpec,
    target_pos: dict[str, float] | None,
) -> None:
    """Annotate the chart with the target neuron's own location.

    Per axis, classifies the bound column against the cell's oriented
    coords:
      - depth-shaped (`soma_depth`, `median_syn_depth_*`) → cell's soma_depth
      - `soma_x` → cell's soma_x
      - `soma_z` → cell's soma_z

    Then:
      - **Both axes mappable** → single open black circle at the target's
        coordinate. For an `soma_x` × `soma_z` scatter this marks the
        cell's actual position in the cortex-flat plane; for a
        `soma_depth` × `median_syn_depth_out` scatter it sits on the
        diagonal at (target_depth, target_depth) and reads as a depth
        reference rather than a topographic location (per the SPA
        tooltip on the toggle).
      - **One axis mappable** → thin black dashed line at the target's
        value on that axis (hline if y is the spatial axis, vline if x).
      - **Neither** → no-op.

    No-op when `target_pos` is None. Lines / markers live on
    `layer="below"` so data traces remain the visual focus.
    """
    if target_pos is None:
        return
    x_val, x_kind = _axis_target_value(spec.x, target_pos)
    y_val, y_kind = _axis_target_value(spec.y, target_pos)
    if x_val is None and y_val is None:
        return

    if x_val is not None and y_val is not None:
        # Both axes spatial. Open circle keeps the glyph from obscuring
        # data points at the same coordinate. Hover names the axes —
        # cleaner than the raw values alone, especially for the diagonal
        # case where the two coords numerically equal each other.
        fig.add_trace(go.Scatter(
            x=[x_val],
            y=[y_val],
            mode="markers",
            marker={
                "symbol": "circle-open",
                "size": _CELL_MARKER_SIZE,
                "color": _CELL_MARKER_COLOR,
                "line": {"width": _CELL_MARKER_LINE_WIDTH, "color": _CELL_MARKER_COLOR},
            },
            name="cell soma",
            showlegend=False,
            hovertemplate=(
                f"cell soma<br>{x_kind}: {x_val:.1f}<br>{y_kind}: {y_val:.1f}<extra></extra>"
            ),
        ))
        return

    line_kwargs = dict(
        color=_CELL_MARKER_COLOR,
        width=_CELL_MARKER_LINE_WIDTH,
        dash="dash",
    )
    if y_val is not None:
        fig.add_hline(y=y_val, line=line_kwargs, layer="below")
    else:
        fig.add_vline(x=x_val, line=line_kwargs, layer="below")


def _apply_depth_guides(
    fig: go.Figure,
    spec: PlotSpec,
    depth_range: list[float] | None,
    layer_boundaries: list[float] | None,
    layer_names: list[str] | None,
) -> None:
    """Per-datastack background guides on depth-axis plots. Two effects:

    1. **Range fix.** When `depth_range` is set, the depth axis (whichever
       of x or y is bound to a depth-shaped column) is pinned to that
       range — different neurons / different mat versions render in a
       shared coordinate system instead of each chart auto-fitting its
       own data extent.
    2. **Layer guides.** Each value in `layer_boundaries` becomes a
       dotted background line on the depth axis; `layer_names` (if
       supplied) annotates the regions between boundaries with
       cortical-layer labels (L1 / L2/3 / L4 / ...).

    No-op when both `depth_range` and `layer_boundaries` are absent, or
    when neither axis is bound to a depth column. Y-axis depth and x-axis
    depth are handled symmetrically — though the `_maybe_flip_depth` flip
    only applies on the y side, the range-pin here reverses the y-axis
    range tuple to preserve pia-on-top, and overrides any prior
    `autorange="reversed"`.
    """
    if not depth_range and not layer_boundaries:
        return
    x_is_depth = _is_depth_column(spec.x)
    y_is_depth = _is_depth_column(spec.y)
    if not x_is_depth and not y_is_depth:
        return

    # Build per-axis update dicts. `showgrid=False` + `zeroline=False`
    # suppress the default tick gridlines on the depth axis — the dotted
    # layer-boundary lines below serve the same "horizontal reference"
    # role, so leaving the regular grid on creates two parallel sets of
    # near-horizontal lines that read as visual noise. Tick labels stay
    # so the numeric scale remains readable.
    #
    # Range pin. y-axis range tuple is reversed (`[hi, lo]`) so plotly
    # renders pia at top while overriding any prior `autorange="reversed"`
    # — setting `range` already overrides autorange in plotly, but we
    # also pass `autorange=False` to be explicit.
    y_update: dict = {"showgrid": False, "zeroline": False}
    x_update: dict = {"showgrid": False, "zeroline": False}
    if depth_range and len(depth_range) == 2:
        lo, hi = float(depth_range[0]), float(depth_range[1])
        if y_is_depth:
            y_update["range"] = [hi, lo]
            y_update["autorange"] = False
        if x_is_depth:
            x_update["range"] = [lo, hi]
            x_update["autorange"] = False
    if y_is_depth:
        fig.update_yaxes(**y_update)
    if x_is_depth:
        fig.update_xaxes(**x_update)

    # Boundary lines. `layer="below"` puts them behind data traces so
    # bars / strips / scatter dots remain the visual focus.
    if layer_boundaries:
        for boundary in layer_boundaries:
            if y_is_depth:
                fig.add_hline(
                    y=float(boundary),
                    line=dict(color=_DEPTH_LINE_COLOR, width=1, dash="dot"),
                    layer="below",
                )
            if x_is_depth:
                fig.add_vline(
                    x=float(boundary),
                    line=dict(color=_DEPTH_LINE_COLOR, width=1, dash="dot"),
                    layer="below",
                )

    # Layer-name annotations at each region's midpoint. Only meaningful
    # when both `depth_range` (to bound the first/last region) and
    # `layer_names` are supplied. `layer_names[i]` labels the region
    # whose bottom is `layer_boundaries[i]`; trailing regions without a
    # name (e.g. white matter below L6) are simply unlabeled.
    if depth_range and layer_boundaries and layer_names:
        edges = [float(depth_range[0])] + [float(b) for b in layer_boundaries] + [float(depth_range[1])]
        for i, name in enumerate(layer_names):
            if i + 1 >= len(edges):
                break
            top, bottom = edges[i], edges[i + 1]
            mid = (top + bottom) / 2.0
            if y_is_depth:
                fig.add_annotation(
                    xref="paper", yref="y",
                    x=0.005, y=mid,
                    text=name, showarrow=False,
                    font=dict(size=10, color=_DEPTH_LABEL_COLOR),
                    xanchor="left", yanchor="middle",
                )
            elif x_is_depth:
                fig.add_annotation(
                    xref="x", yref="paper",
                    x=mid, y=0.99,
                    text=name, showarrow=False,
                    font=dict(size=10, color=_DEPTH_LABEL_COLOR),
                    xanchor="center", yanchor="top",
                )


# --- unified frame + direction-scope helpers ---------------------------------

# Direction-class values written into the synthetic `direction` column on the
# unified frame. The SPA exposes this as a hue-bind option so the user can
# color points by which side of the connection the partner sits on. Labels
# match the panel's scope picker terminology — `in only` / `out only` are
# the strict-single-direction buckets, `reciprocal` is the both-direction
# bucket. With the panel scope set to `both` (no row filter), binding hue
# to `direction` reproduces the per-axis scope distinction in color rather
# than as a row filter.
_DIRECTION_IN_ONLY = "in only"      # n_syn_in > 0, n_syn_out == 0
_DIRECTION_OUT_ONLY = "out only"    # n_syn_out > 0, n_syn_in == 0
_DIRECTION_RECIP = "reciprocal"     # both > 0


def _direction_class(row) -> str:
    has_in = (row.get("n_syn_in") or 0) > 0
    has_out = (row.get("n_syn_out") or 0) > 0
    if has_in and has_out:
        return _DIRECTION_RECIP
    if has_in:
        return _DIRECTION_IN_ONLY
    return _DIRECTION_OUT_ONLY


def _apply_scope_filter(df: pd.DataFrame, scope: str) -> pd.DataFrame:
    """Filter the unified frame by panel-level direction scope.

    `scope`:
      - "input"      → rows where the partner gives input (`n_syn_in > 0`).
                       Loose: includes reciprocal partners.
      - "output"     → rows where the partner receives output (`n_syn_out > 0`).
                       Loose: includes reciprocal partners.
      - "reciprocal" → strict intersection (`n_syn_in > 0 AND n_syn_out > 0`).
                       Equivalent to the legacy `x_scope=post + y_scope=pre`
                       composition, but explicit.
      - "both"       → no filter (the canonical population — every partner).

    The reason "both" and "reciprocal" are distinct: with `direction` bound
    to hue, "both" gives the population view colored by direction class;
    "reciprocal" zooms in on the reciprocal subset alone.
    """
    if scope == "input":
        return df[df["n_syn_in"].fillna(0) > 0]
    if scope == "output":
        return df[df["n_syn_out"].fillna(0) > 0]
    if scope == "reciprocal":
        return df[(df["n_syn_in"].fillna(0) > 0) & (df["n_syn_out"].fillna(0) > 0)]
    return df


def _build_unified_frame(nq: NeuronQuery) -> pd.DataFrame:
    """Mirror the SPA's `unifyPartners` server-side: one row per unique
    partner root_id, `num_syn` split into `n_syn_in` / `n_syn_out`, and each
    `synapse_aggregation_rules` column split into `<name>_in` / `<name>_out`
    with null in the missing direction.

    Lets dynamic plots reach across both directions on a single row — e.g.
    scatter `n_syn_in` vs `n_syn_out` with `hue = cell_type` to find
    reciprocal partners stratified by class.

    Implementation note: a vectorized outer merge on `root_id`. Earlier
    versions iterated `pout`/`pin` row-by-row (`iterrows()`) which scaled
    poorly — at 5K partners the per-request cost was tens of ms, at 20K
    seconds. The merge is O(n) in C; rule columns left as NaN where the
    partner is missing in that direction (`pd.merge` semantics) match the
    SPA-side unifier (`unify.ts:48,76`), since averages of nothing are
    not zero.
    """
    pin = nq.partners_in()
    pout = nq.partners_out()
    rule_names = list(nq.synapse_aggregation_rules.keys())

    if pin.empty and pout.empty:
        return pd.DataFrame(columns=["root_id", "n_syn_out", "n_syn_in"])

    def _renamed(df: pd.DataFrame, suffix: str) -> pd.DataFrame:
        # Map raw partner-frame columns to the unified frame's
        # direction-suffixed names. Drops any unrelated columns so the
        # merge doesn't pull in stragglers from upstream changes.
        rename_map = {"num_syn": f"n_syn_{suffix}"}
        for name in rule_names:
            if name in df.columns:
                rename_map[name] = f"{name}_{suffix}"
        keep = ["root_id"] + [rename_map[k] for k in rename_map]
        return df.rename(columns=rename_map)[keep]

    if pout.empty:
        merged = _renamed(pin, "in").copy()
        merged["n_syn_out"] = 0
        for name in rule_names:
            merged[f"{name}_out"] = pd.NA
    elif pin.empty:
        merged = _renamed(pout, "out").copy()
        merged["n_syn_in"] = 0
        for name in rule_names:
            merged[f"{name}_in"] = pd.NA
    else:
        merged = pd.merge(
            _renamed(pout, "out"),
            _renamed(pin, "in"),
            on="root_id",
            how="outer",
        )
        # Synapse counts get a real 0 (the partner exists but contributes
        # zero synapses on this side); rule columns stay NaN.
        merged["n_syn_out"] = merged["n_syn_out"].fillna(0)
        merged["n_syn_in"] = merged["n_syn_in"].fillna(0)

    merged["n_syn_out"] = merged["n_syn_out"].astype(int)
    merged["n_syn_in"] = merged["n_syn_in"].astype(int)
    merged["root_id"] = merged["root_id"].astype(int)
    return merged.reset_index(drop=True)


# ----- resolver ---------------------------------------------------------------

def resolve_plot(
    *,
    spec: PlotSpec,
    nq: NeuronQuery,
    decoration_tables: list[str] | None,
    column_override: str | None,
    bindings: dict[str, str | None] | None = None,
    client_factory,
    spatial_provider=None,
    cell_filters: list[CellFilter] | None = None,
    show_cell_depth: bool = True,
) -> dict:
    """Materialize `spec.data_query` against `nq` (with optional decoration),
    dispatch to the kind-specific builder, return Plotly figure JSON.

    Two override paths:
      - Legacy `column_override` — drops onto `spec.x` (single-axis column-
        bound plots).
      - `bindings: {x?, y?, hue?, size?, weight?}` — preferred. For dynamic
        specs (`spec.dynamic=True`), `kind` auto-resolves from bound axes:
        x AND y → scatter; one axis with non-numeric x or weight bound →
        bar; one axis with numeric x and no weight → histogram. Static specs
        still use their declared kind; bindings just override the channels.

    `bindings` wins when present; `column_override` is honored only when
    `bindings` doesn't supply an `x`. This keeps existing callers working.
    """
    if spec.data_query.source == "partners_in":
        df = nq.partners_in().copy()
    elif spec.data_query.source == "partners_out":
        df = nq.partners_out().copy()
    else:  # partners_both — unified frame spanning both directions
        with timer("build_unified_frame"):
            df = _build_unified_frame(nq)
        # Synthetic 'direction' column on the unified frame so the SPA can
        # bind hue to it; values are the direction-class buckets ('in only',
        # 'out only', 'reciprocal'). With panel scope=both, this lets the
        # user split a single chart by direction visually.
        if not df.empty:
            df["direction"] = df.apply(_direction_class, axis=1)

    # Merge legacy + new override paths into a single bindings map.
    bindings = bindings or {}
    bound = {
        "x": bindings.get("x") if bindings.get("x") is not None else (column_override or spec.x),
        "y": bindings.get("y") if bindings.get("y") is not None else spec.y,
        "hue": bindings.get("hue") if bindings.get("hue") is not None else _resolve_hue(spec),
        "size": bindings.get("size") if bindings.get("size") is not None else spec.size,
        "weight": bindings.get("weight") if bindings.get("weight") is not None else spec.weight,
    }
    # Panel-level scope filter (only meaningful on the unified frame). One
    # picker per panel applied uniformly to every channel, instead of the
    # legacy per-axis pair (x_scope + y_scope) that AND-composed:
    #   - "input"      — rows where the partner gives input (loose).
    #   - "output"     — rows where the partner receives output (loose).
    #   - "reciprocal" — strict intersection (both directions present).
    #   - "both"       — no filter; binding `hue=direction` recovers the
    #                    direction split visually on a single chart.
    scope = (bindings.get("scope") or "both") if bindings else "both"
    if spec.data_query.source == "partners_both" and not df.empty:
        df = _apply_scope_filter(df, scope)
    # Kind auto-pick for dynamic specs is deferred until after the decoration
    # merge — we need to know whether `bound["x"]` is numeric on the resolved
    # frame to choose between histogram (numeric x → bin & count) and bar
    # (categorical x → discrete groups). Static specs keep their declared kind.
    spec = spec.model_copy(update={
        "x": bound["x"],
        "y": bound["y"],
        "hue": bound["hue"],
        "size": bound["size"],
        "weight": bound["weight"],
        "color": None,  # consumed; resolver works off `hue` now.
    })

    # Auto-extend decoration_tables to cover every table referenced by a cell
    # filter — the user's intent is "filter by these columns", they shouldn't
    # also have to remember to load the table.
    cell_filters = cell_filters or []
    decoration_tables = list(decoration_tables or [])
    for f in cell_filters:
        if f.table not in decoration_tables:
            decoration_tables.append(f.table)

    served: dict[int, dict] = {}
    needs_decoration = bool(nq.soma_table or decoration_tables)
    if needs_decoration:
        from .decoration import lookup_decorations
        # Pass the datastack's soma_table so num_soma / cell_id columns are
        # available as bar-plot grouping targets. The SWR + warmup machinery
        # means the second request hits the cached soma snapshot instantly.
        with timer("lookup_decorations"):
            served, _groups, _reval = lookup_decorations(
                client_factory=client_factory,
                ds=nq.datastack,
                mat_version=nq.mat_version,
                soma_table=nq.soma_table,
                soma_root_id_column=nq.soma_root_id_column,
                root_ids=df["root_id"].astype(int).tolist(),
                decoration_tables=decoration_tables or [],
            )
        # Each served record's keys are namespaced as `<table>.<col>` for
        # decoration_tables and bare for the soma group (`num_soma`, `cell_id`).
        # Materialize them as columns.
        # `pt_position` is internal scaffolding for the spatial computation
        # below — drop it from the column materialization so it doesn't leak
        # into the figure as an array-valued column.
        # The materialization is one root-id-keyed `.map(...)` per attached
        # column; cheap each but with 20+ decoration columns × 5K partners
        # the loop has shown up as a multi-hundred-ms tail. Timed so it's
        # visible in the request log.
        if served:
            with timer("attach_decoration_columns"):
                all_keys: set[str] = set()
                for rec in served.values():
                    all_keys.update(rec.keys())
                all_keys.discard("pt_position")
                for k in all_keys:
                    df[k] = df["root_id"].astype(int).map(
                        lambda rid, _k=k: served.get(rid, {}).get(_k)
                    )

    # Apply cell filters AFTER decoration columns are materialized — predicates
    # reference `<table>.<col>` which only exists post-merge. Stash the pre/post
    # counts so the SPA can show "N / M cells" under the analytics rail.
    pre_filter_count = int(len(df))
    if cell_filters:
        with timer("apply_cell_filters"):
            df = _apply_cell_filters(df, cell_filters)
    matched_count = int(len(df))

    # Spatial features via the SpatialProvider. The bundle assembler in
    # connectivity.py applies the same logic; here we mirror it onto the
    # plot frame. Median dist (plain Euclidean, no frame required) is
    # computed directly; everything else flows through the provider.
    if served:
        from .neuron import _compute_median_dist_to_target_soma, _partner_soma_positions
        from .spatial import build_spatial_provider, compute_spatial_features_cached

        if spatial_provider is None:
            from types import SimpleNamespace
            spatial_provider = build_spatial_provider(
                SimpleNamespace(provider="null", provider_module=None, params={})
            )
        root_soma = nq.soma_summary().get("soma_pt_position")
        source = spec.data_query.source
        want_in = source in ("partners_in", "partners_both")
        want_out = source in ("partners_out", "partners_both")

        # `median_dist_to_target_soma` — plain Euclidean, frame-independent.
        partner_soma_positions = _partner_soma_positions(spatial_provider, served)
        median_dist_in, median_dist_out = _compute_median_dist_to_target_soma(
            nq=nq,
            partner_soma_positions=partner_soma_positions,
            root_soma_position_nm=root_soma,
            need_in=want_in, need_out=want_out,
        )

        # Provider-driven features — cached helper computes BOTH directions
        # (cheap; synapse dfs are cached) so the cache entry is reusable
        # across plot panels with different `source` values. After the
        # connectivity endpoint warms it, every plot-panel request on this
        # neuron skips the ~1.2s numpy compute.
        spatial_features = compute_spatial_features_cached(
            nq=nq,
            provider=spatial_provider,
            decoration_lookup=served,
            root_soma_position_nm=root_soma,
        )

        # Spatial feature columns: one `.map` per (column, direction).
        # ~5–10 columns × up-to-2 directions × 5K partners — usually under
        # 100ms, but worth surfacing so a regression here is visible
        # rather than disappearing into `processing_ms`.
        with timer("attach_spatial_columns"):
            manifest = list(spatial_provider.feature_manifest())
            intrinsic_specs = [s for s in manifest if s.scope == "partner_intrinsic"]
            per_direction_specs = [s for s in manifest if s.scope == "partner_per_direction"]

            # Intrinsic columns: same value for both directions.
            for spec_entry in intrinsic_specs:
                col = spec_entry.name
                df[col] = df["root_id"].astype(int).map(
                    lambda rid, _c=col: spatial_features.intrinsic.get(rid, {}).get(_c)
                )

            # Per-direction columns. Mirror the SPA's unified-table schema: on
            # `partners_both` they appear as `<col>_in` / `<col>_out`; on a
            # single-direction source they appear as plain `<col>`.
            def _attach_per_direction(col_name: str, lookup_in: dict, lookup_out: dict) -> None:
                if source == "partners_both":
                    if lookup_in:
                        df[f"{col_name}_in"] = df["root_id"].astype(int).map(
                            lambda rid, _l=lookup_in: _l.get(rid)
                        )
                    if lookup_out:
                        df[f"{col_name}_out"] = df["root_id"].astype(int).map(
                            lambda rid, _l=lookup_out: _l.get(rid)
                        )
                else:
                    lookup = lookup_in if source == "partners_in" else lookup_out
                    if lookup:
                        df[col_name] = df["root_id"].astype(int).map(
                            lambda rid, _l=lookup: _l.get(rid)
                        )

            _attach_per_direction(
                "median_dist_to_target_soma",
                median_dist_in if want_in else {},
                median_dist_out if want_out else {},
            )
            for spec_entry in per_direction_specs:
                in_lookup = spatial_features.per_direction_in.get(spec_entry.name, {}) if want_in else {}
                out_lookup = spatial_features.per_direction_out.get(spec_entry.name, {}) if want_out else {}
                _attach_per_direction(spec_entry.name, in_lookup, out_lookup)

    # Dynamic kind dispatch happens here (post-decoration-merge) so we can
    # inspect dtypes on the resolved frame:
    #   - x AND y, x categorical, y numeric → stripplot (one jittered cloud
    #     per x bucket; same x-axis ordering as bar so views align)
    #   - x AND y, both numeric (or both categorical) → scatter
    #   - x only, x non-numeric or weight bound → bar
    #   - x only, x numeric, no weight → histogram
    #   - y only → histogram
    if spec.dynamic:
        has_x = spec.x is not None
        has_y = spec.y is not None
        has_weight = spec.weight is not None
        if has_x and has_y:
            x_series = df[spec.x] if spec.x in df.columns else None
            y_series = df[spec.y] if spec.y in df.columns else None
            x_is_numeric = x_series is not None and pd.api.types.is_numeric_dtype(x_series)
            y_is_numeric = y_series is not None and pd.api.types.is_numeric_dtype(y_series)
            # Categorical x + numeric y is the stripplot signature. The
            # reverse (numeric x + categorical y) falls through to scatter
            # for now — if it turns out to be a common ask, swapping to a
            # horizontal stripplot is a one-line change.
            chosen = "stripplot" if (not x_is_numeric and y_is_numeric) else "scatter"
        elif has_x and not has_y:
            x_series = df[spec.x] if spec.x in df.columns else None
            x_is_numeric = x_series is not None and pd.api.types.is_numeric_dtype(x_series)
            chosen = "bar" if (not x_is_numeric or has_weight) else "histogram"
        elif has_y and not has_x:
            chosen = "histogram"
        else:
            raise ValueError(
                "dynamic plot needs at least one of `x` or `y` bound — pick a column."
            )
        spec = spec.model_copy(update={"kind": chosen})

    # Universe lookup helper. Returns the cached list of distinct values for
    # `col` when (a) the column exists on the resolved frame, (b) it's
    # categorical, and (c) provenance traces to a cell-type / decoration
    # table. Returns None for intrinsic / synthetic / numeric columns —
    # those fall through to plotly's default colorway and to observed-only
    # x-axis ordering.
    def _column_universe(col: str | None) -> list | None:
        if not col or col not in df.columns:
            return None
        if pd.api.types.is_numeric_dtype(df[col]):
            return None
        table, bare = _provenance_for(col)
        if not table:
            return None
        universe = get_unique_values(
            client_factory=client_factory,
            ds=nq.datastack,
            mat_version=nq.mat_version,
            table=table,
            column=bare,
        )
        return universe or None

    hue_universe = _column_universe(spec.hue)
    # Stash on spec only for kinds where the x-axis is categorical and the
    # builder honors `spec.x_universe` (true-zero rendering on bar / strip).
    x_universe = (
        _column_universe(spec.x) if spec.kind in ("bar", "stripplot") else None
    )

    # Universe-pinned color map. Hue wins when both x and hue are categorical
    # and traceable — that's the conventional plotly convention (hue drives
    # color). Without hue, bar and stripplot fall back to coloring by the x
    # bucket so cell-type colors stay consistent with a hue-driven plot of
    # the same column elsewhere on the rail.
    color_map = None
    if hue_universe:
        color_map = resolve_categorical_color_map(
            universe=hue_universe,
            observed=df[spec.hue].dropna().unique().tolist(),
        )
    elif x_universe and not spec.hue:
        color_map = resolve_categorical_color_map(
            universe=x_universe,
            observed=df[spec.x].dropna().unique().tolist(),
        )
    spec = spec.model_copy(update={"color_map": color_map, "x_universe": x_universe})

    # Bound axes that can't render → placeholder figure, not a red 422.
    # Two cases handled symmetrically:
    #   - column missing from the frame (per-direction spatial features
    #     skip attachment when no partner has a value, decoration tables
    #     that didn't load).
    #   - column present but every partner's value is null.
    # Hue / size graceful-degrade above; only x / y are panel-fatal so
    # they get the placeholder treatment.
    placeholder_msg: str | None = None
    for ch in ("x", "y"):
        col = getattr(spec, ch)
        if not col:
            continue
        if col not in df.columns:
            placeholder_msg = (
                f"No data — '{_format_label(col)}' isn't available for this neuron."
            )
            break
        if len(df) > 0 and df[col].isna().all():
            placeholder_msg = (
                f"No data — every partner has a null '{_format_label(col)}' here."
            )
            break
    if placeholder_msg is not None:
        fig = _empty_figure_with_message(placeholder_msg)
        _apply_layout(fig, spec.layout)
        return {
            "figure": json.loads(fig.to_json()),
            "meta": {
                "matched_count": matched_count,
                "pre_filter_count": pre_filter_count,
                "filtered": bool(cell_filters),
                "placeholder": True,
            },
        }
    # Hue / size gracefully degrade when missing: drop the binding so the
    # chart still renders (no color split / fixed marker size) instead of
    # 422-ing the request. Common case: a preset binds `hue=cell_type`
    # but no cell-type table is loaded for this datastack — the SPA-side
    # presets.ts comment at STATIC_PLOT_PRESETS already documents this
    # as the intended degrade behavior; this enforces it server-side too.
    for ch in ("hue", "size"):
        col = getattr(spec, ch)
        if col and col not in df.columns:
            spec = spec.model_copy(update={ch: None})
    # Histogram needs *something* to bin; scatter and stripplot need both
    # axes; bar needs at least x.
    if spec.kind == "histogram" and not (spec.x or spec.y):
        raise ValueError("histogram needs `x` or `y` bound.")
    if spec.kind == "scatter" and (spec.x is None or spec.y is None):
        raise ValueError("scatter plot requires both `x` and `y` bound.")
    if spec.kind == "stripplot" and (spec.x is None or spec.y is None):
        raise ValueError("stripplot requires both `x` and `y` bound.")
    if spec.kind == "bar" and not spec.x:
        raise ValueError("bar plot requires `x` bound.")

    builder = _BUILDERS.get(spec.kind)
    if builder is None:
        raise ValueError(f"Unknown plot kind: {spec.kind!r}")
    with timer(f"plot_builder[{spec.kind}]"):
        fig = builder(df, spec)
    # Layout / depth-guide / cell-marker pass. Each step is small, but a
    # bare `to_json` on a stripplot with thousands of points has been
    # observed in the 100–300ms range, and the depth-guide annotations
    # alone scale with layer count. Wrapping the whole post-build phase
    # surfaces it as `plot_finalize` so the residual in `processing_ms`
    # actually corresponds to framework + I/O overhead.
    with timer("plot_finalize"):
        _apply_layout(fig, spec.layout)
        _apply_auto_titles(fig, spec)
        _maybe_flip_depth(fig, spec)
        # Depth-axis decorations live in `provider.meta()` for cortex; null
        # provider returns an empty meta and the guides become no-ops.
        provider_meta = spatial_provider.meta() if spatial_provider is not None else {}
        _apply_depth_guides(
            fig, spec,
            provider_meta.get("depth_range"),
            provider_meta.get("layer_boundaries"),
            provider_meta.get("layer_names"),
        )
        if show_cell_depth and spatial_provider is not None:
            target_pos = _target_oriented_position(nq, spatial_provider)
            _apply_cell_position_marker(fig, spec, target_pos)
    # Plotly's to_json returns a JSON string; parse it back so Flask jsonify
    # nests it as a real object rather than a quoted string. Timed because
    # plotly's serializer is the long pole on heavy figures (per-point
    # marker arrays, customdata, hovertemplate compilation).
    with timer("plot_to_json"):
        figure_json = json.loads(fig.to_json())
    return {
        "figure": figure_json,
        "meta": {
            "matched_count": matched_count,
            "pre_filter_count": pre_filter_count,
            "filtered": bool(cell_filters),
        },
    }
