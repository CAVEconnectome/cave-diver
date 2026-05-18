"""cell_id ↔ root_id translation for the Feature Explorer.

Thin wrapper over ``services/cell_id.py`` that produces the structured
``{cell_id, root_id, status}`` shape the SelectionPane and ``/resolve_roots``
endpoint consume. The underlying primitive already batches + caches; this
layer adds:

- A structured ``Resolution`` record (vs the existing ``dict`` shape) so
  callers can distinguish ``ok`` / ``missing`` / ``ambiguous`` without
  guessing from a ``None`` value.
- Forward-compatible ``ambiguous`` status (with ``candidates``). v1's
  forward direction (cell → root) doesn't produce ambiguous results in
  practice — the materialized view is one row per cell — but the field
  exists so a future tightening (e.g. surfacing splits across versions)
  doesn't break the wire shape.

The resolver is *not* called from within the explorer's data path
(/points, /column, /distance_to_set) — those operate purely in cell_id
space. The resolver is invoked only at boundaries: ``/resolve_roots``
for SPA cross-nav prefetch.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Sequence

logger = logging.getLogger(__name__)

ResolutionStatus = Literal["ok", "missing", "ambiguous"]


@dataclass(frozen=True)
class Resolution:
    """One ``cell_id -> root_id`` resolution result.

    - ``status == "ok"``: ``root_id`` is a valid current root for the cell
      at the requested mat_version.
    - ``status == "missing"``: the cell either isn't in the lookup view at
      this mat_version, OR (live mode) its supervoxel doesn't resolve to a
      non-zero root.
    - ``status == "ambiguous"``: reserved for a future extension; the
      ``candidates`` tuple would carry the colliding root_ids. v1's
      forward direction does not emit this status.

    ``source_ds`` tags the resolution with the datastack the cell_id lives
    in. Single-ds callers leave it ``None`` (the path-scoped endpoint
    knows the ds from its URL); the ``(ds, cell_id)`` tuple form
    populates it so multi-ds callers can route each resolution back to
    its home datastack without a side lookup.
    """

    cell_id: int
    root_id: int | None
    status: ResolutionStatus
    candidates: tuple[int, ...] = field(default_factory=tuple)
    source_ds: str | None = None


def resolve_cell_ids_to_root_ids(
    *,
    client,
    cfg,
    mat_version: int | str | None,
    datastack: str,
    cell_ids: Sequence[int],
) -> list[Resolution]:
    """Translate cell_ids → root_ids at ``mat_version``.

    Order is preserved: ``output[i].cell_id == cell_ids[i]``. Caching,
    batching, and (live mode) supervoxel → root translation are inherited
    from the underlying ``cell_ids_to_root_ids`` primitive.

    Raises ``ValueError`` (propagated from the primitive) when the
    datastack has no ``cell_id_lookup`` block configured. The endpoint layer
    surfaces that as a 422.
    """
    # Local import to keep this module free of circular dependencies
    # (services/cell_id imports nothing from this package).
    from ..cell_id import cell_ids_to_root_ids

    if not cell_ids:
        return []

    mapping = cell_ids_to_root_ids(
        client=client,
        cfg=cfg,
        mat_version=mat_version,
        datastack=datastack,
        cell_ids=[int(c) for c in cell_ids],
    )

    results: list[Resolution] = []
    for raw in cell_ids:
        cell_id = int(raw)
        root_id = mapping.get(cell_id)
        if root_id is None:
            results.append(
                Resolution(cell_id=cell_id, root_id=None, status="missing")
            )
        else:
            results.append(
                Resolution(
                    cell_id=cell_id, root_id=int(root_id), status="ok"
                )
            )
    return results


def resolve_pairs_to_root_ids(
    *,
    client_factory: Callable[[str], Any],
    cfg_factory: Callable[[str], Any],
    mat_version: int | str | None,
    pairs: Sequence[tuple[str, int]],
) -> list[Resolution]:
    """Translate ``(datastack, cell_id)`` pairs → root_ids at ``mat_version``.

    The multi-dataset companion to :func:`resolve_cell_ids_to_root_ids`.
    Shards ``pairs`` by datastack, dispatches one per-ds batch through
    the existing single-ds primitive, and stitches results back into the
    original positional order. Each returned ``Resolution`` carries its
    ``source_ds`` so multi-ds callers (e.g. the phase-2 body-scoped
    ``/resolve_roots`` endpoint) can route every resolution back to its
    home datastack without a side lookup.

    Parameters
    ----------
    client_factory
        ``ds -> CAVEclient``. Called once per distinct datastack present
        in ``pairs``. Phase-1 callers can wrap the existing
        :func:`api.cave.request_client` factory.
    cfg_factory
        ``ds -> DatastackConfig``. Called once per distinct datastack.
        Typically a thin closure over
        :func:`services.datastack_config.load_datastack_config`.
    mat_version
        Shared materialization version for the whole batch. The resolver
        only supports one mat_version per call because the cell_id
        universe cache is keyed on it; mixing versions in one call would
        force per-pair cache lookups and lose the batching benefit.
    pairs
        ``(datastack, cell_id)`` tuples. Order is preserved in the
        output. An empty list short-circuits to ``[]``.
    """
    if not pairs:
        return []

    # Bucket positions by datastack so we can issue one batch per ds
    # while preserving the caller's order in the final list.
    by_ds: dict[str, list[int]] = {}
    positions: dict[str, list[int]] = {}
    for i, (ds, cid) in enumerate(pairs):
        by_ds.setdefault(ds, []).append(int(cid))
        positions.setdefault(ds, []).append(i)

    output: list[Resolution | None] = [None] * len(pairs)
    for ds, cids in by_ds.items():
        client = client_factory(ds)
        cfg = cfg_factory(ds)
        results = resolve_cell_ids_to_root_ids(
            client=client,
            cfg=cfg,
            mat_version=mat_version,
            datastack=ds,
            cell_ids=cids,
        )
        for j, res in enumerate(results):
            original_index = positions[ds][j]
            # Re-stamp with source_ds so the wire shape carries the
            # row's home datastack. ``replace`` rather than mutating
            # because Resolution is frozen.
            from dataclasses import replace
            output[original_index] = replace(res, source_ds=ds)

    # Cast: ``None`` slots are filled because every position appears in
    # exactly one ds bucket; the type narrowing is for the type checker.
    return [r for r in output if r is not None]


def reverse_resolve_root_id_to_cell_id(
    *,
    client,
    cfg,
    mat_version: int | str | None,
    datastack: str,
    root_id: int,
) -> int | None:
    """Reverse-resolve a single root_id to its cell_id.

    Kept as a public helper for callers that need single-root reverse
    resolution (typically a root_id pasted from a Neuroglancer tab being
    translated into the cell_id namespace before any explorer action).
    The lookup goes through the datastack's
    ``root_id_lookup_main_table`` + any ``root_id_lookup_alt_tables``
    exactly as the existing ``/cell-ids/lookup`` endpoint does.

    Returns ``None`` when the root has no nucleus mapping, or maps
    ambiguously to multiple cells (the underlying primitive drops
    duplicate-pt_root_id rows). The endpoint layer translates ``None`` to
    a 404.
    """
    from ..cell_id import root_ids_to_cell_ids

    mapping = root_ids_to_cell_ids(
        client=client,
        cfg=cfg,
        mat_version=mat_version,
        datastack=datastack,
        root_ids=[int(root_id)],
    )
    cid = mapping.get(int(root_id))
    return int(cid) if cid is not None else None
