# Feature-Table Discovery by Convention — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-datastack `feature_explorer.manifest_uri` with a convention-based discovery rule rooted in one env var (`CDV_FEATURE_TABLES_BASE_URI`). Drop the unused multi-datastack participation block. Make `source.uri` in per-FT YAMLs optional with a co-located-parquet default. Ensure every committed YAML is reproducible from a scaffolder. End with a `docker build && docker run` smoke test.

**Architecture:** One env var (`CDV_FEATURE_TABLES_BASE_URI`) sets the base URI at deploy time. The backend computes `<base>/feature_tables/<datastack>/` from it; datastack YAMLs no longer carry an explicit URI. Per-FT YAMLs default `source.uri` to a co-located `<id>.parquet`. The schema shrinks (drops `FeatureExplorerConfig.manifest_uri`, `FeatureTableSpec.datastacks`, `DatastackEntry`, `effective_datastacks`). Validation gate: regenerate every committed YAML via scaffolders, then run the service inside Docker against the bundled catalog.

**Tech Stack:** Python 3.13, Flask, Pydantic v2, pytest, Pandas, PyArrow, Hatchling, Docker, uv. YAML config via PyYAML.

**Spec:** `docs/superpowers/specs/2026-05-18-feature-table-discovery-design.md`

---

## File Structure

### Modify
- `cave_data_viewer/api/__init__.py` — Wire `CDV_FEATURE_TABLES_BASE_URI` into `app.config`. Update the manifest cache comment.
- `cave_data_viewer/api/services/datastack_config.py` — Drop `FeatureExplorerConfig.manifest_uri` field.
- `cave_data_viewer/api/services/embeddings/manifest.py` — Add `resolve_manifest_uri()` helper; make `FeatureTableSourceRef.uri` optional + default-fill in `_fetch_and_validate_ft()`; drop `FeatureTableSpec.datastacks`, `DatastackEntry`, `effective_datastacks`, `_coerce_datastacks`; change `get_manifest()` cache key to `(datastack,)`.
- `cave_data_viewer/api/services/embeddings/source.py` — `source_for()` reads `app.config["FEATURE_TABLES_BASE_URI"]` and computes URI via `resolve_manifest_uri()` instead of reading `fe.manifest_uri`.
- `cave_data_viewer/api/services/embeddings/__init__.py` — Remove `DatastackEntry`, `effective_datastacks` from re-exports.
- `cave_data_viewer/api/endpoints/embeddings.py` — Simplify `/feature_tables` endpoint: drop the `datastacks: [...]` field from the response; no more `effective_datastacks` loop.
- `frontend/src/api/types.ts` — Remove `ManifestDatastackEntry` and the `datastacks?:` field from `FeatureTableListResponse`.
- `config/datastacks/minnie65_public.yaml` — Drop `manifest_uri` line from `feature_explorer:` block.
- `config/datastacks/minnie65_phase3_v1.yaml` — Drop `manifest_uri` line from `feature_explorer:` block.
- `Dockerfile` — Add `/etc/cdv/feature_tables` mkdir; document the override env var.
- `scripts/scaffold_datastack.py` — Update template to emit `cell_id_lookup: {kind, name}` block and trimmed `feature_explorer: {enabled, cell_id_source_table}` block.
- `scripts/scaffold_feature_explorer.py` — Add `--datastack`; default output path to `config/feature_tables/<ds>/<id>.yaml`; `--out` becomes override.
- `scripts/make_sample_embedding.py` — Default `--outdir` to `config/feature_tables/<ds>/`; add `--datastack`; drop the `feature_explorer:` printout.
- `docs/setting-up-a-datastack.md` — Rewrite §2 around convention discovery.
- `docs/datastack-config.md` — Update `feature_explorer` rows in field tables.
- `docs/feature-explorer-plan.md` — Light prose update.

### Create
- `scripts/scaffold_aligned_volume.py` — New skeleton-style scaffolder for `config/aligned_volumes/<name>.yaml`.
- `config/feature_tables/minnie65_public/<sample-id>.yaml` — Committed synthetic sample manifest (output of `make_sample_embedding.py`).
- `config/feature_tables/minnie65_public/<sample-id>.parquet` — Committed synthetic sample parquet (~sub-100KB).
- `tests/test_manifest_loader.py` — New test file for the convention + default-fill behavior.

### Update (.gitignore)
- `.gitignore` — Add an exception for the synthetic sample parquet (`!config/feature_tables/**/*.parquet`) so the committed sample isn't swept up by the existing `*.parquet` rule. Keep the broad ignore; only this one sample is committed.

---

## Task 1: Wire `CDV_FEATURE_TABLES_BASE_URI` into `app.config`

**Files:**
- Modify: `cave_data_viewer/api/__init__.py`
- Test: `tests/test_feature_tables_base_uri.py` (new)

- [ ] **Step 1: Read the current app-config wiring**

```bash
grep -n "FEATURE_TABLES_BASE_URI\|CDV_DATASTACK_CONFIG_DIR\|app.config\[" cave_data_viewer/api/__init__.py | head -30
```

Look for the pattern used for `CDV_DATASTACK_CONFIG_DIR` — that's the closest precedent. Note the line numbers where env vars are read into `app.config`.

- [ ] **Step 2: Write the failing test**

Create `tests/test_feature_tables_base_uri.py`:

```python
"""Tests for CDV_FEATURE_TABLES_BASE_URI wiring into app.config."""

import os
from pathlib import Path

import pytest

from cave_data_viewer.api import create_app


def test_base_uri_defaults_to_repo_config_when_env_unset(monkeypatch):
    """No env var => default to the repo's config/ as a file:// URI."""
    monkeypatch.delenv("CDV_FEATURE_TABLES_BASE_URI", raising=False)
    app = create_app()
    uri = app.config["FEATURE_TABLES_BASE_URI"]
    assert uri.startswith("file://")
    assert uri.endswith("/")  # convention: directory URIs end in /
    # The default points at one of the bundled config locations.
    path = uri[len("file://"):]
    assert Path(path).is_dir(), f"default base URI path does not exist: {path}"


def test_base_uri_from_env_overrides_default(monkeypatch):
    """When set, the env var wins verbatim."""
    monkeypatch.setenv("CDV_FEATURE_TABLES_BASE_URI", "gs://my-bucket/")
    app = create_app()
    assert app.config["FEATURE_TABLES_BASE_URI"] == "gs://my-bucket/"


def test_base_uri_normalized_to_trailing_slash(monkeypatch):
    """Trailing slash is added if missing — downstream join code expects it."""
    monkeypatch.setenv("CDV_FEATURE_TABLES_BASE_URI", "gs://my-bucket")
    app = create_app()
    assert app.config["FEATURE_TABLES_BASE_URI"] == "gs://my-bucket/"
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
uv run --active pytest tests/test_feature_tables_base_uri.py -v
```

Expected: 3 FAIL — `app.config["FEATURE_TABLES_BASE_URI"]` does not exist yet (KeyError).

- [ ] **Step 4: Implement the wiring**

In `cave_data_viewer/api/__init__.py`, locate the section where other config-dir env vars are read (search for `DATASTACK_CONFIG_DIR`). Add immediately after it:

```python
    # Feature-table catalog base URI. The loader joins this with
    # "feature_tables/<datastack>/" to find a datastack's per-file FT
    # YAMLs. Read once at boot; the manifest cache key is just
    # `(datastack,)` because the URI is a deterministic function of
    # this value + the datastack name.
    #
    # Default: the repo-root or wheel-bundled `config/` dir as a
    # file:// URI. In Docker images this resolves to /app/config/;
    # in a source install to <repo>/config/. Override at deploy time
    # for production (`gs://<bucket>/`) or for bind-mount layouts
    # (`file:///etc/cdv/`).
    base_uri = os.environ.get("CDV_FEATURE_TABLES_BASE_URI")
    if not base_uri:
        # Use the bundled config dir (source install first, then wheel).
        from .services.datastack_config import _REPO_ROOT_CONFIG, _PACKAGED_CONFIG
        for candidate in (_REPO_ROOT_CONFIG, _PACKAGED_CONFIG):
            if candidate.is_dir():
                base_uri = f"file://{candidate}/"
                break
        else:
            base_uri = f"file://{_REPO_ROOT_CONFIG}/"
    if not base_uri.endswith("/"):
        base_uri += "/"
    app.config["FEATURE_TABLES_BASE_URI"] = base_uri
