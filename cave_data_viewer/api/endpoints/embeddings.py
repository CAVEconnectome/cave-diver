"""Feature Explorer endpoints — foundation slice.

Mounted at ``/api/v1/datastacks/<ds>/feature_tables/...``:

- ``GET  /feature_tables``                              catalog: tables +
                                                        nested embeddings
                                                        + kNN defaults
                                                        + cell_id_source_table.
- ``POST /feature_tables/<ft>/distance_to_set``         universe-aligned
                                                        distances from a seed
                                                        cell-id set. Backs the
                                                        Explorer's similarity-
                                                        based selection growth.
                                                        Spaces: raw / pca /
                                                        mahalanobis (whitened).
- ``POST /feature_tables/<ft>/resolve_roots``           batched cell_id →
                                                        root_id at mat_version.

The plotting + table-rows endpoints land separately:
``services/plots.py`` gains an ``embedding_cells`` data source (served
through the existing ``/plots/<spec>`` machinery), and a sibling
``/feature_tables/<ft>/rows`` endpoint provides table-mode rows.

The auth decorator gates everything at the same boundary as the rest of
the API; ``CDV_DEV_AUTH_BYPASS=1`` covers local dev.

**GET vs POST convention.** Endpoints that may carry a variable-length
``cell_ids`` list (``/cells``, ``/distance_to_set``, ``/resolve_roots``)
are POST so the payload lives in the request body and isn't bounded by
Node's ~8 KB header limit. Endpoints with fixed-size parameter sets
(``/scatter``, ``/column``, ``/column_histogram``) are GET so they
stay CDN-cacheable and benefit from the query-key-based response cache
on the SPA.
"""

from __future__ import annotations

import math
import time
from typing import Any

import numpy as np
import pandas as pd
from flask import Blueprint, current_app, jsonify, request

from ..auth import auth_required, current_token, is_dev_bypass
from ..cave import request_client
from ..errors import ApiError
from ..services.datastack_config import check_live_allowed, load_datastack_config
from ..services.cell_id import root_ids_to_cell_ids
from ..services.embeddings import (
    EmbeddingSpec,
    FeatureTableQuery,
    FeatureTableSpec,
    effective_datastacks,
    load_feature_table_frame,
    resolve_cell_ids_to_root_ids,
    source_for,
)
from ..services.embeddings.column_histogram import (
    compute_categorical_histogram,
    compute_numeric_histogram,
    histogram_to_json,
)
from ..services.embeddings.distance import compute_distance_to_set
from ..services.embeddings.feature_matrix import get_matrix
from ..services.embeddings.pca import get_pca_svd, resolve_k_for_variance
from ..services.embeddings.loader import SOURCE_DS_COLUMN
from ..services.categorical import (
    get_unique_values as _categorical_get_unique_values,
    resolve_categorical_color_map,
)
from ..services.neuron import suggest_current_roots
from ..services.plots import _apply_cell_filters, _parse_cells_param
from ..services.timing import record_stage, timer


# Distance-to-set seed cap. The nearest/mean reductions allocate a
# pairwise (chunk, S, D) intermediate per chunk, so keeping S small
# bounds per-request transient memory predictably regardless of
# universe size. Distinct from the per-chunk universe slice cap in
# services/embeddings/distance.py; this is the user-facing API limit.
_MAX_SEED_CELL_IDS = 20

# Top-K truncation on /distance_to_set responses. The default is set
# high enough to ship the entire universe for every public connectome
# we know about (minnie65 ~94k, FlyWire ~140k); the SPA's elbow plot,
# Select/Add actions, and synthetic ``__distance`` column all want the
# full distribution, and a 100k-float payload is ~600 KB gzipped — not
# worth the bookkeeping of a partial response. The ceiling stays in
# place as a sanity guard against a future dataset blowing up wire
# costs unexpectedly, and against buggy clients explicitly requesting
# a billion rows.
_DEFAULT_DISTANCE_LIMIT = 200000
_MAX_DISTANCE_LIMIT = 1000000


def _stringify_cell_ids(frame: pd.DataFrame) -> list[str]:
    """Wire-shape cell_id rendering: int64 column → list[str].

    Cell ids exceed JS Number precision (2**53), so the SPA expects them
    as strings end-to-end. Every endpoint that emits a parallel arrays
    payload routes through here for consistency.
    """
    return [str(int(c)) for c in frame["cell_id"].tolist()]


def _make_client_factory(ds: str, mat_version: int | str | None):
    """Build the lazy CAVE-client closure every embeddings endpoint uses.

    The closure isn't invoked until something downstream actually needs
    a CAVE call (decoration join, nucleus position enrichment, etc.).
    Parquet-only request paths never construct a client.
    """
    def _client_factory():
        return request_client(
            datastack_name=ds,
            server_address=current_app.config["GLOBAL_SERVER_ADDRESS"],
            auth_token=current_token(),
            dev_bypass=is_dev_bypass(),
            materialize_version=mat_version,
        )
    return _client_factory


def _load_universe_frame(
    *,
    ds: str,
    cfg,
    ft: FeatureTableSpec,
    mat_version: int | str | None,
    decoration_tables: list[str],
    client_factory,
) -> pd.DataFrame:
    """Universe frame for one feature table at one mat_version.

    Builds a :class:`FeatureTableQuery` and returns ``ft_query.frame()``
    with the requested decoration tables joined. Every endpoint that
    operates on the per-feature-table frame (``/scatter``, ``/column``,
    ``/cells``, ``/column_histogram``) routes through here so the
    request_client wiring and decoration-tables coercion live in one
    place.
    """
    ft_query = FeatureTableQuery(
        datastack=ds,
        mat_version=mat_version,
        feature_table=ft,
        cfg=cfg,
        client_factory=client_factory,
    )
    return ft_query.frame(decoration_tables=decoration_tables or None)


def _scale_size_rank(
    values: pd.Series, *, lo_px: float = 2.0, hi_px: float = 18.0
) -> pd.Series:
    """Percentile-rank scaling to ``[lo_px, hi_px]``.

    Each row's size is its rank position in the sorted distribution,
    mapped linearly into the px range. Uniform visual spread regardless
    of the source distribution's shape — long-tailed features
    (soma_volume_um, etc.) get the same visual fidelity as roughly-
    uniform ones (depth, etc.).

    Ties get the average rank (pandas' default). NaN / non-numeric
    rows fall to ``lo_px`` so they're visible-but-deprioritized.
    """
    s = pd.to_numeric(values, errors="coerce")
    if s.notna().sum() == 0:
        return pd.Series([hi_px] * len(values), index=values.index)
    ranks = s.rank(method="average", pct=True)
    # NaN ranks → smallest size so the user sees they're there but
    # they don't visually compete with valid data.
    ranks = ranks.fillna(0.0)
    return ranks * (hi_px - lo_px) + lo_px

bp = Blueprint("embeddings", __name__, url_prefix="/datastacks")


