"""Open a feature parquet, introspect its columns, and emit a starter
Feature Explorer manifest.

The classification heuristics:

| Column | Bucket |
|--------|--------|
| Named ``cell_id`` / ``id``, int-typed | ``id_column`` |
| Numeric, name contains "depth" | ``depth_columns`` + ``feature_columns`` |
| Pair ``<prefix>_x`` / ``<prefix>_y`` (or ``_1`` / ``_2``) where prefix is in {umap, tsne, t-sne, pca, phate, mds, isomap, lle} | one ``embeddings:`` entry |
| Named ``source_root_id`` / ``source_mat_version`` (or ``*_source_root*``, ``*_source_mat_version*``) | ``audit.*`` |
| Numeric, not in audit / axes / id | ``feature_columns`` |
| Object / string / categorical dtype | ``categorical_columns`` |

The output is a complete manifest with ``TODO`` markers on every
decision the script can't make for you (default_color_by, category
groupings, the manifest's knn defaults if you want non-defaults).
Review and edit before deploying.

Companion to ``docs/setting-up-a-datastack.md``.

Usage:
    uv run python scripts/scaffold_feature_explorer.py \\
        --parquet path/to/features.parquet \\
        --feature-table-id morpho_v1

    uv run python scripts/scaffold_feature_explorer.py \\
        --parquet ./morpho.parquet --feature-table-id morpho_v1 \\
        --parquet-uri gs://my-bucket/embeddings/morpho.parquet \\
        --out /tmp/manifest.yaml
"""

from __future__ import annotations

import argparse
import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any

# pandas + pyarrow are project deps (used widely under cave_data_viewer/).
import pandas as pd
import yaml


# Embedding-pair detection. The regex captures `<prefix>_<axis>` where
# axis ∈ {x, y, 1, 2}. We then group columns by prefix and pair off
# {x, y} or {1, 2}. Prefix is only treated as an embedding if it's a
# known dimensionality-reduction name; arbitrary `<word>_x` / `<word>_y`
# coordinate pairs (e.g. `soma_x` / `soma_y`) are NOT embeddings.
_EMBEDDING_PREFIX_TOKENS = frozenset(
    {"umap", "tsne", "t-sne", "pca", "phate", "mds", "isomap", "lle"}
)
_AXIS_RE = re.compile(r"^(?P<prefix>.+?)[_-](?P<axis>x|y|1|2)$", re.IGNORECASE)


def _prefix_looks_like_embedding(prefix: str) -> bool:
    """True when any embedding token appears in the prefix as a substring
    (case-insensitive). Catches plain `umap` AND descriptive variants like
    `umap_embedding`, `morpho_umap`, `umap_inhibitory_only`, etc."""
    lowered = prefix.lower().replace("_", "-")
    return any(tok in lowered for tok in _EMBEDDING_PREFIX_TOKENS)

# Audit-column name patterns. Loose matching so `source_root_id`,
# `feature_source_root_id`, `source_mat_version`, etc. all classify.
_SOURCE_ROOT_PATTERNS = (re.compile(r"source[_-]?root", re.IGNORECASE),)
_SOURCE_MV_PATTERNS = (re.compile(r"source[_-]?mat[_-]?version", re.IGNORECASE),)

# Candidate id-column names. The id column is also constrained to an
# integer dtype to avoid catching a string "id" column that happens to
# be named the same thing.
_ID_CANDIDATES = ("cell_id", "id")
# Loose pattern: any int column whose name ends in `_id` is likely a
# foreign key into some table, not a feature. We exclude these from
# `feature_columns` and surface them as id-column candidates when the
# canonical `cell_id` / `id` column isn't present.
_ID_LIKE_RE = re.compile(r"_id$", re.IGNORECASE)


def _is_numeric(dtype: Any) -> bool:
    """Pandas numeric-dtype predicate. Catches int / float / nullable
    integer dtypes uniformly."""
    return pd.api.types.is_numeric_dtype(dtype) and not pd.api.types.is_bool_dtype(dtype)


def _is_integer(dtype: Any) -> bool:
    return pd.api.types.is_integer_dtype(dtype)


def _matches_any(name: str, patterns: Iterable[re.Pattern[str]]) -> bool:
    return any(p.search(name) for p in patterns)


def _detect_id_column(df: pd.DataFrame, override: str | None) -> str | None:
    """Resolve the id column. Explicit override always wins; otherwise
    pick the first int-typed column whose name matches an id candidate."""
    if override is not None:
        if override not in df.columns:
            raise SystemExit(f"--id-column {override!r} not in parquet columns")
        return override
    for cand in _ID_CANDIDATES:
        if cand in df.columns and _is_integer(df[cand].dtype):
            return cand
    return None


