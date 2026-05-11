import re

import pandas as pd
from flask import Blueprint, current_app, jsonify, request

from ..auth import auth_required, current_token, is_dev_bypass
from ..cave import request_client
from ..errors import ApiError
from ..services.datastack_config import cached_datastack_info, latest_valid_mat_version
from ..services.keys import is_live
from ..services.tables import TableQuery, parse_filters


def _to_string_id(v):
    """Convert one cell value to a string id, preserving null. Cast through
    `int(v)` first so a numpy int64 / pandas nullable Int64 / float-with-no-
    fraction all round-trip to the canonical decimal string with no `.0`
    suffix or scientific notation."""
    if v is None or pd.isna(v):
        return None
    try:
        return str(int(v))
    except (TypeError, ValueError):
        return str(v)


# Match any column name that reads as an opaque integer id:
#   - `id`                        (table primary key)
#   - `*_id`                      (FKs, root_id, supervoxel_id, cell_id, …)
#   - `id_ref`, `*_id_ref`        (the joined-row id from a reference-table
#                                   query; same precision concerns as the
#                                   un-suffixed form, just on a joined column)
# `(?:^|_)id(?:_ref)?$` rejects `created_ref`, `valid_ref` (no `id` segment),
# but matches the four shapes above.
_ID_COLUMN_PATTERN = re.compile(r"(?:^|_)id(?:_ref)?$")