```

Make sure `import os` is at the top of the file (it almost certainly already is).

- [ ] **Step 5: Run the test to verify it passes**

```bash
uv run --active pytest tests/test_feature_tables_base_uri.py -v
```

Expected: 3 PASS.

- [ ] **Step 6: Commit**

```bash
git add cave_data_viewer/api/__init__.py tests/test_feature_tables_base_uri.py
git commit -m "$(cat <<'EOF'
feat(config): wire CDV_FEATURE_TABLES_BASE_URI into app.config

One env var sets the base for the feature_table convention path
(<base>/feature_tables/<datastack>/). Defaults to the bundled
config dir as a file:// URI so source installs and Docker images
work out of the box; override for GCS / bind-mount deploys.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `resolve_manifest_uri()` helper

**Files:**
- Modify: `cave_data_viewer/api/services/embeddings/manifest.py`
- Test: `tests/test_manifest_loader.py` (new)

- [ ] **Step 1: Write the failing test**

Create `tests/test_manifest_loader.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run --active pytest tests/test_manifest_loader.py -v
```

Expected: 3 FAIL with `ImportError: cannot import name 'resolve_manifest_uri'`.

- [ ] **Step 3: Implement `resolve_manifest_uri()`**

In `cave_data_viewer/api/services/embeddings/manifest.py`, add this helper near the top of the file (after the `SUPPORTED_SCHEMA_VERSIONS` constant):

```python
def resolve_manifest_uri(base_uri: str, datastack: str) -> str:
    """Compute the feature-table catalog directory URI for ``datastack``.

    The deployment-wide base URI (``CDV_FEATURE_TABLES_BASE_URI``,
    read once at boot into ``app.config["FEATURE_TABLES_BASE_URI"]``)
    is joined with the convention path ``feature_tables/<datastack>/``.

    Defensive trailing-slash normalization: callers should pass a
    URI already ending in ``/``, but we tolerate the missing slash
    rather than producing a malformed URI downstream.
    """
    if not base_uri.endswith("/"):
        base_uri = base_uri + "/"
    return f"{base_uri}feature_tables/{datastack}/"
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
uv run --active pytest tests/test_manifest_loader.py -v
```

Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add cave_data_viewer/api/services/embeddings/manifest.py tests/test_manifest_loader.py
git commit -m "$(cat <<'EOF'
feat(manifest): add resolve_manifest_uri() helper

Joins <base>/feature_tables/<datastack>/ from one env var instead
of reading manifest_uri off each datastack YAML. Pure helper; the
source.py + datastack-config wiring lands in the next two commits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Drop `FeatureExplorerConfig.manifest_uri` + update `source_for()`

**Files:**
- Modify: `cave_data_viewer/api/services/datastack_config.py`
- Modify: `cave_data_viewer/api/services/embeddings/source.py`
- Modify: `config/datastacks/minnie65_public.yaml`
- Modify: `config/datastacks/minnie65_phase3_v1.yaml`
- Test: `tests/test_manifest_loader.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_manifest_loader.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run --active pytest tests/test_manifest_loader.py::test_source_for_uses_convention_when_enabled -v
```

Expected: FAIL — current `source_for()` checks `fe.manifest_uri` which we haven't built yet.

- [ ] **Step 3: Drop `manifest_uri` from `FeatureExplorerConfig`**

In `cave_data_viewer/api/services/datastack_config.py`, find the `FeatureExplorerConfig` class. Replace it with:

```python
class FeatureExplorerConfig(BaseModel):
    """Per-datastack Feature Explorer enablement.

    The embedding catalog itself lives at the convention path
    ``<CDV_FEATURE_TABLES_BASE_URI>/feature_tables/<datastack>/``,
    one subdir per datastack. There is no per-datastack
    ``manifest_uri`` — the URI is a deterministic function of the
    deploy-time base + the datastack name.

    ``cell_id_source_table`` names the CAVE table that defines the
    cell_id namespace used by every parquet under this datastack's
    feature_tables subdir. Optional at this layer: a per-FT YAML can
    set its own ``cell_id_source_table`` and override this fallback.
    When neither is set, downstream resolver paths surface a clean
    422 at resolve time.

    Kept as a distinct field from ``root_id_lookup_main_table`` so a
    future datastack with a multi-table reverse-lookup chain doesn't
    ambiguate which table anchors the embedding namespace. In practice
    they will usually point at the same table.
    """

    enabled: bool = False
    cell_id_source_table: str | None = None
```

- [ ] **Step 4: Update `source_for()` to use the convention**

In `cave_data_viewer/api/services/embeddings/source.py`, replace `source_for()` with:

```python
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
```

- [ ] **Step 5: Drop `manifest_uri` from both committed datastack YAMLs**

Edit `config/datastacks/minnie65_public.yaml` — remove the entire `manifest_uri:` line from the `feature_explorer:` block. The block should become:

```yaml
feature_explorer:
  enabled: true
  cell_id_source_table: nucleus_detection_v0
```

Edit `config/datastacks/minnie65_phase3_v1.yaml` — same change. The block becomes:

```yaml
feature_explorer:
  enabled: true
  cell_id_source_table: nucleus_detection_v0
```

- [ ] **Step 6: Run all tests to verify everything passes**

```bash
uv run --active pytest tests/test_manifest_loader.py tests/test_feature_tables_base_uri.py -v
```

Expected: all PASS. Also run the full suite to catch regressions:

```bash
uv run --active pytest -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add cave_data_viewer/api/services/datastack_config.py cave_data_viewer/api/services/embeddings/source.py config/datastacks/minnie65_public.yaml config/datastacks/minnie65_phase3_v1.yaml tests/test_manifest_loader.py
git commit -m "$(cat <<'EOF'
refactor(config): convention-based feature_tables manifest discovery

Drops FeatureExplorerConfig.manifest_uri. source_for() now computes
<base>/feature_tables/<datastack>/ from app.config + the datastack
name. Both committed datastack YAMLs lose their manifest_uri lines.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Change manifest cache key to `(datastack,)`

**Files:**
- Modify: `cave_data_viewer/api/__init__.py:235` (the comment about key shape)
- Modify: `cave_data_viewer/api/services/embeddings/manifest.py` (the `get_manifest` function)
- Test: `tests/test_manifest_loader.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_manifest_loader.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run --active pytest tests/test_manifest_loader.py::test_get_manifest_cache_key_is_datastack_only -v
```

Expected: FAIL — the current cache key is `(datastack, manifest_uri)` so `('ds_a',)` isn't in the keys.

- [ ] **Step 3: Update `get_manifest()` to key on datastack only**

In `cave_data_viewer/api/services/embeddings/manifest.py`, find the `get_manifest()` function. Change the key construction:

```python
def get_manifest(
    datastack: str, uri: str, *, project: str | None = None
) -> Manifest:
    """Return the manifest, cached.

    Cache key is ``(datastack,)`` — the manifest URI is a
    deterministic function of the deploy-time base + the datastack
    name (both immutable for the lifetime of the process), so adding
    it to the key would just be redundant. The ``uri`` argument is
    retained as the fetch target.

    Cache hit, fresh: return immediately. Cache hit, stale: return
    immediately and schedule a background refresh. Cache miss:
    synchronous fetch; first-fetch errors propagate so a
    misconfigured manifest_uri is obvious from the very first request.

    When no cache is registered on the app (e.g. unit-test context
    with no full app-context setup), falls through to a direct fetch
    every time.
    """
    cache = current_app.extensions.get("dcv_embedding_manifest_cache")
    if cache is None:
        return fetch_and_parse_manifest(uri, project=project)

    key = (datastack,)
    hit = cache.get(key)
    if hit is None:
        manifest = fetch_and_parse_manifest(uri, project=project)
        cache.set(key, manifest)
        return manifest

    value, freshness = hit
    if freshness == "stale":
        _schedule_refresh(cache, key, uri, project=project)
    return value
