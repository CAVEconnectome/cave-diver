"""Stale-while-revalidate decorations for cell-type and per-root-id soma counts.

Both kinds are cached as full per-(ds, mv, table) snapshots — a `dict[int, value]`
that maps every root_id in the table to its decoration value. Caching at this
granularity (one entry per table, not per root_id) means cross-navigation hits
reuse the same in-memory dict, and revalidation is one CAVE call regardless of
how many root_ids the request touched.
"""

import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Literal

import pandas as pd
from cachetools import TTLCache
from flask import current_app

from .keys import is_live
from .query_runner import run_query
from .request_state import current_timestamp
from .tables import is_view_name
from .timing import current_stages, timer


def _decoration_query_factory(client, name: str, mat_version, **filters):
    """Return a CAVE query factory for `name`, dispatched to the right
    manager (``views`` for views, ``tables`` for tables).

    Decoration tables are operator-configured at the YAML / URL layer and
    can resolve to either a CAVE table or a materialized view (e.g.
    `aibs_cell_info` is a view). `client.materialize.tables[<view>]`
    raises ``AttributeError: 'TableManager' object has no attribute ...``
    for views, so the fetchers must dispatch.

    Views have no `live_query` and only exist in materialized mode —
    matches the rule enforced by `TableQuery` and documented in CLAUDE.md.
    Raise ``ValueError`` here so the endpoint translates to a 422 instead
    of a 502.
    """
    if is_view_name(client, name):
        if is_live(mat_version):
            raise ValueError(
                f"View {name!r} is only available in materialized mode; "
                "pass an explicit mat_version to use it as a decoration source."
            )
        mgr = client.materialize.views
    else:
        mgr = client.materialize.tables
    return mgr[name](**filters)

import datetime as _dt
import logging

from flask import g

logger = logging.getLogger("cdv.decoration")


_TICKET_TTL_SECONDS = 5 * 60