@bp.route("/<ds>/feature_tables", methods=["GET"])
@auth_required
def list_feature_tables(ds: str):
    """List the feature tables (with their nested embeddings) for one datastack.

    Always returns 200 with an ``enabled`` flag — the SPA switches the
    /explore route on this flag rather than guessing from a 404. When the
    feature explorer is disabled or unconfigured for the datastack, only
    ``enabled: false`` is set.
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        return jsonify({"enabled": False})

    try:
        manifest = src.list()
    except ValueError as exc:
        raise ApiError(
            502,
            "manifest_unavailable",
            f"could not load feature explorer manifest: {exc}",
        ) from exc

    # ``datastacks`` is now per-feature-table (v1 schema). Aggregate the
    # union across all loaded tables so the SPA still gets one catalog-
    # level list; falls back to ``[ds]`` when no table declares any.
    # First-occurrence wins for the per-datastack cell_id_source_table
    # override (consistent with the rest of the registry's first-wins
    # duplicate-handling).
    declared_by_name: dict[str, str | None] = {}
    for ft in manifest.feature_tables:
        for entry in effective_datastacks(ft, ds):
            if entry.name not in declared_by_name:
                declared_by_name[entry.name] = entry.cell_id_source_table
    if not declared_by_name:
        declared_by_name = {ds: None}
    return jsonify(
        {
            "enabled": True,
            "cell_id_source_table": cfg.feature_explorer.cell_id_source_table,
            "datastacks": [
                {"name": name, "cell_id_source_table": cst}
                for name, cst in declared_by_name.items()
            ],
            "feature_tables": [_feature_table_summary(ft) for ft in manifest.feature_tables],
        }
    )


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/embeddings/<embedding_id>/scatter",
    methods=["GET"],
)
@auth_required
def scatter(ds: str, feature_table_id: str, embedding_id: str):
    """Universe scatter payload for one embedding view, with optional
    channel bindings.

    Returns parallel arrays — ``cell_ids`` + the two axis columns the
    user picked (default: the embedding's declared axes) — for *every*
    cell in the parquet. Highlight overlays (``?cells=`` filter result,
    ``?sel_<id>=`` brush, lasso selection) are computed client-side as
    Set<cell_id> intersections over the universe ``cell_ids`` array, no
    extra round-trip per filter change.

    Optional query params override the defaults seaborn-style:

    - ``x``, ``y`` — column to bind to each axis. Bare name resolves to
      a parquet column under the feature_table's prefix
      (``{ft.id}.<col>``); dotted ``<table>.<col>`` resolves to a
      decoration column (the table must appear in ``?dec=``).
    - ``color`` — column to bind to per-point color. Categorical columns
      come back with a stable ``color_map`` derived from the column's
      universe via ``resolve_categorical_color_map`` so the same value
      lands on the same hex in every plot (consistent with /neuron).
      Numeric columns come back with raw values; the SPA picks a
      continuous colorscale.
    - ``size`` — numeric column to bind to per-point size. Server
      pre-scales to a [4, 20] px range via ``_scale_size``.
    - ``dec`` — comma-separated decoration tables to attach. Required
      when any channel references a ``<table>.<col>`` name.
    - ``mv`` — mat_version. Required when any channel references a
      decoration column (drives the cell_id → root_id resolver).

    No CAVE call when channels reference only parquet columns. Backed
    by ``dcv_embedding_frame_cache`` (immutable L1 + L2 GCS), so cold
    pods see a one-time parquet read and every subsequent request is
    dict-fast.

    Response shape::

        {
          "cell_ids": ["12345", ...],
          "x": [1.23, 2.34, ...],
          "y": [-0.12, 4.21, ...],
          "axes": {"x": "<col>", "y": "<col>"},
          "color": null | {
            "column": "<col>",
            "kind": "categorical" | "numeric",
            "values": ["L23_PYR", "L4_PYR", null, ...],
            "color_map": {"L23_PYR": "#1f77b4", ...}  // categorical only
          },
          "size": null | {
            "column": "<col>",
            "values": [4.2, 12.7, 4.0, ...],  // pre-scaled to [4, 20] px
            "raw_range": [min, max]
          },
          "n_cells": 94010
        }

    Cell_ids are stringified at the JSON boundary per the project's
    int64-as-string convention.
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        raise ApiError(
            404,
            "feature_explorer_disabled",
            f"datastack {ds!r} does not enable the feature explorer",
        )

    try:
        ft, emb = src.resolve_embedding(feature_table_id, embedding_id)
    except KeyError as exc:
        raise ApiError(404, "embedding_not_found", str(exc)) from exc

    # Channel + decoration params.
    x_override = request.args.get("x") or None
    y_override = request.args.get("y") or None
    color_col = request.args.get("color") or None
    size_col = request.args.get("size") or None
    mv_raw = request.args.get("mat_version")
    if mv_raw is None or mv_raw == "":
        mat_version: int | str | None = None
    elif mv_raw == "live":
        mat_version = "live"
    else:
        try:
            mat_version = int(mv_raw)
        except ValueError as exc:
            raise ApiError(
                422, "invalid_mat_version",
                f"mat_version must be an integer or 'live', got {mv_raw!r}",
            ) from exc

    decoration_tables: list[str] = []
    dec_raw = request.args.get("dec") or ""
    if dec_raw:
        decoration_tables = [t.strip() for t in dec_raw.split(",") if t.strip()]

    # Defaults for axes: the embedding's declared axes get prefixed with
    # the feature_table id to match the canonical column-naming convention
    # FeatureTableQuery.frame() emits.
    default_x = f"{ft.id}.{emb.axes[0]}"
    default_y = f"{ft.id}.{emb.axes[1]}"
    x_col = x_override or default_x
    y_col = y_override or default_y

    # Auto-extend decoration_tables to cover any channel that references
    # a non-feature-table table. Channels that reference the feature_table
    # itself read from the prefixed parquet columns natively; channels
    # that reference the synthetic `nucleus.*` columns (added by
    # FeatureTableQuery.frame() from the universe cache) are also
    # native — no decoration join needed.
    for col in (x_col, y_col, color_col, size_col):
        if not col:
            continue
        if "." not in col:
            continue
        table = col.split(".", 1)[0]
        if table == ft.id or table == "nucleus":
            continue
        if table not in decoration_tables:
            decoration_tables.append(table)

    if decoration_tables and mat_version is None:
        raise ApiError(
            422,
            "missing_mat_version",
            "mat_version is required when a channel references a "
            "decoration column",
        )
    if decoration_tables:
        try:
            check_live_allowed(ds, mat_version)
        except ValueError as exc:
            raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    client_factory = _make_client_factory(ds, mat_version)
    frame = _load_universe_frame(
        ds=ds,
        cfg=cfg,
        ft=ft,
        mat_version=mat_version,
        decoration_tables=decoration_tables,
        client_factory=client_factory,
    )

    missing = [c for c in (x_col, y_col) if c not in frame.columns]
    for ch in (color_col, size_col):
        if ch and ch not in frame.columns:
            missing.append(ch)
    if missing:
        raise ApiError(
            422,
            "channel_column_missing",
            f"channel references unknown column(s) {missing!r} "
            f"(have {list(frame.columns)})",
        )

    # Channel projections.
    color_block: dict | None = None
    if color_col:
        series = frame[color_col]
        if pd.api.types.is_numeric_dtype(series):
            color_block = {
                "column": color_col,
                "kind": "numeric",
                "values": [
                    None if pd.isna(v) else float(v) for v in series.tolist()
                ],
            }
        else:
            # Categorical: build a stable color_map keyed off the
            # column's universe. Parquet columns have a closed universe
            # we can read directly; decoration columns ask CAVE via the
            # cell_type-colors machinery so the same value lands on the
            # same hex /everywhere/ — explorer scatter, /neuron plots,
            # bar charts in the analytics rail.
            table_name = color_col.split(".", 1)[0] if "." in color_col else None
            bare_col = color_col.split(".", 1)[1] if "." in color_col else color_col
            universe: list[str]
            if table_name == ft.id:
                universe = (
                    series.dropna().astype(str).unique().tolist()
                )
            elif table_name:
                universe = _categorical_get_unique_values(
                    client_factory=client_factory,
                    ds=ds,
                    mat_version=mat_version,
                    table=table_name,
                    column=bare_col,
                )
                if not universe:
                    universe = series.dropna().astype(str).unique().tolist()
            else:
                universe = series.dropna().astype(str).unique().tolist()
            color_map = resolve_categorical_color_map(
                universe=universe,
                observed=series.dropna().tolist(),
            )
            color_block = {
                "column": color_col,
                "kind": "categorical",
                "values": [None if pd.isna(v) else str(v) for v in series.tolist()],
                "color_map": {str(k): v for k, v in color_map.items() if k is not None},
            }

    size_block: dict | None = None
    if size_col:
        series = frame[size_col]
        if not pd.api.types.is_numeric_dtype(series):
            raise ApiError(
                422,
                "channel_size_non_numeric",
                f"size channel {size_col!r} is not numeric "
                f"(dtype={series.dtype}); size only supports numeric columns",
            )
        # Ship raw values + raw_range. The client handles the
        # px-encoding mapping (rank percentile → [size_min, size_max])
        # because (a) the user-controlled size-range slider becomes a
        # free client transform with no refetch, and (b) the summary
        # panel needs raw values to render a meaningful histogram —
        # binning rank-scaled px values would produce a uniform
        # distribution by construction.
        finite = pd.to_numeric(series, errors="coerce").dropna()
        if finite.empty:
            raw_range = [0.0, 0.0]
        else:
            raw_range = [float(finite.min()), float(finite.max())]
        coerced = pd.to_numeric(series, errors="coerce")
        size_block = {
            "column": size_col,
            "values": [
                None if pd.isna(v) else float(v) for v in coerced.tolist()
            ],
            "raw_range": raw_range,
        }

    return jsonify(
        {
            "cell_ids": _stringify_cell_ids(frame),
            # Parallel per-row datastack tag. Uniform on single-ds
            # manifests (every value equals ``ds``); diverges per row
            # on multi-ds manifests. Read by the SPA to route cross-nav
            # back to each cell's home datastack.
            "source_ds": [
                str(v) for v in frame[SOURCE_DS_COLUMN].tolist()
            ],
            "x": [
                None if pd.isna(v) else float(v)
                for v in frame[x_col].tolist()
            ],
            "y": [
                None if pd.isna(v) else float(v)
                for v in frame[y_col].tolist()
            ],
            "axes": {"x": x_col, "y": y_col},
            "color": color_block,
            "size": size_block,
            "n_cells": int(len(frame)),
        }
    )


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/column/<path:column>",
    methods=["GET"],
)
@auth_required
def column(ds: str, feature_table_id: str, column: str):
    """Universe-aligned values for one column.

    Same ``cell_ids`` order as ``/scatter`` so the SPA can index the
    response by position when overlaying with the scatter's selection
    mask or with row-level data from ``/cells``.

    Feeds:
    - **Manual histograms** in the summary panel (universe-vs-selection
      density requires the full universe values, not just the current
      table page).
    - **Differential features** (Welch's t-stat / chi-squared between
      a selection and the complement, computed client-side).
    - **Similarity expansion** (distance-to-set in raw / PCA / UMAP
      space — needs the feature matrix).

    Path-routed ``<path:column>`` so dotted column names
    (``<table>.<col>``) survive without query-string escaping. The
    column must resolve to one of:

    - a parquet column on the active feature table
      (``<feature_table_id>.<col>``),
    - a decoration column (``<table>.<col>`` where ``<table>`` is named
      in ``?dec=`` or auto-attached because the column reference
      requires it),
    - a synthetic nucleus position (``nucleus.x`` / ``nucleus.y`` /
      ``nucleus.z``).

    Query params:
    - ``mat_version`` — required when the column is a decoration or
      nucleus position (those go through the resolver).
    - ``dec`` — comma-separated decoration tables to attach. Auto-
      extended to include the column's table when not listed.

    Response::

        {
          "column": "<resolved column>",
          "kind": "numeric" | "categorical",
          "values": [...],
          "raw_range": [min, max],     // numeric only
          "color_map": {...}            // categorical only — same
                                        //   palette resolution as
                                        //   /scatter
        }

    Backed by the same ``FeatureTableQuery.frame()`` as ``/scatter`` —
    parquet content is immutably cached, decoration joins reuse the
    SWR-cached snapshot, so warm requests are ~ms.
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        raise ApiError(
            404,
            "feature_explorer_disabled",
            f"datastack {ds!r} does not enable the feature explorer",
        )
    try:
        ft = src.resolve_feature_table(feature_table_id)
    except KeyError as exc:
        raise ApiError(404, "feature_table_not_found", str(exc)) from exc

    mv_raw = request.args.get("mat_version")
    mat_version: int | str | None
    if mv_raw is None or mv_raw == "":
        mat_version = None
    elif mv_raw == "live":
        mat_version = "live"
    else:
        try:
            mat_version = int(mv_raw)
        except ValueError as exc:
            raise ApiError(
                422, "invalid_mat_version",
                f"mat_version must be an integer or 'live', got {mv_raw!r}",
            ) from exc

    decoration_tables: list[str] = []
    dec_raw = request.args.get("dec") or ""
    if dec_raw:
        decoration_tables = [t.strip() for t in dec_raw.split(",") if t.strip()]

    # Auto-attach the column's table if it's a decoration reference.
    # Same convention as /scatter — feature_table_id and `nucleus` are
    # native to the frame and don't need a decoration join.
    if "." in column:
        table = column.split(".", 1)[0]
        if table not in (ft.id, "nucleus") and table not in decoration_tables:
            decoration_tables.append(table)

    if decoration_tables and mat_version is None:
        raise ApiError(
            422,
            "missing_mat_version",
            "mat_version is required when the column lives in a "
            "decoration table or synthetic nucleus space",
        )
    if decoration_tables:
        try:
            check_live_allowed(ds, mat_version)
        except ValueError as exc:
            raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    client_factory = _make_client_factory(ds, mat_version)
    frame = _load_universe_frame(
        ds=ds,
        cfg=cfg,
        ft=ft,
        mat_version=mat_version,
        decoration_tables=decoration_tables,
        client_factory=client_factory,
    )

    if column not in frame.columns:
        raise ApiError(
            422,
            "column_not_found",
            f"column {column!r} not present in feature_table frame "
            f"(have {list(frame.columns)[:20]}…)",
        )

    source_ds_values = [str(v) for v in frame[SOURCE_DS_COLUMN].tolist()]
    series = frame[column]
    if pd.api.types.is_numeric_dtype(series):
        coerced = pd.to_numeric(series, errors="coerce")
        finite = coerced.dropna()
        raw_range = (
            [float(finite.min()), float(finite.max())]
            if not finite.empty
            else [0.0, 0.0]
        )
        return jsonify(
            {
                "column": column,
                "kind": "numeric",
                "values": [
                    None if pd.isna(v) else float(v) for v in coerced.tolist()
                ],
                "raw_range": raw_range,
                "cell_ids": _stringify_cell_ids(frame),
                "source_ds": source_ds_values,
                "n_cells": int(len(frame)),
            }
        )

    # Categorical: build the same color_map /scatter does so universe
    # palettes line up everywhere. Parquet columns: universe is the
    # column's distinct values. Decoration columns: ask CAVE for the
    # column's universe so the palette is stable across materializations.
    table_name = column.split(".", 1)[0] if "." in column else None
    bare_col = column.split(".", 1)[1] if "." in column else column
    universe: list[str]
    if table_name == ft.id or table_name is None:
        universe = series.dropna().astype(str).unique().tolist()
    elif table_name == "nucleus":
        # `nucleus.x/y/z` are always numeric — categorical shouldn't
        # arrive here, but degrade gracefully if it does.
        universe = series.dropna().astype(str).unique().tolist()
    else:
        universe = _categorical_get_unique_values(
            client_factory=client_factory,
            ds=ds,
            mat_version=mat_version,
            table=table_name,
            column=bare_col,
        )
        if not universe:
            universe = series.dropna().astype(str).unique().tolist()
    color_map = resolve_categorical_color_map(
        universe=universe,
        observed=series.dropna().tolist(),
    )
    return jsonify(
        {
            "column": column,
            "kind": "categorical",
            "values": [None if pd.isna(v) else str(v) for v in series.tolist()],
            "color_map": {str(k): v for k, v in color_map.items() if k is not None},
            "cell_ids": _stringify_cell_ids(frame),
            "source_ds": source_ds_values,
            "n_cells": int(len(frame)),
        }
    )


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/cells",
    methods=["POST"],
)
@auth_required
def cells(ds: str, feature_table_id: str):
    """Row payload for the explorer's cell-list table.

    Mirrors the partners-frame ``{rows, column_groups}`` shape that
    ``PartnersTable`` consumes, so the same component renders both
    ``/neuron``'s partners and ``/explore``'s cells.

    **POST** rather than GET — the optional ``cell_ids`` field can be a
    list of tens of thousands of ints (large lasso). Carrying that in a
    query string overflows Node's default 8KB request-header limit. Body
    is JSON.

    Body fields (all optional):

    - ``mat_version`` — int or ``"live"``. Required only when ``dec``
      is non-empty (drives the cell_id → root_id resolver).
    - ``dec`` — list of decoration table names to join onto the frame.
    - ``cells`` — filter expression, same syntax as the partners
      endpoints (``<table>.<col>:<op>:<val>[,...]``).
    - ``cell_ids`` — explicit cell_id subset (universe-scatter lasso).
      List of ints or numeric strings. ANDed with the filter expression
      after the frame is built. Empty / absent = no constraint.
    - ``limit`` — server-side cap on returned rows.

    Response shape unchanged from the previous GET version.
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        raise ApiError(
            404,
            "feature_explorer_disabled",
            f"datastack {ds!r} does not enable the feature explorer",
        )
    try:
        ft = src.resolve_feature_table(feature_table_id)
    except KeyError as exc:
        raise ApiError(404, "feature_table_not_found", str(exc)) from exc

    body = request.get_json(silent=True) or {}

    mat_version_raw = body.get("mat_version")
    mat_version: int | str | None
    if mat_version_raw is None or mat_version_raw == "":
        mat_version = None
    elif mat_version_raw == "live":
        mat_version = "live"
    else:
        try:
            mat_version = int(mat_version_raw)
        except (TypeError, ValueError) as exc:
            raise ApiError(
                422, "invalid_mat_version",
                f"mat_version must be an integer or 'live', got {mat_version_raw!r}",
            ) from exc

    decoration_tables: list[str] = []
    dec_body = body.get("dec")
    if isinstance(dec_body, list):
        decoration_tables = [str(t).strip() for t in dec_body if str(t).strip()]
    elif isinstance(dec_body, str) and dec_body:
        # Tolerate the legacy comma-separated string shape so an older
        # caller doesn't immediately break.
        decoration_tables = [t.strip() for t in dec_body.split(",") if t.strip()]

    try:
        cell_filters = _parse_cells_param(body.get("cells"))
    except ValueError as exc:
        raise ApiError(422, "cells_invalid", str(exc)) from exc
    # Auto-extend decoration_tables to cover every table referenced by a
    # cell filter — the user's intent is "filter by these columns"; they
    # shouldn't also have to remember to attach the table. Clauses that
    # reference the feature_table itself OR the synthetic `nucleus.*`
    # columns are skipped — those columns live on the frame natively,
    # no decoration join needed.
    for f in cell_filters:
        if f.table == feature_table_id or f.table == "nucleus":
            continue
        if f.table not in decoration_tables:
            decoration_tables.append(f.table)

    # Lasso selection — a JSON list of ints / numeric strings. ANDed with
    # the filter expression after the frame is built. Empty / absent =
    # no constraint. Naming matches /distance_to_set and /resolve_roots
    # for cross-endpoint consistency.
    sel_raw = body.get("cell_ids")
    sel_cell_ids: set[int] | None = None
    if sel_raw is not None:
        if not isinstance(sel_raw, list):
            raise ApiError(
                422, "invalid_cell_ids",
                "cell_ids must be a JSON list of integer-compatible values",
            )
        try:
            sel_cell_ids = {int(c) for c in sel_raw if c is not None and c != ""}
        except (TypeError, ValueError) as exc:
            raise ApiError(
                422, "invalid_cell_ids",
                f"cell_ids must be a list of integer-compatible values: {exc}",
            ) from exc

    # check_live_allowed + mat_version are only meaningful when we'll
    # actually call CAVE (decoration join). A parquet-only request runs
    # without a mat_version — the frame is pinned by parquet_uri.
    if decoration_tables:
        if mat_version is None:
            raise ApiError(
                422,
                "missing_mat_version",
                "mat_version is required when decoration tables are attached",
            )
        try:
            check_live_allowed(ds, mat_version)
        except ValueError as exc:
            raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    try:
        limit = int(body.get("limit", 500000))
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422, "invalid_limit", f"limit must be an integer: {exc}"
        ) from exc

    client_factory = _make_client_factory(ds, mat_version)
    frame = _load_universe_frame(
        ds=ds,
        cfg=cfg,
        ft=ft,
        mat_version=mat_version,
        decoration_tables=decoration_tables,
        client_factory=client_factory,
    )
    total_count = int(len(frame))

    if cell_filters:
        frame = _apply_cell_filters(frame, cell_filters)
    if sel_cell_ids is not None:
        # Lasso ANDs with the filter expression. The cell_id column is
        # int64 in the frame; the URL gives us strings → ints.
        frame = frame[frame["cell_id"].astype(int).isin(sel_cell_ids)]
    matched_count = int(len(frame))

    limit_hit = matched_count > limit
    if limit_hit:
        frame = frame.head(limit)

    # Stringify primary key at the JSON boundary — matches the partners
    # convention (root_id-as-string) so PartnersTable's getRowId reads
    # a string regardless of source.
    frame = frame.copy()
    frame["cell_id"] = frame["cell_id"].astype(int).astype(str)
    rows = frame.to_dict(orient="records")
    # `to_dict(orient="records")` emits numpy scalars as Python floats,
    # which means NaN values arrive as Python `float('nan')` rather
    # than np.float64. NumpyJSONProvider's `default()` only catches
    # np.floating; Python floats are a default-encoder type and slip
    # through, leaving the bare non-standard JSON token `NaN` in the
    # response body. JSON.parse on the client then rejects with
    # "Unexpected token 'N' in JSON". Replace in-place so the JSON
    # boundary is clean. Negligible cost (single pass; ~µs per row).
    for row in rows:
        for k, v in row.items():
            if isinstance(v, float) and not math.isfinite(v):
                row[k] = None

    # column_groups mirror the partners-frame schema so the SPA's column
    # visibility / collapsed-group machinery works unchanged. Parquet
    # columns are prefixed with the feature_table_id inside
    # FeatureTableQuery.frame() so they share the `<table>.<col>`
    # namespace with decoration columns. Layout:
    #   - "id" intrinsic group with just cell_id
    #   - one feature-table group ("<ft.id>") with parquet columns
    #   - one "table" group per attached decoration table
    feature_cols = [
        f"{ft.id}.{c}" for c in (ft.feature_columns or [])
        if f"{ft.id}.{c}" in frame.columns
    ]
    categorical_cols = [
        f"{ft.id}.{c}" for c in (ft.categorical_columns or [])
        if f"{ft.id}.{c}" in frame.columns
    ]
    # ``source_ds`` joins ``cell_id`` in the intrinsic ``id`` group so it
    # rides alongside the primary key and isn't picked up by per-table
    # column-visibility / filter logic. Single-ds manifests have a
    # constant column (every value equals ``ds``) — still shipped so
    # the shape is uniform and the SPA can route cross-nav from row
    # data without a special case.
    id_columns: list[str] = ["cell_id"]
    if SOURCE_DS_COLUMN in frame.columns:
        id_columns.append(SOURCE_DS_COLUMN)
    column_groups: list[dict] = [
        {"name": "id", "kind": "intrinsic", "columns": id_columns},
    ]
    parquet_cols = feature_cols + categorical_cols
    if parquet_cols:
        column_groups.append(
            {"name": ft.id, "kind": "table", "columns": parquet_cols}
        )
    # Synthetic nucleus position columns (added by FeatureTableQuery
    # from the universe cache). Render as their own group so the
    # channel pickers and column-visibility menu see them, and the
    # ?cells= filter picker exposes them.
    nucleus_cols = [
        c for c in ("nucleus.x", "nucleus.y", "nucleus.z") if c in frame.columns
    ]
    if nucleus_cols:
        column_groups.append(
            {"name": "nucleus", "kind": "table", "columns": nucleus_cols}
        )
    for table in decoration_tables:
        cols = [c for c in frame.columns if c.startswith(f"{table}.")]
        if cols:
            column_groups.append(
                {"name": table, "kind": "table", "columns": cols}
            )

    return jsonify(
        {
            "cell_ids": [row["cell_id"] for row in rows],
            "rows": rows,
            "column_groups": column_groups,
            "matched_count": matched_count,
            "total_count": total_count,
            "limit": limit,
            "limit_hit": limit_hit,
        }
    )


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/column/<path:column>/histogram",
    methods=["GET"],
)
@auth_required
def column_histogram(ds: str, feature_table_id: str, column: str):
    """Tiny histogram summary of one column.

    Companion to ``/column``. Where ``/column`` ships the full
    universe-aligned values (~750KB for a 94k-row column), this returns
    a few-hundred-byte digest: bin counts + min/max for numeric, per-
    value counts for categorical. Drives first-paint of the Selection
    Builder's predicate widgets without forcing every user to download
    the full column on column-add.

    Cache shape: ``LayeredSwrCache(immutable=True)`` against GCS L2,
    keyed on ``(cache_ds, ft_id, column, dec_tuple, mat_version,
    n_bins)``. Immutable per the parquet URI + mat_version contract,
    so the cache effectively never expires. Wire round-trip on warm
    hit is dominated by the GCS read (~30ms).

    Query params:
    - ``bins`` — numeric bin count. Default 60. Ignored for categorical.
    - ``dec`` — comma-separated decoration tables (same as ``/column``).
    - ``mat_version`` — required for decoration / nucleus columns.
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        raise ApiError(
            404,
            "feature_explorer_disabled",
            f"datastack {ds!r} does not enable the feature explorer",
        )
    try:
        ft = src.resolve_feature_table(feature_table_id)
    except KeyError as exc:
        raise ApiError(404, "feature_table_not_found", str(exc)) from exc

    mv_raw = request.args.get("mat_version")
    mat_version: int | str | None
    if mv_raw is None or mv_raw == "":
        mat_version = None
    elif mv_raw == "live":
        mat_version = "live"
    else:
        try:
            mat_version = int(mv_raw)
        except ValueError as exc:
            raise ApiError(
                422, "invalid_mat_version",
                f"mat_version must be an integer or 'live', got {mv_raw!r}",
            ) from exc

    decoration_tables: list[str] = []
    dec_raw = request.args.get("dec") or ""
    if dec_raw:
        decoration_tables = [t.strip() for t in dec_raw.split(",") if t.strip()]
    if "." in column:
        table = column.split(".", 1)[0]
        if table not in (ft.id, "nucleus") and table not in decoration_tables:
            decoration_tables.append(table)
    if decoration_tables and mat_version is None:
        raise ApiError(
            422,
            "missing_mat_version",
            "mat_version is required when the column lives in a "
            "decoration table or synthetic nucleus space",
        )
    if decoration_tables:
        try:
            check_live_allowed(ds, mat_version)
        except ValueError as exc:
            raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    n_bins_raw = request.args.get("bins", "60")
    try:
        n_bins = int(n_bins_raw)
    except ValueError as exc:
        raise ApiError(
            422, "invalid_bins", f"bins must be an integer, got {n_bins_raw!r}"
        ) from exc
    if n_bins < 1 or n_bins > 500:
        raise ApiError(
            422, "invalid_bins", "bins must be in [1, 500]"
        )

    binning_raw = request.args.get("binning", "linear")
    if binning_raw not in ("linear", "log"):
        raise ApiError(
            422,
            "invalid_binning",
            f"binning must be 'linear' or 'log', got {binning_raw!r}",
        )

    cache_ds = cfg.cache_alias or ds
    dec_tuple = tuple(sorted(decoration_tables))
    # Binning participates in the cache key so the linear and log
    # variants of the same column cache as distinct entries — switching
    # the toggle pays at most one cold-fetch per (column, mode), then
    # the cache serves either instantly.
    key = (cache_ds, ft.id, column, dec_tuple, mat_version, n_bins, binning_raw)

    cache = current_app.extensions.get("dcv_column_histogram_cache")
    if cache is not None:
        t0 = time.perf_counter()
        hit = cache.get(key)
        cache_elapsed_ms = (time.perf_counter() - t0) * 1000.0
        if hit is not None:
            value, _ = hit
            record_stage("column_histogram_l1_hit", cache_elapsed_ms)
            return jsonify(value)

    client_factory = _make_client_factory(ds, mat_version)
    frame = _load_universe_frame(
        ds=ds,
        cfg=cfg,
        ft=ft,
        mat_version=mat_version,
        decoration_tables=decoration_tables,
        client_factory=client_factory,
    )

    if column not in frame.columns:
        raise ApiError(
            422,
            "column_not_found",
            f"column {column!r} not present in feature_table frame "
            f"(have {list(frame.columns)[:20]}…)",
        )

    series = frame[column]
    if pd.api.types.is_numeric_dtype(series):
        h = compute_numeric_histogram(
            series, n_bins=n_bins, binning=binning_raw  # type: ignore[arg-type]
        )
    else:
        h = compute_categorical_histogram(series)

    payload = histogram_to_json(h)
    if cache is not None:
        cache.set(key, payload)
    return jsonify(payload)


@bp.route(
    "/<ds>/feature_tables/<feature_table_id>/distance_to_set", methods=["POST"]
)
@auth_required
def distance_to_set(ds: str, feature_table_id: str):
    """Distance from a seed cell-id set to every universe cell.

    Backs the "grow my selection by similarity" workflow. One endpoint
    serves every variant — single-seed is just a bag of one; discrete
    top-K is a client-side ``argpartition`` slice on the returned
    arrays. Three spaces:

    - ``raw``         — Euclidean on z-scored features.
    - ``pca``         — Euclidean on top-``k_pca`` PCA components.
    - ``mahalanobis`` — Euclidean on whitened (all components, scaled by
      1/singular_value) features. Equivalent to Mahalanobis distance on
      the z-scored input; corrects for correlated feature dimensions.

    Body shape::

        {
          "cell_ids":   [str|int, ...],
          "space":      "raw" | "pca" | "mahalanobis",
          "variance":   float (0..1, default 0.9; ignored unless pca).
                        Fraction of total variance the top-K PCA
                        components must explain; the server resolves
                        K from the variance request and echoes it in
                        the response. A user-facing "explain 90% of
                        the variance" knob is meaningful regardless of
                        the table's feature count, where "10 components"
                        is not.
          "reduction":  "centroid" | "nearest" | "mean",
          "feature_columns": [str, ...]   (optional override)
        }

    Response is universe-aligned: ``cell_ids[i]`` matches ``distances[i]``
    in feature-matrix row order, so the SPA joins by index when building
    its in-memory distance map.
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        raise ApiError(
            404,
            "feature_explorer_disabled",
            f"datastack {ds!r} does not enable the feature explorer",
        )

    try:
        ft = src.resolve_feature_table(feature_table_id)
    except KeyError as exc:
        raise ApiError(404, "feature_table_not_found", str(exc)) from exc

    body = request.get_json(silent=True) or {}

    raw_ids = body.get("cell_ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        raise ApiError(
            422,
            "missing_cell_ids",
            "request body must include a non-empty `cell_ids` list",
        )
    # Hard cap on the seed set. The nearest/mean reductions materialize
    # an O(chunk × S × D) intermediate per chunk — keeping S small keeps
    # the constant factor predictable, and 20 covers the meaningful
    # growth use cases (a hand-picked kernel, a tight lasso). Larger
    # bags should be summarized (centroid, a few representative cells)
    # before being used as seeds.
    if len(raw_ids) > _MAX_SEED_CELL_IDS:
        raise ApiError(
            422,
            "too_many_seeds",
            f"distance_to_set accepts at most {_MAX_SEED_CELL_IDS} seed "
            f"cell_ids; got {len(raw_ids)}. Narrow the selection (e.g. "
            "lasso a tighter kernel) before computing.",
        )
    seed_cell_ids: list[int] = []
    for sid in raw_ids:
        try:
            seed_cell_ids.append(int(sid))
        except (TypeError, ValueError) as exc:
            raise ApiError(
                422,
                "invalid_cell_id",
                f"cell_ids must be ints or numeric strings; got {sid!r}",
            ) from exc

    space = body.get("space", "pca")
    if space not in ("raw", "pca", "mahalanobis"):
        raise ApiError(
            422,
            "invalid_space",
            f"space must be one of raw | pca | mahalanobis; got {space!r}",
        )

    reduction = body.get("reduction", "centroid")
    if reduction not in ("centroid", "nearest", "mean"):
        raise ApiError(
            422,
            "invalid_reduction",
            f"reduction must be one of centroid | nearest | mean; "
            f"got {reduction!r}",
        )

    limit_raw = body.get("limit", _DEFAULT_DISTANCE_LIMIT)
    try:
        limit = int(limit_raw)
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422, "invalid_limit", f"limit must be an integer, got {limit_raw!r}"
        ) from exc
    if limit < 1:
        raise ApiError(422, "invalid_limit", "limit must be >= 1")
    if limit > _MAX_DISTANCE_LIMIT:
        raise ApiError(
            422,
            "invalid_limit",
            f"limit may not exceed {_MAX_DISTANCE_LIMIT}; got {limit}",
        )

    variance_raw = body.get("variance", 0.9)
    try:
        variance = float(variance_raw)
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422,
            "invalid_variance",
            f"variance must be a number in (0, 1], got {variance_raw!r}",
        ) from exc
    if not (0.0 < variance <= 1.0):
        raise ApiError(
            422,
            "invalid_variance",
            f"variance must be in (0, 1], got {variance}",
        )

    feature_columns = body.get("feature_columns")
    if feature_columns is not None:
        if not isinstance(feature_columns, list) or not all(
            isinstance(c, str) for c in feature_columns
        ):
            raise ApiError(
                422,
                "invalid_feature_columns",
                "feature_columns must be a list of column names",
            )
        if len(feature_columns) < 2:
            raise ApiError(
                422,
                "invalid_feature_columns",
                "feature_columns must include at least 2 columns "
                "(distance in 1D collapses to absolute difference and "
                "PCA / Mahalanobis are undefined)",
            )

    # Pydantic deserializes ``[lo, hi]`` from YAML as a list; normalize
    # to a 2-tuple at the boundary so the matrix layer's type hint is
    # honored and the digest formatter doesn't have to branch.
    #
    # Per-table since schema v1: each FeatureTableSpec owns its own
    # `scaling` / `standardize` / `clip_percentiles`. The endpoint reads
    # from `ft` directly — no manifest-level fallback to consult.
    clip_setting = ft.clip_percentiles
    clip_percentiles: tuple[float, float] | None = (
        (float(clip_setting[0]), float(clip_setting[1]))
        if clip_setting is not None
        else None
    )
    # Scaling source-of-truth is the ``scaling`` field. The legacy
    # ``standardize: bool`` overrides only when a YAML explicitly opts
    # out of standardization (sets it to false) and hasn't set
    # ``scaling``. Tables that leave ``standardize`` at its default land
    # at ``zscore`` either way — no silent behavior change.
    scaling = ft.scaling
    if not ft.standardize and scaling == "zscore":
        scaling = "raw"
    try:
        matrix = get_matrix(
            ds,
            ft,
            feature_columns=feature_columns,
            scaling=scaling,
            clip_percentiles=clip_percentiles,
            cache_ds=cfg.cache_alias or ds,
        )
    except ValueError as exc:
        raise ApiError(422, "matrix_build_failed", str(exc)) from exc

    svd = None
    resolved_k = None
    variance_explained = None
    if space != "raw":
        # PCA + Mahalanobis both ride on the same cached SVD; one fit,
        # two projections. Cache key is independent of variance/k so a
        # slider drag on the SPA never refits.
        svd = get_pca_svd(cfg.cache_alias or ds, ft, matrix)
        if space == "pca":
            # Resolve variance → K once per request. The SVD slice is
            # cheap; the slider response stays interactive.
            resolved_k, variance_explained = resolve_k_for_variance(svd, variance)

    try:
        result = compute_distance_to_set(
            matrix,
            seed_cell_ids,
            space=space,
            reduction=reduction,
            k_pca=resolved_k or 1,  # ignored when space != "pca"
            svd=svd,
        )
    except ValueError as exc:
        raise ApiError(422, "no_seeds_in_index", str(exc)) from exc

    # Sort + (optionally) truncate before serializing. The default
    # ``limit`` is large enough to ship the entire universe for every
    # known dataset; the argpartition branch only runs when a caller
    # explicitly requests a slice smaller than the universe. Either
    # way the response arrives pre-sorted ascending.
    n_universe = len(result.distances)
    effective_limit = min(limit, n_universe)
    with timer("distance_truncate_topk"):
        # argpartition gets the indices of the K smallest in O(N); we then
        # sort just those K so the response arrives pre-sorted ascending.
        if effective_limit < n_universe:
            unsorted_top = np.argpartition(
                result.distances, effective_limit - 1
            )[:effective_limit]
            order = unsorted_top[np.argsort(result.distances[unsorted_top])]
        else:
            order = np.argsort(result.distances)
        top_cell_ids = result.cell_ids[order]
        top_distances = result.distances[order]

    return jsonify(
        {
            "cell_ids": [str(cid) for cid in top_cell_ids.tolist()],
            "distances": top_distances.tolist(),
            "space": space,
            "variance": variance if space == "pca" else None,
            "k_pca": resolved_k,
            "variance_explained": variance_explained,
            "reduction": reduction,
            "n_seed_in_index": result.n_seed_in_index,
            "n_seed_missing": result.n_seed_missing,
            "n_returned": int(effective_limit),
            "n_universe": int(n_universe),
            "feature_columns": list(matrix.feature_columns),
        }
    )