```

- [ ] **Step 4: Update the cache-shape comment in `api/__init__.py`**

Find line 235 (`# isn't worth it. Key shape: (datastack, manifest_uri).`) and replace it with:

```python
    # isn't worth it. Key shape: `(datastack,)` — the URI is a
    # deterministic function of CDV_FEATURE_TABLES_BASE_URI + the
    # datastack name, so we don't need to key on it.
```

- [ ] **Step 5: Run the tests**

```bash
uv run --active pytest tests/test_manifest_loader.py -v
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add cave_data_viewer/api/services/embeddings/manifest.py cave_data_viewer/api/__init__.py tests/test_manifest_loader.py
git commit -m "$(cat <<'EOF'
refactor(manifest): cache key is (datastack,) only

The manifest URI is a deterministic function of the deploy-time
base + the datastack name (both immutable for the life of the
process), so keying on it was redundant.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Make `FeatureTableSourceRef.uri` optional + default-fill

**Files:**
- Modify: `cave_data_viewer/api/services/embeddings/manifest.py`
- Test: `tests/test_manifest_loader.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_manifest_loader.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run --active pytest tests/test_manifest_loader.py::test_source_uri_defaults_to_colocated_parquet -v
```

Expected: FAIL — Pydantic rejects the YAML because `source.uri` is currently required.

- [ ] **Step 3: Make `FeatureTableSourceRef.uri` optional**

In `cave_data_viewer/api/services/embeddings/manifest.py`, find `FeatureTableSourceRef`. Update it:

```python
class FeatureTableSourceRef(BaseModel):
    """How the backend finds a feature table's underlying data.

    v1 only ships ``kind: parquet``. A future catalog service would
    add ``kind: catalog`` (or similar) without changing this file's
    downstream consumers — the loader dispatches on ``kind``.

    ``uri`` is optional in the YAML: when omitted, the loader fills
    it in with ``<yaml-prefix>/<id>.parquet`` so a co-located
    parquet doesn't need to be named. When set explicitly, that
    wins — this is the escape hatch for parquets in a shared bucket
    or a different storage class than the YAML.
    """

    kind: Literal["parquet"]
    uri: str | None = None
```

- [ ] **Step 4: Default-fill `source.uri` in `_fetch_and_validate_ft()`**

Find `_fetch_and_validate_ft()` in `manifest.py`. After the `parent.model_copy(...)` call near the end, replace the return statement with:

```python
    ft = parent.model_copy(
        update={"embeddings": valid_embeddings, "categories": valid_categories}
    )

    # Default-fill source.uri from the YAML's prefix when absent.
    # The convention is <yaml-prefix>/<id>.parquet, where the prefix
    # is the URI up to and including the trailing slash before the
    # filename. file:// and gs:// alike are handled because we
    # operate on the URI string, not the filesystem.
    if ft.source.uri is None:
        last_slash = uri.rfind("/")
        yaml_prefix = uri[: last_slash + 1] if last_slash >= 0 else ""
        default_uri = f"{yaml_prefix}{ft.id}.parquet"
        ft = ft.model_copy(
            update={
                "source": FeatureTableSourceRef(
                    kind=ft.source.kind, uri=default_uri,
                )
            }
        )

    return ft
```

- [ ] **Step 5: Run the tests**

```bash
uv run --active pytest tests/test_manifest_loader.py -v
```

Expected: all PASS, including the two new tests.

- [ ] **Step 6: Commit**

```bash
git add cave_data_viewer/api/services/embeddings/manifest.py tests/test_manifest_loader.py
git commit -m "$(cat <<'EOF'
feat(manifest): source.uri optional; defaults to co-located parquet

A per-FT YAML without source.uri gets it filled in at load time to
<yaml-prefix>/<id>.parquet — the common case for the 'drop a pair'
operator workflow. Explicit source.uri still wins for shared
parquets or parquets in a different bucket.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Drop `datastacks:` block + helpers + frontend type

**Files:**
- Modify: `cave_data_viewer/api/services/embeddings/manifest.py`
- Modify: `cave_data_viewer/api/services/embeddings/__init__.py`
- Modify: `cave_data_viewer/api/endpoints/embeddings.py`
- Modify: `frontend/src/api/types.ts`
- Test: `tests/test_manifest_loader.py` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_manifest_loader.py`:

```python
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
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
uv run --active pytest tests/test_manifest_loader.py::test_effective_datastacks_helper_removed -v
```

Expected: FAIL — the symbols are still exported.

- [ ] **Step 3: Remove `datastacks`, `DatastackEntry`, `effective_datastacks`, `_coerce_datastacks` from `manifest.py`**

In `cave_data_viewer/api/services/embeddings/manifest.py`:

- Delete the entire `class DatastackEntry(BaseModel):` definition (and its docstring).
- Delete the `datastacks: list[DatastackEntry] = Field(default_factory=list)` line from `FeatureTableSpec`.
- Delete the `def effective_datastacks(...)` function.
- Delete the `def _coerce_datastacks(...)` function.
- In `_fetch_and_validate_ft`, delete the block that says:

  ```python
      # Datastacks block accepts bare-name strings; coerce before validation.
      if "datastacks" in data:
          data["datastacks"] = _coerce_datastacks(data["datastacks"], uri=uri)
  ```

- In `effective_cell_id_source_table`, remove the loop over `ft.datastacks`. The function becomes:

  ```python
  def effective_cell_id_source_table(
      ft: FeatureTableSpec, datastack: str, fallback: str | None
  ) -> str | None:
      """Pick the cell_id source table for ``ft`` in ``datastack``.

      Precedence:
        1. The feature table's own ``cell_id_source_table``.
        2. The datastack YAML's
           ``feature_explorer.cell_id_source_table`` (passed in as
           ``fallback``).

      Returns None when no source table is declared anywhere —
      downstream consumers (e.g. the resolver) surface a 422 in
      that case. The ``datastack`` argument is retained for log
      messages / future use; current implementation does not branch
      on it.
      """
      if ft.cell_id_source_table:
          return ft.cell_id_source_table
      return fallback
  ```

- [ ] **Step 4: Remove re-exports from `embeddings/__init__.py`**

In `cave_data_viewer/api/services/embeddings/__init__.py`:

- Remove `DatastackEntry` from the import line and from `__all__`.
- Remove `effective_datastacks` from the import line and from `__all__`.

- [ ] **Step 5: Simplify `endpoints/embeddings.py`**

In `cave_data_viewer/api/endpoints/embeddings.py`, find the import line that includes `effective_datastacks` (around line 55) and remove it.

Find the `/feature_tables` endpoint handler. Find the block (around line 204–216):

```python
    # ``datastacks`` is now per-feature-table (v1 schema). Aggregate the
    # union across all loaded tables so the SPA still gets one catalog-
    # level list; falls back to ``[ds]`` when no table declares any.
    # First-occurrence wins for the per-datastack cell_id_source_table
    # override (consistent with the rest of the registry's first-wins
    # duplicate-handling).
    declared_by_name: dict[str, str | None] = {}
    for ft in manifest.feature_tables:
        for entry in effective_datastacks(ft, ds):
            if entry.name not in declared_by_name:
                declared_by_name[entry.name] = entry.cell_id_source_table
    if not declared_by_name:
        declared_by_name = {ds: None}
    return jsonify(
        {
            "enabled": True,
            "cell_id_source_table": cfg.feature_explorer.cell_id_source_table,
            "datastacks": [
                {"name": name, "cell_id_source_table": cst}
                for name, cst in declared_by_name.items()
            ],
            "feature_tables": [_feature_table_summary(ft) for ft in manifest.feature_tables],
        }
    )
