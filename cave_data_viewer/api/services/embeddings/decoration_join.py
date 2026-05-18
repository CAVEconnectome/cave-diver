"""Join a decoration-table column onto a positional cell_id sequence.

The Feature Explorer scatters cells in cell_id space; the existing
decoration tables (cell types, proofreading status, etc.) are keyed on
root_id. This module bridges the two:

1. Resolve every cell_id → root_id at the requested mat_version via the
   resolver. Cached in services/cell_id.py's per-id TTLCache.
2. Pull the table's ``{root_id: row}`` snapshot from the existing
   ``DecorationService`` cache (synchronously fetching + caching the
   whole table on a cold miss).
3. Project one column out of each row, producing a positionally-aligned
   list with ``None`` for cells that didn't resolve or whose root_id
   isn't in the decoration table.

This is the symmetric counterpart of Part 2 (which will do
``root_id -> cell_id`` to project feature columns into connectivity).
Part 1's direction is the one the explorer needs immediately so the
ColorByPicker / FeatureFilters / cell-detail tooltip can show
decoration values alongside parquet-native columns.

Future optimization (not v1): many decoration tables — especially
cell-type tables sourced directly from nucleus rows — are themselves
keyed by cell_id in CAVE, not by root_id. For those tables we could
skip the resolver step entirely and project values straight from a
cell_id → row map. v1 takes the universally-correct resolver path; a
follow-up can detect cell_id-keyed tables (via table metadata or a
per-table flag in the datastack YAML) and short-circuit.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Sequence

from ..cache_lifecycle import cache_datastack
from ..keys import is_live
from .resolver import resolve_cell_ids_to_root_ids

logger = logging.getLogger(__name__)


def get_decoration_table_snapshot(
    *,
    client_factory: Callable[[], Any],
    ds: str,
    mat_version: int | str | None,
    table: str,
) -> dict[int, dict[str, Any]]:
    """Return the ``{root_id: row_dict}`` snapshot for a decoration table.

    Cache-first: if the existing decoration service holds the snapshot,
    return it directly (free). On a cold miss, fetch the table from CAVE
    synchronously and populate the cache so the next caller hits warm.

    This bypasses ``lookup_decorations``' ticket-minting/revalidation
    logic — those are useful for partner-set lookups that want SWR
    semantics, but for batch joins over many cells we just want the
    snapshot. The underlying decoration cache is shared, so a warmed
    entry serves both code paths.
    """
    # Local imports keep this module from picking up the decoration
    # service's full transitive surface at import time.
    from ..decoration import _fetch_decoration_table, get_decoration_service

    service = get_decoration_service()
    live = is_live(mat_version)
    cache = service.cache_for("table", live)
    cache_ds = cache_datastack(ds)
    key = (cache_ds, mat_version, table)

    entry = cache.get(key)
    if entry is not None:
        value, _freshness = entry
        return value or {}

    snapshot = _fetch_decoration_table(client_factory(), table, mat_version)
    cache.set(key, snapshot)
    return snapshot or {}


def join_decoration_column(
    *,
    client_factory: Callable[[], Any],
    cfg,
    ds: str,
    mat_version: int | str | None,
    table: str,
    column: str,
    cell_ids: Sequence[int],
) -> tuple[list[Any], dict[str, int]]:
    """Project ``table.column`` onto the positional order of ``cell_ids``.

    Parameters
    ----------
    client_factory
        Zero-arg callable that returns a configured CAVEclient. The
        existing decoration service uses the same factory convention so
        background revalidation closures can rebuild clients with the
        right auth context.
    cfg
        Loaded ``DatastackConfig``. Used by the resolver to find
        the ``cell_id_lookup`` block and friends.
    ds
        Datastack name (NOT the cache alias — cache aliasing is applied
        internally where needed).
    mat_version
        Materialization version (or ``"live"``). Forwarded to both the
        resolver and the decoration snapshot lookup.
    table, column
        Decoration table + column to project.
    cell_ids
        The positional cell_id sequence (typically from ``/points``).
        Order is preserved in the output.

    Returns
    -------
    (values, resolution_stats)
        ``values[i]`` is the decoration value for ``cell_ids[i]``, or
        ``None`` if the cell didn't resolve to a root_id, or its root_id
        isn't in the decoration table, or the row exists but the column
        value is null.

        ``resolution_stats`` is ``{"ok": N, "missing": N, "ambiguous": N,
        "no_decoration": N}``. Breaks the count of nulls down by cause
        so the SPA can show "12% of cells lack a cell_type assignment"
        vs "8% of cells couldn't be resolved at this mat_version".
    """
    cell_ids = [int(c) for c in cell_ids]
    if not cell_ids:
        return [], {"ok": 0, "missing": 0, "ambiguous": 0, "no_decoration": 0}

    # Step 1: cell_id -> root_id.
    resolutions = resolve_cell_ids_to_root_ids(
        client=client_factory(),
        cfg=cfg,
        mat_version=mat_version,
        datastack=ds,
        cell_ids=cell_ids,
    )

    # Step 2: full table snapshot.
    snapshot = get_decoration_table_snapshot(
        client_factory=client_factory, ds=ds, mat_version=mat_version, table=table,
    )

    # Step 3: positional projection.
    stats = {"ok": 0, "missing": 0, "ambiguous": 0, "no_decoration": 0}
    values: list[Any] = []
    for res in resolutions:
        if res.status == "missing":
            stats["missing"] += 1
            values.append(None)
            continue
        if res.status == "ambiguous":
            stats["ambiguous"] += 1
            values.append(None)
            continue
        # ok
        row = snapshot.get(int(res.root_id)) if res.root_id is not None else None
        if row is None:
            # Root resolved but the decoration table doesn't carry it —
            # distinct from "cell didn't resolve at all", and useful to
            # surface separately so users can tell "this mat_version
            # doesn't have <table> entries for these cells".
            stats["no_decoration"] += 1
            values.append(None)
            continue
        val = row.get(column)
        if val is None:
            # Row exists but the specific column is null. Bucket as
            # no_decoration — same UX as "not in table" from the user's
            # perspective.
            stats["no_decoration"] += 1
            values.append(None)
        else:
            stats["ok"] += 1
            values.append(val)

    return values, stats