class DecorationService:
    """Holds the SWR caches, ticket store, and worker pool for one Flask app."""

    def __init__(self, app):
        from .swr import LayeredSwrCache  # local import: avoid cycles at module-load time
        from .revalidation import RevalidationExecutor
        from .warmup import PeriodicWarmer
        from .cache_lifecycle import retention_class_for
        from .object_store import build_l2_stores

        self._app = app
        # Two distinct executors:
        # - `self.executor` (RevalidationExecutor): runs decoration
        #   revalidation closures (`_refresh_soma`, `_refresh_table`)
        #   which need a Flask app context (CAVEclient setup) and
        #   per-key dedup (avoid stampeding refetches on the same
        #   (ds, mv, table) snapshot).
        # - `dcv_l2_writer` (plain ThreadPoolExecutor, owned by
        #   `_init_l2_infrastructure`): used by every LayeredSwrCache
        #   for fire-and-forget L2 writes. L2 writes don't need app
        #   context and are idempotent for a given cache key, so the
        #   simpler executor is the right tool.
        self.executor = RevalidationExecutor(
            app, max_workers=app.config["DECORATION_REVALIDATION_WORKERS"]
        )
        l2_writer = app.extensions.get("dcv_l2_writer")
        l2 = build_l2_stores(app)  # {} when GCS_CACHE_BUCKET is unset

        # Retention resolver — consulted on every L2 read/write to pick
        # `default` vs `longlived`. Decoration cache keys are tuples
        # `(ds, mat_version, table)`; we pull (ds, mv) and let the
        # longlived registry decide. The resolver closes over the running
        # app so it can lazily fetch the registry from extensions.
        def _resolve_retention(key) -> str:
            if not isinstance(key, tuple) or len(key) < 2:
                return "default"
            ds, mat_version = key[0], key[1]
            registry = app.extensions.get("dcv_longlived_registry")
            if registry is None:
                return "default"
            return retention_class_for(registry, ds, mat_version)

        # Per-kind L2 dicts keyed by retention class. When `l2` is empty
        # (no GCS), `_l2_for_kind` returns None and the LayeredSwrCache
        # short-circuits to L1-only.
        def _l2_for_kind(kind: str):
            if not l2:
                return None
            return {retention: l2[retention][kind] for retention in l2}

        # Both modes use LayeredSwrCache; live-mode caches just pass `l2=None`
        # to short-circuit the disk layer. Short live-mode TTLs (seconds–
        # minutes) make a GCS round-trip a net loss on those reads, and a
        # snapshot of "live" data is meaningless across pod restarts anyway.
        # `LayeredSwrCache(l2=None)` is bit-identical to a plain SwrCache —
        # see `_resolve_l2_store` early-out — so this is purely a cache-
        # primitive consolidation, no behavior change.
        #
        # Two caches: `num_soma_*` (per-soma-table count + cell_id summary)
        # and `table_decorations_*` (generic annotation table snapshot).
        # Every annotation table the SPA names in `decoration_tables` —
        # including cell-type tables — uses the generic table cache; there's
        # no longer a dedicated cell_type cache slot since the wire format
        # and processing are identical to any other decoration table.
        self.num_soma_mat = LayeredSwrCache(
            soft_ttl=app.config["CACHE_DECORATION_SOFT_TTL_SECONDS"],
            hard_ttl=app.config["CACHE_DECORATION_HARD_TTL_SECONDS"],
            l2=_l2_for_kind("num_soma"),
            executor=l2_writer,
            retention_resolver=_resolve_retention,
        )
        self.num_soma_live = LayeredSwrCache(
            soft_ttl=app.config["CACHE_DECORATION_LIVE_SOFT_TTL_SECONDS"],
            hard_ttl=app.config["CACHE_DECORATION_LIVE_HARD_TTL_SECONDS"],
            l2=None,
        )
        self.table_decorations_mat = LayeredSwrCache(
            soft_ttl=app.config["CACHE_DECORATION_SOFT_TTL_SECONDS"],
            hard_ttl=app.config["CACHE_DECORATION_HARD_TTL_SECONDS"],
            maxsize=64,  # # of distinct (ds, mv, table) snapshots in memory
            l2=_l2_for_kind("table"),
            executor=l2_writer,
            retention_resolver=_resolve_retention,
        )
        self.table_decorations_live = LayeredSwrCache(
            soft_ttl=app.config["CACHE_DECORATION_LIVE_SOFT_TTL_SECONDS"],
            hard_ttl=app.config["CACHE_DECORATION_LIVE_HARD_TTL_SECONDS"],
            maxsize=64,
            l2=None,
        )
        # Tickets: short-lived per-request snapshots so the SPA's poll can compute deltas.
        self.tickets: TTLCache = TTLCache(maxsize=4096, ttl=_TICKET_TTL_SECONDS)
        self.warmer = PeriodicWarmer(app)

    def cache_for(self, kind: Literal["num_soma", "table"], live: bool):
        if kind == "table":
            return self.table_decorations_live if live else self.table_decorations_mat
        return self.num_soma_live if live else self.num_soma_mat

    # --- Tickets --------------------------------------------------------------

    def mint_ticket(self, *, ds: str, mat_version: int | str | None,
                    soma_table: str | None,
                    served: dict[int, dict]) -> str:
        ticket_id = uuid.uuid4().hex
        self.tickets[ticket_id] = {
            "ds": ds,
            "mat_version": mat_version,
            "soma_table": soma_table,
            "served": served,
            "minted_at": time.time(),
        }
        return ticket_id

    def poll_ticket(self, ticket_id: str) -> dict:
        from .cache_lifecycle import cache_datastack

        ticket = self.tickets.get(ticket_id)
        if ticket is None:
            return {"status": "expired"}
        live = is_live(ticket["mat_version"])
        soma_table = ticket["soma_table"]
        ds = ticket["ds"]
        # Cache namespace alias: must match `lookup_decorations` writes,
        # otherwise the meta-readback below misses on aliased datastacks.
        cache_ds = cache_datastack(ds)
        mv = ticket["mat_version"]
        minted_at = ticket["minted_at"]

        soma_cache = self.cache_for("num_soma", live) if soma_table else None

        # Readiness = "the cache entry has been refreshed since the ticket was minted"
        # — independent of soft/hard TTL state, which can re-stale a freshly written value.
        soma_lookup = None
        if soma_cache is not None:
            meta = soma_cache.get_with_meta((cache_ds, mv, soma_table))
            if meta is not None and meta[1] >= minted_at:
                soma_lookup = meta[0]

        if soma_table and soma_lookup is None:
            return {"status": "in_flight", "retry_after": 2}

        deltas: dict[int, dict[str, Any]] = {}
        for rid_str, served in ticket["served"].items():
            rid = int(rid_str)
            current: dict[str, Any] = {}
            if soma_lookup is not None:
                soma_rec = soma_lookup.get(rid) or {}
                current["num_soma"] = int(soma_rec.get("num_soma", 0))
                if "cell_id" in soma_rec:
                    current["cell_id"] = soma_rec["cell_id"]
            diff = {k: v for k, v in current.items() if served.get(k) != v}
            if diff:
                deltas[rid] = diff
        return {"status": "ready", "deltas": deltas}


def init_decoration_service(app) -> DecorationService:
    service = DecorationService(app)
    app.extensions["dcv_decoration"] = service
    _register_warmup_jobs(app, service)
    service.warmer.start()
    return service


def _latest_valid_version(client) -> int | None:
    metadata = client.materialize.get_versions_metadata()
    valid = [int(m["version"]) for m in metadata if m.get("valid", True)]
    return max(valid) if valid else None