def _id_like_columns(df: pd.DataFrame, id_column: str | None) -> list[str]:
    """Int columns whose name ends in `_id` and that aren't already the
    resolved id_column. Treated as foreign-key candidates and excluded
    from `feature_columns` so they don't pollute kNN."""
    return [
        col
        for col in df.columns
        if col != id_column
        and _is_integer(df[col].dtype)
        and _ID_LIKE_RE.search(col) is not None
    ]


def _detect_audit(df: pd.DataFrame) -> dict[str, str]:
    """Find source_root + source_mat_version columns. Returns the
    `audit:` block content as a dict (empty if neither is found)."""
    audit: dict[str, str] = {}
    for col in df.columns:
        if "source_root_column" not in audit and _matches_any(col, _SOURCE_ROOT_PATTERNS):
            audit["source_root_column"] = col
        if "source_mat_version_column" not in audit and _matches_any(col, _SOURCE_MV_PATTERNS):
            audit["source_mat_version_column"] = col
    return audit


def _detect_embeddings(df: pd.DataFrame) -> tuple[list[dict[str, Any]], set[str]]:
    """Find embedding axis pairs. Returns (embeddings_list, axis_columns_consumed).

    Axis columns are matched by name regex AND filtered to the
    recognized embedding-prefix set so non-embedding `<word>_x/_y`
    coordinate pairs (soma_x/soma_y) don't get classified as
    embeddings.
    """
    # Group axis-shaped columns by prefix.
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
        # Normalize to a canonical key so `umap_embedding` and `UMAP-embedding`
        # collapse into one group.
        key = prefix.lower().replace("-", "_")
        by_prefix.setdefault(key, {})[axis] = col

    embeddings: list[dict[str, Any]] = []
    consumed: set[str] = set()
    for prefix in sorted(by_prefix):
        axes_map = by_prefix[prefix]
        # Accept either {x, y} or {1, 2} pairings; skip prefixes that
        # don't have both members of a pair (one-of-pair is probably a
        # misnamed feature, not an embedding).
        if "x" in axes_map and "y" in axes_map:
            pair = [axes_map["x"], axes_map["y"]]
        elif "1" in axes_map and "2" in axes_map:
            pair = [axes_map["1"], axes_map["2"]]
        else:
            continue
        consumed.update(pair)
        embeddings.append(
            {
                "id": prefix,
                "title": prefix.upper().replace("_", "-"),
                "axes": pair,
                # default_color_by is operator-supplied; flagged as TODO.
                "default_color_by": "TODO_pick_a_color_by_column",
            }
        )
    return embeddings, consumed


def _classify_columns(
    df: pd.DataFrame,
    id_column: str | None,
    audit: dict[str, str],
    axis_columns: set[str],
    id_like_columns: list[str],
) -> tuple[list[str], list[str], list[str]]:
    """Split remaining columns into (feature_columns, categorical_columns, depth_columns).

    `id_like_columns` are int columns ending in `_id` (foreign-key
    candidates); excluded from features so they don't pollute kNN.
    """
    reserved = {id_column} if id_column else set()
    reserved |= set(audit.values())
    reserved |= axis_columns
    reserved |= set(id_like_columns)

    feature_columns: list[str] = []
    categorical_columns: list[str] = []
    depth_columns: list[str] = []
    for col in df.columns:
        if col in reserved:
            continue
        dtype = df[col].dtype
        is_depth = "depth" in col.lower()
        if _is_numeric(dtype):
            feature_columns.append(col)
            if is_depth:
                depth_columns.append(col)
        elif (
            pd.api.types.is_string_dtype(dtype)
            or pd.api.types.is_object_dtype(dtype)
            or isinstance(dtype, pd.CategoricalDtype)
            or pd.api.types.is_bool_dtype(dtype)
        ):
            categorical_columns.append(col)
        else:
            # Datetimes, timedeltas, etc. — don't classify; let the
            # operator decide what to do with them.
            pass
    return feature_columns, categorical_columns, depth_columns


