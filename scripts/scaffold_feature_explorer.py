"""Interactive scaffolder for a Feature Explorer manifest.

Opens a feature-table parquet, classifies its columns with heuristics,
then walks the operator through a series of review prompts (id column,
classification overrides, embeddings, categories, kNN scaling) using
``rich`` for the UI. The output is validated against the Pydantic
``Manifest`` schema before being written, so an authored manifest is
parseable by the running backend by construction.

Heuristics (run once, then reviewable in the UI):

| Column                                                | Bucket          |
|-------------------------------------------------------|-----------------|
| Named ``cell_id`` / ``id``, int-typed                 | ``id_column``   |
| Other int columns ending in ``_id``                   | id-like (excluded from features) |
| Numeric, name contains "depth"                        | ``depth_columns`` + ``feature_columns`` |
| Pair ``<prefix>_x`` / ``<prefix>_y`` where prefix mentions umap/tsne/pca/phate/mds/isomap/lle | one ``embeddings:`` entry |
| Named matching ``source[_-]?root`` / ``source[_-]?mat[_-]?version`` | ``audit.*`` |
| Other numeric                                         | ``feature_columns`` |
| String / object / categorical / bool                  | ``categorical_columns`` |

Companion to ``docs/setting-up-a-datastack.md``.

Usage:
    # Interactive (recommended) — only the parquet and datastack are required
    uv run python scripts/scaffold_feature_explorer.py \\
        --parquet path/to/features.parquet \\
        --datastack minnie65_public

    # Non-interactive — accept all heuristic defaults, no prompts
    uv run python scripts/scaffold_feature_explorer.py \\
        --parquet path/to/features.parquet \\
        --datastack minnie65_public \\
        --feature-table-id morpho_v1 \\
        --non-interactive --id-column cell_id
"""

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Literal

import pandas as pd
import yaml
from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, Prompt
from rich.table import Table


# ────────── Heuristic configuration ──────────

# Embedding-pair detection: any token must appear *as a substring* in the
# prefix (case-insensitive, treating `_` and `-` as equivalent). Catches
# `umap`, `umap_embedding`, `morpho_umap`, `umap_inhibitory_only`, etc.
_EMBEDDING_PREFIX_TOKENS = frozenset(
    {"umap", "tsne", "t-sne", "pca", "phate", "mds", "isomap", "lle"}
)
_AXIS_RE = re.compile(r"^(?P<prefix>.+?)[_-](?P<axis>x|y|1|2)$", re.IGNORECASE)

# Audit-column name patterns. Loose matching so `source_root_id`,
# `feature_source_root_id`, `source_mat_version`, etc. all classify.
_SOURCE_ROOT_PATTERNS = (re.compile(r"source[_-]?root", re.IGNORECASE),)
_SOURCE_MV_PATTERNS = (re.compile(r"source[_-]?mat[_-]?version", re.IGNORECASE),)

# Canonical id-column names. The id column must also be int-typed.
_ID_CANDIDATES = ("cell_id", "id")
# Loose pattern for "looks like a foreign key", e.g. `soma_id`, `nucleus_id`.
_ID_LIKE_RE = re.compile(r"_id$", re.IGNORECASE)

# Spatial-feature heuristics. A numeric column matching any of these
# is tagged spatial (and still counted as a `feature`). Spatial columns
# are further split by transform-state:
#
# - `spatial_pre`: BEFORE the aligned-volume's spatial transform. Used
#   for Neuroglancer linking (the volume's native frame). CAVE
#   convention: `pt_position_*`, `pt_*`, or columns with `_nm`
#   (nanometers, the raw volume unit).
# - `spatial_post`: AFTER the transform. Biologically meaningful coords
#   (cortical depth, layer-aware distances). Includes anything with
#   `depth`, `_um` (microns, the post-transform unit), or generic
#   `_x/y/z` suffixes that aren't pre-transform-marked (a reasonable
#   default for already-transformed derived parquets).
# - `depth`: strict subset of `spatial_post` — depth is what the
#   transform produces along the cortical axis.
_SPATIAL_DEPTH_RE = re.compile(r"depth", re.IGNORECASE)
_SPATIAL_POS_RE = re.compile(r"[_-][xyz]$", re.IGNORECASE)
_SPATIAL_DIST_RE = re.compile(r"_dist(?:_|\b|$)", re.IGNORECASE)
_SPATIAL_RADIAL_RE = re.compile(r"(?:^|_)radial(?:_|$)", re.IGNORECASE)
# Pre-transform marker: `pt_position` (CAVE convention for the raw
# segmentation point in the volume's native frame — always pre-
# transform). Other heuristics (`pt_` alone, `_nm` suffix,
# `_position_` standalone) are too loose to use as automatic
# signals; the operator can reassign columns to spatial_pre via the
# interactive review when they know the column is pre-transform.
_PRE_MARKERS = (re.compile(r"pt_position", re.IGNORECASE),)
# Post-transform markers: `depth` is the only unambiguous one. The
# `_um` (microns) suffix doesn't work here — it catches volume / area /
# density columns that share the same unit but aren't spatial
# coordinates (nucleus_volume_um, soma_area_um). Spatial-but-not-depth
# post-transform columns fall through to the generic `_x/_y/_z` /
# `_dist` / `radial_` heuristics in _spatial_kind.
_POST_MARKERS = (_SPATIAL_DEPTH_RE,)