def _register_warmup_jobs(app, service: "DecorationService") -> None:
    """Walk the configured datastacks directory; for each datastack with an
    enabled `decoration_warmup` block, register periodic refresh jobs. Each
    job re-resolves the latest valid materialized version at every fire and
    keys the cache by that version, so the warm cache rolls forward when new
    versions land upstream.

    Warmup is one of two sanctioned anonymous-auth code paths (the other is
    dev bypass). It uses `make_client_anonymous(env_token_var=...)` so audit
    trails record every fire, and the env-var-supplied token is preferred over
    the local cave-secret fallback.
    """
    from pathlib import Path

    import yaml

    from ..cave import make_client_anonymous

    config_dir = app.config.get("DATASTACK_CONFIG_DIR")
    if not config_dir:
        return
    config_path = Path(config_dir)
    if not config_path.is_dir():
        return

    server_address = app.config["GLOBAL_SERVER_ADDRESS"]

    for yaml_path in sorted(config_path.glob("*.yaml")):
        ds_name = yaml_path.stem
        try:
            data = yaml.safe_load(yaml_path.read_text()) or {}
        except Exception:
            continue
        warmup = (data.get("decoration_warmup") or {})
        if not warmup or not warmup.get("enabled"):
            continue
        interval = float(warmup.get("interval_seconds") or 3600.0)
        startup_delay = float(warmup.get("startup_delay_seconds") or 0.0)
        # `tables` is the canonical name; `cell_type_tables` is the legacy
        # field that pre-dated the cell_type / table cache merger. Reading
        # both keeps existing YAMLs valid; new YAMLs should use `tables`.
        tables_to_warm = list(
            warmup.get("tables")
            or warmup.get("cell_type_tables")
            or []
        )
        warm_soma = bool(warmup.get("warm_soma_table"))
        if not tables_to_warm and not warm_soma:
            continue

        def make_factory(ds: str):
            def cf():
                return make_client_anonymous(
                    ds, server_address, materialize_version=None,
                    reason="warmup", env_token_var="CDV_WARMUP_AUTH_TOKEN",
                )
            return cf

        cf = make_factory(ds_name)

        for tbl in tables_to_warm:
            cache = service.table_decorations_mat

            def _warm_table(_cache=cache, _cf=cf, _ds=ds_name, _table=tbl):
                from .cache_lifecycle import cache_datastack
                client = _cf()
                latest = _latest_valid_version(client)
                if latest is None:
                    return
                client.materialize.version = latest
                fresh = _fetch_decoration_table(client, _table, latest)
                # cache_datastack() resolves the alias so warmer writes
                # land on the same key the request-path readers consult.
                _cache.set((cache_datastack(_ds), latest, _table), fresh)

            service.warmer.register(
                f"{ds_name}/table/{tbl}", _warm_table, interval, startup_delay
            )

        if warm_soma:
            cache = service.num_soma_mat

            def _warm_soma(_cache=cache, _cf=cf, _ds=ds_name):
                from .cache_lifecycle import cache_datastack
                client = _cf()
                latest = _latest_valid_version(client)
                if latest is None:
                    return
                client.materialize.version = latest
                soma_table = client.info.get_datastack_info().get("soma_table")
                if not soma_table:
                    return
                fresh = _fetch_num_soma_table(client, soma_table, latest)
                _cache.set((cache_datastack(_ds), latest, soma_table), fresh)
                # Side-populate the cell-id caches from this same fetch — every
                # single-soma row is a (root_id, cell_id) pair, and the soma
                # table is the source of truth for that decoration. Saves a
                # second round-trip against the dedicated lookup view.
                _populate_cell_id_caches_from_soma(fresh, _ds, latest)

            service.warmer.register(
                f"{ds_name}/num_soma", _warm_soma, interval, startup_delay
            )


def get_decoration_service() -> DecorationService:
    return current_app.extensions["dcv_decoration"]


# -- Fetchers (live and materialized share the body; only run_query branches) -

# Single fetcher for every annotation table the SPA names in
# `decoration_tables`. Cell-type tables and any other operator-curated
# decoration use the same path — there's no longer a dedicated
# `_fetch_cell_type_table` shim, since the wire format and processing
# are identical.


def _fetch_decoration_table(
    client, table: str, mat_version,
    *,
    stages: dict | None = None,
    timestamp=None,
) -> dict[int, dict]:
    """Fetch a generic annotation table whole, return `{root_id: {col: value}}`.

    Skips system/positional/reference columns; keeps user-meaningful annotation
    fields (cell_type, status flags, scores, free text, …). Rows whose root id
    appears more than once in the table are dropped — an ambiguous mapping —
    so the joined value is always unambiguous per partner.

    `stages` accepts an explicit dict for use from worker threads where
    `flask.g` isn't reachable; cold parallel fetches dispatched from
    `lookup_decorations` use this path to surface per-table CAVE time.

    `timestamp` is the request's pinned consistency timestamp (live mode
    only). When set, the live_query underneath uses it so this fetch is
    consistent with synapse + soma queries in the same request. None for
    materialized mode (timestamp irrelevant) and the warmup background
    path (no per-request consistency contract — falls back to `now()`).
    """
    qf = _decoration_query_factory(client, table, mat_version)
    with timer(f"decoration_query[{table}]", stages=stages):
        df = run_query(qf, live=is_live(mat_version), timestamp=timestamp, split_positions=True)
    return _decoration_df_to_lookup(df)


