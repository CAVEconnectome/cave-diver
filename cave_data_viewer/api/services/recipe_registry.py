"""Loader for operator recipes + examples.

Two parallel directory layouts under `config/`:
- `config/recipes/<datastack>/<id>.yaml` — operator recipes (the older
  inline `recipes:` block in `config/datastacks/<ds>.yaml` moved here).
- `config/examples/<datastack>/<id>.yaml` — operator examples, with the
  additional `title` + `summary` (required), `full_text` + `thumbnail`
  (optional), and `pinned: {mv, root?}` (kind-dependent) fields.

Tri-source pattern matches `services/datastack_config.py`:
  1. Repo-relative `config/` (source installs)
  2. In-wheel `_bundled_config/` (wheel installs)
  3. `CDV_RECIPES_CONFIG_DIR` / `CDV_EXAMPLES_CONFIG_DIR` (env override,
     last-wins — used for ConfigMap injection in helm/k8s deployments)

The registry is built once at app boot and held read-only. Edits require
a pod restart, matching the datastack-config model.
"""

from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any

import yaml

from .recipes import SUPPORTED_SCHEMA_VERSIONS

logger = logging.getLogger("cdv.recipe_registry")

# Filename / id allowlist. Matches operator-curated id conventions
# (kebab-case, no leading hyphens, length-bounded).
_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_-]{2,63}$")

# Thumbnail basename allowlist — same defense-in-depth pattern as recipe ids,
# plus a closed extension allowlist.
_THUMBNAIL_PATTERN = re.compile(r"^[a-z0-9_-]+\.(png|jpg|webp)$")

# Bounds on prose fields (defense in depth — Pydantic validation in
# datastack_config would also catch these, but the registry is the entry
# point and a malformed example shouldn't even reach Pydantic).
_TITLE_MAX = 200
_SUMMARY_MAX = 500
_FULL_TEXT_MAX = 5000

_VALID_KINDS = frozenset({"connectivity", "explorer"})


