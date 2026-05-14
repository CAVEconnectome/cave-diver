"""Feature Explorer endpoints.

Mounted at ``/api/v1/datastacks/<ds>/embeddings/...``:

- ``GET  /embeddings``                     list the catalog (always 200; carries
                                           an ``enabled`` flag).
- ``GET  /embeddings/<id>/points``         scatter payload (cell_ids + xy + color).

Both endpoints are pure reads of the cached parquet — no CAVE round-trip on
the hot path. The auth decorator still gates them at the same boundary as
every other endpoint (and ``CDV_DEV_AUTH_BYPASS=1`` covers local dev).

Decoration-sourced color/filter columns (the ``table.column`` form) will be
wired into ``/points`` in a follow-up task; today the endpoint returns a
clean 501 when the SPA asks for one.
"""

from __future__ import annotations

import math
from typing import Any

import pandas as pd
from flask import Blueprint, current_app, jsonify, request

from ..auth import auth_required, current_token, is_dev_bypass
from ..cave import request_client
from ..errors import ApiError
from ..services.datastack_config import check_live_allowed, load_datastack_config
from ..services.embeddings import (
    EmbeddingSpec,
    get_index,
    join_decoration_column,
    load_embedding_frame,
    resolve_cell_ids_to_root_ids,
    reverse_resolve_root_id_to_cell_id,
    source_for,
)

bp = Blueprint("embeddings", __name__, url_prefix="/datastacks")


@bp.route("/<ds>/embeddings", methods=["GET"])
@auth_required
def list_embeddings(ds: str):
    """List the embeddings available for one datastack.

    Always returns 200 with an ``enabled`` flag — the SPA switches the
    /explore route on this flag rather than guessing from a 404. When the
    feature explorer is disabled or unconfigured for the datastack, only
    ``enabled: false`` is set; the rest of the body is omitted so the SPA
    doesn't render an empty picker.
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        return jsonify({"enabled": False})

    try:
        manifest = src.list()
    except ValueError as exc:
        # Manifest fetch / parse failure. 502 because the misconfiguration
        # is in upstream storage (the manifest_uri), not the request.
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
            "embeddings": [_spec_summary(e) for e in manifest.embeddings],
        }
    )


@bp.route("/<ds>/embeddings/<embedding_id>/points", methods=["GET"])
@auth_required
def points(ds: str, embedding_id: str):
    """Scatter payload for one embedding.

    Query params
    ------------
    x, y
        Columns to plot on the two axes. Defaults to the manifest's
        ``axes`` field. Accept the same two name forms as ``color_by``:

        - bare column (e.g. ``soma_depth_y``) — parquet-native.
        - ``table.column`` (e.g. ``cell_type_multifeature_combo.cell_type``)
          — decoration-sourced; same gating as decoration color.

        Letting x/y override means the explorer renders not just the
        pre-computed UMAP, but any pair of features-vs-features (e.g.
        ``soma_depth_y`` vs ``soma_area_um``) or even decoration columns
        on an axis (categorical x renders as a category axis in plotly).
    color_by
        Same shape, populates the ``color`` block. Defaults to
        ``spec.default_color_by``.
    dec
        Comma-separated decoration tables attached to this request.
        Tables outside this list cannot supply x/y/color values.
    mv
        Materialization version (int or ``"live"``). Required when any of
        x/y/color_by names a decoration column.

    Response shape
    --------------
    ``{cell_ids, x, y, color?}`` where each of x/y/color is a column block
    (same shape: ``{kind, source, column, values, resolution_stats?}``).
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
        spec = src.resolve(embedding_id)
    except KeyError as exc:
        raise ApiError(404, "embedding_not_found", str(exc)) from exc

    x_col = request.args.get("x") or spec.axes[0]
    y_col = request.args.get("y") or spec.axes[1]
    color_by = request.args.get("color_by") or spec.default_color_by
    size_by = request.args.get("size")
    attached_decorations = _parse_csv(request.args.get("dec"))
    mat_version = request.args.get("mv")

    df = load_embedding_frame(ds, spec, cache_ds=cfg.cache_alias or ds)

    cell_id_strings = [str(v) for v in df[spec.id_column].tolist()]
    cell_id_ints = [int(v) for v in df[spec.id_column].tolist()]

    payload: dict[str, Any] = {
        "cell_ids": cell_id_strings,
        "x": _build_column_block(
            ds=ds, cfg=cfg, spec=spec, df=df, column=x_col,
            attached_decorations=attached_decorations,
            cell_ids=cell_id_ints, mat_version=mat_version,
            error_code="x_column_unknown",
        ),
        "y": _build_column_block(
            ds=ds, cfg=cfg, spec=spec, df=df, column=y_col,
            attached_decorations=attached_decorations,
            cell_ids=cell_id_ints, mat_version=mat_version,
            error_code="y_column_unknown",
        ),
    }

    if color_by:
        payload["color"] = _build_column_block(
            ds=ds, cfg=cfg, spec=spec, df=df, column=color_by,
            attached_decorations=attached_decorations,
            cell_ids=cell_id_ints, mat_version=mat_version,
            error_code="color_column_unknown",
        )

    if size_by:
        # Size is meaningful only for numeric columns — the SPA's scatter
        # maps the value range onto a marker-pixel range. Reject categorical
        # / decoration-categorical inputs with a structured 422 so the SPA
        # can fall back to uniform sizing without guessing.
        size_block = _build_column_block(
            ds=ds, cfg=cfg, spec=spec, df=df, column=size_by,
            attached_decorations=attached_decorations,
            cell_ids=cell_id_ints, mat_version=mat_version,
            error_code="size_column_unknown",
        )
        if size_block["kind"] != "numeric":
            raise ApiError(
                422,
                "size_column_not_numeric",
                f"size={size_by!r} is {size_block['kind']!r}; only numeric "
                "columns work for marker size",
            )
        payload["size"] = size_block

    return jsonify(payload)


