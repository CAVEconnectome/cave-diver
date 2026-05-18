"""Feature Explorer service layer.

Discovery flow (one indirection):

::

    datastack YAML (feature_explorer.manifest_uri)
          │
          ▼
    directory of per-file FeatureTableSpec YAMLs  ← cached, SWR ~5 min soft / ~1 h hard
          │ schema_version: 1 on each file; filename basename = id
          │   └── EmbeddingSpec × N  (axes-only views onto the table)
          ▼
    parquet DataFrame             ← cached, immutable, L2 GCS-backed

Public re-exports below. Endpoint and downstream service code should
depend on the ``FeatureTableSource`` Protocol and the Pydantic schema
types; the manifest's caching behavior, URI fetcher, and parquet
reader are implementation details.
"""

from .decoration_join import get_decoration_table_snapshot, join_decoration_column
from .feature_matrix import EmbeddingMatrix, build_matrix, get_matrix
from .loader import load_feature_table_frame
from .query import FeatureTableQuery
from .manifest import (
    EmbeddingSpec,
    FeatureCategorySpec,
    FeatureTableAudit,
    FeatureTableSourceRef,
    FeatureTableSpec,
    Manifest,
    SUPPORTED_SCHEMA_VERSIONS,
    effective_cell_id_source_table,
    fetch_and_parse_manifest,
    get_manifest,
)
from .resolver import (
    Resolution,
    ResolutionStatus,
    resolve_cell_ids_to_root_ids,
    resolve_pairs_to_root_ids,
    reverse_resolve_root_id_to_cell_id,
)
from .source import FeatureTableSource, ManifestFeatureTableSource, source_for

__all__ = [
    # Source layer (Protocol + impl + factory).
    "FeatureTableSource",
    "ManifestFeatureTableSource",
    "source_for",
    # Manifest schema + helpers.
    "EmbeddingSpec",
    "FeatureCategorySpec",
    "FeatureTableAudit",
    "FeatureTableSourceRef",
    "FeatureTableSpec",
    "Manifest",
    "SUPPORTED_SCHEMA_VERSIONS",
    "effective_cell_id_source_table",
    "fetch_and_parse_manifest",
    "get_manifest",
    # Parquet loader.
    "load_feature_table_frame",
    # Row context for ``embedding_cells``-sourced plots.
    "FeatureTableQuery",
    # Standardized feature matrix (powers distance-to-set + PCA + Mahalanobis).
    "EmbeddingMatrix",
    "build_matrix",
    "get_matrix",
    # cell_id <-> root_id resolver.
    "Resolution",
    "ResolutionStatus",
    "resolve_cell_ids_to_root_ids",
    "resolve_pairs_to_root_ids",
    "reverse_resolve_root_id_to_cell_id",
    # Decoration projection onto cell_id-positional order.
    "get_decoration_table_snapshot",
    "join_decoration_column",
]