```

Replace with:

```python
    return jsonify(
        {
            "enabled": True,
            "cell_id_source_table": cfg.feature_explorer.cell_id_source_table,
            "feature_tables": [_feature_table_summary(ft) for ft in manifest.feature_tables],
        }
    )
```

- [ ] **Step 6: Remove `ManifestDatastackEntry` + `datastacks?:` from frontend types**

In `frontend/src/api/types.ts`, find the `ManifestDatastackEntry` interface (around line 562) and delete it (interface + docblock).

Find the `FeatureTableListResponse` interface (around line 570). Remove the entire `datastacks?:` field and its docblock:

```typescript
  /** Manifest-declared participating datastacks. Always populated when
   *  `enabled` is true; single-ds (or pre-phase-1) manifests collapse to a
   *  one-element list naming the request's `ds`. */
  datastacks?: ManifestDatastackEntry[];
```

- [ ] **Step 7: Verify frontend type-check passes**

```bash
cd frontend && npm run build 2>&1 | tail -20
```

Expected: build succeeds. If it fails, search for any remaining references to `ManifestDatastackEntry` or `.datastacks` on a `FeatureTableListResponse`:

```bash
grep -rn "ManifestDatastackEntry" frontend/src/
```

Expected: zero matches.

- [ ] **Step 8: Run all backend tests**

```bash
cd /Users/caseysm/Work/Code/cave-data-viewer
uv run --active pytest tests/ -v 2>&1 | tail -40
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add cave_data_viewer/api/services/embeddings/manifest.py cave_data_viewer/api/services/embeddings/__init__.py cave_data_viewer/api/endpoints/embeddings.py frontend/src/api/types.ts tests/test_manifest_loader.py
git commit -m "$(cat <<'EOF'
refactor(manifest): drop unused multi-datastack participation block

Removes FeatureTableSpec.datastacks, DatastackEntry,
effective_datastacks, and _coerce_datastacks from the catalog
schema. Each per-FT YAML now belongs to exactly one datastack — the
one whose subdir it lives in. /feature_tables response drops the
`datastacks: [...]` field; the SPA type for it
(ManifestDatastackEntry) and the optional field are removed.

No committed YAML used the datastacks: block. Per spec, the future
multi-ds need is either two uploads (one per datastack subdir) or a
future cache_alias extension.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Update `scaffold_datastack.py` template

**Files:**
- Modify: `scripts/scaffold_datastack.py`

- [ ] **Step 1: Inspect the current template**

```bash
grep -n "feature_explorer\|cell_id_lookup\|manifest_uri" scripts/scaffold_datastack.py
```

Note the line numbers where the current template references the now-removed fields.

- [ ] **Step 2: Update the `feature_explorer:` block in the template**

In `scripts/scaffold_datastack.py`, find the commented-out `feature_explorer:` block in the template. Replace any reference to `manifest_uri` with this block:

```python
# ---- feature explorer -------------------------------------------------
# Enable /explore for this datastack. The embedding catalog lives at the
# convention path <CDV_FEATURE_TABLES_BASE_URI>/feature_tables/<this datastack>/
# — there's no per-datastack manifest_uri to set. New feature tables are
# added by dropping a (parquet, yaml) pair under that subdir; no datastack
# YAML edit and no service redeploy.
#
# `cell_id_source_table` names the CAVE table whose row ids the
# feature_tables' id_column references. Optional fallback — per-FT YAMLs
# can override.
#
# feature_explorer:
#   enabled: true
#   cell_id_source_table: nucleus_detection_v0
```

- [ ] **Step 3: Verify the cell_id_lookup block in the template matches the new shape**

The previous refactor (commit `91ce836`) moved cell_id_lookup to a discriminated block. Confirm the template already reflects that:

```bash
grep -A 4 "cell_id_lookup" scripts/scaffold_datastack.py
```

Expected output:

```
# cell_id_lookup:
#   kind: view                                          # or "table"
#   name: nucleus_detection_lookup_v1
# root_id_lookup_main_table: nucleus_detection_v0
```

If the script doesn't show this (the previous refactor missed updating it), apply the change now — replace any older `cell_id_lookup_view:` / `cell_id_lookup_table:` lines with the block above.

- [ ] **Step 4: Run the scaffolder and validate the output**

```bash
uv run --active python scripts/scaffold_datastack.py --datastack scratch_test --aligned-volume minnie65_phase3 --out /tmp/scratch_test.yaml --force
uv run --active python -c "
import yaml
from flask import Flask
app = Flask(__name__)
with app.app_context():
    from cave_data_viewer.api.services.datastack_config import DatastackConfig
    data = yaml.safe_load(open('/tmp/scratch_test.yaml').read()) or {}
    cfg = DatastackConfig.model_validate(data)
    print('OK:', cfg)
"
```

Expected: `OK: ...` — the generated YAML validates against the current schema. (The default scaffolder output is a heavily-commented skeleton with most fields commented out, so the parsed cfg is mostly defaults; we're just confirming nothing in the template is malformed.)

- [ ] **Step 5: Commit**

```bash
git add scripts/scaffold_datastack.py
git commit -m "$(cat <<'EOF'
feat(scripts): scaffold_datastack template matches new schema

Template's commented feature_explorer block drops manifest_uri and
explains the convention path. cell_id_lookup block reflects the
discriminated shape from commit 91ce836.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Update `scaffold_feature_explorer.py` output path computation

**Files:**
- Modify: `scripts/scaffold_feature_explorer.py`

- [ ] **Step 1: Inspect the current arg parsing**

```bash
grep -n "argparse\|add_argument\|--out\|--feature-table-id\|default=" scripts/scaffold_feature_explorer.py | head -30
```

Find the `main()` function and its argparse setup.

- [ ] **Step 2: Add `--datastack` and update default `--out` resolution**

In `scripts/scaffold_feature_explorer.py`, find `main()`. Update the argument parser:

```python
def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--parquet", required=True, type=Path,
                   help="the feature parquet to inspect")
    p.add_argument("--datastack", default=None,
                   help="datastack name; output goes to "
                        "config/feature_tables/<datastack>/<id>.yaml")
    p.add_argument("--feature-table-id", default=None,
                   help="manifest's feature_tables[].id (required with --non-interactive)")
    p.add_argument("--out", type=Path, default=None,
                   help="explicit output path (overrides the convention)")
    p.add_argument("--parquet-uri", default=None,
                   help="URI to embed in source.uri; defaults to file://<absolute-path>")
    p.add_argument("--id-column", default=None,
                   help="pre-resolve the id column (skips the prompt)")
    p.add_argument("--non-interactive", action="store_true",
                   help="accept heuristic defaults; no prompts")
    p.add_argument("--force", action="store_true",
                   help="overwrite an existing output file")
    args = p.parse_args(argv)

    # ... (existing interactive prompts to resolve feature_table_id) ...

    # Resolve output path: --out overrides; otherwise use the
    # convention <repo>/config/feature_tables/<datastack>/<id>.yaml.
    if args.out is not None:
        out_path = args.out
    else:
        if args.datastack is None:
            raise SystemExit(
                "--datastack is required when --out is not given "
                "(needed to compute the convention output path)"
            )
        # Find the repo root by walking up from this script.
        repo_root = Path(__file__).resolve().parents[1]
        out_path = (
            repo_root / "config" / "feature_tables"
            / args.datastack / f"{feature_table_id}.yaml"
        )
        out_path.parent.mkdir(parents=True, exist_ok=True)

    # ... (existing write logic) ...

    print(f"wrote: {out_path}")
    return 0