def _stringify_id_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Stringify any column whose name reads as an opaque integer id —
    `id`, `pt_root_id`, `pre_pt_supervoxel_id`, `cell_id`, `target_id`,
    `id_ref`, `*_id_ref`.

    int64 values larger than 2^53 lose precision when JavaScript parses
    them as `Number` (float64), so root_ids and supervoxel_ids regularly
    arrive at the SPA *wrong* unless we serialize them as JSON strings.
    Connectivity endpoints already do this manually for `root_id`; this
    helper extends the same rule to every id-shaped column the rows
    endpoint might serve, including ones we didn't anticipate (custom
    views, new annotation schemas).

    Frontend convention (see `plots/columns.ts::isIdShaped` and the
    CLAUDE.md note "Root IDs are strings end-to-end") matches: id-shaped
    cells are rendered as opaque copy-able strings, never `Number()`-coerced.
    """
    for col in df.columns:
        if _ID_COLUMN_PATTERN.search(col):
            df[col] = df[col].apply(_to_string_id)
    return df

# Default and ceiling for the per-table row limit. The default is large
# enough that every typical CAVE table (10–100k rows) fits in a single
# request; the ceiling matches CAVE's own backend cap, so a power user can
# `?limit=200000` if they really need it. The SPA stays at the default and
# uses server-side filters to narrow when the cap actually fires.
_DEFAULT_ROW_LIMIT = 20_000
_MAX_ROW_LIMIT = 200_000


bp = Blueprint("table_rows", __name__, url_prefix="/datastacks")


def _client_for(ds: str):
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


@bp.route("/<ds>/tables/<table>/rows", methods=["GET"])
@auth_required
def rows(ds: str, table: str):
    args = request.args.to_dict(flat=True)
    offset = int(args.get("offset", 0))
    raw_limit = int(args.get("limit", _DEFAULT_ROW_LIMIT))
    # Clamp to [1, _MAX_ROW_LIMIT] so a malformed query can't ask for an
    # absurd number of rows. The clamp is silent — the response carries
    # `limit` reflecting what we actually used, so the SPA can detect the
    # adjustment if it cares.
    limit = max(1, min(raw_limit, _MAX_ROW_LIMIT))
    select_columns_raw = args.get("select_columns")
    select_columns = [c.strip() for c in select_columns_raw.split(",")] if select_columns_raw else None
    is_view_raw = args.get("is_view")
    is_view = is_view_raw.lower() in {"1", "true", "yes"} if is_view_raw is not None else None

    mat_version = args.get("mat_version") or None

    client = _client_for(ds)
    filters = parse_filters(args)

    # In live mode, pre-resolve the latest valid mat version and stamp it on
    # the client. Setting `client.materialize.version` is what makes
    # `get_views()` / `get_tables_metadata()` work (those need a concrete
    # materialization); it does NOT affect `.live_query()`, which uses a
    # timestamp instead of the version field, so tables in live mode still
    # query the live timestamp correctly below.
    if is_live(mat_version):
        latest = latest_valid_mat_version(client)
        if latest is None:
            raise ApiError(
                502, "no_valid_mat_versions",
                f"No valid materialization versions available for {ds!r} — "
                f"cannot resolve 'live' to a concrete row set.",
            )
        client.materialize.version = latest

    # Detect whether the target is a view. The SPA's `is_view` query param
    # wins when present; otherwise fall back to a CAVE lookup. With the
    # version stamp above, `get_views()` works even in live mode.
    detected_is_view: bool
    if is_view is not None:
        detected_is_view = is_view
    else:
        try:
            detected_is_view = table in client.materialize.get_views()
        except Exception:
            detected_is_view = False

    # mat_version dispatch: tables in live mode go through `.live_query()`
    # (live timestamp at the CAVE layer — exactly what the user asked for
    # when they picked "live"); views in live mode fall back to `.query()`
    # against the substituted latest version because CAVE doesn't support
    # live joins. Materialized requests pass through unchanged.
    mat_version_for_query: int | str | None = mat_version
    if is_live(mat_version) and detected_is_view:
        mat_version_for_query = client.materialize.version

    try:
        tq = TableQuery(
            client, table, filters=filters,
            is_view=detected_is_view,
            mat_version=mat_version_for_query,
        )
    except ValueError as exc:
        raise ApiError(422, "invalid_query", str(exc)) from exc

    # Pull positions in the datastack's viewer_resolution so a row's
    # `*_pt_position_x/y/z` triple drops straight into a Neuroglancer URL
    # without any nm conversion. Reads from the long-TTL
    # `dcv_datastack_info_cache` (24h) so warm pods skip the info-service
    # round-trip entirely. The viewer-resolution components are stable
    # properties of the datastack, so caching with the rest of
    # datastack-info is correct. Failures fall back to the table's
    # native resolution — better to serve rows in surprising units than
    # to refuse the page.
    info_dict = cached_datastack_info(ds, client) or {}
    rx = info_dict.get("viewer_resolution_x")
    ry = info_dict.get("viewer_resolution_y")
    rz = info_dict.get("viewer_resolution_z")
    if rx is not None and ry is not None and rz is not None:
        desired_resolution = [float(rx), float(ry), float(rz)]
    else:
        desired_resolution = None

    try:
        df = tq.rows(
            offset=offset, limit=limit,
            select_columns=select_columns,
            desired_resolution=desired_resolution,
        )
    except KeyError as exc:
        raise ApiError(404, "table_not_found", f"No such table or view: {table}") from exc
    except Exception as exc:
        raise ApiError(502, "cave_upstream", str(exc)) from exc

    # Strip dynamic-annotation-engine bookkeeping columns:
    #   - `superceded_id`: points at the row that replaced this one. A row
    #     carrying a non-null value shouldn't be served at all (it's been
    #     replaced upstream); the deeper fix is to filter those rows out.
    #   - `deleted` / `deleted_ref`: the soft-delete tombstone flag (and
    #     its reference-table-join twin), internal-only.
    # The SPA has no use for any of these; drop them from the response in
    # all cases. `errors="ignore"` keeps this safe for tables and views
    # that don't have the columns in the first place.
    df = df.drop(
        columns=["superceded_id", "deleted", "deleted_ref"],
        errors="ignore",
    )

    # Stringify int64 id columns before serialization — see helper docstring.
    df = _stringify_id_columns(df)

    row_count = int(df.shape[0])
    # `limit_hit` is the SPA's signal that the response was truncated and
    # may be missing matching rows beyond the cap. The signal is necessarily
    # heuristic — CAVE doesn't return a separate "total matching count" we
    # could compare against — so we treat "exactly limit rows returned" as
    # "probably truncated." False negatives are possible (a table with
    # exactly 20,000 matching rows would falsely flag) but that's a rare
    # collision and the SPA's response (a partial-data disclosure pill) is
    # appropriate either way.
    limit_hit = row_count >= limit

    return jsonify({
        "datastack": ds,
        "table": table,
        "is_view": tq.is_view,
        "offset": offset,
        "limit": limit,
        "filters": filters,
        "row_count": row_count,
        "limit_hit": limit_hit,
        "columns": list(df.columns),
        "rows": df.to_dict(orient="records"),
    })
