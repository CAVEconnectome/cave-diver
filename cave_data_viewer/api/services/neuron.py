from types import SimpleNamespace
from typing import Any

import numpy as np
import pandas as pd
from flask import current_app

from ..caches import cache_key_with_config
from .keys import canonical_query_hash, is_live
from .query_runner import run_query
from .request_state import current_timestamp
import time as _time

from .timing import record_stage, timer


DEFAULT_DESIRED_RESOLUTION = [1, 1, 1]

# Sentinel used when no provider is supplied to `connectivity_bundle` (e.g.
# tests that don't bother wiring one). `build_spatial_provider` resolves it
# to `NullSpatialProvider`, so the bundle still assembles cleanly with no
# spatial columns.
_NULL_SPATIAL_CFG = SimpleNamespace(provider="null", provider_module=None, params={})


class NeuronQuery:
    def __init__(
        self,
        client,
        root_id: int,
        *,
        datastack: str,
        mat_version: int | str | None,
        synapse_table: str | None = None,
        soma_table: str | None = None,
        soma_root_id_column: str = "pt_root_id",
        synapse_aggregation_rules: dict[str, dict] | None = None,
        synapse_columns: list[str] | None = None,
        synapse_position_prefix: str = "ctr_pt",
        desired_resolution: list[int] | None = None,
    ):
        self.client = client
        self.root_id = int(root_id)
        self.datastack = datastack
        self.mat_version = mat_version
        info = client.info.get_datastack_info()
        self.synapse_table = synapse_table or info.get("synapse_table")
        self.soma_table = soma_table or info.get("soma_table")
        self.soma_root_id_column = soma_root_id_column
        self.synapse_aggregation_rules = synapse_aggregation_rules or {}
        self.synapse_columns = synapse_columns
        self.synapse_position_prefix = synapse_position_prefix
        self.desired_resolution = desired_resolution or DEFAULT_DESIRED_RESOLUTION
        # Pinned consistency timestamp captured at NQ construction. For
        # live mode the endpoint pins `datetime.now(utc)` on `flask.g`
        # before instantiating NQ; we read it here so every CAVE call
        # this NQ makes uses the same point in time. None for
        # materialized mode (queries are implicitly consistent via
        # version number) and outside a request context (warmup, tests).
        self.timestamp_for_consistency = current_timestamp() if is_live(mat_version) else None
        # Per-NQ memoization for `soma_summary()`. The method is called
        # multiple times per request (root soma for spatial features,
        # summary payload, plot endpoints) — caching on the instance
        # avoids re-deriving from the bulk num_soma cache on each call.
        # Fresh per request because NQ is request-scoped; cross-request
        # memoization rides on the bulk num_soma decoration cache.
        self._soma_summary_memo: dict | None = None
        # Legacy field — `df.attrs["timestamp"]` from the synapse query
        # that CAVE echoes back. Kept for backwards-compat in callers
        # that still read `timestamp_used`, but `timestamp_for_consistency`
        # is now the source of truth surfaced on the response payload.
        self.timestamp_used = None

    def _cache_key(self, kind: str, **extra: Any) -> tuple | None:
        """Build the synapse-cache key.

        Live mode returns None so the cache is bypassed entirely. For
        materialized mode, returns a 3-tuple `(cache_ds, mat_version,
        canonical_hash)`. The leading `(ds, mv)` lets the LayeredSwrCache
        retention resolver pick the right L2 partition (default vs
        longlived) without re-deriving them from a hashed payload.
        Every knob that affects the returned dataframe shape stays
        inside `canonical_hash`: synapse_columns drives the projection,
        position_prefix drives the split-position column names,
        desired_resolution drives the unit of the position values.
        Forgetting any one of these silently serves a previous-request
        shape from cache.

        `cache_datastack` resolves any per-datastack alias (e.g.
        `minnie65_public` → `minnie65_phase3_v1`) so two datastacks
        backed by the same underlying data share one cache entry. The
        actual CAVE call still uses `self.datastack`; only the key
        changes.
        """
        if is_live(self.mat_version):
            return None
        from .cache_lifecycle import cache_datastack
        cache_ds = cache_datastack(self.datastack)
        payload = {"kind": kind, "ds": cache_ds, "mv": self.mat_version,
                   "syn": self.synapse_table, "rid": self.root_id,
                   "cols": tuple(self.synapse_columns) if self.synapse_columns else None,
                   "pos_prefix": self.synapse_position_prefix,
                   "desired_res": tuple(self.desired_resolution),
                   **extra}
        return (cache_ds, self.mat_version, canonical_query_hash(payload))

    def _synapse_df(self, direction: str, *, stages: dict | None = None) -> pd.DataFrame:
        """Fetch (or read from cache) the per-direction synapse df.

        `stages` is the optional explicit stage dict for cross-thread use.
        When `_synapse_df` runs inside a `ThreadPoolExecutor` worker (the
        synapse-pre/post parallelization in `connectivity_bundle`),
        `flask.g.timing_stages` isn't shared across threads — Flask's
        `copy_current_request_context` gives each worker its own `g`,
        so writes to it never reach the request log. Caller passes the
        captured request-thread dict here; `timer()` writes into it
        directly. Same pattern `lookup_decorations` uses for its cold-
        fetch pool.

        No `synapse_query[direction]` timer wraps the CAVE call here —
        the orchestrator (`connectivity_bundle`) wraps the entire
        parallel post+pre block in a single `synapse_query` timer
        instead. Per-direction timers would double-count under
        parallelization (sum of two parallel calls > wall time), which
        broke `cave_ms` / `processing_ms` rollup math.
        """
        if self.synapse_table is None:
            raise ValueError("synapse_table is not configured for this datastack")
        key = self._cache_key("synapses", direction=direction)
        cache = current_app.extensions.get("dcv_synapse_cache") if key else None
        if cache is not None:
            # Time the lookup *around* `get_with_layer` (not inside) so the
            # GCS round-trip on an L2 promotion is captured rather than
            # bleeding into the surrounding `synapse_query` outer timer.
            # The pre-fix version wrapped only the post-hit return, which
            # always logged 0ms and hid hundreds of ms of cold-pod L2 work.
            t0 = _time.perf_counter()
            hit_layer = cache.get_with_layer(key)
            elapsed_ms = (_time.perf_counter() - t0) * 1000.0
            if hit_layer is not None:
                value, _freshness, layer = hit_layer
                record_stage(
                    f"synapse_{layer}_hit[{direction}]", elapsed_ms, stages=stages,
                )
                return value
        partner_col = "pre_pt_root_id" if direction == "post" else "post_pt_root_id"
        own_col = "post_pt_root_id" if direction == "post" else "pre_pt_root_id"
        qf = self.client.materialize.tables[self.synapse_table](**{own_col: self.root_id})
        query_kwargs: dict[str, Any] = {
            "split_positions": True,
            "desired_resolution": self.desired_resolution,
        }
        if self.synapse_columns is not None:
            query_kwargs["select_columns"] = self.synapse_columns
        df = run_query(
            qf,
            live=is_live(self.mat_version),
            timestamp=self.timestamp_for_consistency,
            **query_kwargs,
        )
        df = df[df[partner_col] != 0].copy()
        df = df[df[partner_col] != self.root_id].copy()  # drop autapses
        if df.attrs.get("timestamp"):
            self.timestamp_used = str(df.attrs["timestamp"])
        if cache is not None:
            cache.set(key, df)
        return df

    def _aggregate(
        self,
        syn_df: pd.DataFrame,
        partner_col: str,
        *,
        timer_label: str | None = None,
        stages: dict | None = None,
    ) -> pd.DataFrame:
        if syn_df.empty:
            return pd.DataFrame(columns=["root_id", "num_syn"])
        # Timer wraps just the groupby + per-rule aggregation work, NOT
        # the synapse fetch (already tagged separately as
        # `synapse_query[*]` / `synapse_cache_hit[*]`). Caller passes
        # `timer_label` to tag per-direction cost cleanly without the
        # implicit-overlap problem the earlier wrap had.
        if timer_label is not None:
            with timer(timer_label, stages=stages):
                return self._aggregate_inner(syn_df, partner_col)
        return self._aggregate_inner(syn_df, partner_col)

    def _aggregate_inner(self, syn_df: pd.DataFrame, partner_col: str) -> pd.DataFrame:
        grp = syn_df.groupby(partner_col, sort=False)
        out = grp.size().to_frame("num_syn")
        for new_col, rule in self.synapse_aggregation_rules.items():
            out[new_col] = grp[rule["column"]].agg(rule["agg"])
        out = out.reset_index().rename(columns={partner_col: "root_id"})
        return out.sort_values("num_syn", ascending=False).reset_index(drop=True)

    def partners_out(self, *, stages: dict | None = None) -> pd.DataFrame:
        return self._aggregate(
            self._synapse_df("pre", stages=stages),
            "post_pt_root_id",
            timer_label="aggregate_partners[out]",
            stages=stages,
        )

    def partners_in(self, *, stages: dict | None = None) -> pd.DataFrame:
        return self._aggregate(
            self._synapse_df("post", stages=stages),
            "pre_pt_root_id",
            timer_label="aggregate_partners[in]",
            stages=stages,
        )

    def soma_summary(self) -> dict:
        """Return `{num_soma, soma_pt_position}` for the queried cell.

        Cache hierarchy:
          1. Per-NQ memo (within-request): same NQ instance is asked
             multiple times per connectivity bundle (root soma for
             spatial features, summary payload, plot endpoints).
          2. Bulk `num_soma` decoration cache (cross-request): a single
             dict keyed by `(ds, mv, soma_table)` holds every root id's
             soma row. Loaded by `lookup_decorations` for any
             connectivity request, warmed via decoration warmup, and
             survives pod restart via the L2 (GCS) layer.
          3. Per-cell CAVE fallback: only when the bulk cache hasn't
             been populated (e.g. a path that calls `soma_summary`
             without invoking `lookup_decorations` first, or a cold
             pod hitting the soma_summary side of a plot endpoint
             before any other request).

        The bulk cache holds `{root_id: {num_soma, cell_id?, pt_position?}}`,
        with `pt_position` set only on single-soma rows (multi-soma
        cells get `num_soma` only — there's no unambiguous position
        for them). This translates `pt_position` → `soma_pt_position`
        for the SPA-facing shape.
        """
        if self._soma_summary_memo is not None:
            return self._soma_summary_memo
        result = self._compute_soma_summary()
        self._soma_summary_memo = result
        return result

    def _compute_soma_summary(self) -> dict:
        if self.soma_table is None:
            return {"num_soma": 0, "soma_pt_position": None}
        # Try the bulk num_soma decoration cache first. Hits the same
        # cache that `lookup_decorations` populates, so within a
        # connectivity request this is always a free dict lookup —
        # `lookup_decorations` runs ~17 lines before `soma_summary` in
        # `connectivity_bundle`, leaving the bulk dict L1-warm.
        # `_lookup_bulk_num_soma` records the underlying cache lookup
        # latency itself (`soma_l1_hit` / `soma_l2_hit`); this branch is
        # pure dict-lookup work afterwards, no timer needed.
        bulk_row = self._lookup_bulk_num_soma()
        if bulk_row is not None:
            if bulk_row == "absent":
                # Cache hit but the queried root has no row in the
                # soma table — definitive "no soma" answer.
                return {"num_soma": 0, "soma_pt_position": None}
            return {
                "num_soma": int(bulk_row.get("num_soma", 0)),
                "soma_pt_position": bulk_row.get("pt_position"),
            }
        # Bulk cache cold — fall back to a per-cell CAVE fetch.
        try:
            qf = self.client.materialize.tables[self.soma_table](
                **{self.soma_root_id_column: self.root_id}
            )
            with timer("soma_query"):
                df = run_query(
                    qf,
                    live=is_live(self.mat_version),
                    timestamp=self.timestamp_for_consistency,
                    split_positions=False,
                    desired_resolution=self.desired_resolution,
                )
        except Exception:
            # Transient CAVE errors don't get memoized — caller can
            # retry on the next request. (The per-NQ memo still caches
            # within this request to avoid hammering CAVE on retry.)
            return {"num_soma": 0, "soma_pt_position": None}
        if df.empty:
            return {"num_soma": 0, "soma_pt_position": None}
        pt_col = next((c for c in df.columns if c.endswith("pt_position")), None)
        soma_pt = None
        if pt_col is not None:
            value = df.iloc[0][pt_col]
            if hasattr(value, "tolist"):
                value = value.tolist()
            soma_pt = list(value) if value is not None else None
        return {"num_soma": int(len(df)), "soma_pt_position": soma_pt}

    def _lookup_bulk_num_soma(self):
        """Read this cell's row from the bulk num_soma decoration cache.

        Returns:
          - the row dict (e.g. `{"num_soma": 1, "cell_id": "...", "pt_position": [...]}`)
            on a cache hit where the cell is in the soma table;
          - the string ``"absent"`` on a cache hit where the cell is NOT
            in the soma table (definitive "no soma" answer);
          - None when the bulk cache isn't populated (caller falls
            through to a per-cell CAVE fetch).

        Sentinel `"absent"` distinguishes "cache had it; said no" from
        "cache cold; ask CAVE." Without it, both cases return None and
        the caller can't tell whether to do a CAVE fetch.
        """
        from .cache_lifecycle import cache_datastack
        from .decoration import get_decoration_service
        try:
            bulk_cache = get_decoration_service().cache_for(
                "num_soma", live=is_live(self.mat_version)
            )
        except Exception:
            return None
        bulk_key = (cache_datastack(self.datastack), self.mat_version, self.soma_table)
        # Wall-time the lookup so an L2 GCS read is visible per-request
        # under `soma_l2_hit` rather than disappearing into framework
        # overhead. L1 hits typically log <1ms; L2 hits log the GCS
        # round-trip + unpickle cost.
        t0 = _time.perf_counter()
        hit_layer = bulk_cache.get_with_layer(bulk_key)
        elapsed_ms = (_time.perf_counter() - t0) * 1000.0
        if hit_layer is None:
            return None
        bulk_dict, _freshness, layer = hit_layer
        record_stage(f"soma_{layer}_hit", elapsed_ms)
        row = bulk_dict.get(int(self.root_id))
        return row if row is not None else "absent"


