from concurrent.futures import ThreadPoolExecutor

from cachetools.keys import hashkey
from flask import Blueprint, current_app, jsonify, request

from ..auth import auth_required, current_token, is_dev_bypass
from ..caches import table_meta_cache
from ..cave import request_client
from ..errors import ApiError
from ..services.cache_lifecycle import cache_datastack
from ..services.datastack_config import (
    cached_datastack_info,
    latest_valid_mat_version,
    load_datastack_config,
)
from ..services.keys import is_live

bp = Blueprint("datastacks", __name__, url_prefix="/datastacks")


@bp.route("", methods=["GET"])
@bp.route("/", methods=["GET"])
@auth_required
def list_datastacks():
    """Allowlisted datastacks the SPA picker should offer.

    Returns the configured `DATASTACKS_ALLOWED` list verbatim; endpoints
    themselves don't enforce it (CAVE auth is the security boundary), but
    surfacing only this set in the picker keeps users from accidentally
    pointing the SPA at something the operator hasn't characterized for
    spatial / cell-id / synapse-table conventions.
    """
    allowed = current_app.config.get("DATASTACKS_ALLOWED") or []
    return jsonify({"datastacks": list(allowed)})


def _client_for(ds: str) -> "object":
    mat_version = request.args.get("mat_version") or None
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


@bp.route("/<ds>/info")
@auth_required
def info(ds: str):
    client = _client_for(ds)
    # 24h cache covers all the fields below; a warm pod serves /info
    # without an info-service round-trip. None if CAVE's info service
    # is unreachable or the datastack is unconfigured — we still return
    # a useful payload (datastack name + live_mode) so the SPA doesn't
    # crash on partial responses.
    info_dict = cached_datastack_info(ds, client) or {}
    cfg = load_datastack_config(ds)
    return jsonify({
        "datastack": ds,
        "aligned_volume": info_dict.get("aligned_volume", {}),
        "viewer_site": info_dict.get("viewer_site"),
        "soma_table": info_dict.get("soma_table"),
        "synapse_table": info_dict.get("synapse_table"),
        "voxel_resolution": info_dict.get("viewer_resolution_x") and [
            info_dict.get("viewer_resolution_x"),
            info_dict.get("viewer_resolution_y"),
            info_dict.get("viewer_resolution_z"),
        ],
        "live_mode": cfg.live_mode,
    })


@bp.route("/<ds>/versions")
@auth_required
def versions(ds: str):
    cache_key = hashkey("versions", ds)
    if cache_key in table_meta_cache:
        return jsonify(table_meta_cache[cache_key])
    try:
        client = _client_for(ds)
        metadata = client.materialize.get_versions_metadata()
    except ApiError:
        raise
    except Exception as exc:
        raise ApiError(502, "cave_upstream", str(exc)) from exc
    out = []
    for entry in metadata:
        out.append({
            "version": entry["version"],
            "expires_on": entry["expires_on"].isoformat() if entry.get("expires_on") else None,
            "valid": entry.get("valid", True),
        })
    out.sort(key=lambda v: v["version"], reverse=True)
    payload = {"versions": out}
    table_meta_cache[cache_key] = payload
    return jsonify(payload)


# Fields surfaced on the table-list response. Restricting the projection at
# this layer (rather than passing every metadata field through) keeps the SPA
# contract narrow — adding a field upstream in CAVE doesn't accidentally
# leak through, and the wire payload stays tight even when the metadata dict
# carries permission flags / internal bookkeeping we don't need.
_METADATA_FIELDS = ("description", "schema_type", "reference_table", "voxel_resolution")


def _project_metadata(meta: dict) -> dict:
    """Pull just the SPA-facing fields from a CAVE metadata dict."""
    out = {k: meta.get(k) for k in _METADATA_FIELDS}
    # row_count surfaces as `valid_row_count` upstream; rename to the shorter
    # form for the wire so the SPA can reuse it across tables and views
    # (views have row counts under the same key in the view-metadata API).
    if meta.get("valid_row_count") is not None:
        out["row_count"] = int(meta["valid_row_count"])
    else:
        out["row_count"] = None
    return out


