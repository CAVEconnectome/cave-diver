"""Tests for `RecipeRegistry` — the shared loader for operator recipes
and examples.

Tri-source layout (repo → wheel _bundled_config → env override) mirrors
`services/datastack_config.py`. Tests use a `tmp_path` dir as the repo
source and skip the wheel-bundle / env-override branches (covered by
integration tests).
"""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from cave_data_viewer.api.services.recipe_registry import RecipeRegistry


@pytest.fixture()
def repo_root(tmp_path: Path) -> Path:
    (tmp_path / "config" / "recipes" / "ds_x").mkdir(parents=True)
    (tmp_path / "config" / "examples" / "ds_x").mkdir(parents=True)
    (tmp_path / "config" / "examples" / "ds_x" / "_assets").mkdir()
    return tmp_path


def _write_yaml(p: Path, content: dict) -> None:
    p.write_text(yaml.safe_dump(content, sort_keys=False))


def test_loads_operator_recipe(repo_root: Path) -> None:
    _write_yaml(
        repo_root / "config" / "recipes" / "ds_x" / "show-soma.yaml",
        {
            "version": 1,
            "kind": "connectivity",
            "id": "show-soma",
            "title": "Show soma",
            "decoration_tables": ["soma_table"],
        },
    )
    reg = RecipeRegistry(repo_root=repo_root)
    recipes = reg.recipes("ds_x")
    assert len(recipes) == 1
    assert recipes[0]["id"] == "show-soma"
    assert recipes[0]["kind"] == "connectivity"


def test_loads_example_with_pinned_mv(repo_root: Path) -> None:
    _write_yaml(
        repo_root / "config" / "examples" / "ds_x" / "l23p-depth.yaml",
        {
            "version": 1,
            "kind": "explorer",
            "id": "l23p-depth",
            "title": "L2/3 depth gradient",
            "summary": "Quick tour of scatter color binding.",
            "pinned": {"mv": 1078},
            "explorer": {
                "ft": "l23p_features",
                "emb": "umap",
                "selection": ["864691135123456789"],
            },
        },
    )
    reg = RecipeRegistry(repo_root=repo_root)
    examples = reg.examples("ds_x")
    assert len(examples) == 1
    assert examples[0]["pinned"]["mv"] == 1078


def test_rejects_example_missing_title(repo_root: Path, caplog: pytest.LogCaptureFixture) -> None:
    _write_yaml(
        repo_root / "config" / "examples" / "ds_x" / "bad.yaml",
        {
            "version": 1,
            "kind": "explorer",
            "id": "bad",
            "summary": "no title",
            "pinned": {"mv": 1078},
            "explorer": {"selection": ["x"]},
        },
    )
    reg = RecipeRegistry(repo_root=repo_root)
    assert reg.examples("ds_x") == []
    assert any("title" in r.message for r in caplog.records)


def test_rejects_example_with_explorer_root(repo_root: Path) -> None:
    """pinned.root forbidden when kind=explorer."""
    _write_yaml(
        repo_root / "config" / "examples" / "ds_x" / "bad.yaml",
        {
            "version": 1,
            "kind": "explorer",
            "id": "bad",
            "title": "Bad",
            "summary": "explorer with root",
            "pinned": {"mv": 1078, "root": "864691135123456789"},
            "explorer": {"selection": ["x"]},
        },
    )
    reg = RecipeRegistry(repo_root=repo_root)
    assert reg.examples("ds_x") == []


def test_rejects_example_connectivity_missing_root(repo_root: Path) -> None:
    """pinned.root required when kind=connectivity."""
    _write_yaml(
        repo_root / "config" / "examples" / "ds_x" / "bad.yaml",
        {
            "version": 1,
            "kind": "connectivity",
            "id": "bad",
            "title": "Bad",
            "summary": "connectivity without root",
            "pinned": {"mv": 1078},
            "decoration_tables": [],
        },
    )
    reg = RecipeRegistry(repo_root=repo_root)
    assert reg.examples("ds_x") == []


def test_filename_must_match_id(repo_root: Path) -> None:
    _write_yaml(
        repo_root / "config" / "recipes" / "ds_x" / "filename-says-foo.yaml",
        {
            "version": 1,
            "kind": "connectivity",
            "id": "body-says-bar",
            "title": "Mismatch",
        },
    )
    reg = RecipeRegistry(repo_root=repo_root)
    assert reg.recipes("ds_x") == []


def test_asset_path_resolution(repo_root: Path) -> None:
    asset = repo_root / "config" / "examples" / "ds_x" / "_assets" / "thumb.png"
    asset.write_bytes(b"\x89PNG\r\n\x1a\n")
    reg = RecipeRegistry(repo_root=repo_root)
    assert reg.asset_path("ds_x", "thumb.png") == asset
    assert reg.asset_path("ds_x", "missing.png") is None
    # Path traversal must fail at the regex gate, not just at the FS lookup.
    assert reg.asset_path("ds_x", "../../etc/passwd") is None


def test_unknown_datastack_returns_empty(repo_root: Path) -> None:
    reg = RecipeRegistry(repo_root=repo_root)
    assert reg.recipes("ds_unknown") == []
    assert reg.examples("ds_unknown") == []


def test_rejects_malformed_yaml(repo_root: Path, caplog: pytest.LogCaptureFixture) -> None:
    """A YAML file that fails to parse should be logged + skipped, not
    raise. The exception handler must catch yaml.YAMLError subclasses."""
    (repo_root / "config" / "recipes" / "ds_x" / "bad-parse.yaml").write_text(": invalid:::yaml{{")
    reg = RecipeRegistry(repo_root=repo_root)
    assert reg.recipes("ds_x") == []
    assert any("parse failed" in r.message for r in caplog.records)


def test_rejects_explorer_example_missing_explorer_block(repo_root: Path) -> None:
    """An explorer example must carry an `explorer:` block — otherwise
    there's nothing to load."""
    _write_yaml(
        repo_root / "config" / "examples" / "ds_x" / "bad.yaml",
        {
            "version": 1,
            "kind": "explorer",
            "id": "bad",
            "title": "Bad",
            "summary": "no explorer block",
            "pinned": {"mv": 1078},
            # deliberately no "explorer:" key
        },
    )
    reg = RecipeRegistry(repo_root=repo_root)
    assert reg.examples("ds_x") == []


def test_rejects_example_missing_pinned(repo_root: Path) -> None:
    """A `pinned:` block is required on every example regardless of kind."""
    _write_yaml(
        repo_root / "config" / "examples" / "ds_x" / "bad.yaml",
        {
            "version": 1,
            "kind": "connectivity",
            "id": "bad",
            "title": "Bad",
            "summary": "no pinned",
            # no "pinned" key
        },
    )
    reg = RecipeRegistry(repo_root=repo_root)
    assert reg.examples("ds_x") == []


def test_rejects_unsupported_version(repo_root: Path, caplog: pytest.LogCaptureFixture) -> None:
    """Examples (and recipes) with a version outside SUPPORTED_SCHEMA_VERSIONS
    are skipped at load time so a future schema can't silently load against
    an older server."""
    _write_yaml(
        repo_root / "config" / "recipes" / "ds_x" / "future.yaml",
        {
            "version": 999,
            "kind": "connectivity",
            "id": "future",
            "title": "From the future",
        },
    )
    reg = RecipeRegistry(repo_root=repo_root)
    assert reg.recipes("ds_x") == []
    assert any("version" in r.message for r in caplog.records)