import logging as _logging
_root_xlate_logger = _logging.getLogger("cdv.root_translation")


def suggest_current_root(
    client,
    root_id: int,
    *,
    mat_version: int | str | None,
) -> int | None:
    """Ask the chunkedgraph what root_id `root_id` maps to at the
    request's "current" timestamp.

    Timestamp resolution:
      - Live mode: the request's pinned consistency timestamp
        (`current_timestamp()`), so the suggestion shares the same point
        in time as every other CAVE call in this request.
      - Materialized mode: the version's frozen timestamp, derived from
        `client.materialize.get_versions_metadata()` via
        `services.datastack_config.version_timestamp`. The suggested
        root is what was canonical at that materialization.

    Returns:
      - A new int root_id when the chunkedgraph thinks the input has
        been split/merged into something else, or
      - The same `root_id` when nothing changed (caller treats this as
        no-op), or
      - `None` when the chunkedgraph call fails or no timestamp can be
        derived (caller skips the translation).
    """
    from .datastack_config import version_timestamp
    from .request_state import current_timestamp

    if is_live(mat_version):
        ts = current_timestamp()
    else:
        ts = version_timestamp(client, mat_version)
    if ts is None:
        _root_xlate_logger.info(
            "suggest_current_root(%s, mv=%s): no usable timestamp — skipped",
            root_id, mat_version,
        )
        return None
    try:
        with timer("suggest_latest_roots"):
            # Method name is plural in caveclient (`suggest_latest_roots`)
            # even though we pass a single root and get a single root back.
            # An earlier attempt called the singular spelling, which
            # silently AttributeError'd through the broad except below
            # and degraded the whole feature to a no-op for weeks.
            suggested = client.chunkedgraph.suggest_latest_roots(int(root_id), timestamp=ts)
    except Exception as exc:
        # Chunkedgraph hiccup, or root_id unknown — caller falls back to
        # serving an empty bundle on the original root, which is safer
        # than failing the whole request.
        _root_xlate_logger.warning(
            "suggest_current_root(%s, mv=%s, ts=%s): exception %s: %s",
            root_id, mat_version, ts, type(exc).__name__, exc,
        )
        return None
    _root_xlate_logger.info(
        "suggest_current_root(%s, mv=%s, ts=%s) -> %r (type=%s)",
        root_id, mat_version, ts, suggested, type(suggested).__name__,
    )
    if suggested is None:
        return None
    return int(suggested)