@bp.route("/<ds>/feature_tables/<feature_table_id>/resolve_roots", methods=["POST"])
@auth_required
def resolve_roots(ds: str, feature_table_id: str):
    """Batched cell_id → root_id resolve at a specific mat_version.

    Body: ``{cell_ids: [int|str, ...], mat_version: int | "live"}``.
    Response: ``{mat_version, resolutions: [{cell_id, root_id, status, ...}]}``.
    Order matches the request.

    Keyed on feature_table rather than embedding because the cell_id
    universe is owned by the table; embedding choice doesn't affect
    resolution.
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        raise ApiError(
            404,
            "feature_explorer_disabled",
            f"datastack {ds!r} does not enable the feature explorer",
        )

    try:
        src.resolve_feature_table(feature_table_id)
    except KeyError as exc:
        raise ApiError(404, "feature_table_not_found", str(exc)) from exc

    body = request.get_json(silent=True) or {}

    raw_ids = body.get("cell_ids")
    if not isinstance(raw_ids, list):
        raise ApiError(
            422, "missing_cell_ids", "body must include a `cell_ids` list"
        )
    try:
        cell_ids = [int(c) for c in raw_ids]
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422, "invalid_cell_ids", f"all cell_ids must be integers: {exc}"
        ) from exc

    if not cell_ids:
        return jsonify({"mat_version": body.get("mat_version"), "resolutions": []})

    if "mat_version" not in body:
        raise ApiError(
            422,
            "missing_mat_version",
            "body must include `mat_version` (int or \"live\")",
        )
    mat_version = body["mat_version"]

    try:
        check_live_allowed(ds, mat_version)
    except ValueError as exc:
        raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    # Lazy CAVEclient — only constructed when the universe cache misses
    # and we need to actually hit CAVE. CAVEclient construction has its
    # own ~500ms cost (auth-server discovery + datastack info fetch); on
    # a cache hit it's wasted work. The resolver primitive accesses
    # `client.materialize.views[view]` only on the cold path, so a
    # LazyClient that defers construction until first attribute access
    # is safe.
    client = _LazyClient(lambda: _cave_client(ds, mat_version))

    try:
        resolutions = resolve_cell_ids_to_root_ids(
            client=client,
            cfg=cfg,
            mat_version=mat_version,
            datastack=ds,
            cell_ids=cell_ids,
        )
    except ValueError as exc:
        raise ApiError(422, "lookup_unavailable", str(exc)) from exc
    except Exception as exc:
        raise ApiError(
            502, "cave_upstream", f"{type(exc).__name__}: {exc}"
        ) from exc

    return jsonify(
        {
            "mat_version": str(mat_version) if mat_version is not None else None,
            "resolutions": [_resolution_to_json(r, ds=ds) for r in resolutions],
        }
    )


@bp.route("/<ds>/feature_tables/<feature_table_id>/find_cells", methods=["POST"])
@auth_required
def find_cells(ds: str, feature_table_id: str):
    """Cross-version root_id → cell_id lookup for the explorer's search box.

    Universe-first pipeline per input:

    1. **Direct lookup against the universe.** ``root_ids_to_cell_ids``
       hits the in-process ``dcv_cell_id_universe_cache`` snapshot of
       the datastack's nucleus lookup view at ``mat_version``. For
       inputs that are already canonical at this mat_version (the
       common case — root_ids copied straight out of a Neuroglancer URL
       or a notebook against the current snapshot), this is an O(1)
       dict lookup with zero CAVE calls. The lookup-view CAVE query
       only fires as a fallback for misses on a cold universe.
    2. **Chunkedgraph alignment for the misses.** Inputs that didn't
       resolve in step 1 (proofread-since-mv, axon-only without a
       nucleus, or garbage) go through ``suggest_current_roots`` —
       ``is_latest_roots`` first to filter then ``suggest_latest_roots``
       for any genuinely stale subset — to find the current root.
    3. **Re-lookup the aligned roots.** Whichever current roots came
       out of step 2 get a second pass through ``root_ids_to_cell_ids``
       to find their cell_id. Per-root caching makes this near-free.

    For a paste where every input is already canonical at this mv, the
    whole request resolves on a warm universe in <1ms with no CAVE
    round-trips.

    The endpoint exists only for root_id input; the explorer's search
    box validates ``cell_id`` mode locally against the universe
    cell_ids array already loaded in the SPA, so this endpoint stays
    single-purpose.

    Body::

        {"root_ids": ["864691...", ...], "mat_version": 1718}

    Returns one result per input in input order::

        {
          "mat_version": "1718",
          "results": [
            {
              "original_root_id": "864691...",
              "root_id": "864691...",     // aligned at mv; null on unaligned
              "cell_id": "294101",         // null on unaligned / unresolved
              "aligned": true,             // chunkedgraph returned a new root
              "status": "ok"               // "ok" | "unaligned" | "unresolved"
            },
            ...
          ]
        }

    Per-input failures (status ``unaligned`` or ``unresolved``) are
    **not** top-level errors; partial-success batches are the common
    case (e.g. paste 50 root_ids copied from a Neuroglancer
    ``segments=`` fragment, 47 land on the embedding, 3 are stale
    beyond the lineage walk).

    Same chunkedgraph code path as ``/connectivity``'s stale-root
    recovery — both go through ``suggest_current_roots`` — so a root
    that ``/explore`` reports as aligned will produce the same
    ``root_id_updated.current`` in ``/connectivity`` when used as
    ``?root=``.
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        raise ApiError(
            404,
            "feature_explorer_disabled",
            f"datastack {ds!r} does not enable the feature explorer",
        )

    try:
        src.resolve_feature_table(feature_table_id)
    except KeyError as exc:
        raise ApiError(404, "feature_table_not_found", str(exc)) from exc

    body = request.get_json(silent=True) or {}

    raw_ids = body.get("root_ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        raise ApiError(
            422,
            "missing_root_ids",
            "body must include a non-empty `root_ids` list",
        )
    try:
        original_root_ids = [int(r) for r in raw_ids]
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422,
            "invalid_root_ids",
            f"all root_ids must be integers: {exc}",
        ) from exc

    if "mat_version" not in body:
        raise ApiError(
            422,
            "missing_mat_version",
            "body must include `mat_version` (int or \"live\")",
        )
    mat_version_raw = body["mat_version"]
    if mat_version_raw == "live":
        mat_version: int | str = "live"
    else:
        try:
            mat_version = int(mat_version_raw)
        except (TypeError, ValueError) as exc:
            raise ApiError(
                422,
                "invalid_mat_version",
                f"mat_version must be an integer or 'live', got {mat_version_raw!r}",
            ) from exc

    try:
        check_live_allowed(ds, mat_version)
    except ValueError as exc:
        raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    client = _cave_client(ds, mat_version)

    # Step 1 — universe-first lookup. The Feature Explorer's universe
    # cache (`dcv_cell_id_universe_cache`) holds the snapshot of the
    # datastack's nucleus lookup view at `mat_version`, with a reverse
    # `root_to_cell` map. For the common case — user pastes root_ids
    # copied straight from a Neuroglancer URL or a notebook against the
    # current snapshot — every input is already canonical at this
    # mat_version and `root_ids_to_cell_ids` resolves the whole batch
    # via O(1) dict lookups with zero CAVE calls.
    #
    # Only inputs that miss the universe (proofread-since-mv, axon-only
    # without a nucleus, or just garbage) fall through to the
    # chunkedgraph alignment in step 2.
    try:
        direct_lookup = root_ids_to_cell_ids(
            client=client,
            cfg=cfg,
            mat_version=mat_version,
            datastack=ds,
            root_ids=original_root_ids,
        )
    except ValueError as exc:
        raise ApiError(422, "lookup_unavailable", str(exc)) from exc
    except Exception as exc:
        raise ApiError(
            502,
            "cave_upstream",
            f"universe lookup failed: {type(exc).__name__}: {exc}",
        ) from exc

    # Step 2 — chunkedgraph alignment for the misses only. is_latest_roots
    # + suggest_latest_roots inside `suggest_current_roots` handles the
    # "this root was edited since mv" case. Skips entirely when every
    # input landed in step 1 — the happy-path zero-CAVE-call promise.
    missing_inputs = [
        r for r in original_root_ids if direct_lookup.get(r) is None
    ]
    alignment: dict[int, int | None] = {}
    aligned_lookup: dict[int, int | None] = {}
    if missing_inputs:
        try:
            alignment = suggest_current_roots(
                client, missing_inputs, mat_version=mat_version
            )
        except Exception as exc:
            raise ApiError(
                502,
                "cave_upstream",
                f"chunkedgraph alignment failed: {type(exc).__name__}: {exc}",
            ) from exc

        # Step 3 — lookup the aligned roots produced by step 2. The
        # per-root cache inside `root_ids_to_cell_ids` makes a second
        # call cheap; for aligned roots that already passed through the
        # universe (e.g. two stale inputs that merged into the same
        # current root) the cache returns the answer instantly.
        aligned_to_lookup: list[int] = []
        seen: set[int] = set()
        for orig in missing_inputs:
            aligned = alignment.get(orig)
            if aligned is None or aligned in seen:
                continue
            # Skip inputs whose aligned root is the same as the input —
            # those already missed step 1, so re-asking won't change the
            # answer. They're genuinely unresolved.
            if aligned == orig:
                continue
            aligned_to_lookup.append(aligned)
            seen.add(aligned)

        if aligned_to_lookup:
            try:
                aligned_lookup = root_ids_to_cell_ids(
                    client=client,
                    cfg=cfg,
                    mat_version=mat_version,
                    datastack=ds,
                    root_ids=aligned_to_lookup,
                )
            except ValueError as exc:
                raise ApiError(422, "lookup_unavailable", str(exc)) from exc
            except Exception as exc:
                raise ApiError(
                    502,
                    "cave_upstream",
                    f"nucleus lookup failed: {type(exc).__name__}: {exc}",
                ) from exc

    # Stitch per-input results in input order.
    results: list[dict[str, Any]] = []
    for orig in original_root_ids:
        direct_cid = direct_lookup.get(orig)
        if direct_cid is not None:
            results.append(
                {
                    "original_root_id": str(orig),
                    "root_id": str(orig),
                    "cell_id": str(int(direct_cid)),
                    "aligned": False,
                    "status": "ok",
                }
            )
            continue
        aligned = alignment.get(orig)
        if aligned is None:
            results.append(
                {
                    "original_root_id": str(orig),
                    "root_id": None,
                    "cell_id": None,
                    "aligned": False,
                    "status": "unaligned",
                }
            )
            continue
        # `aligned == orig` only reaches here when step 1 missed but
        # the chunkedgraph said the root is current — i.e. the
        # chunkedgraph and the nucleus lookup view disagree. Treat as
        # unresolved (cell present in chunkedgraph but with no nucleus
        # mapping in the lookup view at this mv).
        if aligned == orig:
            results.append(
                {
                    "original_root_id": str(orig),
                    "root_id": str(aligned),
                    "cell_id": None,
                    "aligned": False,
                    "status": "unresolved",
                }
            )
            continue
        cell_id = aligned_lookup.get(aligned)
        if cell_id is None:
            results.append(
                {
                    "original_root_id": str(orig),
                    "root_id": str(aligned),
                    "cell_id": None,
                    "aligned": True,
                    "status": "unresolved",
                }
            )
            continue
        results.append(
            {
                "original_root_id": str(orig),
                "root_id": str(aligned),
                "cell_id": str(int(cell_id)),
                "aligned": True,
                "status": "ok",
            }
        )

    return jsonify(
        {
            "mat_version": str(mat_version) if mat_version is not None else None,
            "results": results,
        }
    )