def _spatial_kind(name: str) -> Literal["pre", "post", None]:
    """Classify a numeric column's spatial kind by name, or None if it
    isn't spatial. Used by the auto-classifier and the interactive
    review. Pre/post markers override each other in order:
      1. Pre marker → pre.
      2. Post marker → post.
      3. Otherwise: if any generic spatial pattern matches (_x/_y/_z
         suffix, _dist, radial), default to `post` (a reasonable
         default for derived feature parquets, which are typically
         already transformed). The operator can reassign interactively.
    """
    for p in _PRE_MARKERS:
        if p.search(name):
            return "pre"
    for p in _POST_MARKERS:
        if p.search(name):
            return "post"
    if (
        _SPATIAL_POS_RE.search(name)
        or _SPATIAL_DIST_RE.search(name)
        or _SPATIAL_RADIAL_RE.search(name)
    ):
        return "post"
    return None


# ────────── Classification helpers (pure) ──────────


def _is_numeric(dtype: Any) -> bool:
    return pd.api.types.is_numeric_dtype(dtype) and not pd.api.types.is_bool_dtype(dtype)


def _is_integer(dtype: Any) -> bool:
    return pd.api.types.is_integer_dtype(dtype)


def _is_categorical_dtype_compat(dtype: Any) -> bool:
    return (
        pd.api.types.is_string_dtype(dtype)
        or pd.api.types.is_object_dtype(dtype)
        or isinstance(dtype, pd.CategoricalDtype)
        or pd.api.types.is_bool_dtype(dtype)
    )


def _matches_any(name: str, patterns: Iterable[re.Pattern[str]]) -> bool:
    return any(p.search(name) for p in patterns)


def _prefix_looks_like_embedding(prefix: str) -> bool:
    lowered = prefix.lower().replace("_", "-")
    return any(tok in lowered for tok in _EMBEDDING_PREFIX_TOKENS)


def _detect_id_column(df: pd.DataFrame, override: str | None) -> str | None:
    """Return the canonical id column, or None when nothing matches."""
    if override is not None:
        if override not in df.columns:
            raise SystemExit(f"--id-column {override!r} not in parquet columns")
        return override
    for cand in _ID_CANDIDATES:
        if cand in df.columns and _is_integer(df[cand].dtype):
            return cand
    return None


def _id_like_columns(df: pd.DataFrame, id_column: str | None) -> list[str]:
    """Int columns whose name ends in `_id` and that aren't the resolved
    id_column. Excluded from features."""
    return [
        col
        for col in df.columns
        if col != id_column
        and _is_integer(df[col].dtype)
        and _ID_LIKE_RE.search(col) is not None
    ]


def _detect_audit(df: pd.DataFrame) -> dict[str, str]:
    audit: dict[str, str] = {}
    for col in df.columns:
        if "source_root_column" not in audit and _matches_any(col, _SOURCE_ROOT_PATTERNS):
            audit["source_root_column"] = col
        if "source_mat_version_column" not in audit and _matches_any(col, _SOURCE_MV_PATTERNS):
            audit["source_mat_version_column"] = col
    return audit


def _detect_embeddings(df: pd.DataFrame) -> tuple[list[dict[str, Any]], set[str]]:
    """Find embedding axis pairs. Returns (embeddings_list, axis_columns_consumed)."""
    by_prefix: dict[str, dict[str, str]] = {}
    for col in df.columns:
        m = _AXIS_RE.match(col)
        if not m:
            continue
        prefix = m.group("prefix")
        axis = m.group("axis").lower()
        if not _prefix_looks_like_embedding(prefix):
            continue
        if not _is_numeric(df[col].dtype):
            continue
        key = prefix.lower().replace("-", "_")
        by_prefix.setdefault(key, {})[axis] = col

    embeddings: list[dict[str, Any]] = []
    consumed: set[str] = set()
    for key in sorted(by_prefix):
        axes_map = by_prefix[key]
        if "x" in axes_map and "y" in axes_map:
            pair = [axes_map["x"], axes_map["y"]]
        elif "1" in axes_map and "2" in axes_map:
            pair = [axes_map["1"], axes_map["2"]]
        else:
            continue
        consumed.update(pair)
        embeddings.append(
            {
                "id": key,
                "title": key.upper().replace("_", "-"),
                "axes": pair,
                "default_color_by": None,  # filled by interactive or left null
            }
        )
    return embeddings, consumed


# ────────── Column-classification model ──────────


