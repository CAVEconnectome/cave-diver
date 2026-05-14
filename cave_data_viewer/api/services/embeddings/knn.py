"""kNN over an embedding's feature space.

The Feature Explorer's "find similar cells" affordance is a kNN query in
standardized feature space, exactly like the reference ``cell_search_app``
but cached so the index is built at most once per ``(datastack,
embedding_id, feature_columns)`` triple.

Why scipy + a hand-rolled standardizer instead of scikit-learn:

- ``scipy.spatial.KDTree`` is already in the dep tree (transitive via
  pandas/caveclient).
- ``sklearn`` is not, and pulling it in for a single z-score helper would
  add ~30MB to the wheel for two lines of numpy.

The index isn't picklable cheaply (KDTree state + numpy arrays would
round-trip through pickle but the wire size is comparable to rebuilding
from the cached frame), so the cache is L1-only. Cold pods rebuild from
the L2-backed frame cache, which is the expensive step anyway.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from hashlib import blake2b
from typing import Sequence

import numpy as np
import pandas as pd
from flask import current_app
from scipy.spatial import KDTree

from .loader import load_embedding_frame
from .manifest import EmbeddingSpec

logger = logging.getLogger(__name__)


@dataclass
class EmbeddingIndex:
    """Built kNN index for one feature subset of one embedding.

    Holds the KDTree + the standardization params + the row→cell_id map.
    Constructed by :func:`build_index`; cached by :func:`get_index`.

    The ``mean`` / ``std`` vectors are retained so that future "look up a
    new cell that wasn't in the training set" extensions can standardize
    a query point using the same scaling as the index. v1 only supports
    in-set lookups so they're documentation-only for now.
    """

    tree: KDTree
    cell_ids: np.ndarray  # shape (n,), int
    cell_id_to_row: dict[int, int]
    mean: np.ndarray
    std: np.ndarray
    feature_columns: tuple[str, ...]

    def query(self, cell_id: int, k: int) -> list[tuple[int, float]]:
        """Return the ``k`` nearest neighbors of ``cell_id`` as
        ``(cell_id, distance)`` pairs, excluding the query cell itself.

        Distances are in the same (standardized or raw) feature space the
        index was built in. Distance to self is dropped, so the caller
        gets exactly ``k`` neighbors (assuming the index has at least
        ``k+1`` cells).

        Raises ``KeyError`` when ``cell_id`` is not in the index — either
        the parquet doesn't contain that id at all, or all of its feature
        values were null and it was dropped during build.
        """
        row = self.cell_id_to_row.get(int(cell_id))
        if row is None:
            raise KeyError(f"cell_id {cell_id!r} is not in this embedding's index")

        # Query for k+1 to leave room to drop the query point itself; clamp
        # to the index size so KDTree doesn't return inf-padded results.
        k_with_self = min(k + 1, len(self.cell_ids))
        point = self.tree.data[row]
        dists, idxs = self.tree.query(point, k=k_with_self)

        # KDTree.query returns scalars when k=1; normalize to 1-D arrays so
        # the caller path doesn't have to branch.
        if np.ndim(dists) == 0:
            dists = np.array([dists])
            idxs = np.array([idxs])

        results: list[tuple[int, float]] = []
        for d, i in zip(dists.tolist(), idxs.tolist()):
            if i == row:
                continue
            results.append((int(self.cell_ids[i]), float(d)))
            if len(results) >= k:
                break
        return results


def build_index(
    frame: pd.DataFrame,
    *,
    id_column: str,
    feature_columns: Sequence[str],
    standardize: bool = True,
) -> EmbeddingIndex:
    """Build the kNN index from a cached embedding frame.

    Rows with any null in ``feature_columns`` are dropped — they can't
    participate in kNN regardless, and including them would either crash
    KDTree or produce nonsense distances. The dropped rows simply won't
    appear in neighbor lists; the SPA shows that as the cell being
    unavailable for similarity search.

    A feature column with zero variance (all rows identical) is treated as
    ``std=1`` so the scaled values come out as zero, contributing nothing
    to the distance. Matches ``sklearn.StandardScaler``'s behavior for
    degenerate columns (silently, since the alternative — refusing to
    build the index — is worse).
    """
    missing = [c for c in feature_columns if c not in frame.columns]
    if missing:
        raise ValueError(
            f"feature columns not in frame: {missing} (available: {list(frame.columns)})"
        )
    if id_column not in frame.columns:
        raise ValueError(f"id_column {id_column!r} not in frame")

    sub = frame[[id_column, *feature_columns]].dropna()
    if len(sub) == 0:
        raise ValueError(
            "no rows survive null filtering — every cell has at least one "
            "null feature value across the requested feature_columns"
        )

    cell_ids = sub[id_column].to_numpy()
    X = sub[list(feature_columns)].to_numpy(dtype=np.float64)

    if standardize:
        mean = X.mean(axis=0)
        std = X.std(axis=0)
        std_safe = np.where(std == 0, 1.0, std)
        X = (X - mean) / std_safe
    else:
        mean = np.zeros(X.shape[1])
        std = np.ones(X.shape[1])

    tree = KDTree(X)
    row_map = {int(cid): i for i, cid in enumerate(cell_ids)}
    return EmbeddingIndex(
        tree=tree,
        cell_ids=cell_ids,
        cell_id_to_row=row_map,
        mean=mean,
        std=std,
        feature_columns=tuple(feature_columns),
    )


def get_index(
    datastack: str,
    spec: EmbeddingSpec,
    *,
    feature_columns: Sequence[str] | None = None,
    standardize: bool = True,
    cache_ds: str | None = None,
) -> EmbeddingIndex:
    """Cached lookup for the index of one (embedding, feature_subset).

    Resolution order for ``feature_columns``:

    1. Explicit argument (the endpoint passes the request's
       ``feature_columns`` here when set).
    2. Manifest-declared ``spec.feature_columns``.
    3. Auto-derived: every non-axis non-audit numeric column on the
       loaded frame.

    The cache key incorporates a digest of the resolved column set so
    distinct subsets cache separately — a user that explicitly narrows
    the kNN to ``[soma_depth_y]`` doesn't collide with the default.
    """
    cache_ds = cache_ds or datastack

    df = load_embedding_frame(datastack, spec, cache_ds=cache_ds)

    if feature_columns is not None:
        cols = list(feature_columns)
    elif spec.feature_columns is not None:
        cols = list(spec.feature_columns)
    else:
        cols = _default_feature_columns(df, spec)

    if not cols:
        raise ValueError(
            f"embedding {spec.id!r}: no feature columns available for kNN "
            "(neither manifest nor auto-detection yielded any numeric column)"
        )

    digest = blake2b(
        ",".join(cols).encode() + (b"|std" if standardize else b"|raw"),
        digest_size=8,
    ).hexdigest()
    key = (cache_ds, None, spec.id, digest)

    cache = current_app.extensions.get("dcv_embedding_index_cache")
    if cache is not None:
        t0 = time.perf_counter()
        hit = cache.get(key)
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        if hit is not None:
            value, _ = hit
            logger.debug(
                "embedding_index cache hit ds=%s id=%s in %.1fms",
                cache_ds, spec.id, elapsed_ms,
            )
            return value

    t0 = time.perf_counter()
    index = build_index(
        df, id_column=spec.id_column, feature_columns=cols, standardize=standardize
    )
    build_ms = (time.perf_counter() - t0) * 1000.0
    logger.info(
        "built kNN index ds=%s id=%s n=%d k_features=%d in %.1fms",
        cache_ds, spec.id, len(index.cell_ids), len(cols), build_ms,
    )
    if cache is not None:
        cache.set(key, index)
    return index


def _default_feature_columns(df: pd.DataFrame, spec: EmbeddingSpec) -> list[str]:
    """Auto-derive feature columns when neither the call site nor the
    manifest names any. Every numeric column that isn't an axis, the id,
    or an audit column qualifies.

    Booleans are excluded — they're picker-friendly for filter/color but
    contribute nothing useful to euclidean distance.
    """
    excluded: set[str] = set(spec.axes) | {spec.id_column}
    if spec.audit:
        if spec.audit.source_root_column:
            excluded.add(spec.audit.source_root_column)
        if spec.audit.source_mat_version_column:
            excluded.add(spec.audit.source_mat_version_column)
    return [
        c
        for c in df.columns
        if c not in excluded
        and pd.api.types.is_numeric_dtype(df[c])
        and not pd.api.types.is_bool_dtype(df[c])
    ]