class _LazyClient:
    """Proxy that defers a CAVEclient construction until first
    attribute access. Used by the resolve_roots endpoint so cache-hit
    requests skip the ~500ms client-build overhead entirely. On a
    miss, the first ``client.materialize.views[...]`` access triggers
    the underlying ``_cave_client()`` call exactly once."""

    __slots__ = ("_factory", "_built")

    def __init__(self, factory):
        self._factory = factory
        self._built = None

    def __getattr__(self, name):
        if self._built is None:
            self._built = self._factory()
        return getattr(self._built, name)


# -- internals ----------------------------------------------------------------


def _cave_client(ds: str, mat_version: int | str | None):
    """Build a CAVE client with the request's auth context."""
    try:
        return request_client(
            datastack_name=ds,
            server_address=current_app.config["GLOBAL_SERVER_ADDRESS"],
            auth_token=current_token(),
            dev_bypass=is_dev_bypass(),
            materialize_version=mat_version,
        )
    except ValueError as exc:
        raise ApiError(401, "no_auth_token", str(exc)) from exc


def _resolution_to_json(r, *, ds: str) -> dict[str, Any]:
    # ``source_ds`` per resolution — phase 1 path-scoped endpoint emits a
    # uniform tag equal to the request's ``ds``. Phase 2's body-scoped
    # /resolve_roots will accept per-row (ds, cell_id) input and emit
    # per-row source_ds on the response, at which point Resolution gains
    # the field directly and this helper drops the ds= keyword.
    out: dict[str, Any] = {
        "cell_id": str(r.cell_id),
        "source_ds": ds,
        "root_id": str(r.root_id) if r.root_id is not None else None,
        "status": r.status,
    }
    if r.candidates:
        out["candidates"] = [str(c) for c in r.candidates]
    return out