# Buckets returned by classification. Used as a stable vocabulary across
# the heuristic and the interactive review.
_BUCKETS = (
    "id_column",
    "feature",          # plain numeric feature (kNN, range filter, no spatial semantics)
    "spatial_pre",      # pre-transform spatial (Neuroglancer-space); always co-tagged `feature`
    "spatial_post",     # post-transform spatial (biological-space); always co-tagged `feature`
    "depth",            # strict subset of spatial_post; co-tagged `feature` + `spatial_post`
    "categorical",
    "audit_root",
    "audit_mat_version",
    "axis",             # consumed by an embedding pair
    "id_like",          # excluded foreign-key int
    "unclassified",
)


def _classify_one(
    col: str,
    dtype: Any,
    *,
    id_column: str | None,
    audit: dict[str, str],
    axis_columns: set[str],
    id_like_set: set[str],
) -> set[str]:
    """Return the set of bucket tags for one column. Depth is a tag,
    not an exclusive bucket — a column can be both `feature` and `depth`."""
    tags: set[str] = set()
    if col == id_column:
        tags.add("id_column")
        return tags
    if col in id_like_set:
        tags.add("id_like")
        return tags
    if col == audit.get("source_root_column"):
        tags.add("audit_root")
        return tags
    if col == audit.get("source_mat_version_column"):
        tags.add("audit_mat_version")
        return tags
    if col in axis_columns:
        tags.add("axis")
        return tags
    if _is_numeric(dtype):
        tags.add("feature")
        kind = _spatial_kind(col)
        if kind == "pre":
            tags.add("spatial_pre")
        elif kind == "post":
            tags.add("spatial_post")
            if _SPATIAL_DEPTH_RE.search(col):
                # Depth is a strict subset of spatial_post — adds the
                # depth sub-tag that the renderer special-cases for
                # axis flip + cortical layer markers.
                tags.add("depth")
        return tags
    if _is_categorical_dtype_compat(dtype):
        tags.add("categorical")
        return tags
    tags.add("unclassified")
    return tags


# ────────── Manifest construction ──────────


def _build_feature_table_dict(
    *,
    feature_table_id: str,
    title: str,
    description: str | None,
    parquet_uri: str,
    id_column: str,
    cell_id_source_table: str | None,
    classification: dict[str, set[str]],
    audit: dict[str, str],
    embeddings: list[dict[str, Any]],
    categories: list[dict[str, Any]],
    knn: dict[str, Any],
) -> dict[str, Any]:
    """Build the per-file FeatureTableSpec dict (schema v1) ready for
    yaml.safe_dump. One file = one feature table at the top level — no
    `feature_tables: [...]` wrapper, no manifest-level `knn:` block."""
    feature_columns = [c for c, tags in classification.items() if "feature" in tags]
    categorical_columns = [c for c, tags in classification.items() if "categorical" in tags]
    spatial_pre_columns = [c for c, tags in classification.items() if "spatial_pre" in tags]
    spatial_post_columns = [c for c, tags in classification.items() if "spatial_post" in tags]
    depth_columns = [c for c, tags in classification.items() if "depth" in tags]

    ft: dict[str, Any] = {"schema_version": 1, "id": feature_table_id, "title": title}
    if description:
        ft["description"] = description
    ft["source"] = {"kind": "parquet", "uri": parquet_uri}
    ft["id_column"] = id_column
    if cell_id_source_table:
        ft["cell_id_source_table"] = cell_id_source_table
    ft["feature_columns"] = feature_columns
    ft["categorical_columns"] = categorical_columns
    if spatial_pre_columns:
        ft["spatial_pre_columns"] = spatial_pre_columns
    if spatial_post_columns:
        ft["spatial_post_columns"] = spatial_post_columns
    if depth_columns:
        ft["depth_columns"] = depth_columns
    if audit:
        ft["audit"] = audit
    if categories:
        ft["categories"] = categories
    # Similarity controls (per-table since v1). Always emit so the YAML
    # is self-documenting; defaults that match Pydantic's are still nice
    # to surface for an operator scanning the file.
    ft["scaling"] = knn.get("scaling", "zscore")
    if knn.get("clip_percentiles") is None:
        ft["clip_percentiles"] = None
    else:
        ft["clip_percentiles"] = list(knn["clip_percentiles"])
    # Embeddings: drop entries whose default_color_by is still None so
    # the wire shape stays clean. The Pydantic schema allows it null
    # but absent reads cleaner.
    cleaned_embeddings = []
    for emb in embeddings:
        e = {k: v for k, v in emb.items() if v is not None}
        cleaned_embeddings.append(e)
    ft["embeddings"] = cleaned_embeddings
    return ft


# ────────── UI helpers (rich) ──────────


def _make_console() -> Console:
    return Console(stderr=False, highlight=False)


