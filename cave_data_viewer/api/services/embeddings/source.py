"""``FeatureTableSource`` Protocol + the v1 manifest-backed implementation.

The Protocol exists so the future "catalog service" path (an HTTP endpoint
hosting the catalog) is a drop-in replacement: same methods, different
backend. Endpoint and service code only depends on the Protocol.
"""

from __future__ import annotations

from typing import Protocol

from flask import current_app

from .manifest import EmbeddingSpec, FeatureTableSpec, Manifest, get_manifest


class FeatureTableSource(Protocol):
    """How the backend discovers + resolves feature tables (and their
    embeddings) for a specific datastack.

    Sources are constructed per-request from the datastack config; they
    hold the datastack name internally so call sites don't have to
    re-pass it.
    """

    def list(self) -> Manifest:
        """Return the full ``Manifest`` — every feature table and its
        nested embeddings, plus the kNN defaults.
        """

    def resolve_feature_table(self, feature_table_id: str) -> FeatureTableSpec:
        """Look up one feature table by id. Raises ``KeyError`` on miss."""

    def resolve_embedding(
        self, feature_table_id: str, embedding_id: str
    ) -> tuple[FeatureTableSpec, EmbeddingSpec]:
        """Look up one (table, embedding) pair. Raises ``KeyError`` when
        either id is unknown. Returns both so callers don't have to
        double-resolve (data context + axes).
        """


class ManifestFeatureTableSource:
    """``FeatureTableSource`` backed by a manifest YAML referenced from the
    datastack config.

    v1 implementation. A future ``CatalogFeatureTableSource`` would
    implement the same Protocol by calling an HTTP catalog service
    instead — endpoint code depends on the Protocol and would not need
    to change.
    """

    def __init__(
        self,
        datastack: str,
        manifest_uri: str,
        *,
        gcs_project: str | None = None,
    ) -> None:
        self.datastack = datastack
        self.manifest_uri = manifest_uri
        self.gcs_project = gcs_project

    def list(self) -> Manifest:
        return get_manifest(
            self.datastack, self.manifest_uri, project=self.gcs_project
        )

    def resolve_feature_table(self, feature_table_id: str) -> FeatureTableSpec:
        manifest = self.list()
        for ft in manifest.feature_tables:
            if ft.id == feature_table_id:
                return ft
        raise KeyError(
            f"datastack {self.datastack!r}: no feature_table with "
            f"id={feature_table_id!r} in manifest at {self.manifest_uri!r} "
            f"(available: {[t.id for t in manifest.feature_tables]})"
        )

    def resolve_embedding(
        self, feature_table_id: str, embedding_id: str
    ) -> tuple[FeatureTableSpec, EmbeddingSpec]:
        ft = self.resolve_feature_table(feature_table_id)
        for emb in ft.embeddings:
            if emb.id == embedding_id:
                return ft, emb
        raise KeyError(
            f"datastack {self.datastack!r}: feature_table {feature_table_id!r} "
            f"has no embedding with id={embedding_id!r} "
            f"(available: {[e.id for e in ft.embeddings]})"
        )


def source_for(datastack: str, ds_cfg) -> ManifestFeatureTableSource | None:
    """Build a ``ManifestFeatureTableSource`` from a loaded
    ``DatastackConfig``, or return ``None`` when the feature explorer
    is disabled for the datastack.

    The manifest URI is computed from the deploy-time base
    (``app.config["FEATURE_TABLES_BASE_URI"]``, set from
    ``CDV_FEATURE_TABLES_BASE_URI``) joined with the convention
    ``feature_tables/<datastack>/`` path. Datastack YAMLs no longer
    carry a per-datastack ``manifest_uri``.

    Endpoint code is expected to short-circuit on ``None`` (404 the
    request or omit the route from the listing).

    ``ds_cfg`` is the result of ``load_datastack_config(datastack)``.
    Typed as ``Any`` here to avoid a circular import.
    """
    fe = getattr(ds_cfg, "feature_explorer", None)
    if fe is None or not fe.enabled:
        return None
    from .manifest import resolve_manifest_uri
    base = current_app.config["FEATURE_TABLES_BASE_URI"]
    manifest_uri = resolve_manifest_uri(base, datastack)
    project = current_app.config.get("GCS_CACHE_PROJECT")
    return ManifestFeatureTableSource(
        datastack, manifest_uri, gcs_project=project
    )