def _decoration_df_to_lookup(df) -> dict[int, dict]:
    """Shared post-fetch processing for decoration tables: column filtering,
    drop ambiguous duplicate root rows, build `{root_id: {col: value}}`.

    Factored out so both bulk (`_fetch_decoration_table`) and filtered
    (`_fetch_decoration_table_filtered`) fetchers share identical
    output semantics.

    Performance note: an earlier version used `df.iterrows()` which costs
    ~100µs per row. At 80K-row scale (cell_type table for minnie65) that
    was ~8s in pure Python. This version does the per-row dict
    construction via `df.to_dict(orient="index")` (C-level pandas),
    leaving only a tight inner loop for NA filtering and numpy-scalar
    coercion. ~10–20× faster on the same input.
    """
    if df.empty:
        return {}
    root_col = "pt_root_id" if "pt_root_id" in df.columns else next(
        (c for c in df.columns if c.endswith("_root_id")), None
    )
    if root_col is None:
        return {}
    skip_exact = {
        root_col, "id", "created", "valid", "id_ref", "created_ref",
        "valid_ref", "target_id", "deleted",
    }
    skip_suffixes = (
        "_position_x", "_position_y", "_position_z",
        "_supervoxel_id", "_root_id",
    )
    keep_cols = [
        c for c in df.columns
        if c not in skip_exact and not any(c.endswith(s) for s in skip_suffixes)
    ]

    # Drop ambiguous duplicates and any row whose root_id is missing/0.
    # Vectorized boolean masking instead of per-row checks.
    df = df.drop_duplicates(subset=root_col, keep=False)
    valid_root = df[root_col].notna() & (df[root_col] != 0)
    df = df[valid_root]
    if df.empty:
        return {}

    # `to_dict(orient="index")` is the C-level shortcut: returns
    # `{root_id: {col: val, col: val, ...}}` in one pass. Numpy scalars
    # are converted to Python natives by pandas. NaN cells come through
    # as `nan` floats; pd.NA cells stay as `pd.NA`. We strip those in
    # the tight loop below.
    indexed = df.set_index(root_col)[keep_cols].to_dict(orient="index")

    out: dict[int, dict] = {}
    NA = pd.NA  # local-binding for tight loop
    for rid, rec in indexed.items():
        cleaned: dict = {}
        for k, v in rec.items():
            # Inline NA check — `_is_missing()` was a function call per
            # cell and showed up at the top of the profile at this scale.
            # Three-way explicit check covers None / NaN / pd.NA in
            # ~constant time.
            if v is None or v is NA:
                continue
            if isinstance(v, float) and v != v:  # NaN
                continue
            cleaned[k] = v
        if cleaned:
            out[int(rid)] = cleaned
    return out


def _fetch_decoration_table_filtered(
    client, table: str, mat_version,
    root_ids: list[int],
    *,
    stages: dict | None = None,
    timestamp=None,
) -> dict[int, dict]:
    """Filtered counterpart to `_fetch_decoration_table` — fetch only rows
    whose pt_root_id is in `root_ids`.

    Used by the live-mode delta-driven path: when the bulk cache has a
    slightly stale snapshot, `get_delta_roots` tells us which root_ids
    changed since the snapshot was taken; this function pulls fresh data
    just for those affected partners. ~1-100 rows per call instead of
    ~80K, so cost is bounded by the recent-edit set rather than the
    full table size.

    Empty `root_ids` short-circuits — no CAVE round-trip.
    """
    if not root_ids:
        return {}
    qf = _decoration_query_factory(client, table, mat_version, pt_root_id=list(root_ids))
    with timer(f"decoration_query_filtered[{table}]", stages=stages):
        df = run_query(qf, live=is_live(mat_version), timestamp=timestamp, split_positions=True)
    return _decoration_df_to_lookup(df)


# -- Live-mode delta-driven helpers --------------------------------------------


def _new_roots_since(client, snapshot_time: float, target_time: _dt.datetime) -> set[int]:
    """Roots created between `snapshot_time` (Unix seconds) and
    `target_time` (datetime). Result is cached on `flask.g` so multiple
    decoration tables in one request share a single chunkedgraph round-
    trip; per-request entries keyed by `(snapshot_time, target_time)`.

    Returns an empty set on chunkedgraph errors (cache too old, network
    blip) — caller falls back to bulk-cached snapshot semantics. The
    soft TTL on the underlying SWR cache (5 min for live mode) bounds
    how stale the snapshot can be; `get_delta_roots` retention is
    typically much longer.
    """
    snapshot_dt = _dt.datetime.fromtimestamp(snapshot_time, tz=_dt.timezone.utc)
    cache_key = (snapshot_dt, target_time)

    try:
        per_request = g.setdefault("delta_roots_cache", {})
        if cache_key in per_request:
            return per_request[cache_key]
    except RuntimeError:
        per_request = None

    with timer("get_delta_roots"):
        try:
            delta = client.chunkedgraph.get_delta_roots(snapshot_dt, target_time)
        except Exception as exc:
            logger.warning(
                "get_delta_roots failed (%s: %s); falling back to bulk-snapshot semantics",
                type(exc).__name__, exc,
            )
            delta = None

    new_roots = _extract_new_roots(delta)
    if per_request is not None:
        per_request[cache_key] = new_roots
    return new_roots


def _extract_new_roots(delta) -> set[int]:
    """Pull the 'newly created roots' list out of `get_delta_roots`'s
    return value. Defensive against API shape — caveclient versions have
    historically returned tuple, dict, or namedtuple. We only need the
    `new` list (newly-created roots that may now appear as partners);
    the `expired` list isn't useful here because synapse_query at
    T_pinned won't surface expired roots in the partner set anyway.
    """
    if delta is None:
        return set()
    new = None
    if isinstance(delta, tuple) and len(delta) == 2:
        # Convention: (expired, new)
        _expired, new = delta
    elif isinstance(delta, dict):
        new = delta.get("new_roots") or delta.get("new")
    elif hasattr(delta, "new_roots"):
        new = delta.new_roots
    if not new:
        return set()
    return {int(r) for r in new}