def _sample_str(series: pd.Series, n: int = 3) -> str:
    """Compact head-of-column display for the column-overview table."""
    head = series.head(n).tolist()
    formatted = []
    for v in head:
        if pd.isna(v):
            formatted.append("∅")
        elif isinstance(v, float):
            formatted.append(f"{v:.3g}")
        else:
            s = str(v)
            formatted.append(s if len(s) <= 18 else s[:15] + "…")
    return ", ".join(formatted)


def _bucket_label(tags: set[str]) -> str:
    """One-line bucket summary for the column-overview table.

    `spatial` is a tag on top of `feature` (a spatial column is still a
    feature — it participates in kNN). `depth` is a sub-tag of `spatial`
    that additionally drives the cortical-axis-flip rendering.
    """
    if "id_column" in tags:
        return "[bold cyan]id_column[/]"
    if "id_like" in tags:
        return "[dim]id_like (excluded)[/]"
    if "audit_root" in tags:
        return "[magenta]audit.source_root[/]"
    if "audit_mat_version" in tags:
        return "[magenta]audit.source_mat_version[/]"
    if "axis" in tags:
        return "[yellow]axis (embedding)[/]"
    if "feature" in tags:
        if "depth" in tags:
            return "[green]spatial (depth)[/]"
        if "spatial_post" in tags:
            return "[green]spatial (post)[/]"
        if "spatial_pre" in tags:
            return "[cyan]spatial (pre)[/]"
        return "feature"
    if "categorical" in tags:
        return "categorical"
    if "unclassified" in tags:
        return "[dim]unclassified[/]"
    return "?"


def _columns_table(
    df: pd.DataFrame, classification: dict[str, set[str]], title: str
) -> Table:
    table = Table(title=title, show_lines=False)
    table.add_column("#", justify="right", style="dim")
    table.add_column("column")
    table.add_column("dtype")
    table.add_column("bucket")
    table.add_column("sample")
    for i, col in enumerate(df.columns, start=1):
        table.add_row(
            str(i),
            col,
            str(df[col].dtype),
            _bucket_label(classification[col]),
            _sample_str(df[col]),
        )
    return table


def _parse_multi_select(
    text: str, total: int, all_columns: list[str]
) -> list[int]:
    """Parse multi-select syntax into a list of 1-indexed column indices.

    Supported syntax:
      - Single number: ``3``
      - Range: ``1-5``
      - Comma-separated: ``1,3,5-7``
      - Column name: ``soma_depth_y`` (resolved to its index)
      - Special tokens: ``all``, ``none`` (clears)

    Returns sorted, deduplicated 1-indexed indices. Skips tokens that
    don't resolve (with a printed warning) so a typo doesn't kill the
    whole input.
    """
    name_to_idx = {c: i + 1 for i, c in enumerate(all_columns)}
    text = text.strip()
    if text.lower() in {"all", "*"}:
        return list(range(1, total + 1))
    if text.lower() in {"none", "-"}:
        return []
    out: set[int] = set()
    for token in text.split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token and not token.startswith("-"):
            # range
            lo_s, hi_s = token.split("-", 1)
            try:
                lo, hi = int(lo_s), int(hi_s)
            except ValueError:
                _make_console().print(f"[yellow]skipping token: {token!r}[/]")
                continue
            if lo > hi:
                lo, hi = hi, lo
            for n in range(lo, hi + 1):
                if 1 <= n <= total:
                    out.add(n)
            continue
        # bare number?
        try:
            n = int(token)
            if 1 <= n <= total:
                out.add(n)
            continue
        except ValueError:
            pass
        # bare column name?
        if token in name_to_idx:
            out.add(name_to_idx[token])
            continue
        _make_console().print(f"[yellow]skipping unrecognized token: {token!r}[/]")
    return sorted(out)


# ────────── Interactive flow ──────────


def _interactive_pick_id_column(
    console: Console, df: pd.DataFrame, initial: str | None
) -> str:
    """Prompt for the id column. Returns the chosen column name."""
    console.print()
    console.rule("[bold]Step 2/6 — Pick id column[/]")
    candidates = []
    # Canonical names first.
    for cand in _ID_CANDIDATES:
        if cand in df.columns and _is_integer(df[cand].dtype):
            candidates.append(cand)
    # Then `*_id` integer columns.
    for col in df.columns:
        if col in candidates:
            continue
        if _is_integer(df[col].dtype) and _ID_LIKE_RE.search(col):
            candidates.append(col)
    # Fall back to all int columns.
    if not candidates:
        candidates = [c for c in df.columns if _is_integer(df[c].dtype)]

    if not candidates:
        console.print("[red]No integer-typed columns in the parquet to use as id_column.[/]")
        raise SystemExit(2)

    table = Table(title="id column candidates", show_lines=False)
    table.add_column("#", justify="right", style="dim")
    table.add_column("column")
    table.add_column("dtype")
    table.add_column("sample")
    for i, c in enumerate(candidates, start=1):
        marker = " [bold cyan](auto)[/]" if c == initial else ""
        table.add_row(str(i), c + marker, str(df[c].dtype), _sample_str(df[c]))
    console.print(table)

    default_idx = str(candidates.index(initial) + 1) if initial in candidates else "1"
    while True:
        ans = Prompt.ask(
            "Pick id column [number or name]", default=default_idx, console=console
        )
        try:
            n = int(ans)
            if 1 <= n <= len(candidates):
                return candidates[n - 1]
        except ValueError:
            pass
        if ans in df.columns:
            return ans
        console.print(f"[yellow]'{ans}' isn't a valid choice; try again.[/]")


