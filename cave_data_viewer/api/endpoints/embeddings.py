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
from flask import Blueprint, jsonify, request

from ..auth import auth_required
from ..errors import ApiError
from ..services.datastack_config import load_datastack_config
from ..services.embeddings import (
    EmbeddingSpec,
    get_index,
    load_embedding_frame,
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
    color_by
        Column to populate the ``color`` block with. Defaults to
        ``spec.default_color_by``. v1 accepts only parquet-native columns;
        decoration-table columns (``table.column``) are rejected with a
        501 here — they're a follow-up task. When neither query nor default
        names a color column the ``color`` block is omitted.

    Response shape
    --------------
    ``{cell_ids, x, y, color?}``. Parallel arrays — keeps the wire size
    sub-MB even for 500k-row embeddings (column-arrays vs per-point objects
    is ~10x smaller in JSON).
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

    color_by = request.args.get("color_by") or spec.default_color_by

    df = load_embedding_frame(ds, spec, cache_ds=cfg.cache_alias or ds)

    if color_by and color_by not in df.columns:
        if "." in color_by:
            # `table.column` form — decoration-sourced color isn't wired
            # in v1; reject with a code the SPA can branch on.
            raise ApiError(
                501,
                "decoration_color_not_implemented",
                f"color_by={color_by!r}: decoration-table color is not yet "
                "implemented; pass a parquet-native column for now.",
            )
        raise ApiError(
            404,
            "color_column_unknown",
            f"color_by={color_by!r} is not a column in this embedding "
            f"(available: {sorted(df.columns)})",
        )

    payload: dict[str, Any] = {
        "cell_ids": [str(v) for v in df[spec.id_column].tolist()],
        "x": _numeric_list(df[spec.axes[0]]),
        "y": _numeric_list(df[spec.axes[1]]),
    }
    if color_by:
        payload["color"] = _color_block(df[color_by], color_by, source="parquet")
    return jsonify(payload)


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

    if "root_id" in body and "cell_id" not in body:
        raise ApiError(
            501,
            "root_id_knn_not_implemented",
            "root_id input is a follow-up task; pass cell_id for now",
        )

    if "cell_id" not in body:
        raise ApiError(
            422, "missing_cell_id", "request body must include `cell_id`"
        )

    try:
        cell_id = int(body["cell_id"])
    except (TypeError, ValueError) as exc:
        raise ApiError(
            422,
            "invalid_cell_id",
            f"cell_id must be an integer or numeric string, got {body['cell_id']!r}",
        ) from exc

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


# -- internals ----------------------------------------------------------------


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


def _color_block(s: pd.Series, column: str, *, source: str) -> dict[str, Any]:
    """Shape the color payload. Infers ``categorical`` vs ``numeric`` from
    the column's dtype.

    ``bool`` dtype is treated as categorical (three states: True/False/None)
    so the SPA can pick a 2-color palette for it. Strings, object, and
    pandas Categorical all flow through the categorical branch with
    null-preserving conversion.
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
        if v is None or v is pd.NA or (isinstance(v, float) and math.isnan(v)):
            values.append(None)
        elif isinstance(v, (str, bool, int)):
            values.append(v)
        else:
            values.append(str(v))
    return {
        "kind": "categorical",
        "column": column,
        "source": source,
        "values": values,
    }