class RecipeRegistry:
    """In-memory cache of operator recipes + examples per datastack.

    Constructed at app boot from the repo, wheel-bundled, and env-override
    sources (last-wins). All datastacks discovered across all three sources
    are merged; within a datastack, env-override wins over wheel which wins
    over repo.
    """

    def __init__(
        self,
        repo_root: Path | None = None,
        bundled_root: Path | None = None,
        recipes_override_dir: Path | None = None,
        examples_override_dir: Path | None = None,
    ) -> None:
        self._recipes: dict[str, list[dict]] = {}
        self._examples: dict[str, list[dict]] = {}
        self._example_assets_roots: dict[str, list[Path]] = {}

        # Repo source (source installs)
        if repo_root is not None:
            self._ingest_dir(repo_root / "config" / "recipes", self._recipes, expect_example=False)
            self._ingest_dir(repo_root / "config" / "examples", self._examples, expect_example=True)
            self._register_assets_roots(repo_root / "config" / "examples")

        # Wheel-bundled source
        if bundled_root is not None:
            self._ingest_dir(bundled_root / "recipes", self._recipes, expect_example=False)
            self._ingest_dir(bundled_root / "examples", self._examples, expect_example=True)
            self._register_assets_roots(bundled_root / "examples")

        # Env-override sources (last-wins — replace, not merge, per datastack)
        if recipes_override_dir is not None:
            self._ingest_dir(recipes_override_dir, self._recipes, expect_example=False, replace=True)
        if examples_override_dir is not None:
            self._ingest_dir(examples_override_dir, self._examples, expect_example=True, replace=True)
            self._register_assets_roots(examples_override_dir, replace=True)

    @classmethod
    def from_env(cls) -> "RecipeRegistry":
        """Build a registry from the standard env-var conventions:
        - Repo `config/` is the cwd's `config/` if it exists.
        - `_bundled_config/` is alongside the installed package.
        - `CDV_RECIPES_CONFIG_DIR`, `CDV_EXAMPLES_CONFIG_DIR` for env overrides.
        """
        # Repo root, resolved relative to this file's location (NOT cwd) to
        # avoid silent failure when the process working directory differs from
        # the repo root (e.g. in a container that `cd`s to /app at entrypoint).
        # Path layout: this file at cave_data_viewer/api/services/recipe_registry.py
        # → parents[3] is the repo root.
        repo_root: Path | None = None
        cand = Path(__file__).resolve().parents[3]
        if (cand / "config" / "recipes").exists() or (cand / "config" / "examples").exists():
            repo_root = cand

        # The wheel installs `_bundled_config/` next to the package — find it
        # by importing the package and resolving its parent.
        bundled_root: Path | None = None
        try:
            import cave_data_viewer  # noqa: F401
            pkg_dir = Path(cave_data_viewer.__file__).parent
            cand = pkg_dir / "_bundled_config"
            if cand.exists():
                bundled_root = cand
        except Exception:  # pragma: no cover — defensive
            pass

        rec_override = os.environ.get("CDV_RECIPES_CONFIG_DIR")
        ex_override = os.environ.get("CDV_EXAMPLES_CONFIG_DIR")

        return cls(
            repo_root=repo_root,
            bundled_root=bundled_root,
            recipes_override_dir=Path(rec_override) if rec_override else None,
            examples_override_dir=Path(ex_override) if ex_override else None,
        )

    # -------- public reads ---------------------------------------------

    def recipes(self, ds: str) -> list[dict]:
        return list(self._recipes.get(ds, []))

    def examples(self, ds: str) -> list[dict]:
        return list(self._examples.get(ds, []))

    def example(self, ds: str, eid: str) -> dict | None:
        for ex in self._examples.get(ds, []):
            if ex.get("id") == eid:
                return ex
        return None

    def asset_path(self, ds: str, filename: str) -> Path | None:
        """Resolve a thumbnail asset path. Returns None if the basename
        fails the allowlist or no source directory has the file."""
        if not _THUMBNAIL_PATTERN.match(filename):
            return None
        for root in self._example_assets_roots.get(ds, []):
            candidate = root / filename
            if candidate.is_file():
                return candidate
        return None

    # -------- ingestion ------------------------------------------------

    def _ingest_dir(
        self,
        root: Path,
        target: dict[str, list[dict]],
        *,
        expect_example: bool,
        replace: bool = False,
    ) -> None:
        if not root.exists():
            return
        for ds_dir in sorted(root.iterdir()):
            if not ds_dir.is_dir():
                continue
            ds = ds_dir.name
            items: list[dict] = []
            for fpath in sorted(ds_dir.glob("*.yaml")):
                parsed = self._load_file(fpath, expect_example=expect_example)
                if parsed is not None:
                    items.append(parsed)
            if replace or ds not in target:
                target[ds] = items
            else:
                target[ds].extend(items)

    def _register_assets_roots(self, examples_root: Path, replace: bool = False) -> None:
        if not examples_root.exists():
            return
        for ds_dir in examples_root.iterdir():
            if not ds_dir.is_dir():
                continue
            assets = ds_dir / "_assets"
            if not assets.exists():
                continue
            if replace or ds_dir.name not in self._example_assets_roots:
                self._example_assets_roots[ds_dir.name] = [assets]
            else:
                self._example_assets_roots[ds_dir.name].append(assets)

    def _load_file(self, fpath: Path, *, expect_example: bool) -> dict | None:
        try:
            text = fpath.read_text(encoding="utf-8")
            data = yaml.safe_load(text)
        except Exception as exc:
            logger.warning("%s: parse failed: %s", fpath, exc)
            return None
        if not isinstance(data, dict):
            logger.warning("%s: top-level must be a mapping", fpath)
            return None

        # Filename must match id.
        expected_id = fpath.stem
        if data.get("id") != expected_id:
            logger.warning("%s: id %r doesn't match filename stem", fpath, data.get("id"))
            return None
        if not _ID_PATTERN.match(expected_id):
            logger.warning("%s: filename stem doesn't match id pattern", fpath)
            return None

        # Version required + supported.
        version = data.get("version")
        if version not in SUPPORTED_SCHEMA_VERSIONS:
            logger.warning(
                "%s: version %r not in supported set %s",
                fpath, version, sorted(SUPPORTED_SCHEMA_VERSIONS),
            )
            return None

        # Kind required + allowed.
        kind = data.get("kind")
        if kind not in _VALID_KINDS:
            logger.warning("%s: kind %r not in %s", fpath, kind, sorted(_VALID_KINDS))
            return None

        if expect_example:
            err = self._validate_example_fields(data, kind)
            if err is not None:
                logger.warning("%s: %s", fpath, err)
                return None
        else:
            if "pinned" in data:
                logger.warning("%s: operator recipes must not carry a `pinned:` block", fpath)
                return None

        return data

    def _validate_example_fields(self, data: dict, kind: str) -> str | None:
        title = data.get("title")
        if not isinstance(title, str) or not title.strip():
            return "title: required, non-empty string"
        if len(title) > _TITLE_MAX:
            return f"title: too long ({len(title)} > {_TITLE_MAX})"

        summary = data.get("summary")
        if not isinstance(summary, str) or not summary.strip():
            return "summary: required, non-empty string"
        if len(summary) > _SUMMARY_MAX:
            return f"summary: too long ({len(summary)} > {_SUMMARY_MAX})"

        ft = data.get("full_text")
        if ft is not None:
            if not isinstance(ft, str):
                return "full_text: must be a string when present"
            if len(ft) > _FULL_TEXT_MAX:
                return f"full_text: too long ({len(ft)} > {_FULL_TEXT_MAX})"

        thumb = data.get("thumbnail")
        if thumb is not None and (not isinstance(thumb, str) or not _THUMBNAIL_PATTERN.match(thumb)):
            return "thumbnail: must match [a-z0-9_-]+\\.(png|jpg|webp)"

        pinned = data.get("pinned")
        if not isinstance(pinned, dict):
            return "pinned: required mapping"
        mv = pinned.get("mv")
        if not isinstance(mv, int) or isinstance(mv, bool):
            return "pinned.mv: required integer"

        if kind == "connectivity":
            root = pinned.get("root")
            if not isinstance(root, str) or not root.strip():
                return "pinned.root: required string for connectivity examples"
        elif kind == "explorer":
            if "root" in pinned:
                return "pinned.root: forbidden for explorer examples"
            explorer = data.get("explorer")
            if not isinstance(explorer, dict):
                return "explorer: required mapping for explorer examples"
            selection = explorer.get("selection")
            if not isinstance(selection, list) or not selection:
                return "explorer.selection: required non-empty list for explorer examples"

        return None