def _interactive_classification_review(
    console: Console,
    df: pd.DataFrame,
    classification: dict[str, set[str]],
) -> dict[str, set[str]]:
    """Walk the user through review/edit of column buckets. Returns the
    (possibly modified) classification."""
    console.print()
    console.rule("[bold]Step 3/6 — Review column classification[/]")
    console.print(_columns_table(df, classification, "All columns"))
    if not Confirm.ask(
        "Edit any column's bucket?",
        default=False,
        console=console,
    ):
        return classification

    name_to_idx = {c: i + 1 for i, c in enumerate(df.columns)}
    while True:
        ans = Prompt.ask(
            "Column to reassign [number, name, or 'done']",
            default="done",
            console=console,
        )
        if ans.strip().lower() in {"done", "q", ""}:
            break
        try:
            n = int(ans)
            if not 1 <= n <= len(df.columns):
                raise ValueError
            col = list(df.columns)[n - 1]
        except ValueError:
            if ans in name_to_idx:
                col = ans
            else:
                console.print(f"[yellow]'{ans}' isn't a valid column.[/]")
                continue
        console.print(
            f"  current bucket: {_bucket_label(classification[col])}  "
            f"[dim]({df[col].dtype})  sample: {_sample_str(df[col])}[/]"
        )
        new_bucket = Prompt.ask(
            "  reassign to",
            choices=[
                "feature",
                "spatial_pre",
                "spatial_post",
                "depth",
                "categorical",
                "audit_root",
                "audit_mat_version",
                "id_like",
                "skip",
            ],
            default="skip",
            console=console,
        )
        if new_bucket == "skip":
            continue
        # spatial_pre / spatial_post / depth co-tag with `feature`.
        # `depth` implies `spatial_post` (depth is the post-transform
        # cortical axis).
        if new_bucket == "depth":
            classification[col] = {"feature", "spatial_post", "depth"}
        elif new_bucket == "spatial_post":
            classification[col] = {"feature", "spatial_post"}
        elif new_bucket == "spatial_pre":
            classification[col] = {"feature", "spatial_pre"}
        else:
            classification[col] = {new_bucket}
    console.print()
    console.print(_columns_table(df, classification, "Updated classification"))
    return classification


def _slugify_for_id(text: str) -> str:
    """Map a free-form string (typically the parquet basename) to a
    manifest-id-shaped slug: lowercase, underscores for word boundaries,
    no leading non-alphanumeric."""
    slug = re.sub(r"[^A-Za-z0-9]+", "_", text).strip("_").lower()
    return slug or "feature_table"


def _interactive_feature_table_identity(
    console: Console, parquet: Path, initial_id: str | None
) -> tuple[str, str, str | None, str | None]:
    """Prompt for feature_table id + title + description +
    cell_id_source_table. Returns the quadruple.

    The id is the stable handle the SPA uses in /explore URLs
    (`?ft=<id>`), in recipes (`explorer.ft: <id>`), and in operator
    examples. Slug-shaped: lowercase, kebab or underscore.

    `cell_id_source_table` is the CAVE annotation table whose row ids
    `id_column` references. Combined they form the composite stable
    identity `(cell_id_source_table, id_column)` — necessary because
    not every object gets a universal id; the source table is part of
    the key. Optional here (an empty answer leaves the datastack-level
    fallback to fill in).
    """
    console.print()
    console.rule("[bold]Step 1/6 — Feature table identity[/]")
    console.print(
        "[dim]The `id` is the stable handle the SPA references in URLs "
        "(?ft=<id>), recipes, and examples. Lowercase kebab/underscore; "
        "rename later only with a coordinated client/data migration.[/]"
    )
    default_id = initial_id or _slugify_for_id(parquet.stem)
    ft_id = Prompt.ask("feature_table.id", default=default_id, console=console)
    ft_id = _slugify_for_id(ft_id)  # normalize whatever the user typed

    title = Prompt.ask(
        "title  (human-readable, shows up in the explorer picker)",
        default=f"Feature table: {ft_id}",
        console=console,
    )
    description = Prompt.ask(
        "description  [empty to skip]",
        default="",
        console=console,
    )
    console.print(
        "[dim]\n`cell_id_source_table` is the CAVE table whose row ids "
        "this parquet's id_column references (e.g. nucleus_detection_v0). "
        "Combined with id_column it forms the stable identity for every "
        "row. Leave empty to inherit the datastack-level fallback "
        "(feature_explorer.cell_id_source_table in the datastack YAML).[/]"
    )
    cell_id_source_table = Prompt.ask(
        "cell_id_source_table  [empty = use datastack fallback]",
        default="",
        console=console,
    )
    return (
        ft_id,
        title,
        description.strip() or None,
        cell_id_source_table.strip() or None,
    )


