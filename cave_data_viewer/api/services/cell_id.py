"""Cell-id ↔ root-id lookup.

A cell id is a persistent identifier (typically a nucleus row id) that survives
proofreading splits/merges. Root ids do not. To go between them we follow the
pattern from `ceesem/cortical-tools` (common.py + microns_public.py):

  cell_id → root_id  (forward)
    Query a materialized view (`cell_id_lookup_view`) keyed on `id`.
    - In materialized mode the view's `pt_root_id` is what we want.
    - In live mode we resolve `pt_supervoxel_id` → current root via the
      chunkedgraph (the view itself doesn't update with edits).

  root_id → cell_id  (reverse)
    Query a `main_table` keyed on `pt_root_id`. Drop ambiguous rows where the
    root id appears more than once (those aren't safely a single cell id).
    Try `alt_tables` for any root ids the main table missed (split/merge edge
    cases the dataset operator chose to cover). Each alt table is expected to
    expose `pt_ref_root_id` + `target_id` columns; we rename to the main-table
    schema before merging.

Datastacks without these resources omit the config keys; the corresponding
endpoint refuses with 422 and the SPA hides the cell-id input.

Caching strategy
----------------
The mapping for a *frozen* materialization version is a finite, immutable
universe — typically tens of thousands of (cell_id, root_id) pairs. Caching
per-cell would force a CAVE roundtrip every time a request touches a
cell_id we haven't seen yet, even though the universe itself never
changes within a mat_version. So:

- **Materialized forward (cell → root)**: a per-(ds, mat_version)
  "universe" cache. First miss fetches the *whole* lookup view, populates
  a `{cell_id: root_id}` dict, and that one entry serves every forward
  lookup at that mat_version for the cache TTL. The reverse-direction
  ``_root_to_cell`` cache is opportunistically populated from the same
  fetch, so root-side lookups for cells in the universe also become free.

- **Live forward (cell → root)**: per-cell TTLCache with short TTL.
  Live mode drifts as proofreading lands, and the universe at a given
  request timestamp isn't materialized — caching it would either be
  wrong (drift past the snapshot) or wasteful (re-fetch the whole view
  every few minutes). Per-cell with a short TTL keeps the size + cost
  small while honoring the moving target.

- **Reverse (root → cell)**: per-root TTLCache, long TTL. ``root_id →
  cell_id`` is invariant once known (a root id is a frozen identifier).
  The universe-load above pre-warms most entries; the reverse-only path
  hits CAVE only for root ids that aren't in the lookup view at all
  (orphan roots without nucleus rows — covered by the optional
  ``root_id_lookup_alt_tables``).
"""

import datetime as _dt
import threading
from dataclasses import dataclass
from typing import Iterable

from cachetools import TTLCache

from .keys import is_live
from .query_runner import run_query
from .request_state import current_timestamp


# ----- caches -----------------------------------------------------------------

# Universe cache: (datastack, mat_version) → CellUniverse. One entry per
# frozen materialization, holding the full {cell_id: root_id} dict from
# the lookup view. A TTLCache rather than a plain dict so a dev session
# that touches a hundred mat versions doesn't accumulate forever; the
# 7-day TTL is effectively "until pod restart" for any version that
# stays in the working set.
_UNIVERSE_TTL = 7 * 24 * 3600
_universe_mat: TTLCache = TTLCache(maxsize=64, ttl=_UNIVERSE_TTL)

# Root → cell is invariant per-(ds, root_id) once known. The universe
# load pre-populates this for every (cell_id, root_id) pair it sees,
# so most reverse lookups become dict reads against this cache.
_ROOT_TO_CELL_TTL = 7 * 24 * 3600
_root_to_cell: TTLCache = TTLCache(maxsize=100_000, ttl=_ROOT_TO_CELL_TTL)

# Live mode keeps per-cell entries with a short TTL because the universe
# is moving. Bumping to per-universe would force a 94k-row refetch
# every TTL window even when the user only cares about a handful of
# cells.
_CELL_TO_ROOT_LIVE_TTL = 5 * 60
_cell_to_root_live: TTLCache = TTLCache(maxsize=10_000, ttl=_CELL_TO_ROOT_LIVE_TTL)

_lock = threading.Lock()


@dataclass(frozen=True)
class CellUniverse:
    """Materialized cell_id ↔ root_id mapping for one (datastack,
    mat_version). Holds both directions so forward and reverse hits
    are O(1) dict lookups.

    ``cell_to_root`` is dense (every row of the lookup view). Values
    are ``None`` when a cell's view row exists but its root has rolled
    over to 0 (genuinely missing root_id).

    ``root_to_cell`` is built from the same data, dropping duplicate
    root_ids (those are ambiguous — leave None and let the caller
    decide). Use it for opportunistic root→cell answers; the
    main+alt-tables path in :func:`root_ids_to_cell_ids` still handles
    root_ids that aren't in the lookup view at all.
    """
    cell_to_root: dict[int, int | None]
    root_to_cell: dict[int, int | None]