# Per-view metadata fetch is serial in CAVEclient (no batch endpoint), so we
# parallelize across views and cache each result individually. Pool size is
# small enough not to hammer CAVE on datastacks with dozens of views.
_VIEW_METADATA_WORKERS = 8


def _fetch_view_metadata(client, ds: str, mat_version: int, view_name: str) -> dict | None:
    """Fetch one view's metadata and project it. Caches per-(ds, mv, view)
    so a future request hits the per-view cache even if the list-level
    cache rolls over. Failures return None and are NOT cached — descriptions
    aren't critical, so we'd rather retry than serve a stale negative.
    """
    cache_key = hashkey("view_metadata", ds, mat_version, view_name)
    cached = table_meta_cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        meta = client.materialize.get_view_metadata(view_name)
    except Exception:
        return None
    if not isinstance(meta, dict):
        return None
    projected = _project_metadata(meta)
    table_meta_cache[cache_key] = projected
    return projected


@bp.route("/<ds>/tables")
@auth_required
def tables(ds: str):
    mv_raw = request.args.get("mat_version") or None
    live_mode = is_live(mv_raw)
    # Cache key uses the literal request mode ("live" or the integer version)
    # so live and v<N> stay separate cache entries — the response payload
    # mirrors the requested `mat_version` field and we don't want one to
    # poison the other even when their internal table set is the same.
    cache_key = hashkey("tables_and_views", ds, "live" if live_mode else int(mv_raw))
    if cache_key in table_meta_cache:
        return jsonify(table_meta_cache[cache_key])
    try:
        client = _client_for(ds)
    except ApiError:
        raise
    except Exception as exc:
        raise ApiError(502, "cave_upstream", str(exc)) from exc

    # Live-mode substitution. CAVE doesn't surface a stable "live" table set
    # (views are unavailable; descriptions need a version); pinning the
    # listing to the latest valid mat version is "close enough for a front
    # end" — the user requested a browsing view, not a precise snapshot of
    # the live state. The response still reports `mat_version: null` so the
    # SPA URL stays canonical (`?mv=live`); only the internal CAVE call uses
    # the substituted version.
    effective_version: int | None
    if live_mode:
        effective_version = latest_valid_mat_version(client)
        if effective_version is None:
            raise ApiError(
                502, "no_valid_mat_versions",
                f"No valid materialization versions available for datastack {ds!r} — "
                f"cannot resolve 'live' to a concrete table set.",
            )
        client.materialize.version = effective_version
    else:
        effective_version = int(mv_raw)

    try:
        table_names = client.materialize.get_tables()
    except Exception as exc:
        raise ApiError(502, "cave_upstream", str(exc)) from exc

    # Fetch table metadata in one batch call against the effective version.
    # Failures are non-fatal — the table list is more important than the
    # description sidecar.
    table_meta_by_name: dict[str, dict] = {}
    try:
        for entry in client.materialize.get_tables_metadata(version=effective_version):
            name = entry.get("table_name")
            if name:
                table_meta_by_name[name] = entry
    except Exception:
        table_meta_by_name = {}

    items: list[dict] = []
    for name in sorted(table_names):
        item = {"name": name, "kind": "table"}
        meta = table_meta_by_name.get(name)
        if meta:
            item.update(_project_metadata(meta))
        items.append(item)

    # Views are listed only for explicit-version requests. In live mode we
    # deliberately skip them: CAVE doesn't support live_query against views
    # (joins require a materialized snapshot), so a view that appears in
    # the listing would only confuse the user when clicking it falls back
    # to a stale-by-construction integer version. Tables in live mode use
    # live_query natively, so they're listed unchanged.
    if not live_mode:
        try:
            view_names = client.materialize.get_views()
        except Exception:
            view_names = []
        view_names = sorted(view_names)
        if view_names:
            with ThreadPoolExecutor(
                max_workers=min(_VIEW_METADATA_WORKERS, len(view_names))
            ) as pool:
                view_meta = list(pool.map(
                    lambda v: _fetch_view_metadata(client, ds, effective_version, v),
                    view_names,
                ))
            for name, meta in zip(view_names, view_meta):
                item = {"name": name, "kind": "view"}
                if meta:
                    item.update(meta)
                items.append(item)
    # Mirror the requested mode in the response so the SPA's "tables (live)"
    # / "v<N>" hint reads correctly. The `effective_version` field discloses
    # the substituted version when live was requested — handy for debugging
    # and for the SPA to show "showing v<N>" when it wants to.
    payload = {
        "tables": items,
        "mat_version": None if live_mode else effective_version,
        "effective_mat_version": effective_version,
    }
    table_meta_cache[cache_key] = payload
    return jsonify(payload)