def _interactive_embeddings(
    console: Console,
    detected: list[dict[str, Any]],
    classification: dict[str, set[str]],
    df: pd.DataFrame,
) -> list[dict[str, Any]]:
    """Confirm detected embeddings; pick default_color_by; allow adding more."""
    console.print()
    console.rule("[bold]Step 4/6 — Embeddings[/]")
    if not detected:
        console.print(
            "[dim]No embedding axis pairs auto-detected. You'll need to "
            "add at least one before the scatter renders.[/]"
        )

    categorical = [c for c, tags in classification.items() if "categorical" in tags]
    numeric = [c for c, tags in classification.items() if "feature" in tags]
    color_options = categorical + numeric

    out: list[dict[str, Any]] = []
    for emb in detected:
        console.print(
            f"  [yellow]Detected:[/] {emb['id']}  axes = {emb['axes']}"
        )
        if not Confirm.ask("  keep this embedding?", default=True, console=console):
            continue
        # default_color_by picker
        default_cb = categorical[0] if categorical else (numeric[0] if numeric else None)
        if color_options:
            console.print(
                f"  available color_by columns: {', '.join(color_options[:8])}"
                + ("…" if len(color_options) > 8 else "")
            )
            cb = Prompt.ask(
                "  default_color_by [name or empty to leave unset]",
                default=default_cb or "",
                console=console,
            )
            emb["default_color_by"] = cb.strip() or None
        out.append(emb)

    while Confirm.ask(
        "Add another embedding manually?", default=False, console=console
    ):
        eid = Prompt.ask("  embedding id (lowercase, kebab/underscore)", console=console)
        if not eid:
            continue
        title = Prompt.ask("  title", default=eid.upper(), console=console)
        x = Prompt.ask("  x-axis column", console=console)
        y = Prompt.ask("  y-axis column", console=console)
        if x not in df.columns or y not in df.columns:
            console.print(f"  [yellow]skipping: {x!r} or {y!r} not in parquet[/]")
            continue
        cb = Prompt.ask(
            "  default_color_by [empty to leave unset]",
            default="",
            console=console,
        )
        out.append(
            {
                "id": eid,
                "title": title,
                "axes": [x, y],
                "default_color_by": cb.strip() or None,
            }
        )
    return out


def _interactive_categories(
    console: Console,
    df: pd.DataFrame,
    classification: dict[str, set[str]],
) -> list[dict[str, Any]]:
    """Loop: ask if the user wants to define a category; collect title +
    columns via multi-select."""
    console.print()
    console.rule("[bold]Step 5/6 — Category groups[/]")
    console.print(
        "[dim]Categories are UI groupings for the channel picker. Columns "
        "not in any category render under \"Uncategorized\". Skip if you "
        "want everything in one bucket.[/]"
    )

    relevant = [
        c
        for c, tags in classification.items()
        if {"feature", "categorical", "depth"} & tags
    ]
    if not relevant:
        return []

    # Show a slim version of the column table once.
    slim = Table(title="Pickable columns")
    slim.add_column("#", justify="right", style="dim")
    slim.add_column("column")
    slim.add_column("bucket")
    name_to_idx: dict[str, int] = {}
    for i, col in enumerate(df.columns, start=1):
        if col not in relevant:
            continue
        name_to_idx[col] = i
        slim.add_row(str(i), col, _bucket_label(classification[col]))
    console.print(slim)

    out: list[dict[str, Any]] = []
    while Confirm.ask("Define a category?", default=False, console=console):
        cid = Prompt.ask("  id (lowercase kebab/underscore)", console=console)
        if not cid:
            continue
        title = Prompt.ask("  title", default=cid.title(), console=console)
        desc = Prompt.ask("  description [empty to skip]", default="", console=console)
        text = Prompt.ask(
            "  columns [numbers + ranges, names, or 'all']",
            console=console,
        )
        indices = _parse_multi_select(text, total=len(df.columns), all_columns=list(df.columns))
        # Filter to the relevant set so we don't accidentally include axis / id cols.
        all_cols = list(df.columns)
        chosen = [all_cols[i - 1] for i in indices if all_cols[i - 1] in relevant]
        if not chosen:
            console.print("  [yellow]no columns picked; skipping[/]")
            continue
        cat: dict[str, Any] = {"id": cid, "title": title, "columns": chosen}
        if desc.strip():
            cat["description"] = desc.strip()
        out.append(cat)
        console.print(f"  [green]added '{cid}' with {len(chosen)} column(s)[/]")
    return out


