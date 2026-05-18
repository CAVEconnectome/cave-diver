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


def test_get_manifest_cache_key_is_datastack_only(monkeypatch, tmp_path):
    """The cache is keyed by datastack alone — the manifest_uri is
    a deterministic function of the datastack, so adding it to the
    key would just be redundant."""
    from cave_data_viewer.api import create_app
    from cave_data_viewer.api.services.embeddings.manifest import get_manifest

    # Build a real on-disk per-FT YAML.
    ft_dir = tmp_path / "feature_tables" / "ds_a"
    ft_dir.mkdir(parents=True)
    (ft_dir / "foo.yaml").write_text(
        "schema_version: 1\n"
        "id: foo\n"
        "title: Foo\n"
        "source: {kind: parquet, uri: gs://x/foo.parquet}\n"
        "id_column: cell_id\n"
        "cell_id_source_table: nucleus_detection_v0\n"
    )

    monkeypatch.setenv("CDV_FEATURE_TABLES_BASE_URI", f"file://{tmp_path}/")
    app = create_app()
    with app.app_context():
        manifest_uri = f"file://{tmp_path}/feature_tables/ds_a/"
        # First call: fetches; second call: cache hit. Inspect the cache
        # to confirm there's exactly one entry keyed by ('ds_a',).
        m1 = get_manifest("ds_a", manifest_uri)
        m2 = get_manifest("ds_a", manifest_uri)
        assert m1.feature_tables[0].id == "foo"
        assert m2.feature_tables[0].id == "foo"
        cache = app.extensions["dcv_embedding_manifest_cache"]
        # Inspect cache internals — the key is a tuple containing only
        # the datastack name.
        keys = list(cache._cache.keys()) if hasattr(cache, "_cache") else []
        assert ("ds_a",) in keys, (
            f"expected ('ds_a',) in cache keys, got {keys}"
        )


def test_source_uri_defaults_to_colocated_parquet(monkeypatch, tmp_path):
    """A per-FT YAML without an explicit source.uri gets it filled
    in to <same-prefix>/<id>.parquet at load time."""
    from cave_data_viewer.api import create_app
    from cave_data_viewer.api.services.embeddings.manifest import (
        fetch_and_parse_manifest,
    )

    ft_dir = tmp_path / "feature_tables" / "ds_a"
    ft_dir.mkdir(parents=True)
    # No source.uri — should default-fill.
    (ft_dir / "morpho.yaml").write_text(
        "schema_version: 1\n"
        "id: morpho\n"
        "title: Morpho\n"
        "source: {kind: parquet}\n"   # uri omitted
        "id_column: cell_id\n"
        "cell_id_source_table: nucleus_detection_v0\n"
    )

    app = create_app()
    with app.app_context():
        manifest = fetch_and_parse_manifest(f"file://{ft_dir}/")
        assert len(manifest.feature_tables) == 1
        ft = manifest.feature_tables[0]
        assert ft.source.uri == f"file://{ft_dir}/morpho.parquet"


def test_explicit_source_uri_wins_over_default(monkeypatch, tmp_path):
    """When source.uri is set in the YAML, it is preserved — the
    default does NOT clobber it. This is the multi-datastack
    shared-parquet escape hatch."""
    from cave_data_viewer.api import create_app
    from cave_data_viewer.api.services.embeddings.manifest import (
        fetch_and_parse_manifest,
    )

    ft_dir = tmp_path / "feature_tables" / "ds_a"
    ft_dir.mkdir(parents=True)
    (ft_dir / "morpho.yaml").write_text(
        "schema_version: 1\n"
        "id: morpho\n"
        "title: Morpho\n"
        "source: {kind: parquet, uri: gs://shared-bucket/morpho.parquet}\n"
        "id_column: cell_id\n"
        "cell_id_source_table: nucleus_detection_v0\n"
    )

    app = create_app()
    with app.app_context():
        manifest = fetch_and_parse_manifest(f"file://{ft_dir}/")
        assert manifest.feature_tables[0].source.uri == "gs://shared-bucket/morpho.parquet"


def test_datastacks_field_is_no_longer_part_of_schema(tmp_path, monkeypatch, caplog):
    """The legacy datastacks: block is rejected as unknown extra; the
    file still loads because Pydantic defaults to extra=ignore but the
    field never lands on the parsed model."""
    from cave_data_viewer.api import create_app
    from cave_data_viewer.api.services.embeddings.manifest import (
        FeatureTableSpec, fetch_and_parse_manifest,
    )

    # Confirm the schema dropped the field.
    assert "datastacks" not in FeatureTableSpec.model_fields

    ft_dir = tmp_path / "feature_tables" / "ds_a"
    ft_dir.mkdir(parents=True)
    (ft_dir / "morpho.yaml").write_text(
        "schema_version: 1\n"
        "id: morpho\n"
        "title: Morpho\n"
        "source: {kind: parquet, uri: gs://x/morpho.parquet}\n"
        "id_column: cell_id\n"
        "cell_id_source_table: nucleus_detection_v0\n"
        "datastacks: [a, b]\n"   # legacy field — should be ignored at parse
    )

    app = create_app()
    with app.app_context():
        manifest = fetch_and_parse_manifest(f"file://{ft_dir}/")
        # File loads; legacy field doesn't crash the parser.
        assert len(manifest.feature_tables) == 1


def test_effective_datastacks_helper_removed():
    """The helper is gone from the embeddings package."""
    import cave_data_viewer.api.services.embeddings as embeddings_pkg
    assert not hasattr(embeddings_pkg, "effective_datastacks")
    assert not hasattr(embeddings_pkg, "DatastackEntry")