def _partner_soma_positions(
    spatial_provider, decoration_lookup: dict[int, dict[str, Any]],
) -> dict[int, list[float]]:
    """Filter `decoration_lookup` rows down to those the spatial provider
    classifies as real somas. The provider's predicate (default cortex impl
    returns the position when `pt_position` is a 3-tuple) lets a future
    cell-id table mix axon-only entries in without leaking them into
    soma-anchored spatial features."""
    out: dict[int, list[float]] = {}
    for rid, rec in decoration_lookup.items():
        pos = spatial_provider.soma_position_from_row(rec)
        if pos is not None:
            out[int(rid)] = pos
    return out


def _compute_median_dist_to_target_soma(
    *,
    nq: "NeuronQuery",
    partner_soma_positions: dict[int, list[float]],
    root_soma_position_nm: list[float] | None,
    need_in: bool,
    need_out: bool,
) -> tuple[dict[int, float], dict[int, float]]:
    """Plain 3D Euclidean distance from each connecting synapse to the
    *target* (postsynaptic) soma, median per partner. Lives outside the
    SpatialProvider because it doesn't depend on a spatial frame — it's
    raw point-to-point distance over CAVE-served positions.

    Output direction → target = partner; needs partner soma.
    Input  direction → target = root;    needs root soma; partner soma optional.

    Distances come back in micrometers (the bundle's emitted unit). One
    vectorized norm + a pandas groupby-median per direction.
    """
    nm_per_um = 1000.0
    median_in: dict[int, float] = {}
    median_out: dict[int, float] = {}

    if need_in and root_soma_position_nm is not None:
        median_in = _median_partner_dist(
            syn_df=nq._synapse_df("post"),
            partner_root_id_column="pre_pt_root_id",
            syn_position_prefix=nq.synapse_position_prefix,
            target_soma_for=lambda _pid, _root=root_soma_position_nm: _root,
        )
        median_in = {rid: v / nm_per_um for rid, v in median_in.items()}

    if need_out and partner_soma_positions:
        median_out = _median_partner_dist(
            syn_df=nq._synapse_df("pre"),
            partner_root_id_column="post_pt_root_id",
            syn_position_prefix=nq.synapse_position_prefix,
            target_soma_for=lambda pid, _lookup=partner_soma_positions: _lookup.get(pid),
        )
        median_out = {rid: v / nm_per_um for rid, v in median_out.items()}

    return median_in, median_out