def _interactive_knn(console: Console) -> dict[str, Any]:
    console.print()
    console.rule("[bold]Step 6/6 — kNN / standardization[/]")
    scaling = Prompt.ask(
        "scaling mode",
        choices=["zscore", "robust", "percentile", "raw"],
        default="zscore",
        console=console,
    )
    clip_text = Prompt.ask(
        "clip_percentiles [comma 'low,high', or 'none' to disable]",
        default="0.1,99.9",
        console=console,
    )
    if clip_text.strip().lower() in {"none", "null", ""}:
        return {"scaling": scaling, "clip_percentiles": None}
    try:
        lo_s, hi_s = clip_text.split(",")
        lo, hi = float(lo_s.strip()), float(hi_s.strip())
        return {"scaling": scaling, "clip_percentiles": [lo, hi]}
    except (ValueError, IndexError):
        console.print(
            f"[yellow]couldn't parse {clip_text!r}; falling back to default (0.1, 99.9)[/]"
        )
        return {"scaling": scaling, "clip_percentiles": [0.1, 99.9]}


# ────────── Validation + write ──────────


def _validate_feature_table(feature_table: dict[str, Any], console: Console) -> bool:
    """Run the Pydantic FeatureTableSpec validator over the dict. Returns
    True on success; prints validation errors and returns False on
    failure."""
    try:
        from cave_data_viewer.api.services.embeddings.manifest import FeatureTableSpec
    except Exception as exc:
        console.print(f"[yellow]could not import FeatureTableSpec for validation: {exc}[/]")
        console.print("[yellow]writing without validation — please verify by hand[/]")
        return True
    try:
        FeatureTableSpec.model_validate(feature_table)
        return True
    except Exception as exc:
        console.print(
            Panel(str(exc), title="FeatureTableSpec validation failed", border_style="red")
        )
        return False


def _format_yaml(manifest: dict[str, Any]) -> str:
    return yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True, default_flow_style=False)


def _print_datastack_snippet(
    console: Console, ft_path: Path, feature_table_id: str
) -> None:
    """Print the YAML block to paste into the datastack YAML.

    The discovery path is derived from CDV_FEATURE_TABLES_BASE_URI + the
    datastack name — no per-datastack manifest_uri is needed. Adding more
    feature tables is then just dropping more (.yaml, .parquet) pairs into
    the convention directory for that datastack.
    """
    snippet = (
        "feature_explorer:\n"
        "  enabled: true\n"
        "  # cell_id_source_table is a fallback used only when a per-FT\n"
        "  # YAML in the convention directory doesn't declare its own.\n"
        "  cell_id_source_table: <CAVE table>     # optional fallback\n"
        "# No manifest_uri — catalog path is:\n"
        "#   <CDV_FEATURE_TABLES_BASE_URI>/feature_tables/<datastack>/\n"
    )
    console.print()
    console.print(
        Panel(
            snippet,
            title=f"Paste into config/datastacks/<ds>.yaml — feature_table '{feature_table_id}'",
            border_style="green",
        )
    )


