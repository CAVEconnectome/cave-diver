"""Tests for the feature-table catalog loader."""

from cave_data_viewer.api.services.embeddings.manifest import resolve_manifest_uri


def test_resolve_manifest_uri_joins_base_and_datastack():
    """The convention is <base>feature_tables/<datastack>/."""
    uri = resolve_manifest_uri("gs://my-bucket/", "minnie65_public")
    assert uri == "gs://my-bucket/feature_tables/minnie65_public/"


def test_resolve_manifest_uri_handles_file_scheme():
    uri = resolve_manifest_uri("file:///app/config/", "minnie65_phase3_v1")
    assert uri == "file:///app/config/feature_tables/minnie65_phase3_v1/"


def test_resolve_manifest_uri_normalizes_missing_trailing_slash():
    """Robust to a base URI missing its trailing slash (although
    upstream wiring normalizes this, downstream callers should be
    defensive)."""
    uri = resolve_manifest_uri("gs://my-bucket", "minnie65_public")
    assert uri == "gs://my-bucket/feature_tables/minnie65_public/"


def test_source_for_uses_convention_when_enabled(monkeypatch):
    """source_for() builds a ManifestFeatureTableSource whose
    manifest_uri is computed from app.config + datastack name."""
    from cave_data_viewer.api import create_app
    from cave_data_viewer.api.services.datastack_config import (
        DatastackConfig, FeatureExplorerConfig,
    )
    from cave_data_viewer.api.services.embeddings.source import source_for

    monkeypatch.setenv("CDV_FEATURE_TABLES_BASE_URI", "gs://my-bucket/")
    app = create_app()
    with app.app_context():
        ds_cfg = DatastackConfig(
            feature_explorer=FeatureExplorerConfig(
                enabled=True,
                cell_id_source_table="nucleus_detection_v0",
            ),
        )
        src = source_for("minnie65_public", ds_cfg)
        assert src is not None
        assert src.manifest_uri == "gs://my-bucket/feature_tables/minnie65_public/"


def test_source_for_returns_none_when_disabled():
    """Explorer disabled => no source."""
    from cave_data_viewer.api import create_app
    from cave_data_viewer.api.services.datastack_config import (
        DatastackConfig, FeatureExplorerConfig,
    )
    from cave_data_viewer.api.services.embeddings.source import source_for

    app = create_app()
    with app.app_context():
        ds_cfg = DatastackConfig(
            feature_explorer=FeatureExplorerConfig(enabled=False),
        )
        assert source_for("minnie65_public", ds_cfg) is None