def _apply_live_delta(
    *,
    snapshot: dict[int, dict],
    snapshot_time: float,
    partner_ids: list[int],
    target_time: _dt.datetime,
    client,
    fetcher,
    request_stages: dict | None,
) -> dict[int, dict]:
    """Overlay fresh data on top of a (slightly stale) bulk snapshot.

    Strategy (Option D — bulk-cache + targeted-fill-in):
      1. Compute new roots in the (snapshot_time, target_time) window
         via `get_delta_roots`. Bounded to whatever's been edited
         dataset-wide in that window (typically tens of roots, not
         thousands).
      2. Determine "affected" partners — root_ids in `partner_ids` that
         are EITHER in the new-roots set (recent edits) OR absent from
         the snapshot entirely (cold-cache-vs-existing-id edge case).
      3. Targeted fetch (`pt_root_id__in=affected`) at `target_time` —
         small CAVE call, bounded by the affected count.
      4. Merge: snapshot for unaffected partners, fresh values for
         affected ones. Snapshot keys not in `partner_ids` are
         irrelevant to the served lookup so they pass through unchanged.

    `fetcher(root_ids, *, timestamp, stages)` is the per-table filtered
    fetch helper (`_fetch_decoration_table_filtered` or its soma
    cousin). Same signature so this function works generically.

    No-op when `snapshot` is None (cold cache — caller falls back to
    bulk fetch) or when there's nothing to fill in.
    """
    if not snapshot or not partner_ids:
        return snapshot or {}

    new_roots = _new_roots_since(client, snapshot_time, target_time)

    # Affected = recently-edited partners ∪ partners missing from the
    # snapshot entirely (covers the case where a partner appeared in
    # the table after the snapshot was taken, regardless of whether it
    # got flagged as a "new root" in the chunkedgraph delta).
    partner_set = {int(p) for p in partner_ids}
    affected = (new_roots & partner_set) | (partner_set - snapshot.keys())
    if not affected:
        return snapshot

    fresh = fetcher(
        sorted(affected),
        timestamp=target_time,
        stages=request_stages,
    )
    # Shallow copy + overlay so the cached snapshot dict isn't mutated.
    merged = dict(snapshot)
    merged.update(fresh)
    return merged


def _is_missing(v) -> bool:
    """True for None / NaN / pd.NA / NaT — but False for arrays and lists.
    Used during decoration extraction so nullable-dtype rows don't carry
    `pd.NA` through to the JSON encoder.
    """
    if v is None:
        return True
    try:
        return bool(pd.isna(v))
    except (TypeError, ValueError):
        return False


def _fetch_num_soma_table(client, soma_table: str, mat_version,
                          soma_root_id_column: str = "pt_root_id",
                          *, stages: dict | None = None,
                          timestamp=None) -> dict[int, dict]:
    """Per-root-id soma decoration: `{num_soma, cell_id?, pt_position?}`.

    `cell_id` and `pt_position` are included only when a root id has exactly
    one row in the soma/nucleus table — i.e. an unambiguous persistent
    identifier and a single point. Multi-row root ids (proofreading hasn't
    separated them yet, or genuinely a single object spanning multiple nuclei)
    get `num_soma` but no `cell_id` / `pt_position`.

    Positions are returned in nanometers (`desired_resolution=[1,1,1]`) so the
    spatial service can pass them straight into a `_nm` standard_transform.
    """
    qf = _decoration_query_factory(client, soma_table, mat_version)
    with timer(f"decoration_query[{soma_table}]", stages=stages):
        df = run_query(
            qf,
            live=is_live(mat_version),
            timestamp=timestamp,
            split_positions=True,
            desired_resolution=[1, 1, 1],
            select_columns=[soma_root_id_column, "id", "pt_position"],
        )
    if df.empty:
        return {}
    return _soma_df_to_lookup(df, soma_root_id_column)


def _soma_df_to_lookup(df, soma_root_id_column: str) -> dict[int, dict]:
    """Shared post-fetch processing for the soma table. Per-partner
    groupby + dedup logic — multi-nucleus partners get `num_soma` only
    (cell_id/pt_position omitted as ambiguous). Used by both bulk and
    filtered fetchers so output semantics are identical.

    Vectorized: `groupby.size()` for counts, then `to_dict(orient="records")`
    over the unique-root subset for cell_id/pt_position. Avoids the
    per-group Python loop that was 5-8 seconds on minnie65's full
    nucleus_neuron_svm + soma table sweep at ~80K rows.
    """
    if df.empty:
        return {}
    df = df[df[soma_root_id_column] != 0]
    if df.empty:
        return {}

    counts = df.groupby(soma_root_id_column).size()
    out: dict[int, dict] = {int(rid): {"num_soma": int(count)} for rid, count in counts.items()}

    # Subset to partners with exactly one row — these are the ones for
    # which we can attach an unambiguous cell_id and pt_position.
    # `duplicated(keep=False) → True` for every row whose key appears
    # more than once; the inversion gives us the singletons.
    is_unique = ~df.duplicated(subset=soma_root_id_column, keep=False)
    singles = df[is_unique]
    if singles.empty:
        return out

    pos_cols = ["pt_position_x", "pt_position_y", "pt_position_z"]
    has_pos = all(c in singles.columns for c in pos_cols)
    select_cols = [soma_root_id_column, "id"] + (pos_cols if has_pos else [])
    records = singles[select_cols].to_dict(orient="records")
    NA = pd.NA
    for rec in records:
        rid = int(rec[soma_root_id_column])
        out[rid]["cell_id"] = str(int(rec["id"]))
        if has_pos:
            xs = (rec["pt_position_x"], rec["pt_position_y"], rec["pt_position_z"])
            ok = True
            for v in xs:
                if v is None or v is NA or (isinstance(v, float) and v != v):
                    ok = False
                    break
            if ok:
                out[rid]["pt_position"] = [float(xs[0]), float(xs[1]), float(xs[2])]
    return out