def _median_partner_dist(
    *,
    syn_df: pd.DataFrame,
    partner_root_id_column: str,
    syn_position_prefix: str,
    target_soma_for,
) -> dict[int, float]:
    """One vectorized norm over all synapse rows + a pandas groupby-median.
    Constant-target case (inputs) and per-partner-target case (outputs)
    share this single code path; the latter just builds a per-row target
    array via a one-time partner→soma map. Distances stay in input units
    (nm); the caller divides to µm."""
    if syn_df is None or syn_df.empty:
        return {}
    pos_cols = [f"{syn_position_prefix}_position_{a}" for a in ("x", "y", "z")]
    if any(c not in syn_df.columns for c in pos_cols):
        return {}

    partner_col_int = syn_df[partner_root_id_column].astype("int64")
    target_arrays: dict[int, np.ndarray] = {}
    for p in partner_col_int.unique():
        t = target_soma_for(int(p))
        if t is not None:
            target_arrays[int(p)] = np.asarray(t, dtype=float)
    if not target_arrays:
        return {}

    valid_mask = partner_col_int.isin(target_arrays.keys()).to_numpy()
    if not valid_mask.any():
        return {}
    sub_partner_col = partner_col_int.to_numpy()[valid_mask]
    sub_pts = syn_df.loc[valid_mask, pos_cols].to_numpy(dtype=float)
    targets = np.stack([target_arrays[int(p)] for p in sub_partner_col])
    dists = np.linalg.norm(sub_pts - targets, axis=1)

    return (
        pd.Series(dists, index=sub_partner_col)
        .groupby(level=0, sort=False)
        .median()
        .to_dict()
    )