```

Locate the actual structure of `main()` in the file and graft these changes into it; the order of declarations should match the existing prompt flow. Critically:

- The `--out` default goes from `/tmp/manifest.yaml` to `None`.
- The new `--datastack` is added.
- The output-path resolution happens AFTER `feature_table_id` is resolved (so the filename matches the basename rule).
- The script prints the resolved path on success.

- [ ] **Step 3: Update the `--parquet-uri` default to use the parquet's actual location**

If the existing logic is fine (`file://<absolute-path>`), leave it. If it points at `/tmp/...`, fix it to use `args.parquet.resolve()`.

- [ ] **Step 4: Test the scaffolder end-to-end**

```bash
uv run --active python scripts/scaffold_feature_explorer.py \
    --parquet /Users/caseysm/Work/Code/cave-data-viewer/microns_SomaData_AllCells_v661.parquet \
    --datastack scratch_test \
    --feature-table-id scratch_morpho \
    --non-interactive \
    --id-column nucleus_id \
    --force
```

Expected:
- Output file at `<repo>/config/feature_tables/scratch_test/scratch_morpho.yaml`.
- Final printed line is `wrote: <repo>/config/feature_tables/scratch_test/scratch_morpho.yaml`.

Validate the output:

```bash
uv run --active python -c "
from flask import Flask
app = Flask(__name__)
with app.app_context():
    from cave_data_viewer.api.services.embeddings.manifest import fetch_and_parse_manifest
    m = fetch_and_parse_manifest('file:///Users/caseysm/Work/Code/cave-data-viewer/config/feature_tables/scratch_test/')
    print('feature_tables:', [ft.id for ft in m.feature_tables])
"
```

Expected: `feature_tables: ['scratch_morpho']`.

Clean up:

```bash
rm -rf config/feature_tables/scratch_test
```

- [ ] **Step 5: Commit**

```bash
git add scripts/scaffold_feature_explorer.py
git commit -m "$(cat <<'EOF'
feat(scripts): scaffold_feature_explorer computes output path from --datastack

Default --out drops in favor of the convention
<repo>/config/feature_tables/<datastack>/<id>.yaml. --out becomes
an override for unusual destinations. The script prints the
resolved path on success.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Update `make_sample_embedding.py` for the convention

**Files:**
- Modify: `scripts/make_sample_embedding.py`

- [ ] **Step 1: Inspect the current arg parsing + output paths**

```bash
grep -n "argparse\|add_argument\|outdir\|feature_explorer" scripts/make_sample_embedding.py | head -20
```

- [ ] **Step 2: Add `--datastack` and change `--outdir` to the convention default**

In `scripts/make_sample_embedding.py`, find `main()`. Update the argparse setup:

```python
def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--datastack", default="minnie65_public",
                   help="datastack name; output goes to "
                        "config/feature_tables/<datastack>/")
    p.add_argument("--outdir", type=Path, default=None,
                   help="explicit output dir (overrides the convention)")
    p.add_argument("--n", type=int, default=1000,
                   help="number of cells (ignored when --ids-csv is given)")
    p.add_argument("--ids-csv", type=Path, default=None,
                   help="one-column CSV of real cell_ids to use as keys")
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args(argv)

    # Resolve output dir: --outdir overrides; otherwise convention.
    if args.outdir is not None:
        outdir = args.outdir
    else:
        repo_root = Path(__file__).resolve().parents[1]
        outdir = repo_root / "config" / "feature_tables" / args.datastack
    outdir.mkdir(parents=True, exist_ok=True)
```

- [ ] **Step 3: Co-locate the parquet next to its YAML; drop the `feature_tables/` subdir**

The current script writes to `<outdir>/morpho_umap_sample.parquet` and `<outdir>/feature_tables/morpho_sample.yaml`. The new convention puts both files in `<outdir>` itself. Update:

```python
    parquet_path = outdir / "morpho_umap_sample.parquet"
    frame.to_parquet(parquet_path, index=False)
    print(f"wrote {parquet_path}  ({len(frame)} rows, {len(frame.columns)} cols)")

    ft = _build_feature_table(parquet_path)
    ft_path = outdir / f"{ft['id']}.yaml"
    ft_path.write_text(yaml.safe_dump(ft, sort_keys=False, allow_unicode=True))
    print(f"wrote {ft_path}")

    print()
    print(f"sample catalog ready at {outdir}/")
    print(f"enable in config/datastacks/{args.datastack}.yaml:")
    print("  feature_explorer:")
    print("    enabled: true")
    print("    cell_id_source_table: nucleus_detection_v0")
    return 0
```

This removes the `catalog_dir = args.outdir / "feature_tables"` line and the old printout block with `manifest_uri:`.

- [ ] **Step 4: Drop the now-redundant `source.uri` from the per-FT dict**

In `_build_feature_table`, the parquet URI no longer needs to be in `source.uri` — the loader's default-fill (from Task 5) handles it. Replace:

```python
"source": {"kind": "parquet", "uri": f"file://{parquet_path}"},
```

with:

```python
"source": {"kind": "parquet"},  # uri default-filled at load time to <prefix>/<id>.parquet
```

This exercises the default-fill behavior end-to-end and means the committed sample YAML is fully portable (no host-absolute paths).

- [ ] **Step 5: Test the generator**

```bash
uv run --active python scripts/make_sample_embedding.py --datastack scratch_test --seed 0 --n 100
ls config/feature_tables/scratch_test/
```

Expected:
```
morpho_sample.yaml
morpho_umap_sample.parquet
```

Validate:

```bash
uv run --active python -c "
from flask import Flask
app = Flask(__name__)
with app.app_context():
    from cave_data_viewer.api.services.embeddings.manifest import fetch_and_parse_manifest
    from cave_data_viewer.api.services.embeddings.loader import load_feature_table_frame
    m = fetch_and_parse_manifest('file:///Users/caseysm/Work/Code/cave-data-viewer/config/feature_tables/scratch_test/')
    ft = m.feature_tables[0]
    print('source.uri:', ft.source.uri)
    df = load_feature_table_frame('scratch_test', ft)
    print(f'frame: {len(df)} rows × {len(df.columns)} cols')
"
```

Expected:
```
source.uri: file:///Users/caseysm/Work/Code/cave-data-viewer/config/feature_tables/scratch_test/morpho_sample.parquet
frame: 100 rows × <some>+1 cols  # +1 for synthesized source_ds
```

Clean up:

```bash
rm -rf config/feature_tables/scratch_test
```

- [ ] **Step 6: Commit**

```bash
git add scripts/make_sample_embedding.py
git commit -m "$(cat <<'EOF'
feat(scripts): make_sample_embedding writes to convention path

Default --outdir is now config/feature_tables/<datastack>/, with
parquet and YAML co-located. The per-FT YAML omits source.uri,
exercising the loader's default-fill from the previous commit.
The 'next steps' printout no longer mentions manifest_uri (which
no longer exists).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Create `scaffold_aligned_volume.py`

**Files:**
- Create: `scripts/scaffold_aligned_volume.py`

- [ ] **Step 1: Inspect the only existing aligned-volume YAML**

```bash
cat config/aligned_volumes/minnie65_phase3.yaml
```

Note the structure: `spatial:` with provider + params (transform, depth_range, layer_boundaries, layer_names), and `synapse:` with position_prefix + columns + aggregation_rules. This is what the skeleton needs to reproduce.

Also peek at `scaffold_datastack.py` for the writing pattern:

```bash
head -80 scripts/scaffold_datastack.py
```

- [ ] **Step 2: Write the new scaffolder**

Create `scripts/scaffold_aligned_volume.py`:

```python
"""Scaffold a config/aligned_volumes/<name>.yaml skeleton.

Aligned-volume YAMLs are typically hand-authored — spatial transform
parameters are domain knowledge (where the cortex starts, what the
layer boundaries are at this volume's scale) that can't be inferred
from segmentation data. The scaffolder emits a heavily-commented
skeleton with every common knob present; operator fills in the
transform fields by hand.

Usage:
    uv run python scripts/scaffold_aligned_volume.py --name minnie65_phase3

Options:
    --name <name>   (required) aligned-volume name; used as filename.
    --out <path>    Override output path (default: config/aligned_volumes/<name>.yaml).
    --force         Overwrite an existing file.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence


TEMPLATE = """\
# Aligned-volume config for {name}.
#
# Carries the spatial transform (datastacks of the same volume share
# the coordinate frame) and synapse defaults (segmentation-pipeline-
# driven; shared across the volume's datastacks). Per-datastack YAMLs
# can override the synapse block field-by-field; spatial config can
# only be set here.
#
# This file is keyed by aligned_volume name (as reported by
# `client.info.get_datastack_info()['aligned_volume']['name']`), NOT
# by datastack. Every datastack mounted on the same volume reads the
# same file.

# ---- spatial transform ------------------------------------------------
# Picks a registered SpatialProvider. `cortex` is the default and only
# bundled provider (handles minnie/v1dd-style cortical sheets); `null`
# emits no spatial columns at all (use for volumes you haven't
# characterized yet); `provider_module` lets you plug an out-of-tree
# provider via a dotted import path that calls register_provider() at
# import time.
#
# spatial:
#   provider: cortex
#   params:
#     # transform: 4x4 affine that maps Neuroglancer-space (nm) → cortex
#     # space (µm, y-axis = depth, x/z = tangential). Hand-authored from
#     # registration. The translation column is in µm post-transform.
#     transform:
#       - [1.0, 0.0, 0.0, 0.0]
#       - [0.0, 1.0, 0.0, 0.0]
#       - [0.0, 0.0, 1.0, 0.0]
#       - [0.0, 0.0, 0.0, 1.0]
#
#     # depth_range: [pia_y, white_matter_y] in µm, post-transform.
#     # The renderer uses this to set the default y-axis extent on
#     # depth-bound plots.
#     depth_range: [0.0, 1500.0]
#
#     # layer_boundaries: list of y-values (µm, post-transform) where
#     # the renderer overlays cortical-layer guide lines. Order:
#     # pia → white matter.
#     layer_boundaries: [120.0, 400.0, 600.0, 900.0, 1200.0]
#
#     # layer_names: one more name than boundaries (regions between).
#     layer_names: [L1, L2/3, L4, L5, L6, WM]

# ---- synapse-table conventions ----------------------------------------
# The default schema applies to every CAVE synapse table on this volume.
# Per-datastack YAMLs can override individual fields without re-stating
# this whole block.
#
# synapse:
#   # Column-name stem for synapse position. Most CAVE synapse tables
#   # use ctr_pt. Some pipelines use anchor_pt or post-anchor.
#   position_prefix: ctr_pt
#
#   # Projected columns. Setting to ~ (null) selects every column —
#   # convenient for ad-hoc exploration, bloats the cache in production.
#   columns:
#     - id
#     - pre_pt_root_id
#     - post_pt_root_id
#     - size
#     - ctr_pt_position
#
#   # Per-partner summary stats. Each entry adds a column to the
#   # partner table by grouping synapses on partner root_id.
#   aggregation_rules:
#     mean_size:
#       column: size
#       agg: mean
#     net_size:
#       column: size
#       agg: sum
"""


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--name", required=True,
                   help="aligned-volume name (filename basename)")
    p.add_argument("--out", type=Path, default=None,
                   help="output path (default: config/aligned_volumes/<name>.yaml)")
    p.add_argument("--force", action="store_true",
                   help="overwrite an existing file")
    args = p.parse_args(argv)

    if args.out is not None:
        out_path = args.out
    else:
        repo_root = Path(__file__).resolve().parents[1]
        out_path = repo_root / "config" / "aligned_volumes" / f"{args.name}.yaml"
        out_path.parent.mkdir(parents=True, exist_ok=True)

    if out_path.exists() and not args.force:
        print(f"refusing to overwrite {out_path} (pass --force to override)", file=sys.stderr)
        return 1

    out_path.write_text(TEMPLATE.format(name=args.name))
    print(f"wrote: {out_path}")
    print(
        "edit the spatial.params block (transform, depth_range, "
        "layer_boundaries, layer_names) by hand — spatial parameters "
        "are domain knowledge, not detectable from a parquet."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Test the new script**

```bash
uv run --active python scripts/scaffold_aligned_volume.py --name scratch_volume --out /tmp/scratch_volume.yaml --force
uv run --active python -c "
import yaml
from flask import Flask
app = Flask(__name__)
with app.app_context():
    from cave_data_viewer.api.services.datastack_config import AlignedVolumeConfig
    data = yaml.safe_load(open('/tmp/scratch_volume.yaml').read()) or {}
    cfg = AlignedVolumeConfig.model_validate(data)
    print('OK:', cfg)
"
```

Expected: the skeleton parses (everything commented = empty mapping = schema defaults), no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/scaffold_aligned_volume.py
git commit -m "$(cat <<'EOF'
feat(scripts): add scaffold_aligned_volume

Heavily-commented skeleton emitter for config/aligned_volumes/<name>.yaml.
Mirrors scaffold_datastack's pattern — operator fills transform /
layer / synapse fields by hand; the script's job is to produce a
correctly-shaped, schema-valid empty starting point.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Update Dockerfile

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Inspect the current mount points**

```bash
grep -n "CDV_\|/etc/cdv" Dockerfile
```

Note the existing pattern for `CDV_DATASTACK_CONFIG_DIR`.

- [ ] **Step 2: Add the feature_tables mount point**

In `Dockerfile`, find the existing block (around line 118):

```dockerfile
# Mount point for external datastack YAMLs. Operators bind-mount their
# private datastack configs here at runtime; bundled defaults from the
# repo's `config/datastacks/` are already in the image at `/app/config/`.
RUN mkdir -p /etc/cdv/datastacks
ENV CDV_DATASTACK_CONFIG_DIR=/etc/cdv/datastacks
```

Insert immediately after it:

```dockerfile
# Mount point for an external feature-table catalog. By default the
# image's bundled `/app/config/` is used (CDV_FEATURE_TABLES_BASE_URI
# is intentionally unset). Override at run time to point at a bind-
# mounted dir or a GCS prefix:
#
#   docker run ... -v /local/feature_tables:/etc/cdv/feature_tables \
#     -e CDV_FEATURE_TABLES_BASE_URI=file:///etc/cdv/ cdv
#
# or for production:
#
#   docker run ... -e CDV_FEATURE_TABLES_BASE_URI=gs://my-bucket/ cdv
RUN mkdir -p /etc/cdv/feature_tables
```

- [ ] **Step 3: Update the run-docs comment block at the top of the Dockerfile**

Find the existing comment (lines 18–28) and append a feature_tables example. Replace:

```dockerfile
# Datastack overrides: mount a directory of YAMLs at /etc/cdv/datastacks
#   docker run ... -v /local/datastacks:/etc/cdv/datastacks cdv
#
# Auth bypass for local testing only — never set in prod:
#   docker run ... -e CDV_DEV_AUTH_BYPASS=1 cdv
```

with:

```dockerfile
# Datastack overrides: mount a directory of YAMLs at /etc/cdv/datastacks
#   docker run ... -v /local/datastacks:/etc/cdv/datastacks cdv
#
# Feature-table catalog override: point at a bind-mount or GCS:
#   docker run ... -v /local/ft:/etc/cdv/feature_tables \
#     -e CDV_FEATURE_TABLES_BASE_URI=file:///etc/cdv/ cdv
#   docker run ... -e CDV_FEATURE_TABLES_BASE_URI=gs://my-bucket/ cdv
#
# Auth bypass for local testing only — never set in prod:
#   docker run ... -e CDV_DEV_AUTH_BYPASS=1 cdv
```

- [ ] **Step 4: Verify the image builds**

```bash
docker build -t cdv:smoke-test .
```

Expected: build succeeds. If it fails, surface the error and fix.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile
git commit -m "$(cat <<'EOF'
feat(docker): add /etc/cdv/feature_tables mount point

Defaults to using the image's bundled /app/config/ catalog
(CDV_FEATURE_TABLES_BASE_URI unset). Override at runtime to point
at a bind-mounted dir or a GCS prefix. Run-docs comment updated
with both override patterns.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Update docs

**Files:**
- Modify: `docs/setting-up-a-datastack.md`
- Modify: `docs/datastack-config.md`
- Modify: `docs/feature-explorer-plan.md`

- [ ] **Step 1: Rewrite `docs/setting-up-a-datastack.md` §2**

Open `docs/setting-up-a-datastack.md`. Find the section starting with `## 2. Feature explorer configuration`. Replace its entire body (down to the next `---` separator) with:

