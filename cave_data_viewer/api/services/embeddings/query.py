"""Row context for ``embedding_cells``-sourced plots.

``FeatureTableQuery`` plays the role ``NeuronQuery`` does on ``/neuron``:
it produces the dataframe that ``resolve_plot`` reads from, plus the
``datastack`` / ``mat_version`` metadata the universe-color lookup and
cache keying need. The two classes are not related by inheritance —
they share only an informal ``RowContext`` shape (``datastack``,
``mat_version``, ``key_column``) that ``resolve_plot`` reads off.

Keying asymmetry:

- ``NeuronQuery`` builds frames keyed on ``root_id`` (partners of one
  cell). Decoration columns are joined inside ``resolve_plot`` by
  ``lookup_decorations(root_ids=df['root_id'])``.
- ``FeatureTableQuery`` builds frames keyed on ``cell_id`` (cells in
  a parquet). Decoration columns are joined here, by resolving each
  ``cell_id`` to ``root_id`` at the request's mat_version and then
  reading the existing per-table snapshot. That keeps ``resolve_plot``'s
  partners-frame decoration path unchanged.

The cell_id column on the emitted frame is renamed to ``cell_id`` even
if the manifest's ``id_column`` was something else, so downstream code
that needs to read the primary key reads a single canonical name.
"""

from __future__ import annotations

import logging
from typing import Any, Callable

import pandas as pd

from .decoration_join import get_decoration_table_snapshot
from .loader import load_feature_table_frame
from .manifest import FeatureTableSpec
from .resolver import resolve_cell_ids_to_root_ids

logger = logging.getLogger(__name__)