def connectivity_bundle(
    nq: NeuronQuery,
    *,
    include: list[str] | None = None,
    decoration_tables: list[str] | None = None,
    client_factory=None,
    spatial_provider=None,
) -> dict:
    include = set(include or ["partners_in", "partners_out", "summary"])
    # All root_id values cross the wire as JSON strings: int64 root ids overflow
    # JavaScript's Number (float64; precise up to 2^53). The frontend keeps them
    # as strings throughout; the backend converts back via int() at the body
    # boundary. Same rule applies inside aggregated partner records below.
    payload: dict[str, Any] = {
        "datastack": nq.datastack,
        "root_id": str(nq.root_id),
        "version_used": nq.mat_version if not is_live(nq.mat_version) else "live",
        "synapse_table": nq.synapse_table,
        "soma_table": nq.soma_table,
    }
    need_in = "partners_in" in include or "summary" in include
    need_out = "partners_out" in include or "summary" in include
    # `partners_in()` / `partners_out()` time their own `_aggregate` step
    # internally as `aggregate_partners[in/out]` — synapse_query[*] and
    # the groupby are tagged separately so the breakdown is additive.
    #
    # When both directions are needed, parallelize the two CAVE round-
    # trips: each `_synapse_df` is a sync `requests`-backed call (the
    # GIL releases during socket IO), so a 2-thread pool cuts cold
    # latency from sum(post,pre) to max(post,pre) — typically a 5s win
    # on a heavily-connected cell. `copy_current_request_context`
    # propagates `current_app` + `flask.g` into the worker threads so
    # the cache lookups (`current_app.extensions["dcv_synapse_cache"]`)
    # and `timer()` calls (which write to `flask.g.stages`) work
    # identically to the sequential path. Per-direction timer keys
    # (e.g. `synapse_query[post]` vs `[pre]`) don't collide.
    # Single `synapse_query` timer captures wall time of the synapse
    # fetch — parallel or sequential. Per-direction timers would
    # double-count under parallelization, which breaks the `cave_ms` /
    # `processing_ms` rollup. The cache-hit path gates microseconds, so
    # wrapping the whole branch (including cache check + potential
    # CAVE call) is fine.
    with timer("synapse_query"):
        if need_in and need_out:
            from concurrent.futures import ThreadPoolExecutor

            from flask import copy_current_request_context

            from .timing import current_stages

            # Capture the request thread's stages dict so worker timer()
            # calls accumulate into it directly. `copy_current_request_context`
            # gives each worker its own `flask.g` — writes to that copy
            # never reach the request log — so we route the timing dict
            # explicitly via the `stages=` parameter instead of relying
            # on `g`.
            request_stages = current_stages()

            @copy_current_request_context
            def _do_in():
                return nq.partners_in(stages=request_stages)

            @copy_current_request_context
            def _do_out():
                return nq.partners_out(stages=request_stages)

            with ThreadPoolExecutor(max_workers=2, thread_name_prefix="cdv-syn") as pool:
                fut_in = pool.submit(_do_in)
                fut_out = pool.submit(_do_out)
                pin = fut_in.result()
                pout = fut_out.result()
        else:
            pin = nq.partners_in() if need_in else None
            pout = nq.partners_out() if need_out else None

    decoration_lookup: dict[int, dict] = {}
    decoration_groups: list[dict] = []
    revalidation: dict[str, Any] | None = None
    if nq.soma_table or (decoration_tables or []):
        if client_factory is None:
            raise ValueError("connectivity_bundle requires client_factory when enriching")
        from .decoration import lookup_decorations
        # The lookup itself is timed; per-table CAVE round-trips inside
        # are tagged separately as decoration_query[<table>] (see
        # decoration.py).
        # Only enrich partners that will actually be in the response —
        # plus the queried root, which the SPA's "Cell" tab renders as a
        # standalone row alongside the partner tabs. Including the root
        # in this single lookup means the per-partner enrichment + the
        # root enrichment share one CAVE round-trip per decoration table.
        partner_ids: list[int] = []
        if pin is not None and "partners_in" in include:
            partner_ids.extend(int(x) for x in pin["root_id"].tolist())
        if pout is not None and "partners_out" in include:
            partner_ids.extend(int(x) for x in pout["root_id"].tolist())
        partner_ids = list(dict.fromkeys(partner_ids))  # preserve order, dedupe
        # Root included AFTER partners so it doesn't perturb the order
        # the partner enrichment iterates in. `dict.fromkeys` deduplicates
        # if the root happens to also appear as a partner (self-loop).
        decoration_ids = list(dict.fromkeys([*partner_ids, int(nq.root_id)]))
        if decoration_ids:
            with timer("lookup_decorations"):
                decoration_lookup, decoration_groups, revalidation = lookup_decorations(
                    client_factory=client_factory,
                    ds=nq.datastack,
                    mat_version=nq.mat_version,
                    soma_table=nq.soma_table,
                    soma_root_id_column=nq.soma_root_id_column,
                    root_ids=decoration_ids,
                    decoration_tables=decoration_tables or [],
                )

    # Spatial features split into three tiers:
    #
    # 1. `median_dist_to_target_soma` — plain 3D Euclidean over CAVE soma
    #    positions. Doesn't depend on a spatial frame, so it's computed here
    #    directly (kept out of the SpatialProvider contract).
    # 2. Provider-emitted features — partner-intrinsic + per-direction +
    #    summary panels, all driven by the SpatialProvider. The bundle
    #    iterates `provider.feature_manifest()` to enrich partner records
    #    and register column groups.
    # 3. The queried-root's own intrinsic features go onto `root_record`.
    from .spatial import (
        CachedSpatialFeatures,
        build_spatial_provider,
        compute_spatial_features_cached,
    )
    if spatial_provider is None:
        spatial_provider = build_spatial_provider(_NULL_SPATIAL_CFG)

    spatial_features: CachedSpatialFeatures = CachedSpatialFeatures.empty()
    median_dist_in: dict[int, float] = {}
    median_dist_out: dict[int, float] = {}

    if decoration_lookup:
        # `nq.soma_summary()` is cross-request cached, so the call is cheap.
        # Root soma seeds both the intrinsic-feature cache (so the SPA's Cell
        # tab gets intrinsic features even when only plot endpoints ran first)
        # and the input-direction `median_dist_to_target_soma` (target = root).
        root_soma = nq.soma_summary().get("soma_pt_position")
        partner_soma_positions = _partner_soma_positions(spatial_provider, decoration_lookup)
        median_dist_in, median_dist_out = _compute_median_dist_to_target_soma(
            nq=nq,
            partner_soma_positions=partner_soma_positions,
            root_soma_position_nm=root_soma,
            need_in=need_in, need_out=need_out,
        )
        spatial_features = compute_spatial_features_cached(
            nq=nq,
            provider=spatial_provider,
            decoration_lookup=decoration_lookup,
            root_soma_position_nm=root_soma,
        )

    # `spatial_meta` carries the SPA-facing axis-role / label-override /
    # summary-kind metadata so generic SPA components don't hardcode the
    # cortex column vocabulary. `summary_panels` is the typed list of
    # per-cell visualizations the provider emits; the SPA dispatches by
    # `kind`.
    payload["spatial_meta"] = spatial_provider.meta()
    payload["summary_panels"] = [
        {"kind": panel.kind, "data": panel.data}
        for panel in spatial_features.summary_panels
    ]

    manifest = list(spatial_provider.feature_manifest())
    intrinsic_specs = [s for s in manifest if s.scope == "partner_intrinsic"]
    per_direction_specs = [s for s in manifest if s.scope == "partner_per_direction"]

    def _enrich_records(df, direction: str):
        if df is None:
            return None
        per_direction = (
            spatial_features.per_direction_in if direction == "in"
            else spatial_features.per_direction_out
        )
        median_dist_lookup = (
            median_dist_in if direction == "in" else median_dist_out
        )
        records = df.to_dict(orient="records")
        for rec in records:
            rid = int(rec["root_id"])
            extra = decoration_lookup.get(rid)
            if extra:
                rec.update(extra)
            intrinsic_extra = spatial_features.intrinsic.get(rid)
            if intrinsic_extra:
                for spec in intrinsic_specs:
                    if spec.name in intrinsic_extra:
                        rec[spec.name] = intrinsic_extra[spec.name]
            for spec in per_direction_specs:
                lookup = per_direction.get(spec.name)
                if lookup and rid in lookup:
                    rec[spec.name] = lookup[rid]
            if rid in median_dist_lookup:
                rec["median_dist_to_target_soma"] = median_dist_lookup[rid]
            # `pt_position` is internal scaffolding for the spatial computation;
            # strip it so the wire payload stays tight and the SPA doesn't see
            # a column it has no place to render.
            rec.pop("pt_position", None)
            # Stringify after the int-keyed decoration lookup, so the wire
            # payload preserves int64 precision for the JS client.
            rec["root_id"] = str(rid)
        return records

    # `_enrich_records` is the per-partner Python loop that merges the
    # decoration + spatial dicts onto each partner row. Currently O(n)
    # over the partner count with a small constant factor; suspect of
    # hidden cost on heavily-connected neurons. Timed separately per
    # direction to surface a per-direction asymmetry if one exists.
    if "partners_in" in include and pin is not None:
        with timer("enrich_records[in]"):
            payload["partners_in"] = _enrich_records(pin, "in")
    if "partners_out" in include and pout is not None:
        with timer("enrich_records[out]"):
            payload["partners_out"] = _enrich_records(pout, "out")

    # The queried cell, shaped as a single partner-record so the SPA's
    # "Cell" tab can reuse PartnersTable's column rendering. Synapse
    # columns and per-edge stats don't apply here — they're per-partner
    # by construction. We include the cell-type / soma decoration and
    # intrinsic spatial features so the tab reads as a place to find
    # "what does CAVE know about this specific cell." `radial_dist_root_soma`
    # for the root would be 0 by definition (distance from itself), so
    # we drop it as noise.
    root_rid = int(nq.root_id)
    root_rec: dict[str, Any] = {"root_id": str(root_rid)}
    extra = decoration_lookup.get(root_rid)
    if extra:
        root_rec.update(extra)
    spatial_self = spatial_features.intrinsic.get(root_rid)
    if spatial_self:
        for spec in intrinsic_specs:
            if spec.role == "radial":
                continue  # zero by construction for the queried cell
            if spec.name in spatial_self:
                root_rec[spec.name] = spatial_self[spec.name]
    root_rec.pop("pt_position", None)
    payload["root_record"] = root_rec
    if "summary" in include:
        soma = nq.soma_summary()
        payload["summary"] = {
            "num_partners_in": int(pin.shape[0]) if pin is not None else None,
            "num_partners_out": int(pout.shape[0]) if pout is not None else None,
            "num_syn_in": int(nq._synapse_df("post").shape[0]),
            "num_syn_out": int(nq._synapse_df("pre").shape[0]),
            **soma,
        }
    # Prefer the pinned consistency timestamp when set (live mode); fall
    # back to the legacy CAVE-echoed value (df.attrs["timestamp"]) for
    # materialized mode where pinning is implicit via version number.
    if nq.timestamp_for_consistency is not None:
        payload["timestamp_used"] = nq.timestamp_for_consistency.isoformat()
    else:
        payload["timestamp_used"] = nq.timestamp_used
    payload["synapse_columns_meta"] = {
        "aggregation_rules": [
            {"name": k, **v} for k, v in nq.synapse_aggregation_rules.items()
        ],
        "synapse_table": nq.synapse_table,
    }

    # column_groups drives the SPA's two-row table header. Order matters: it's
    # the left-to-right column order. Each group has `kind` (intrinsic, synapse,
    # soma, cell_type, table, spatial) so the frontend can style them per-class.
    synapse_cols = ["num_syn"] + list(nq.synapse_aggregation_rules.keys())
    # Direction-specific stats live in the synapse group so the Both-tab
    # unifier splits each into `_in` / `_out` alongside num_syn / mean_size.
    # `median_dist_to_target_soma` is plain Euclidean (computed in this
    # module, not via the spatial provider); per-direction provider features
    # come from the manifest below.
    if median_dist_in or median_dist_out:
        synapse_cols.append("median_dist_to_target_soma")
    for spec in per_direction_specs:
        in_present = bool(spatial_features.per_direction_in.get(spec.name))
        out_present = bool(spatial_features.per_direction_out.get(spec.name))
        if in_present or out_present:
            synapse_cols.append(spec.name)
    column_groups = [
        {"name": "id",      "kind": "intrinsic", "columns": ["root_id"]},
        {"name": "synapse", "kind": "synapse",   "columns": synapse_cols},
        *decoration_groups,
    ]
    if spatial_features.intrinsic:
        # Partner-intrinsic spatial columns: same value for both directions,
        # so the unifier passes them through unchanged. Sample one record
        # to discover which manifest entries actually materialized (e.g.
        # `radial_dist_root_soma` is omitted when no root soma is present).
        sample_rec = next(iter(spatial_features.intrinsic.values()))
        intrinsic_spatial_cols = [
            spec.name for spec in intrinsic_specs if spec.name in sample_rec
        ]
        if intrinsic_spatial_cols:
            column_groups.append({
                "name": "spatial",
                "kind": "spatial",
                "columns": intrinsic_spatial_cols,
            })
    payload["column_groups"] = column_groups

    payload["decoration_revalidation"] = revalidation
    return payload