def clear_caches() -> None:
    """Test/admin entry point. The TTLs are otherwise self-managing."""
    with _lock:
        _universe_mat.clear()
        _root_to_cell.clear()
        _cell_to_root_live.clear()


def _get_universe(
    *, client, view: str, datastack: str, mat_version: int
) -> CellUniverse:
    """Return the cached universe for ``(datastack, mat_version)``, fetching
    it if necessary. Caller holds no lock; this acquires + releases as needed.

    First-miss path: queries the entire lookup view (no ``id=`` filter),
    builds both directional dicts, caches them, opportunistically
    populates the ``_root_to_cell`` per-cell cache so future root-side
    lookups for these cells are free even if the universe entry ages
    out.
    """
    key = (datastack, int(mat_version))

    with _lock:
        hit = _universe_mat.get(key)
        if hit is not None:
            return hit

    # Cold path: fetch the whole view. Materialized views don't support
    # ``live_query`` and the lookup view is small (low-six-digits of rows
    # for minnie65 scale; we've never seen a deployment where it pushes
    # CAVE pagination), so a no-filter query is correct + efficient.
    qf = client.materialize.views[view]()
    df = qf.query(split_positions=False)

    cell_to_root: dict[int, int | None] = {}
    root_counts: dict[int, int] = {}
    if not df.empty:
        for cid, rid in zip(df["id"].astype("int64"), df["pt_root_id"].astype("int64")):
            cid_i = int(cid)
            rid_i = int(rid)
            cell_to_root[cid_i] = rid_i if rid_i != 0 else None
            if rid_i != 0:
                root_counts[rid_i] = root_counts.get(rid_i, 0) + 1

    # Reverse dict: only include unambiguous root_ids (those appearing
    # exactly once). Ambiguous roots map to None so callers see the
    # collision explicitly rather than getting one arbitrary cell_id.
    root_to_cell: dict[int, int | None] = {}
    if not df.empty:
        for cid, rid in zip(df["id"].astype("int64"), df["pt_root_id"].astype("int64")):
            rid_i = int(rid)
            if rid_i == 0:
                continue
            if root_counts[rid_i] == 1:
                root_to_cell[rid_i] = int(cid)
            else:
                root_to_cell[rid_i] = None

    universe = CellUniverse(cell_to_root=cell_to_root, root_to_cell=root_to_cell)

    with _lock:
        _universe_mat[key] = universe
        # Opportunistically prime the per-root cache so reverse-only
        # lookups (e.g. the form-input flow on /neuron) hit warm without
        # needing the universe entry to still be live.
        for rid, cid in root_to_cell.items():
            _root_to_cell[(datastack, rid)] = cid

    return universe


_SENTINEL = object()


def cell_ids_to_root_ids(
    *,
    client,
    cfg,                          # DatastackConfig
    mat_version: int | str | None,
    datastack: str,
    cell_ids: Iterable[int],
) -> dict[int, int | None]:
    """Resolve cell ids → current root ids. Unmapped → None.

    Materialized mode: routes through the per-(ds, mv) universe cache.
    First miss fetches the whole lookup view; subsequent calls (any
    cell_id at the same ds+mv) are pure dict reads.

    Live mode: per-cell TTLCache with short TTL. The universe is moving;
    a per-universe cache would either drift or thrash. Each missed
    cell_id is queried individually-batched against the view, then
    supervoxels resolved to current roots via the chunkedgraph.
    """
    view = cfg.cell_id_lookup_view
    if not view:
        raise ValueError("This datastack has no cell_id_lookup_view configured.")
    cell_ids = [int(x) for x in cell_ids]
    if not cell_ids:
        return {}

    live = is_live(mat_version)

    if not live:
        # Materialized: universe-cache path.
        universe = _get_universe(
            client=client, view=view, datastack=datastack, mat_version=int(mat_version),
        )
        # Cells outside the universe simply weren't in the view —
        # represent as None to keep the wire shape uniform with the
        # legacy implementation.
        return {cid: universe.cell_to_root.get(cid) for cid in cell_ids}

    # Live mode: per-cell TTLCache with short TTL.
    out: dict[int, int | None] = {}
    misses: list[int] = []
    with _lock:
        for cid in cell_ids:
            hit = _cell_to_root_live.get((datastack, cid), _SENTINEL)
            if hit is _SENTINEL:
                misses.append(cid)
            else:
                out[cid] = hit

    if not misses:
        return out

    qf = client.materialize.views[view](id=misses)
    df = qf.query(split_positions=False)

    if not df.empty:
        # Live mode: the view's pt_root_id is at-mat-version; resolve
        # supervoxels to current roots via the chunkedgraph at the
        # request's pinned consistency timestamp so this matches synapse
        # / soma / decoration reads done in the same request.
        ts = current_timestamp() or _dt.datetime.now(_dt.timezone.utc)
        sv_ids = df["pt_supervoxel_id"].astype("int64").tolist()
        roots = client.chunkedgraph.get_roots(sv_ids, timestamp=ts)
        df = df.assign(pt_root_id=roots)

    indexed = df.set_index("id") if not df.empty else df
    fresh: dict[int, int | None] = {}
    for cid in misses:
        if not df.empty and cid in indexed.index:
            r = indexed.at[cid, "pt_root_id"]
            fresh[cid] = int(r) if r and int(r) != 0 else None
        else:
            fresh[cid] = None

    with _lock:
        for cid, rid in fresh.items():
            _cell_to_root_live[(datastack, cid)] = rid
            if rid is not None:
                _root_to_cell[(datastack, rid)] = cid

    out.update(fresh)
    return out