class FeatureTableQuery:
    """Cell_id-keyed row context for the Feature Explorer.

    Parameters
    ----------
    datastack
        Datastack the request was made against. Used for the universe-
        color lookup, the decoration-table snapshot keys, and cache
        keying inside ``load_feature_table_frame``.
    mat_version
        Materialization version (or ``"live"``). Drives the resolver and
        any decoration-table snapshot lookup. Not used for parquet
        loading — that's pinned by ``parquet_uri``.
    feature_table
        Resolved ``FeatureTableSpec`` from the manifest.
    cfg
        Loaded ``DatastackConfig``. Forwarded to the resolver so it can
        find ``cell_id_lookup_view`` and friends.
    client_factory
        Optional zero-arg callable returning a CAVEclient. Required when
        ``frame()`` is asked to merge decoration columns; not needed for
        a pure-parquet read.
    """

    key_column: str = "cell_id"

    def __init__(
        self,
        *,
        datastack: str,
        mat_version: int | str | None,
        feature_table: FeatureTableSpec,
        cfg,
        client_factory: Callable[[], Any] | None = None,
    ) -> None:
        self.datastack = datastack
        self.mat_version = mat_version
        self.feature_table = feature_table
        self.cfg = cfg
        self.client_factory = client_factory

    def frame(self, *, decoration_tables: list[str] | None = None) -> pd.DataFrame:
        """Return the parquet frame, optionally decoration-merged.

        Decoration columns land as ``<table>.<column>`` exactly matching
        the partners-frame convention so ``?cells=`` filter expressions
        and the universe-color resolver work without branching on the
        source. Missing/ambiguous resolutions and rows absent from the
        decoration table all surface as ``None``.

        Parameters
        ----------
        decoration_tables
            List of decoration table names to attach. Empty / ``None``
            returns the parquet untouched (no CAVE calls).
        """
        df = load_feature_table_frame(self.datastack, self.feature_table).copy()
        # Normalize the id column so downstream code (resolve_plot,
        # _apply_cell_filters, universe-color lookup) can read a single
        # canonical name regardless of how the manifest declared it.
        if self.feature_table.id_column != "cell_id":
            df = df.rename(columns={self.feature_table.id_column: "cell_id"})
        # Prefix every non-id parquet column with the feature_table_id so the
        # column lives in the same `<table>.<col>` namespace decoration tables
        # use. The `?cells=` filter parser requires every clause to be
        # `<table>.<col>:<op>:<val>`, so without this the user would have no
        # way to write a predicate on a parquet column. The id stays bare —
        # it's the primary key, treated specially by PartnersTable's
        # getRowId + by the resolver's cell_id resolution.
        ft_id = self.feature_table.id
        rename: dict[str, str] = {}
        for col in df.columns:
            if col == "cell_id":
                continue
            rename[col] = f"{ft_id}.{col}"
        if rename:
            df = df.rename(columns=rename)

        cell_ids = df["cell_id"].astype(int).tolist()

        # Nucleus position enrichment — adds `nucleus.x` / `nucleus.y` /
        # `nucleus.z` columns (µm) reading from the universe cache. The
        # positions ride along on the universe fetch the resolver
        # already performs, so this is "for free" once the resolver
        # has been hit at the active mat_version. Bundles spatial
        # axes into the explorer's column space alongside the parquet's
        # computed features (e.g. soma_depth_y) so the user can plot
        # nucleus.y vs soma_depth_y, color by nucleus.z, etc.
        #
        # Skipped silently when the resolver isn't configured for the
        # datastack, in live mode (no universe cache), or when no
        # client_factory was supplied (a pure parquet read).
        if (
            self.client_factory is not None
            and self.mat_version is not None
            and self.mat_version != "live"
            and getattr(self.cfg, "cell_id_lookup_view", None)
        ):
            try:
                from ..cell_id import cell_ids_to_positions
                positions = cell_ids_to_positions(
                    client=self.client_factory(),
                    cfg=self.cfg,
                    mat_version=self.mat_version,
                    datastack=self.datastack,
                    cell_ids=cell_ids,
                )
                xs: list[float | None] = []
                ys: list[float | None] = []
                zs: list[float | None] = []
                for cid in cell_ids:
                    pos = positions.get(cid)
                    if pos is None:
                        xs.append(None)
                        ys.append(None)
                        zs.append(None)
                    else:
                        xs.append(pos[0])
                        ys.append(pos[1])
                        zs.append(pos[2])
                df["nucleus.x"] = xs
                df["nucleus.y"] = ys
                df["nucleus.z"] = zs
            except Exception:
                # Defensive: nucleus position is a convenience, not a
                # contract. If the universe load fails for any reason
                # (live mode crept in, CAVE hiccup, etc.), proceed
                # without it rather than failing the whole request.
                pass

        if not decoration_tables:
            return df
        if self.client_factory is None:
            raise ValueError(
                "FeatureTableQuery.frame: decoration_tables requested but "
                "no client_factory was provided."
            )

        # Resolve once; reuse across every requested decoration table.
        # The universe cache in services/cell_id.py makes the second-and-
        # subsequent table lookups a free dict read at this mat_version.
        resolutions = resolve_cell_ids_to_root_ids(
            client=self.client_factory(),
            cfg=self.cfg,
            mat_version=self.mat_version,
            datastack=self.datastack,
            cell_ids=cell_ids,
        )
        resolved_root_ids: list[int | None] = [
            res.root_id if res.status == "ok" else None for res in resolutions
        ]

        for table in decoration_tables:
            snapshot = get_decoration_table_snapshot(
                client_factory=self.client_factory,
                ds=self.datastack,
                mat_version=self.mat_version,
                table=table,
            )
            # Column discovery from the snapshot rows. `pt_position` is
            # the partner-side scaffolding for spatial features; the
            # explorer never renders it, so drop it before materializing.
            all_cols: set[str] = set()
            for row in snapshot.values():
                all_cols.update(row.keys())
            all_cols.discard("pt_position")
            for col in all_cols:
                wire_col = f"{table}.{col}"
                values: list[Any] = []
                for rid in resolved_root_ids:
                    if rid is None:
                        values.append(None)
                        continue
                    row = snapshot.get(int(rid))
                    if row is None:
                        values.append(None)
                    else:
                        values.append(row.get(col))
                df[wire_col] = values
        return df