def _feature_table_summary(ft: FeatureTableSpec) -> dict[str, Any]:
    """Public-API projection of a FeatureTableSpec — drops the storage URI
    (internal) and renders the audit block as a boolean flag (the audit
    *values* per cell ship through the rows endpoint, not the catalog).

    Categories are projected as-is so the SPA can render category-grouped
    pickers (channel selector, "+ add plot" menu, kNN feature subset).
    Validation that the referenced columns exist in the parquet happens
    on the SPA side (it already has the column list); the catalog
    response just relays the declared structure.
    """
    return {
        "id": ft.id,
        "title": ft.title,
        "description": ft.description,
        "id_column": ft.id_column,
        "cell_id_source_table": ft.cell_id_source_table,
        "feature_columns": ft.feature_columns,
        "categorical_columns": ft.categorical_columns,
        "spatial_pre_columns": list(ft.spatial_pre_columns),
        "spatial_post_columns": list(ft.spatial_post_columns),
        "depth_columns": ft.depth_columns,
        "has_audit": ft.audit is not None,
        "categories": [
            {
                "id": c.id,
                "title": c.title,
                "description": c.description,
                "columns": list(c.columns),
            }
            for c in ft.categories
        ],
        "embeddings": [_embedding_summary(e) for e in ft.embeddings],
        # Similarity controls moved from the manifest-level `knn:` block
        # to per-table in schema v1. Surfaced for SPA inspection (the
        # similarity computation itself happens server-side and reads
        # the same fields).
        "knn": {
            "scaling": ft.scaling,
            "standardize": ft.standardize,
            "clip_percentiles": (
                list(ft.clip_percentiles) if ft.clip_percentiles is not None else None
            ),
        },
    }


def _embedding_summary(emb: EmbeddingSpec) -> dict[str, Any]:
    return {
        "id": emb.id,
        "title": emb.title,
        "description": emb.description,
        "axes": emb.axes,
        "default_color_by": emb.default_color_by,
        "depth_axis": emb.depth_axis,
    }