# ────────── Main ──────────


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--parquet", type=Path, required=True, help="path to the feature parquet")
    parser.add_argument(
        "--feature-table-id",
        default=None,
        help=(
            "manifest's feature_tables[].id — the stable handle the SPA uses "
            "in URLs (?ft=<id>), recipes (explorer.ft: <id>), and examples. "
            "Prompted interactively when omitted (default: parquet basename "
            "slugified). Required when --non-interactive."
        ),
    )
    parser.add_argument(
        "--datastack",
        default=None,
        help=(
            "datastack name; used to compute the convention output path "
            "config/feature_tables/<datastack>/<id>.yaml when --out is not given."
        ),
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help=(
            "output path override. If a directory (or ends with /), writes "
            "<feature-table-id>.yaml inside it. If a specific .yaml file path, "
            "writes there directly. When omitted, the path is computed from "
            "--datastack as <repo>/config/feature_tables/<datastack>/<id>.yaml."
        ),
    )
    parser.add_argument(
        "--parquet-uri",
        default=None,
        help="URI to embed in manifest's source.uri (default: file://<absolute parquet path>)",
    )
    parser.add_argument("--id-column", default=None, help="override cell_id column detection (skips the prompt)")
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="accept all heuristic defaults; no prompts. Useful for scripted regeneration.",
    )
    parser.add_argument("--force", action="store_true", help="overwrite existing output file")
    args = parser.parse_args(argv)

    console = _make_console()

    if not args.parquet.exists():
        console.print(f"[red]parquet not found:[/] {args.parquet}")
        return 2
    # The existence check on the final path moved down to after we know
    # feature_table_id (the filename is derived from it).

    parquet_uri = args.parquet_uri or f"file://{args.parquet.resolve()}"

    # Read full parquet for the head display. For very large parquets
    # this is wasteful, but feature parquets are typically << 100MB so
    # it's not worth a streaming path here.
    console.print(f"[bold]Inspecting[/] {args.parquet}")
    df = pd.read_parquet(args.parquet)
    console.print(f"[dim]{len(df):,} rows × {len(df.columns):,} columns[/]")

    # ── Heuristic pass ──
    auto_id = _detect_id_column(df, args.id_column)
    id_like_set: set[str] = set()  # filled after id_column is finalized
    audit = _detect_audit(df)
    embeddings, axis_cols = _detect_embeddings(df)

    # ── Interactive (or skip) ──
    if args.non_interactive:
        if args.feature_table_id is None:
            console.print("[red]--non-interactive: --feature-table-id is required[/]")
            return 2
        if auto_id is None:
            console.print("[red]--non-interactive: no id column auto-detected; pass --id-column[/]")
            return 2
        feature_table_id = _slugify_for_id(args.feature_table_id)
        title = f"Feature table: {feature_table_id}"
        description = None
        cell_id_source_table: str | None = None
        id_column = auto_id
        id_like_set = set(_id_like_columns(df, id_column))
        # Wire default_color_by from the first categorical column when present.
        categorical_preview = [
            c for c in df.columns
            if c not in (axis_cols | id_like_set | {id_column} | set(audit.values()))
            and _is_categorical_dtype_compat(df[c].dtype)
        ]
        for emb in embeddings:
            emb["default_color_by"] = categorical_preview[0] if categorical_preview else None
        categories: list[dict[str, Any]] = []
        knn = {"scaling": "zscore", "clip_percentiles": [0.1, 99.9]}
    else:
        feature_table_id, title, description, cell_id_source_table = _interactive_feature_table_identity(
            console, args.parquet, args.feature_table_id
        )
        id_column = _interactive_pick_id_column(console, df, auto_id)
        id_like_set = set(_id_like_columns(df, id_column))
        classification = {
            col: _classify_one(
                col,
                df[col].dtype,
                id_column=id_column,
                audit=audit,
                axis_columns=axis_cols,
                id_like_set=id_like_set,
            )
            for col in df.columns
        }
        classification = _interactive_classification_review(console, df, classification)
        embeddings = _interactive_embeddings(console, embeddings, classification, df)
        categories = _interactive_categories(console, df, classification)
        knn = _interactive_knn(console)

    # ── Recompute classification from final tags ──
    # (the non-interactive path skipped the review loop; rebuild now)
    if args.non_interactive:
        classification = {
            col: _classify_one(
                col,
                df[col].dtype,
                id_column=id_column,
                audit=audit,
                axis_columns=axis_cols,
                id_like_set=id_like_set,
            )
            for col in df.columns
        }

    feature_table = _build_feature_table_dict(
        feature_table_id=feature_table_id,
        title=title,
        description=description,
        parquet_uri=parquet_uri,
        id_column=id_column,
        cell_id_source_table=cell_id_source_table,
        classification=classification,
        audit=audit,
        embeddings=embeddings,
        categories=categories,
        knn=knn,
    )

    # ── Validate ──
    console.print()
    console.rule("[bold]Validating against FeatureTableSpec schema[/]")
    ok = _validate_feature_table(feature_table, console)
    if not ok:
        if args.non_interactive or not Confirm.ask(
            "[yellow]validation failed — write anyway?[/]", default=False, console=console
        ):
            return 3
    else:
        console.print("[green]✓ valid[/]")

    # ── Resolve output path ──
    # --out overrides; otherwise use the convention
    # <repo>/config/feature_tables/<datastack>/<id>.yaml.
    if args.out is not None:
        # Honor --out as-is. If it doesn't end with a YAML extension,
        # treat it as a directory and drop `<feature-table-id>.yaml`
        # inside — that's the canonical "drop into a GCS prefix" workflow.
        # If --out IS a .yaml path, honor it but warn when the basename
        # doesn't match the feature_table_id (the registry will skip the
        # file at directory-mode load time).
        out_str = str(args.out)
        looks_like_file = out_str.endswith(".yaml") or out_str.endswith(".yml")
        if not looks_like_file:
            out_path = args.out / f"{feature_table_id}.yaml"
        else:
            out_path = args.out
            if out_path.stem != feature_table_id:
                console.print(
                    f"[yellow]warning:[/] output filename basename "
                    f"{out_path.stem!r} doesn't match feature_table id "
                    f"{feature_table_id!r}. The catalog loader requires them "
                    f"to match for directory-mode loads."
                )
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

    # ── Write ──
    if out_path.exists() and not args.force:
        console.print(f"[red]refusing to overwrite existing file:[/] {out_path}")
        console.print("[dim](pass --force, or --out <path>)[/]")
        return 2
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(_format_yaml(feature_table))
    console.print()
    console.print(f"[bold green]wrote[/] {out_path}")
    print(f"wrote: {out_path}")

    # ── Datastack snippet ──
    _print_datastack_snippet(console, out_path, feature_table_id)

    return 0


if __name__ == "__main__":
    sys.exit(main())