@bp.route("/<ds>/tours")
@auth_required
def tours(ds: str):
    """Operator-curated examples + recipes for the landing page.

    Pure passthrough of `examples` / `recipes` from the per-datastack YAML.
    No URL minting on the server — the SPA owns URL construction so the
    URL-state conventions (`?ds`, `?mv`, `?root`, `?dec`, `?plots`,
    `?viz_<id>`, `?cells`, `?hide`, `?show`, `?coll`) live in one place.

    Auth-gated so the response inherits the same access policy as the
    rest of `/datastacks/<ds>/*`. Cheap on the wire and the data is
    YAML-static, so no server-side cache layer needed — Pydantic dump
    is fast enough that a per-request serialize is fine.
    """
    cfg = load_datastack_config(ds)
    return jsonify({
        "datastack": ds,
        "examples": [e.model_dump(mode="json") for e in cfg.examples],
        "recipes": [r.model_dump(mode="json") for r in cfg.recipes],
    })


@bp.route("/<ds>/tables/<table>/values")
@auth_required
def table_values(ds: str, table: str):
    """Full-table distinct-string-values lookup, used to populate the SPA's
    category filter dropdowns. Returns `{table, values: {col: [str, ...]}}`
    where each list is the complete universe for that string column.

    In live mode the call is run against the latest valid materialization
    version (CAVE doesn't expose this without a concrete version, and
    distinct-value sets are stable enough across versions that the
    substitution is honest — same trade-off as the table-listing endpoint).
    """
    mv_raw = request.args.get("mat_version") or None
    live_mode = is_live(mv_raw)
    client = _client_for(ds)
    if live_mode:
        latest = latest_valid_mat_version(client)
        if latest is None:
            raise ApiError(
                502, "no_valid_mat_versions",
                f"No valid materialization versions available for {ds!r} — "
                f"cannot resolve 'live' to a unique-values lookup.",
            )
        client.materialize.version = latest
    # `dcv_unique_values_cache` is a `LayeredSwrCache(immutable=True)`:
    # for materialized versions the values are frozen at
    # `materialize.create()` time, so the cached entry is bit-identical
    # to a re-fetch. Bucket lifecycle handles expiry.
    #
    # Stores the bare `{column: [values]}` dict — the same shape
    # `services/categorical.py` writes — so both consumers share one
    # cache entry rather than racing on differently-prefixed keys.
    # The `{table, values}` payload is shaped here at read time.
    cache_version = client.materialize.version
    cache_key = (cache_datastack(ds), cache_version, table)
    cache = current_app.extensions["dcv_unique_values_cache"]
    hit = cache.get(cache_key)
    if hit is not None:
        return jsonify({"table": table, "values": hit[0]})
    try:
        values = client.materialize.get_unique_string_values(table)
    except Exception as exc:
        raise ApiError(502, "cave_upstream", str(exc)) from exc
    values = values or {}
    cache.set(cache_key, values)
    return jsonify({"table": table, "values": values})