```markdown
## 2. Feature explorer configuration

**Directory (convention):** `<CDV_FEATURE_TABLES_BASE_URI>/feature_tables/<datastack>/`. One subdir per datastack. No per-datastack `manifest_uri` — the path is derived from the env var and the datastack name.

**Per-file:** one `<id>.yaml` per feature table. Filename basename must equal the file's `id` field. Adding a new feature table = drop a (parquet, yaml) pair into the right subdir. No service redeploy.

**Schema:** `cave_data_viewer/api/services/embeddings/manifest.py::FeatureTableSpec`.

### Datastack YAML side

The datastack YAML declares only `enabled` and an optional fallback `cell_id_source_table`:

```yaml
feature_explorer:
  enabled: true
  cell_id_source_table: nucleus_detection_v0   # optional fallback
```

When `enabled: false` or the block is omitted, the SPA hides `/explore` for this datastack.

### Per-FT YAML

Minimal — `source.uri` is optional and defaults to the co-located `<id>.parquet`:

```yaml
schema_version: 1
id: morpho_v1
title: "Morphology features (v1)"
source:
  kind: parquet
  # uri omitted: defaults to <yaml-prefix>/morpho_v1.parquet
id_column: cell_id
cell_id_source_table: nucleus_detection_v0
feature_columns: [soma_depth_y, nucleus_volume_um, soma_area_um]
categorical_columns: [predicted_class, predicted_subclass]
depth_columns: [soma_depth_y]
spatial_post_columns: [soma_depth_y]
embeddings:
  - id: umap
    title: UMAP
    axes: [umap_x, umap_y]
    default_color_by: predicted_subclass
scaling: zscore
clip_percentiles: [0.1, 99.9]
```

When `source.uri` IS set explicitly (e.g. a parquet shared by two datastacks; a parquet in a different bucket; an http:// reference), the explicit value wins.

### Where files live in deployment

| Deployment | `CDV_FEATURE_TABLES_BASE_URI` | Files at |
|---|---|---|
| Local source install | unset | `<repo>/config/feature_tables/<ds>/` |
| Local Docker (bundled) | unset | `/app/config/feature_tables/<ds>/` (baked into image) |
| Local Docker (bind-mounted) | `file:///etc/cdv/` | `/etc/cdv/feature_tables/<ds>/` (bind-mount) |
| K8s production | `gs://cdv-cache/` | `gs://cdv-cache/feature_tables/<ds>/` |

Manifests are cached with SWR semantics (soft TTL ~5 min) so edits to the GCS prefix propagate to running pods without a restart.

### Filename convention

Each file's name must be `<feature-table-id>.yaml` — the basename matches the file's `id` field. The loader skips (with a warning) any file whose `id` and filename disagree. The scaffolders enforce this by computing the output path from the `id`.

### Subset embeddings

Rows with null axes are dropped from the scatter automatically. An "inhibitory-only UMAP" simply has null `umap_x` / `umap_y` for non-inhibitory rows in the same parquet.

### Multi-datastack sharing

Each per-FT YAML belongs to one datastack — the one whose subdir it lives in. Sharing the same feature table across two datastacks = uploading the pair into both subdirs (or, when the parquet itself is large and you want to avoid duplicating data, uploading two small YAMLs whose `source.uri:` both point at one shared parquet URL).
```

- [ ] **Step 2: Update `docs/datastack-config.md`'s field tables**

Find the row in the top-level structure table referencing `feature_explorer` (around line 84). Replace any mention of `manifest_uri` with text that describes the new shape. Specifically, find a row mentioning `feature_explorer` (currently inline in the table) and ensure it reads:

```
| `feature_explorer` | `FeatureExplorerConfig?` | `null` | optional | Enables /explore for this datastack. Block contains `enabled: bool` + optional `cell_id_source_table: string?`. The embedding catalog directory is computed from `CDV_FEATURE_TABLES_BASE_URI` + the datastack name — no per-datastack manifest URI to configure. |
```

If there's a dedicated `## Feature explorer` section later in the file (search for "feature explorer" headings), update it to match §2 above.

- [ ] **Step 3: Light prose update in `docs/feature-explorer-plan.md`**

```bash
grep -n "manifest_uri" docs/feature-explorer-plan.md
```

For each hit, update the prose to reference the convention path instead. Example: a line like "the datastack YAML's `manifest_uri:` field" should become "the convention path `<CDV_FEATURE_TABLES_BASE_URI>/feature_tables/<datastack>/`."

- [ ] **Step 4: Confirm no stale references remain**

```bash
grep -rn "manifest_uri" docs/ scripts/ cave_data_viewer/ config/ 2>/dev/null | grep -v "\.pyc"
```

Expected: only references in historical text (e.g. "the legacy `manifest_uri` field, removed in commit ...") — no live config or schema use.

- [ ] **Step 5: Commit**

```bash
git add docs/
git commit -m "$(cat <<'EOF'
docs: update for convention-based feature_tables discovery

setting-up-a-datastack.md §2 rewritten around the convention path.
datastack-config.md updated to reflect FeatureExplorerConfig
without manifest_uri. feature-explorer-plan.md prose updated to
reference the convention instead of the legacy field.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Validation gate — regenerate every committed YAML from scaffolders

This is the proving-ground step from the spec. The implementation is only "done" if every committed config YAML can be reproduced from a scaffolder. Diffs surface scaffolder gaps; reconcile by fixing the scaffolder, not the committed file.

- [ ] **Step 1: Regenerate `minnie65_phase3.yaml` and reconcile**

```bash
uv run --active python scripts/scaffold_aligned_volume.py --name minnie65_phase3 --out /tmp/rebuilt_minnie65_phase3.yaml --force
diff -u config/aligned_volumes/minnie65_phase3.yaml /tmp/rebuilt_minnie65_phase3.yaml | head -80
```

The skeleton is heavily-commented; the committed file has the transform parameters filled in. Differences in *uncommented* fields should be limited to the transform/depth_range/layer_boundaries/layer_names values — those are operator-provided. If the skeleton structure (commented sections, comment text) differs from what the committed file uses as commented context, update the scaffolder's TEMPLATE to match.

- [ ] **Step 2: Regenerate both datastack YAMLs and reconcile**

```bash
uv run --active python scripts/scaffold_datastack.py --datastack minnie65_public --aligned-volume minnie65_phase3 --public --out /tmp/rebuilt_minnie65_public.yaml --force
diff -u config/datastacks/minnie65_public.yaml /tmp/rebuilt_minnie65_public.yaml | head -80

uv run --active python scripts/scaffold_datastack.py --datastack minnie65_phase3_v1 --aligned-volume minnie65_phase3 --internal --out /tmp/rebuilt_minnie65_phase3_v1.yaml --force
diff -u config/datastacks/minnie65_phase3_v1.yaml /tmp/rebuilt_minnie65_phase3_v1.yaml | head -80
```

The scaffolder emits the heavily-commented skeleton; the committed files have specific blocks (cell_id_lookup, root_id_lookup_main_table, decoration_warmup, cache_alias for public) filled in. Any structural divergence between the commented skeleton and what an operator would actually uncomment is a scaffolder bug — fix the template, not the committed YAML.

- [ ] **Step 3: Regenerate the existing Perisomatic feature-table YAML**

```bash
PERISOMATIC=/Users/caseysm/Work/Code/cave-data-viewer/microns_SomaData_AllCells_v661.parquet
test -f "$PERISOMATIC" || { echo "Perisomatic parquet missing; skip this step"; exit 0; }

