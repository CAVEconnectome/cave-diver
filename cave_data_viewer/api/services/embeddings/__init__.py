"""Feature Explorer service layer.

Discovery flow (one indirection):

::

    datastack YAML (feature_explorer.manifest_uri)
          │
          ▼
    manifest YAML            ← cached, SWR ~5 min soft / ~1 h hard
          │ EmbeddingSpec per embedding
          ▼
    parquet DataFrame        ← cached, immutable, L2 GCS-backed

Public re-exports are listed in ``__all__``. Endpoint and downstream
service code should depend on the ``EmbeddingSource`` Protocol and the
``EmbeddingSpec`` / ``Manifest`` Pydantic models; the manifest's caching
behavior, URI fetcher, and parquet reader are implementation details.
"""

from .decoration_join import get_decoration_table_snapshot, join_decoration_column
from .knn import EmbeddingIndex, build_index, get_index
from .loader import load_embedding_frame
from .manifest import (
    EmbeddingAudit,
    EmbeddingSourceRef,
    EmbeddingSpec,
    KnnDefaults,
    Manifest,
    SUPPORTED_SCHEMA_VERSIONS,
    fetch_and_parse_manifest,
    get_manifest,
)
from .resolver import (
    Resolution,
    ResolutionStatus,
    resolve_cell_ids_to_root_ids,
    reverse_resolve_root_id_to_cell_id,
)
from .source import EmbeddingSource, ManifestEmbeddingSource, source_for

__all__ = [
    # Source layer (Protocol + impl + factory).
    "EmbeddingSource",
    "ManifestEmbeddingSource",
    "source_for",
    # Manifest schema + helpers.
    "EmbeddingAudit",
    "EmbeddingSourceRef",
    "EmbeddingSpec",
    "KnnDefaults",
    "Manifest",
    "SUPPORTED_SCHEMA_VERSIONS",
    "fetch_and_parse_manifest",
    "get_manifest",
    # Parquet loader.
    "load_embedding_frame",
    # kNN index.
    "EmbeddingIndex",
    "build_index",
    "get_index",
    # cell_id <-> root_id resolver.
    "Resolution",
    "ResolutionStatus",
    "resolve_cell_ids_to_root_ids",
    "reverse_resolve_root_id_to_cell_id",
    # Decoration projection onto cell_id-positional order.
    "get_decoration_table_snapshot",
    "join_decoration_column",
]