def _fetch_num_soma_table_filtered(
    client, soma_table: str, mat_version,
    root_ids: list[int],
    soma_root_id_column: str = "pt_root_id",
    *,
    stages: dict | None = None,
    timestamp=None,
) -> dict[int, dict]:
    """Filtered counterpart to `_fetch_num_soma_table` — fetch only soma
    rows whose root id is in `root_ids`. Same return shape; same dedup
    semantics for multi-nucleus partners."""
    if not root_ids:
        return {}
    qf = _decoration_query_factory(client, soma_table, mat_version, **{soma_root_id_column: list(root_ids)})
    with timer(f"decoration_query_filtered[{soma_table}]", stages=stages):
        df = run_query(
            qf,
            live=is_live(mat_version),
            timestamp=timestamp,
            split_positions=True,
            desired_resolution=[1, 1, 1],
            select_columns=[soma_root_id_column, "id", "pt_position"],
        )
    if df.empty:
        return {}
    return _soma_df_to_lookup(df, soma_root_id_column)


def _populate_cell_id_caches_from_soma(
    soma_dict: dict[int, dict],
    datastack: str,
    mat_version: int | None,
) -> None:
    """The soma fetch is also a canonical source of cell-id ↔ root-id pairs
    for the single-soma case (the only case where cell_id is meaningful).

    Populates two caches in `services/cell_id.py`:

    - ``_root_to_cell`` (per-root, long TTL): every single-soma row pins
      ``(ds, root_id) -> cell_id``; multi-soma roots pin ``-> None`` so
      ambiguity is captured explicitly.
    - The materialized universe entry ``_universe_mat[(ds, mv)]``: the
      soma table is itself effectively a (cell_id, root_id) universe for
      this mat_version, so populating the universe dict here means the
      first ``cell_ids_to_root_ids`` call at the same mat_version skips
      its lookup-view fetch. If the universe is already loaded
      (someone hit the explorer first), merge into it; if not, build a
      fresh one from the soma scan.
    """
    from .cell_id import CellUniverse, _lock, _root_to_cell, _universe_mat

    with _lock:
        cell_to_root_updates: dict[int, int | None] = {}
        root_to_cell_updates: dict[int, int | None] = {}
        for rid, rec in soma_dict.items():
            if "cell_id" in rec:
                cid = int(rec["cell_id"])
                _root_to_cell[(datastack, rid)] = cid
                if mat_version is not None:
                    cell_to_root_updates[cid] = rid
                    root_to_cell_updates[rid] = cid
            else:
                _root_to_cell[(datastack, rid)] = None

        if mat_version is not None and cell_to_root_updates:
            key = (datastack, int(mat_version))
            existing = _universe_mat.get(key)
            if existing is None:
                _universe_mat[key] = CellUniverse(
                    cell_to_root=cell_to_root_updates,
                    root_to_cell=root_to_cell_updates,
                )
            else:
                # Merge into the existing universe. The universe dicts
                # are frozen dataclass fields but dict identity is what
                # matters — mutate in place since this is the canonical
                # write path for this (ds, mv).
                existing.cell_to_root.update(cell_to_root_updates)
                existing.root_to_cell.update(root_to_cell_updates)


# -- Lookup with SWR semantics --------------------------------------------------

