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
    # Interactive (recommended)
    uv run python scripts/scaffold_feature_explorer.py \\
        --parquet path/to/features.parquet \\
        --feature-table-id morpho_v1

    # Non-interactive — accept all heuristic defaults, no prompts
    uv run python scripts/scaffold_feature_explorer.py \\
        --parquet path/to/features.parquet --feature-table-id morpho_v1 \\
        --non-interactive --out /tmp/manifest.yaml
"""

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any

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
    "feature",
    "categorical",
    "depth",         # always also a feature; depth is a tag, not an exclusive bucket
    "audit_root",
    "audit_mat_version",
    "axis",          # consumed by an embedding pair
    "id_like",       # excluded foreign-key int
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
        if "depth" in col.lower():
            tags.add("depth")
        return tags
    if _is_categorical_dtype_compat(dtype):
        tags.add("categorical")
        return tags
    tags.add("unclassified")
    return tags


# ────────── Manifest construction ──────────


def _build_manifest_dict(
    *,
    feature_table_id: str,
    title: str,
    description: str | None,
    parquet_uri: str,
    id_column: str,
    classification: dict[str, set[str]],
    audit: dict[str, str],
    embeddings: list[dict[str, Any]],
    categories: list[dict[str, Any]],
    knn: dict[str, Any],
) -> dict[str, Any]:
    feature_columns = [c for c, tags in classification.items() if "feature" in tags]
    categorical_columns = [c for c, tags in classification.items() if "categorical" in tags]
    depth_columns = [c for c, tags in classification.items() if "depth" in tags]

    feature_table: dict[str, Any] = {"id": feature_table_id, "title": title}
    if description:
        feature_table["description"] = description
    feature_table["source"] = {"kind": "parquet", "uri": parquet_uri}
    feature_table["id_column"] = id_column
    feature_table["feature_columns"] = feature_columns
    feature_table["categorical_columns"] = categorical_columns
    feature_table["depth_columns"] = depth_columns
    if audit:
        feature_table["audit"] = audit
    if categories:
        feature_table["categories"] = categories
    # Embeddings: drop entries whose default_color_by is still None so
    # the wire shape stays clean. The Pydantic schema allows it null
    # but absent reads cleaner.
    cleaned_embeddings = []
    for emb in embeddings:
        e = {k: v for k, v in emb.items() if v is not None}
        cleaned_embeddings.append(e)
    feature_table["embeddings"] = cleaned_embeddings

    return {
        "schema_version": 2,
        "knn": knn,
        "feature_tables": [feature_table],
    }


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
    """One-line bucket summary for the column-overview table."""
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
        return "feature" + ("[green] +depth[/]" if "depth" in tags else "")
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
    console.rule("[bold]Step 1/6 — Pick id column[/]")
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
    console.rule("[bold]Step 2/6 — Review column classification[/]")
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
            choices=["feature", "categorical", "depth", "audit_root", "audit_mat_version", "id_like", "skip"],
            default="skip",
            console=console,
        )
        if new_bucket == "skip":
            continue
        # `depth` adds to features rather than replacing.
        if new_bucket == "depth":
            classification[col] = {"feature", "depth"}
        else:
            classification[col] = {new_bucket}
    console.print()
    console.print(_columns_table(df, classification, "Updated classification"))
    return classification


def _interactive_title_description(
    console: Console, feature_table_id: str
) -> tuple[str, str | None]:
    console.print()
    console.rule("[bold]Step 3/6 — Feature table title + description[/]")
    title = Prompt.ask(
        "Title",
        default=f"Feature table: {feature_table_id}",
        console=console,
    )
    description = Prompt.ask(
        "Description [empty to skip]",
        default="",
        console=console,
    )
    return title, description.strip() or None


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


def _validate_manifest(manifest: dict[str, Any], console: Console) -> bool:
    """Run the Pydantic Manifest validator over the dict. Returns True on
    success; prints validation errors and returns False on failure."""
    try:
        from cave_data_viewer.api.services.embeddings.manifest import Manifest
    except Exception as exc:
        console.print(f"[yellow]could not import Manifest for validation: {exc}[/]")
        console.print("[yellow]writing without validation — please verify by hand[/]")
        return True
    try:
        Manifest.model_validate(manifest)
        return True
    except Exception as exc:
        console.print(Panel(str(exc), title="Manifest validation failed", border_style="red"))
        return False


def _format_yaml(manifest: dict[str, Any]) -> str:
    return yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True, default_flow_style=False)


def _print_datastack_snippet(
    console: Console, manifest_path: Path, feature_table_id: str
) -> None:
    """Print the YAML block to paste into the datastack YAML."""
    snippet = (
        "feature_explorer:\n"
        "  enabled: true\n"
        "  cell_id_source_table: <CAVE table that defines this cell_id namespace>\n"
        f"  manifest_uri: file://{manifest_path.resolve()}\n"
    )
    console.print()
    console.print(
        Panel(
            snippet,
            title=f"Paste into config/datastacks/<ds>.yaml for feature_table '{feature_table_id}'",
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
    parser.add_argument("--feature-table-id", required=True, help="manifest's feature_tables[].id")
    parser.add_argument("--out", type=Path, default=Path("/tmp/manifest.yaml"), help="output manifest path")
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
    if args.out.exists() and not args.force:
        console.print(f"[red]refusing to overwrite existing file:[/] {args.out}")
        console.print("[dim](pass --force, or --out <path>)[/]")
        return 2

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
        if auto_id is None:
            console.print("[red]--non-interactive: no id column auto-detected; pass --id-column[/]")
            return 2
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
        title = f"Feature table: {args.feature_table_id}"
        description = None
        categories: list[dict[str, Any]] = []
        knn = {"scaling": "zscore", "clip_percentiles": [0.1, 99.9]}
    else:
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
        title, description = _interactive_title_description(console, args.feature_table_id)
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

    manifest = _build_manifest_dict(
        feature_table_id=args.feature_table_id,
        title=title,
        description=description,
        parquet_uri=parquet_uri,
        id_column=id_column,
        classification=classification,
        audit=audit,
        embeddings=embeddings,
        categories=categories,
        knn=knn,
    )

    # ── Validate ──
    console.print()
    console.rule("[bold]Validating against Manifest schema[/]")
    ok = _validate_manifest(manifest, console)
    if not ok:
        if args.non_interactive or not Confirm.ask(
            "[yellow]validation failed — write anyway?[/]", default=False, console=console
        ):
            return 3
    else:
        console.print("[green]✓ valid[/]")

    # ── Write ──
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(_format_yaml(manifest))
    console.print()
    console.print(f"[bold green]wrote[/] {args.out}")

    # ── Datastack snippet ──
    _print_datastack_snippet(console, args.out, args.feature_table_id)

    return 0


if __name__ == "__main__":
    sys.exit(main())
