"""Feature Explorer endpoints — foundation slice.

Mounted at ``/api/v1/datastacks/<ds>/feature_tables/...``:

- ``GET  /feature_tables``                              catalog: tables +
                                                        nested embeddings
                                                        + kNN defaults
                                                        + cell_id_source_table.
- ``POST /feature_tables/<ft>/knn``                     kNN by cell_id (or by
                                                        root_id with server-
                                                        side reverse-resolve).
                                                        Data-level concern —
                                                        independent of which
                                                        embedding the SPA is
                                                        currently rendering.
- ``POST /feature_tables/<ft>/resolve_roots``           batched cell_id →
                                                        root_id at mat_version.

The plotting + table-rows endpoints land separately:
``services/plots.py`` gains an ``embedding_cells`` data source (served
through the existing ``/plots/<spec>`` machinery), and a sibling
``/feature_tables/<ft>/rows`` endpoint provides table-mode rows.

The auth decorator gates everything at the same boundary as the rest of
the API; ``CDV_DEV_AUTH_BYPASS=1`` covers local dev.
"""

from __future__ import annotations

from typing import Any

import pandas as pd
from flask import Blueprint, current_app, jsonify, request

from ..auth import auth_required, current_token, is_dev_bypass
from ..cave import request_client
from ..errors import ApiError
from ..services.datastack_config import check_live_allowed, load_datastack_config
from ..services.embeddings import (
    EmbeddingSpec,
    FeatureTableQuery,
    FeatureTableSpec,
    get_index,
    load_feature_table_frame,
    resolve_cell_ids_to_root_ids,
    reverse_resolve_root_id_to_cell_id,
    source_for,
)
from ..services.categorical import (
    get_unique_values as _categorical_get_unique_values,
    resolve_categorical_color_map,
)
from ..services.plots import _apply_cell_filters, _parse_cells_param


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

    return jsonify(
        {
            "enabled": True,
            "cell_id_source_table": cfg.feature_explorer.cell_id_source_table,
            "knn": manifest.knn.model_dump(),
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
    # Size range bounds — let the client widen/narrow the visual range
    # of the size channel without server changes. Defaults match the
    # _scale_size_rank defaults (2–18 px). Bounded to a sane envelope
    # so a stray URL value doesn't render giant blobs.
    try:
        size_min_px = float(request.args.get("size_min", 2.0))
        size_max_px = float(request.args.get("size_max", 18.0))
    except ValueError as exc:
        raise ApiError(
            422, "invalid_size_range",
            f"size_min / size_max must be numeric: {exc}",
        ) from exc
    size_min_px = max(0.5, min(size_min_px, 40.0))
    size_max_px = max(size_min_px + 0.5, min(size_max_px, 40.0))
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
    # itself read from the prefixed parquet columns natively.
    for col in (x_col, y_col, color_col, size_col):
        if not col:
            continue
        if "." not in col:
            continue
        table = col.split(".", 1)[0]
        if table == ft.id:
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

    def _client_factory():
        return request_client(
            datastack_name=ds,
            server_address=current_app.config["GLOBAL_SERVER_ADDRESS"],
            auth_token=current_token(),
            dev_bypass=is_dev_bypass(),
            materialize_version=mat_version,
        )

    ft_query = FeatureTableQuery(
        datastack=ds,
        mat_version=mat_version,
        feature_table=ft,
        cfg=cfg,
        client_factory=_client_factory if decoration_tables else None,
    )
    frame = ft_query.frame(decoration_tables=decoration_tables or None)

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
                    client_factory=_client_factory,
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
        finite = pd.to_numeric(series, errors="coerce").dropna()
        if finite.empty:
            raw_range = [0.0, 0.0]
        else:
            raw_range = [float(finite.min()), float(finite.max())]
        # Percentile-rank scaling so the visual encoding is uniform
        # regardless of the source distribution. Linear scaling of
        # long-tailed morphology features (soma_volume, nucleus_area,
        # etc. — typical for connectomics) compresses most cells to
        # the small end with a few visible outliers; "looks broken"
        # because the variation hides in the tail. Rank scaling gives
        # the same visual span across the dataset, which is what users
        # expect from a "size by feature" binding.
        #
        # 2-18px range — wider than the Plotly-era 3-10 because deck.gl
        # handles large markers without overdraw issues. Hover surfaces
        # the raw value in raw_range so the user can still read the
        # actual number.
        scaled = _scale_size_rank(series, lo_px=size_min_px, hi_px=size_max_px)
        size_block = {
            "column": size_col,
            "values": [float(v) for v in scaled.tolist()],
            "raw_range": raw_range,
        }

    return jsonify(
        {
            "cell_ids": [str(int(c)) for c in frame["cell_id"].tolist()],
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
    "/<ds>/feature_tables/<feature_table_id>/cells",
    methods=["GET"],
)
@auth_required
def cells(ds: str, feature_table_id: str):
    """Row payload for the explorer's cell-list table.

    Mirrors the partners-frame ``{rows, column_groups}`` shape that
    ``PartnersTable`` consumes, so the same component renders both
    ``/neuron``'s partners and ``/explore``'s cells.

    Query params:

    - ``mat_version`` — drives the resolver for any decoration joins.
      Required when ``dec`` is non-empty.
    - ``dec`` — comma-separated decoration table names to join onto the
      frame. Same syntax as ``/connectivity``'s ``dec``.
    - ``cells`` — filter expression, same syntax as the partners
      endpoints (``<table>.<col>:<op>:<val>[,...]``). Filters reference
      either parquet columns or attached decoration columns.
    - ``limit`` — server-side cap on returned rows. Defaults to a high
      enough value to fit a feature table (~few hundred thousand rows)
      while keeping the response under JSON-encoder time pressure.

    Response::

        {
          "cell_ids": [...],     (echo of primary key column for convenience)
          "rows": [{cell_id, ...parquet/decoration columns...}, ...],
          "column_groups": [...PartnerRecord-style groups...],
          "matched_count": N,    (post-filter)
          "total_count": M,      (pre-filter; for "N of M" indicator)
          "limit": L,
          "limit_hit": bool
        }
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

    mat_version_raw = request.args.get("mat_version")
    mat_version: int | str | None
    if mat_version_raw is None or mat_version_raw == "":
        mat_version = None
    elif mat_version_raw == "live":
        mat_version = "live"
    else:
        try:
            mat_version = int(mat_version_raw)
        except ValueError as exc:
            raise ApiError(
                422, "invalid_mat_version",
                f"mat_version must be an integer or 'live', got {mat_version_raw!r}",
            ) from exc

    decoration_tables: list[str] = []
    dec_raw = request.args.get("dec") or ""
    if dec_raw:
        decoration_tables = [t.strip() for t in dec_raw.split(",") if t.strip()]

    try:
        cell_filters = _parse_cells_param(request.args.get("cells"))
    except ValueError as exc:
        raise ApiError(422, "cells_invalid", str(exc)) from exc
    # Auto-extend decoration_tables to cover every table referenced by a
    # cell filter — the user's intent is "filter by these columns"; they
    # shouldn't also have to remember to attach the table. Clauses that
    # reference the feature_table itself are skipped — those columns are
    # parquet columns that live on the frame natively, no join needed.
    for f in cell_filters:
        if f.table == feature_table_id:
            continue
        if f.table not in decoration_tables:
            decoration_tables.append(f.table)

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
        limit = int(request.args.get("limit", "500000"))
    except ValueError as exc:
        raise ApiError(
            422, "invalid_limit", f"limit must be an integer: {exc}"
        ) from exc

    def _client_factory():
        return request_client(
            datastack_name=ds,
            server_address=current_app.config["GLOBAL_SERVER_ADDRESS"],
            auth_token=current_token(),
            dev_bypass=is_dev_bypass(),
            materialize_version=mat_version,
        )

    ft_query = FeatureTableQuery(
        datastack=ds,
        mat_version=mat_version,
        feature_table=ft,
        cfg=cfg,
        client_factory=_client_factory if decoration_tables else None,
    )
    frame = ft_query.frame(decoration_tables=decoration_tables or None)
    total_count = int(len(frame))

    if cell_filters:
        frame = _apply_cell_filters(frame, cell_filters)
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
    column_groups: list[dict] = [
        {"name": "id", "kind": "intrinsic", "columns": ["cell_id"]},
    ]
    parquet_cols = feature_cols + categorical_cols
    if parquet_cols:
        column_groups.append(
            {"name": ft.id, "kind": "table", "columns": parquet_cols}
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


@bp.route("/<ds>/feature_tables/<feature_table_id>/knn", methods=["POST"])
@auth_required
def knn(ds: str, feature_table_id: str):
    """k-nearest-neighbor query in feature space.

    Keyed on **feature table**, not embedding — the kNN index is built
    from the table's feature columns (or an explicit subset), so the
    same index serves every embedding declared on that table. Switching
    a UMAP for a t-SNE on the SPA doesn't refetch this.

    Body: ``{cell_id | root_id+mat_version, k?, feature_columns?}``.
    ``feature_columns`` defaults to the table's manifest declaration;
    when omitted the call may also pass through an embedding's
    ``knn_features`` override at the SPA layer.
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
    cell_id = _resolve_query_cell_id(ds, cfg, body)

    manifest = src.list()
    requested_k = body.get("k", manifest.knn.default_k)
    try:
        requested_k = int(requested_k)
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422, "invalid_k", f"k must be an integer, got {requested_k!r}"
        ) from exc
    k = max(1, min(requested_k, manifest.knn.max_k))

    feature_columns = body.get("feature_columns")
    if feature_columns is not None and not isinstance(feature_columns, list):
        raise ApiError(
            422,
            "invalid_feature_columns",
            "feature_columns must be a list of column names",
        )

    try:
        index = get_index(
            ds,
            ft,
            feature_columns=feature_columns,
            standardize=manifest.knn.standardize,
            cache_ds=cfg.cache_alias or ds,
        )
    except ValueError as exc:
        raise ApiError(500, "index_build_failed", str(exc)) from exc

    try:
        neighbors = index.query(cell_id, k)
    except KeyError as exc:
        raise ApiError(404, "cell_id_not_in_index", str(exc)) from exc

    return jsonify(
        {
            "query_cell_id": str(cell_id),
            "neighbors": [
                {"cell_id": str(cid), "distance": d}
                for cid, d in neighbors
            ],
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

    client = _cave_client(ds, mat_version)

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
            "resolutions": [_resolution_to_json(r) for r in resolutions],
        }
    )


# -- internals ----------------------------------------------------------------


def _resolve_query_cell_id(ds: str, cfg, body: dict[str, Any]) -> int:
    """Translate the /knn body's ``cell_id`` or ``root_id`` into a cell_id."""
    if "cell_id" in body:
        try:
            return int(body["cell_id"])
        except (TypeError, ValueError) as exc:
            raise ApiError(
                422,
                "invalid_cell_id",
                f"cell_id must be an integer or numeric string, got {body['cell_id']!r}",
            ) from exc

    if "root_id" not in body:
        raise ApiError(
            422,
            "missing_id",
            "request body must include either `cell_id` or `root_id`+`mat_version`",
        )

    try:
        root_id = int(body["root_id"])
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422,
            "invalid_root_id",
            f"root_id must be an integer or numeric string, got {body['root_id']!r}",
        ) from exc

    if "mat_version" not in body:
        raise ApiError(
            422,
            "missing_mat_version",
            "root_id input requires `mat_version` (int or \"live\") so the "
            "reverse resolution knows which version to look up",
        )
    mat_version = body["mat_version"]

    try:
        check_live_allowed(ds, mat_version)
    except ValueError as exc:
        raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    client = _cave_client(ds, mat_version)

    try:
        cell_id = reverse_resolve_root_id_to_cell_id(
            client=client,
            cfg=cfg,
            mat_version=mat_version,
            datastack=ds,
            root_id=root_id,
        )
    except ValueError as exc:
        raise ApiError(422, "lookup_unavailable", str(exc)) from exc
    except Exception as exc:
        raise ApiError(
            502, "cave_upstream", f"{type(exc).__name__}: {exc}"
        ) from exc

    if cell_id is None:
        raise ApiError(
            404,
            "root_id_unresolved",
            f"root_id {root_id!r} could not be reverse-resolved to a "
            f"cell_id at mat_version={mat_version!r} (no matching row in "
            "root_id_lookup_main_table or its alt tables)",
        )
    return cell_id


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


def _resolution_to_json(r) -> dict[str, Any]:
    out: dict[str, Any] = {
        "cell_id": str(r.cell_id),
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
    """
    return {
        "id": ft.id,
        "title": ft.title,
        "description": ft.description,
        "id_column": ft.id_column,
        "feature_columns": ft.feature_columns,
        "categorical_columns": ft.categorical_columns,
        "depth_columns": ft.depth_columns,
        "has_audit": ft.audit is not None,
        "embeddings": [_embedding_summary(e) for e in ft.embeddings],
    }


def _embedding_summary(emb: EmbeddingSpec) -> dict[str, Any]:
    return {
        "id": emb.id,
        "title": emb.title,
        "description": emb.description,
        "axes": emb.axes,
        "default_color_by": emb.default_color_by,
        "knn_features": emb.knn_features,
        "depth_axis": emb.depth_axis,
    }