@bp.route("/<ds>/embeddings/<embedding_id>/column/<path:column>", methods=["GET"])
@auth_required
def column(ds: str, embedding_id: str, column: str):
    """Single-column read for client-side filter / recolor / tooltip.

    Path
    ----
    ``column`` accepts the same two forms as ``/points``' ``color_by``:
    bare parquet column, or ``table.column`` for decoration. Uses ``path``
    converter on the route so ``.`` survives the URL match.

    Query params
    ------------
    Same as ``/points`` (``dec``, ``mv``).

    Response shape
    --------------
    ``{column, kind, source, values, resolution_stats?}``. Indexed
    positionally — same order as ``cell_ids`` from ``/points``. Cached
    per (column, mv) on the TanStack Query side; same caching surface the
    SPA already uses for ``/points``.
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
        spec = src.resolve(embedding_id)
    except KeyError as exc:
        raise ApiError(404, "embedding_not_found", str(exc)) from exc

    attached_decorations = _parse_csv(request.args.get("dec"))
    df = load_embedding_frame(ds, spec, cache_ds=cfg.cache_alias or ds)

    cell_id_ints = [int(v) for v in df[spec.id_column].tolist()]

    block = _build_column_block(
        ds=ds,
        cfg=cfg,
        spec=spec,
        df=df,
        column=column,
        attached_decorations=attached_decorations,
        cell_ids=cell_id_ints,
        mat_version=request.args.get("mv"),
    )
    # The /column endpoint surfaces the same fields as the /points
    # channel blocks (x/y/color/size), just at the top level. No reshaping.
    return jsonify(block)


@bp.route("/<ds>/embeddings/<embedding_id>/knn", methods=["POST"])
@auth_required
def knn(ds: str, embedding_id: str):
    """k-nearest-neighbor query in feature space.

    Request body
    ------------
    ``{cell_id, k?, feature_columns?}``

    - ``cell_id``: the query cell (int or string, both accepted).
    - ``k``: number of neighbors to return. Defaults to
      ``manifest.knn.default_k``; clamped to ``manifest.knn.max_k``.
    - ``feature_columns``: optional override of the kNN feature subset.
      When omitted, falls back to ``spec.feature_columns`` from the
      manifest, then to "all non-axis non-audit numerics" auto-derived
      from the parquet.

    For v1 this endpoint accepts cell_id only. ``root_id`` input (with
    reverse resolution via ``services/cell_id.py``) lands in the next
    task and currently returns 501.

    Response
    --------
    ``{query_cell_id, neighbors: [{cell_id, distance}, ...]}``. Both ids
    are stringified per project convention.
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
        spec = src.resolve(embedding_id)
    except KeyError as exc:
        raise ApiError(404, "embedding_not_found", str(exc)) from exc

    body = request.get_json(silent=True) or {}

    # Resolve the query cell_id. Accepts either a stable cell_id directly or
    # a root_id + mat_version pair that the resolver reverse-translates.
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

    feature_columns = body.get("feature_columns")  # None -> spec defaults
    if feature_columns is not None and not isinstance(feature_columns, list):
        raise ApiError(
            422,
            "invalid_feature_columns",
            "feature_columns must be a list of column names",
        )

    try:
        index = get_index(
            ds,
            spec,
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


@bp.route("/<ds>/embeddings/<embedding_id>/resolve_roots", methods=["POST"])
@auth_required
def resolve_roots(ds: str, embedding_id: str):
    """Batched cell_id → root_id resolve at a specific mat_version.

    Request body
    ------------
    ``{cell_ids: [int|str, ...], mat_version: int | "live"}``

    Both keys are required. Numeric strings are accepted for ids (the SPA
    treats ids as strings end-to-end). Empty list → empty resolutions
    array, no CAVE call.

    Response
    --------
    ``{mat_version, resolutions: [{cell_id, root_id|null, status, candidates?}]}``.
    Order matches the request. Status is ``ok`` / ``missing`` (v1 forward
    direction does not currently emit ``ambiguous``, but the field shape
    accepts it forward-compatibly).
    """
    cfg = load_datastack_config(ds)
    src = source_for(ds, cfg)
    if src is None:
        raise ApiError(
            404,
            "feature_explorer_disabled",
            f"datastack {ds!r} does not enable the feature explorer",
        )

    # Validate the embedding exists so a typo in the URL surfaces here
    # rather than after we've already round-tripped to CAVE.
    try:
        src.resolve(embedding_id)
    except KeyError as exc:
        raise ApiError(404, "embedding_not_found", str(exc)) from exc

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
    """Translate the /knn body's ``cell_id`` or ``root_id`` into a cell_id.

    Accepts either:

    - ``cell_id`` (int or numeric string): used directly.
    - ``root_id`` + ``mat_version``: reverse-resolved through the resolver.

    Raises ``ApiError`` with structured codes the SPA can branch on:
    ``missing_id``, ``invalid_cell_id``, ``invalid_root_id``,
    ``missing_mat_version`` (root_id without mat_version),
    ``root_id_unresolved`` (resolver returned None).
    """
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
    """Build a CAVE client with the request's auth context.

    Centralized so the (typically two) callers in this file don't drift on
    the no-auth-token error path.
    """
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
    """Wire-format projection of a Resolution. Ids are stringified; the
    ``candidates`` field is included only when non-empty."""
    out: dict[str, Any] = {
        "cell_id": str(r.cell_id),
        "root_id": str(r.root_id) if r.root_id is not None else None,
        "status": r.status,
    }
    if r.candidates:
        out["candidates"] = [str(c) for c in r.candidates]
    return out


def _spec_summary(spec: EmbeddingSpec) -> dict[str, Any]:
    """Public-API projection of an EmbeddingSpec.

    Drops ``source.uri`` (internal storage detail, no UI value) and reduces
    ``audit`` to a boolean ``has_audit`` flag — the actual audit *values* per
    cell surface through ``/column`` once that endpoint lands, not by sending
    the column names in the catalog response.
    """
    return {
        "id": spec.id,
        "title": spec.title,
        "description": spec.description,
        "axes": spec.axes,
        "id_column": spec.id_column,
        "default_color_by": spec.default_color_by,
        "feature_columns": spec.feature_columns,
        "categorical_columns": spec.categorical_columns,
        "has_audit": spec.audit is not None,
    }


def _numeric_list(s: pd.Series) -> list[float | None]:
    """Convert a numeric Series to a JSON-safe list.

    NumpyJSONProvider already maps ``pd.NA`` and non-finite floats to null,
    but it triggers via ``default()`` only for non-stdlib types. Bare Python
    ``float('nan')`` returned from ``tolist()`` falls through and Flask
    emits the literal ``NaN`` (invalid JSON). Doing the substitution here
    is belt-and-suspenders, and gives a single place to enforce the rule
    when decoration columns start producing nulls.
    """
    return [
        None if (v is None or (isinstance(v, float) and not math.isfinite(v))) else float(v)
        for v in s.tolist()
    ]


def _build_column_block(
    *,
    ds: str,
    cfg,
    spec: EmbeddingSpec,
    df: pd.DataFrame,
    column: str,
    attached_decorations: list[str],
    cell_ids: list[int],
    mat_version: str | None,
    error_code: str = "column_unknown",
) -> dict[str, Any]:
    """Resolve one column to a ``{kind, source, column, values, ...}``
    block, dispatching parquet vs decoration based on the name shape.

    Used by every channel that takes a column (x, y, color, size) — the
    block shape is identical, only how the SPA *uses* the values differs.

    Bare name → loaded from the cached frame, no CAVE call. ``table.column``
    → joined through the resolver + decoration cache at ``mat_version``.

    ``error_code`` is passed-through into the structured 404 so callers
    (one per channel) can distinguish "the x column was bad" from "the
    color column was bad" in the SPA's error display.

    Errors raised as ``ApiError`` so they map cleanly to HTTP codes:

    - 404 ``<error_code>``: bare column not present in the parquet.
    - 422 ``decoration_table_not_attached``: ``table.column`` form but the
      table isn't in ``?dec=``.
    - 422 ``missing_mat_version``: decoration source without ``?mv=``.
    """
    if "." in column:
        return _decoration_column_block(
            ds=ds,
            cfg=cfg,
            column=column,
            attached_decorations=attached_decorations,
            cell_ids=cell_ids,
            mat_version=mat_version,
        )

    if column not in df.columns:
        raise ApiError(
            404,
            error_code,
            f"column={column!r} is not in this embedding "
            f"(available: {sorted(df.columns)})",
        )
    return _series_column_block(df[column], column, source="parquet")


def _decoration_column_block(
    *,
    ds: str,
    cfg,
    column: str,
    attached_decorations: list[str],
    cell_ids: list[int],
    mat_version: str | None,
) -> dict[str, Any]:
    """Build a column block for a ``table.column`` spec.

    Routes the projection through ``join_decoration_column`` so the
    cell_id → root_id resolution + decoration snapshot fetch is the same
    machinery the rest of the app uses for connectivity decorations.
    """
    table, _, decoration_column = column.partition(".")
    if table not in attached_decorations:
        raise ApiError(
            422,
            "decoration_table_not_attached",
            f"column={column!r} requires `{table}` in ?dec= "
            f"(attached: {attached_decorations or '[]'})",
        )
    if mat_version is None:
        raise ApiError(
            422,
            "missing_mat_version",
            "decoration-sourced column requires ?mv=<int|live>",
        )

    try:
        check_live_allowed(ds, mat_version)
    except ValueError as exc:
        raise ApiError(422, "live_mode_disallowed", str(exc)) from exc

    # Build a client_factory so the decoration service's eventual
    # background revalidation paths get a fresh client; the immediate
    # call captures the request's auth context once.
    auth_token = current_token()
    dev_bypass = is_dev_bypass()
    server_address = current_app.config["GLOBAL_SERVER_ADDRESS"]

    def client_factory():
        return request_client(
            datastack_name=ds,
            server_address=server_address,
            auth_token=auth_token,
            dev_bypass=dev_bypass,
            materialize_version=mat_version,
        )

    try:
        values, stats = join_decoration_column(
            client_factory=client_factory,
            cfg=cfg,
            ds=ds,
            mat_version=mat_version,
            table=table,
            column=decoration_column,
            cell_ids=cell_ids,
        )
    except ValueError as exc:
        raise ApiError(422, "lookup_unavailable", str(exc)) from exc
    except Exception as exc:
        raise ApiError(
            502, "cave_upstream", f"{type(exc).__name__}: {exc}"
        ) from exc

    return _serialize_join_values(
        values, column, source="decoration", resolution_stats=stats
    )


def _series_column_block(s: pd.Series, column: str, *, source: str) -> dict[str, Any]:
    """Shape the color payload from a pandas Series. Infers categorical
    vs numeric from dtype; bool treated as categorical (3 states).
    """
    if pd.api.types.is_numeric_dtype(s) and not pd.api.types.is_bool_dtype(s):
        return {
            "kind": "numeric",
            "column": column,
            "source": source,
            "values": _numeric_list(s),
        }

    values: list[Any] = []
    for v in s.tolist():
        values.append(_clean_categorical(v))
    return {
        "kind": "categorical",
        "column": column,
        "source": source,
        "values": values,
    }


def _serialize_join_values(
    values: list[Any], column: str, *, source: str, resolution_stats: dict[str, int]
) -> dict[str, Any]:
    """Shape the color payload from a list of joined values + stats.

    The join already returned positional values; dtype isn't known at this
    point so we infer from the first non-None entry. An all-null column
    falls back to categorical (no semantically-meaningful color either way).
    """
    sample = next((v for v in values if v is not None), None)
    is_numeric = isinstance(sample, (int, float)) and not isinstance(sample, bool)

    if is_numeric:
        cleaned = [
            None if (v is None or (isinstance(v, float) and not math.isfinite(v))) else float(v)
            for v in values
        ]
        kind = "numeric"
    else:
        cleaned = [_clean_categorical(v) for v in values]
        kind = "categorical"

    return {
        "kind": kind,
        "column": column,
        "source": source,
        "values": cleaned,
        "resolution_stats": resolution_stats,
    }


def _clean_categorical(v: Any) -> Any:
    """Categorical-value normalizer: null forms → None, primitives pass
    through, everything else stringifies."""
    if v is None or v is pd.NA or (isinstance(v, float) and math.isnan(v)):
        return None
    if isinstance(v, (str, bool, int)):
        return v
    return str(v)


def _parse_csv(raw: str | None) -> list[str]:
    """Parse ``?dec=foo,bar,baz`` → ``["foo", "bar", "baz"]``. Empty string
    or missing → empty list."""
    if not raw:
        return []
    return [item.strip() for item in raw.split(",") if item.strip()]