def root_ids_to_cell_ids(
    *,
    client,
    cfg,
    mat_version: int | str | None,
    datastack: str,
    root_ids: Iterable[int],
) -> dict[int, int | None]:
    """Resolve current root ids → cell ids. Unmapped or ambiguous → None.

    Fast path: if the materialized universe for ``(datastack,
    mat_version)`` is already loaded (cell_to_root caller, soma-table
    warmup, or earlier reverse-driven load), serve from its inverse
    dict — pure O(1) lookups, no CAVE call.

    Slow path: query ``root_id_lookup_main_table`` filtered by the
    misses, fall through to ``root_id_lookup_alt_tables`` for anything
    still unmapped (split/merge edge cases the lookup view doesn't
    cover). Per-root results land on ``_root_to_cell`` so subsequent
    calls hit warm.

    ``root → cell`` is invariant once known, regardless of mat_version
    (a root id is a frozen identifier). The per-root cache TTL is long
    because of this; even unmapped (None) results are cached to skip
    re-querying for orphan root ids.
    """
    main = cfg.root_id_lookup_main_table
    if not main:
        raise ValueError("This datastack has no root_id_lookup_main_table configured.")
    root_ids = [int(x) for x in root_ids if int(x) != 0]
    if not root_ids:
        return {}

    out: dict[int, int | None] = {}
    misses: list[int] = []

    # Pass 1: per-root cache (forever-stable values).
    with _lock:
        for rid in root_ids:
            hit = _root_to_cell.get((datastack, rid), _SENTINEL)
            if hit is _SENTINEL:
                misses.append(rid)
            else:
                out[rid] = hit

    # Pass 2: universe inverse (only when a materialized mv is in play
    # and its universe is already loaded — we never trigger a cold
    # universe fetch from the reverse path because the main+alt-table
    # query is usually narrower and faster for a small set of root_ids).
    live = is_live(mat_version)
    if misses and not live and mat_version is not None:
        with _lock:
            universe = _universe_mat.get((datastack, int(mat_version)))
        if universe is not None:
            still_missing: list[int] = []
            for rid in misses:
                if rid in universe.root_to_cell:
                    cid = universe.root_to_cell[rid]
                    out[rid] = cid
                    # Promote into the per-root cache so subsequent
                    # calls hit even if the universe entry ages out.
                    with _lock:
                        _root_to_cell[(datastack, rid)] = cid
                else:
                    still_missing.append(rid)
            misses = still_missing

    if not misses:
        return out

    # Pass 3: main_table + alt_tables (CAVE call).
    fresh: dict[int, int | None] = {rid: None for rid in misses}
    pinned_ts = current_timestamp()

    # Main table: pt_root_id → id. Drop rows where the same root appears
    # multiple times — that's an ambiguous mapping; leave None.
    qf = client.materialize.tables[main](pt_root_id=misses)
    df = run_query(qf, live=live, timestamp=pinned_ts, split_positions=False)
    if not df.empty:
        df = df.drop_duplicates(subset="pt_root_id", keep=False)
        for _, row in df.iterrows():
            rid = int(row["pt_root_id"])
            if rid in fresh:
                fresh[rid] = int(row["id"])

    # Alt tables for any root ids still unmapped. Schema rename matches
    # the upstream pattern (pt_ref_root_id → pt_root_id, target_id → id).
    for alt in cfg.root_id_lookup_alt_tables:
        unmapped = [rid for rid, cid in fresh.items() if cid is None]
        if not unmapped:
            break
        try:
            qf = client.materialize.tables[alt](pt_ref_root_id=unmapped)
            df = run_query(qf, live=live, timestamp=pinned_ts, split_positions=False)
        except Exception:
            continue
        if df.empty:
            continue
        df = df.rename(columns={"pt_ref_root_id": "pt_root_id", "target_id": "id"})
        if "pt_root_id" not in df.columns or "id" not in df.columns:
            continue
        df = df.drop_duplicates(subset="pt_root_id", keep=False)
        for _, row in df.iterrows():
            rid = int(row["pt_root_id"])
            if rid in fresh and fresh[rid] is None:
                fresh[rid] = int(row["id"])

    # Cache successes AND known-unmapped (None) — saves repeated misses
    # for orphan root ids.
    with _lock:
        for rid, cid in fresh.items():
            _root_to_cell[(datastack, rid)] = cid

    out.update(fresh)
    return out