def _build_manifest(
    parquet_uri: str,
    feature_table_id: str,
    df: pd.DataFrame,
    id_column: str | None,
) -> tuple[dict[str, Any], list[str], int]:
    """Build the manifest dict. Returns (manifest, id_like_columns,
    detected_embedding_count) so the caller can report classification
    stats accurately."""
    audit = _detect_audit(df)
    embeddings, axis_cols = _detect_embeddings(df)
    detected_embedding_count = len(embeddings)
    id_like = _id_like_columns(df, id_column)
    feature_cols, categorical_cols, depth_cols = _classify_columns(
        df, id_column, audit, axis_cols, id_like
    )

    feature_table: dict[str, Any] = {
        "id": feature_table_id,
        "title": f"TODO: human-readable title for {feature_table_id}",
        "description": "TODO: one-line description of what this feature table contains.",
        "source": {"kind": "parquet", "uri": parquet_uri},
        "id_column": id_column or "TODO_set_id_column_explicitly",
        "feature_columns": feature_cols,
        "categorical_columns": categorical_cols,
        "depth_columns": depth_cols,
    }
    if audit:
        feature_table["audit"] = audit
    # Categories: not auto-inferable. Emit a single placeholder so the
    # operator sees the shape; they'll edit it (or delete it) by hand.
    if feature_cols or categorical_cols:
        feature_table["categories"] = [
            {
                "id": "all",
                "title": "All columns",
                "description": "TODO: split into meaningful groups (e.g. morphology / classifier / synaptics).",
                "columns": feature_cols + categorical_cols,
            }
        ]
    if embeddings:
        feature_table["embeddings"] = embeddings
    else:
        # No embedding pair detected; emit a placeholder so the operator
        # knows where to author one. Empty list IS valid (the scatter
        # won't render until at least one embedding is added).
        feature_table["embeddings"] = [
            {
                "id": "TODO_embedding_id",
                "title": "TODO embedding title",
                "axes": ["TODO_x_column", "TODO_y_column"],
                "default_color_by": "TODO_pick_a_color_by_column",
            }
        ]

    manifest = {
        "schema_version": 2,
        # knn defaults are good for most morphology / connectomic feature
        # sets; override only when the input parquet is pre-standardized
        # or uses an unusual scaling.
        "knn": {
            "scaling": "zscore",
            "clip_percentiles": [0.1, 99.9],
        },
        "feature_tables": [feature_table],
    }
    return manifest, id_like, detected_embedding_count


def _format_yaml(manifest: dict[str, Any]) -> str:
    # PyYAML's safe_dump is order-preserving when given a dict literal in
    # Python 3.7+. We rely on insertion order here.
    return yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True, default_flow_style=False)


def _print_summary(
    manifest: dict[str, Any],
    df: pd.DataFrame,
    id_column: str | None,
    id_like: list[str],
    detected_embedding_count: int,
) -> None:
    """Print a short stderr summary so the operator sees what was classified."""
    table = manifest["feature_tables"][0]
    print(f"  rows in parquet:      {len(df):,}", file=sys.stderr)
    print(f"  columns in parquet:   {len(df.columns):,}", file=sys.stderr)
    if id_column:
        print(f"  id_column:            {id_column}", file=sys.stderr)
    else:
        msg = "(none detected — set --id-column)"
        if id_like:
            msg += f"  candidates: {id_like}"
        print(f"  id_column:            {msg}", file=sys.stderr)
    print(f"  feature_columns:      {len(table.get('feature_columns', []))}", file=sys.stderr)
    print(f"  categorical_columns:  {len(table.get('categorical_columns', []))}", file=sys.stderr)
    print(f"  depth_columns:        {len(table.get('depth_columns', []))}", file=sys.stderr)
    print(f"  embeddings detected:  {detected_embedding_count}", file=sys.stderr)
    if id_like:
        print(f"  id-like cols excluded: {id_like}", file=sys.stderr)
    audit = table.get("audit", {})
    if audit:
        print(f"  audit columns:        {sorted(audit.values())}", file=sys.stderr)
    print(file=sys.stderr)


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
    parser.add_argument("--id-column", default=None, help="override cell_id column detection")
    parser.add_argument("--force", action="store_true", help="overwrite existing output file")
    args = parser.parse_args(argv)

    if not args.parquet.exists():
        print(f"parquet not found: {args.parquet}", file=sys.stderr)
        return 2
    if args.out.exists() and not args.force:
        print(f"refusing to overwrite existing file: {args.out}", file=sys.stderr)
        print("(pass --force to overwrite, or --out <path> to write elsewhere)", file=sys.stderr)
        return 2

    parquet_uri = args.parquet_uri or f"file://{args.parquet.resolve()}"

    # Read only the schema + a small sample. The classifier doesn't need
    # the full data; we just need dtypes and one row to confirm the
    # parquet is well-formed.
    df = pd.read_parquet(args.parquet)

    id_column = _detect_id_column(df, args.id_column)

    manifest, id_like, detected_embedding_count = _build_manifest(
        parquet_uri, args.feature_table_id, df, id_column
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(_format_yaml(manifest))

    print(f"wrote {args.out}", file=sys.stderr)
    print(file=sys.stderr)
    print("classification summary:", file=sys.stderr)
    _print_summary(manifest, df, id_column, id_like, detected_embedding_count)

    print("Next:", file=sys.stderr)
    print(f"  1. Open {args.out} and edit every TODO marker.", file=sys.stderr)
    print("  2. Point your datastack YAML at it:", file=sys.stderr)
    print("       feature_explorer:", file=sys.stderr)
    print("         enabled: true", file=sys.stderr)
    print("         cell_id_source_table: <your_nucleus_table>", file=sys.stderr)
    print(f"         manifest_uri: file://{args.out.resolve()}", file=sys.stderr)
    print("  3. Restart the backend. /explore shows up for the datastack.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