def lookup_decorations(
    *,
    client_factory,           # () -> CAVEclient (captures auth + datastack + mv)
    ds: str,
    mat_version: int | str | None,
    soma_table: str | None,
    soma_root_id_column: str,
    root_ids: list[int],
    decoration_tables: list[str] | None = None,
) -> tuple[dict[int, dict], list[dict], dict[str, Any] | None]:
    """Resolve num_soma + decoration-table values for `root_ids`. Returns
    `(lookup, revalidation)`.

    `lookup` is `{root_id: {col: val, ...}}` populated from cache (fresh or
    stale). `revalidation` is None on full-fresh hit; otherwise carries
    `{pending_root_ids, ticket_id, poll_url}` and a background refresh has
    been queued. If the cache had no usable hit (cold or past hard TTL) the
    underlying fetcher runs synchronously here so the response is correct,
    just slower.

    Cell-type tables flow through `decoration_tables` like any other
    annotation source — they no longer get a dedicated cache slot or code
    path.
    """
    from .cache_lifecycle import cache_datastack

    service = get_decoration_service()
    live = is_live(mat_version)
    has_stale = False

    # Resolve the cache namespace once. When per-datastack YAML sets
    # `cache_alias`, requests for `ds` redirect to the alias target's
    # cache space — readers and writers must agree, so we compute it
    # here and use `cache_ds` everywhere downstream that builds a cache
    # key. The original `ds` is still used for non-cache concerns
    # (cell-id back-population, log lines, ticket bookkeeping).
    cache_ds = cache_datastack(ds)

    # `soma_lookup[root_id] = {"num_soma": int, "cell_id"?: str}` — cell_id only
    # present when the root has a single row in the soma table.
    soma_lookup: dict[int, dict[str, Any]] | None = None

    # First pass: read caches synchronously. Decide which need a synchronous
    # cold fetch (no cache or hard-expired) vs an async revalidation (stale).
    cold_jobs: list[tuple[str, Any]] = []  # ("num_soma" | "table", payload)

    # Snapshot fetched_at timestamp captured for the live-mode delta
    # fill-in below. Stays None for materialized mode (no delta path).
    soma_snapshot_time: float | None = None

    if soma_table:
        soma_cache = service.cache_for("num_soma", live)
        soma_key = (cache_ds, mat_version, soma_table)
        entry = soma_cache.get_full(soma_key)
        if entry is None:
            cold_jobs.append(("num_soma", (soma_cache, soma_key)))
        else:
            soma_lookup, freshness, soma_snapshot_time = entry
            if freshness == "stale":
                has_stale = True

                def _refresh_soma(_cache=soma_cache, _key=soma_key,
                                  _table=soma_table, _mv=mat_version,
                                  _col=soma_root_id_column, _ds=ds):
                    fresh = _fetch_num_soma_table(client_factory(), _table, _mv,
                                                  soma_root_id_column=_col)
                    _cache.set(_key, fresh)
                    if not is_live(_mv):
                        _populate_cell_id_caches_from_soma(fresh, _ds, int(_mv))

                service.executor.submit(("num_soma", soma_key), _refresh_soma)

    # Per-table decorations. Each requested table fetches once, indexed
    # by root_id; columns merge onto partner records on the served-record loop
    # below. `table_lookups[table]` = {root_id: {col: value}} or None when cold.
    # Cell-type tables flow through here just like any other annotation
    # source — there's no longer a dedicated cell-type code path.
    table_lookups: dict[str, dict[int, dict] | None] = {}
    table_snapshot_times: dict[str, float] = {}
    for tbl in (decoration_tables or []):
        if not tbl or tbl == soma_table:
            # Skip empty / soma-table dupe (soma has its own dedicated path
            # because of the per-cell aggregation; everything else is generic).
            continue
        tcache = service.cache_for("table", live)
        tkey = (cache_ds, mat_version, tbl)
        entry = tcache.get_full(tkey)
        if entry is None:
            cold_jobs.append(("table", (tcache, tkey, tbl)))
            table_lookups[tbl] = None  # populated by the cold-fetch loop below
        else:
            data, freshness, table_snapshot_times[tbl] = entry
            table_lookups[tbl] = data
            if freshness == "stale":
                has_stale = True

                def _refresh_table(_cache=tcache, _key=tkey,
                                   _table=tbl, _mv=mat_version):
                    fresh = _fetch_decoration_table(client_factory(), _table, _mv)
                    _cache.set(_key, fresh)

                service.executor.submit(("table", tkey), _refresh_table)

    # Parallelize cold fetches: they don't depend on each other, and the cell-type
    # table + soma table are usually the slowest two CAVE calls in a request.
    if cold_jobs:
        # Capture the request's timing-stages dict + pinned consistency
        # timestamp here in the request thread, then pass them explicitly
        # into worker threads. Workers can't reach `flask.g`; without
        # explicit pass-through, their decoration_query[*] timings get
        # silently dropped AND their live_queries fall back to now() —
        # which would break the per-request consistency we're enforcing.
        request_stages = current_stages()
        request_ts = current_timestamp()
        with ThreadPoolExecutor(max_workers=min(len(cold_jobs), 8)) as pool:
            futures: dict = {}
            for job in cold_jobs:
                kind = job[0]
                if kind == "num_soma":
                    cache, cache_key = job[1]
                    futures[pool.submit(_fetch_num_soma_table,
                                        client_factory(), soma_table, mat_version,
                                        soma_root_id_column,
                                        stages=request_stages,
                                        timestamp=request_ts)] = (kind, cache, cache_key, None)
                else:  # "table" — covers all annotation tables, including cell-type
                    cache, cache_key, tbl = job[1]
                    futures[pool.submit(_fetch_decoration_table,
                                        client_factory(), tbl, mat_version,
                                        stages=request_stages,
                                        timestamp=request_ts)] = (kind, cache, cache_key, tbl)
            for fut, meta in futures.items():
                kind, cache, cache_key, tbl = meta
                result = fut.result()
                cache.set(cache_key, result)
                if kind == "num_soma":
                    soma_lookup = result
                    if not live:
                        _populate_cell_id_caches_from_soma(result, ds, int(mat_version))
                else:
                    table_lookups[tbl] = result

    # Live-mode delta fill-in. For warm-cache hits (where snapshot_time
    # is set), check the chunkedgraph delta between snapshot and the
    # request's pinned timestamp. Any partner that's a "new root" since
    # the snapshot — or that's missing from the snapshot entirely —
    # gets a targeted CAVE fetch overlaid on top.
    #
    # Cold-fetched lookups skip this: their snapshot_time stays None
    # since we just populated the cache at request time, so there's
    # no staleness to fill in.
    #
    # Materialized mode: skipped entirely (snapshot_time stays None
    # because we don't read get_full's third value into anything for
    # mat-mode purposes; live=False short-circuits below regardless).
    if live and root_ids:
        request_target_time = current_timestamp()
        if request_target_time is not None:
            client_for_delta = client_factory()  # one client; reused across tables
            request_stages_for_fill = current_stages()

            if soma_lookup is not None and soma_snapshot_time is not None and soma_table:
                soma_lookup = _apply_live_delta(
                    snapshot=soma_lookup,
                    snapshot_time=soma_snapshot_time,
                    partner_ids=root_ids,
                    target_time=request_target_time,
                    client=client_for_delta,
                    fetcher=lambda root_ids, *, timestamp, stages: _fetch_num_soma_table_filtered(
                        client_for_delta, soma_table, mat_version, root_ids,
                        soma_root_id_column=soma_root_id_column,
                        stages=stages, timestamp=timestamp,
                    ),
                    request_stages=request_stages_for_fill,
                )
            for tbl, snap_time in table_snapshot_times.items():
                snap = table_lookups.get(tbl)
                if snap is None or snap_time is None:
                    continue
                # Capture `tbl` in the lambda's default arg to avoid the
                # late-binding closure trap (see CLAUDE.md SWR pitfall
                # callout — same shape, different surface).
                table_lookups[tbl] = _apply_live_delta(
                    snapshot=snap,
                    snapshot_time=snap_time,
                    partner_ids=root_ids,
                    target_time=request_target_time,
                    client=client_for_delta,
                    fetcher=lambda root_ids, *, timestamp, stages, _tbl=tbl: _fetch_decoration_table_filtered(
                        client_for_delta, _tbl, mat_version, root_ids,
                        stages=stages, timestamp=timestamp,
                    ),
                    request_stages=request_stages_for_fill,
                )

    served: dict[int, dict[str, Any]] = {}
    for rid in root_ids:
        rid = int(rid)
        rec: dict[str, Any] = {}
        if soma_lookup is not None:
            soma_rec = soma_lookup.get(rid) or {}
            rec["num_soma"] = int(soma_rec.get("num_soma", 0))
            if "cell_id" in soma_rec:
                rec["cell_id"] = soma_rec["cell_id"]
            # `pt_position` is forwarded so downstream (spatial features in
            # connectivity_bundle) can read it without re-fetching the soma
            # table. The bundle assembler strips it before serializing — it's
            # internal scaffolding, not a SPA-rendered column.
            if "pt_position" in soma_rec:
                rec["pt_position"] = soma_rec["pt_position"]
        # Per-table columns get a `<table>.<col>` namespace so two
        # tables that both expose `cell_type` (or anything else) coexist
        # cleanly. The SPA renders the dot-prefix as a group header above
        # the column.
        for tbl, tbl_data in table_lookups.items():
            if tbl_data is None:
                continue
            extra = tbl_data.get(rid)
            if not extra:
                continue
            for k, v in extra.items():
                rec[f"{tbl}.{k}"] = v
        if rec:
            served[rid] = rec

    # Groups metadata: each entry describes a logical group of columns the
    # frontend can render under a shared header. The soma group is
    # special-cased (per-cell aggregation produces flat `num_soma` /
    # `cell_id` columns); every other annotation table contributes a
    # namespaced group.
    groups: list[dict] = []
    if soma_lookup is not None:
        soma_cols = ["num_soma"]
        # cell_id is sparse (only single-soma roots); include it in the group
        # if any served record has one so the column shows up in the table.
        if any("cell_id" in (rec or {}) for rec in served.values()):
            soma_cols.append("cell_id")
        groups.append({
            "name": soma_table or "soma",
            "kind": "soma",
            "columns": soma_cols,
        })
    for tbl, tbl_data in table_lookups.items():
        if not tbl_data:
            continue
        bare_cols: set[str] = set()
        for rec in tbl_data.values():
            bare_cols.update(rec.keys())
        if bare_cols:
            groups.append({
                "name": tbl,
                "kind": "table",
                "columns": [f"{tbl}.{c}" for c in sorted(bare_cols)],
            })

    revalidation: dict[str, Any] | None = None
    if has_stale and served:
        ticket_id = service.mint_ticket(
            ds=ds, mat_version=mat_version,
            soma_table=soma_table,
            served={str(k): v for k, v in served.items()},
        )
        revalidation = {
            "ticket_id": ticket_id,
            "pending_root_ids": list(served.keys()),
            "poll_url": f"/api/v1/decorations/poll?ticket={ticket_id}",
        }
    return served, groups, revalidation