uv run --active python scripts/scaffold_feature_explorer.py \
    --parquet "$PERISOMATIC" \
    --datastack minnie65_phase3_v1 \
    --feature-table-id microns_somadata_allcells_v661 \
    --non-interactive \
    --id-column nucleus_id \
    --out /tmp/rebuilt_microns_somadata_allcells_v661.yaml \
    --force

diff -u config/feature_tables/minnie65_phase3_v1/microns_somadata_allcells_v661.yaml /tmp/rebuilt_microns_somadata_allcells_v661.yaml | head -100
```

Expected differences (these are intentional and live on the committed YAML, not the scaffolder):
- `depth_columns: [soma_depth_y]` (narrowed to one axis on the committed file; the scaffolder heuristic might include all three).
- Categories block (the committed file has hand-tuned `nuclear`, `soma-surface`, `classifications` groups).
- `source.uri` may differ (committed file may have explicit URI; rebuilt one omits to exercise default-fill).
- `description` may differ.

Anything ELSE that differs is a real reconciliation:
- If the scaffolder produces a wrong shape for any other field, fix the scaffolder.
- If the committed YAML has a typo or stale field, fix the committed YAML.

Decide each diff line on its merits; commit the reconciliation if any was needed.

- [ ] **Step 4: Generate the synthetic sample (committed for Docker proving-ground)**

```bash
uv run --active python scripts/make_sample_embedding.py --datastack minnie65_public --seed 42 --n 1000
ls -la config/feature_tables/minnie65_public/
```

Expected: two new files:
```
morpho_sample.yaml          (~2KB)
morpho_umap_sample.parquet  (~30-80KB)
```

Validate end-to-end:

```bash
uv run --active python -c "
from flask import Flask
app = Flask(__name__)
with app.app_context():
    from cave_data_viewer.api.services.embeddings.manifest import fetch_and_parse_manifest
    from cave_data_viewer.api.services.embeddings.loader import load_feature_table_frame
    base = 'file:///Users/caseysm/Work/Code/cave-data-viewer/config/'
    m = fetch_and_parse_manifest(base + 'feature_tables/minnie65_public/')
    for ft in m.feature_tables:
        df = load_feature_table_frame('minnie65_public', ft)
        print(f'{ft.id}: {len(df)} rows × {len(df.columns)} cols')
"
```

Expected: `morpho_sample: 1000 rows × ~10 cols`.

- [ ] **Step 5: Add a .gitignore exception for the committed sample parquet**

```bash
grep -n "parquet" .gitignore
```

Find the broad `*.parquet` rule. Add an explicit allow-through line after it:

```
*.parquet
# Exception: the committed Docker proving-ground sample parquet.
!config/feature_tables/**/*.parquet
```

Verify:

```bash
git check-ignore -v config/feature_tables/minnie65_public/morpho_umap_sample.parquet
```

Expected: no output (NOT ignored) or output showing the `!` rule wins.

- [ ] **Step 6: Commit the synthetic sample + .gitignore change**

```bash
git add .gitignore config/feature_tables/minnie65_public/morpho_sample.yaml config/feature_tables/minnie65_public/morpho_umap_sample.parquet
git commit -m "$(cat <<'EOF'
feat(config): commit synthetic feature_table sample for minnie65_public

Generated by scripts/make_sample_embedding.py --datastack minnie65_public
--seed 42 --n 1000. ~1000 synthetic cells in a small UMAP scatter with
predicted_class / predicted_subclass categorical color. Pair fits in
~80KB on disk; bundled into the Docker image so /explore works
out of the box.

.gitignore gets an exception for config/feature_tables/**/*.parquet
so the committed sample isn't swept up by the project-wide *.parquet
ignore.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Docker smoke test

**Files:** (none modified — this is a smoke test)

- [ ] **Step 1: Build the image fresh**

```bash
docker build -t cdv:smoke-test .
```

Expected: build succeeds.

- [ ] **Step 2: Run the container with dev-auth bypass**

```bash
docker run -d --rm --name cdv-smoke -p 8001:8000 \
    -e CDV_DEV_AUTH_BYPASS=1 \
    -e GLOBAL_SERVER=global.daf-apis.com \
    cdv:smoke-test
sleep 5
docker logs cdv-smoke | tail -20
```

Expected: gunicorn listening on `0.0.0.0:8000`; no startup errors.

- [ ] **Step 3: Hit the feature_tables endpoint for `minnie65_public`**

```bash
curl -sf http://localhost:8001/api/v1/datastacks/minnie65_public/feature_tables | python -m json.tool | head -40
```

Expected: a JSON response with `"enabled": true`, `"cell_id_source_table": "nucleus_detection_v0"`, and a `"feature_tables"` array containing one entry with `"id": "morpho_sample"`.

If this fails, check:
- Container logs: `docker logs cdv-smoke`
- That `/app/config/feature_tables/minnie65_public/` exists in the container: `docker exec cdv-smoke ls /app/config/feature_tables/minnie65_public/`
- That `CDV_FEATURE_TABLES_BASE_URI` resolves correctly: `docker exec cdv-smoke env | grep CDV_FEATURE_TABLES`

- [ ] **Step 4: Hit a scatter-data endpoint to confirm the parquet loads inside the container**

```bash
curl -sf "http://localhost:8001/api/v1/datastacks/minnie65_public/feature_tables/morpho_sample/embeddings/umap/scatter?x=umap_x&y=umap_y" | python -m json.tool | head -20
```

Expected: JSON with arrays of x / y coordinates. Length matches the sample's row count.

- [ ] **Step 5: Confirm no host-path leakage by inspecting the loaded feature-table's source.uri**

```bash
docker exec cdv-smoke python -c "
from flask import Flask
app = Flask(__name__)
import os
os.environ['CDV_DEV_AUTH_BYPASS'] = '1'
from cave_data_viewer.api import create_app
app = create_app()
with app.app_context():
    from cave_data_viewer.api.services.embeddings.manifest import fetch_and_parse_manifest
    m = fetch_and_parse_manifest('file:///app/config/feature_tables/minnie65_public/')
    for ft in m.feature_tables:
        print(f'{ft.id}: source.uri = {ft.source.uri}')
"
```

Expected:
```
morpho_sample: source.uri = file:///app/config/feature_tables/minnie65_public/morpho_umap_sample.parquet
```

Critically: the path is `/app/config/...`, NOT `/Users/caseysm/...`. This is the test that the host-path leakage from earlier is gone.

- [ ] **Step 6: Tear down and commit a smoke-test marker (optional)**

```bash
docker stop cdv-smoke
docker rmi cdv:smoke-test
```

This task doesn't modify any code, so there's nothing to commit. The smoke test's success IS the validation that the implementation is complete.

- [ ] **Step 7: Final state check**

```bash
git log --oneline -15
git status
```

Expected: clean working tree, latest 12-or-so commits track the tasks above.

---

## Self-Review Checklist

Before declaring done:

- [ ] No host-absolute paths in any committed YAML under `config/`.
- [ ] `grep -rn "manifest_uri" config/ scripts/ cave_data_viewer/` returns no results.
- [ ] `grep -rn "DatastackEntry\|effective_datastacks" cave_data_viewer/` returns no results.
- [ ] `grep -rn "ManifestDatastackEntry" frontend/src/` returns no results.
- [ ] `uv run --active pytest -q` is green.
- [ ] `docker build -t cdv . && docker run --rm -p 8000:8000 -e CDV_DEV_AUTH_BYPASS=1 cdv` succeeds; `/api/v1/datastacks/minnie65_public/feature_tables` returns the synthetic sample.
- [ ] Every committed YAML under `config/datastacks/`, `config/aligned_volumes/`, `config/feature_tables/` can be regenerated by the corresponding scaffolder. Operator-supplied fields (spatial transform, layer boundaries, depth_columns refinement) are reasonably documented as "fill in by hand."
