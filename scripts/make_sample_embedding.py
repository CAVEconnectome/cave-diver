"""Generate a small synthetic embedding parquet + feature-table YAML for local
Feature Explorer development.

Outputs (default, using --datastack minnie65_public):
    <repo>/config/feature_tables/minnie65_public/morpho_sample.parquet
    <repo>/config/feature_tables/minnie65_public/morpho_sample.yaml

The parquet's `cell_id` values are synthetic — they don't correspond to real
nucleus_detection_v0 rows. That's fine for the explorer's internal flows
(scatter, kNN, color, filter, lasso) which never call CAVE. Cross-nav into
/neuron (which goes through the cell_id -> root_id resolver) will report
every cell as `missing` unless real cell_ids are supplied via --ids-csv;
this is the expected and correct behavior for fully-synthetic dev data.

The per-FT YAML omits `source.uri`; the loader default-fills it to
`<prefix>/<id>.parquet` at load time, so the committed YAML contains no
host-absolute paths.

Usage:
    uv run python scripts/make_sample_embedding.py
    uv run python scripts/make_sample_embedding.py --datastack minnie65_public --n 2000
    uv run python scripts/make_sample_embedding.py --outdir /tmp/my-embeddings --n 500

To exercise the resolver end-to-end, supply a CSV of real cell_ids drawn
from `nucleus_detection_v0` at a known mat_version:
    uv run python scripts/make_sample_embedding.py --ids-csv ~/real_cell_ids.csv
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence

import numpy as np
import pandas as pd
import yaml

# Two-level synthetic taxonomy so the explorer's categorical color-by has
# something meaningful to render. Cluster centers in UMAP space are seeded
# off the subclass so each subclass forms a visible blob.
SUBCLASSES = [
    ("L23_PYR", "EXC"),
    ("L4_PYR", "EXC"),
    ("L5_PYR", "EXC"),
    ("BC", "INH"),
    ("MC", "INH"),
]

# Approximate cluster centers in the synthetic UMAP plane (one per subclass).
SUBCLASS_CENTERS = {
    "L23_PYR": (-3.0, 2.5),
    "L4_PYR": (-1.0, 3.5),
    "L5_PYR": (1.5, 2.0),
    "BC": (3.0, -2.5),
    "MC": (-2.0, -3.0),
}

# Plausible per-subclass means for the numeric features. Spread is intentionally
# wide so range-slider filters have something to bite on. Units roughly mirror
# the real morphology columns (microns / microns^3).
SUBCLASS_FEATURES = {
    "L23_PYR": {"soma_depth_y": 220.0, "nucleus_volume_um": 380.0, "soma_area_um": 950.0},
    "L4_PYR": {"soma_depth_y": 410.0, "nucleus_volume_um": 420.0, "soma_area_um": 1050.0},
    "L5_PYR": {"soma_depth_y": 680.0, "nucleus_volume_um": 560.0, "soma_area_um": 1450.0},
    "BC": {"soma_depth_y": 480.0, "nucleus_volume_um": 290.0, "soma_area_um": 720.0},
    "MC": {"soma_depth_y": 350.0, "nucleus_volume_um": 310.0, "soma_area_um": 780.0},
}


def _load_real_cell_ids(csv_path: Path) -> np.ndarray:
    """Read cell_ids from a one-column CSV (header optional)."""
    df = pd.read_csv(csv_path, header=None)
    col = df.iloc[:, 0]
    if col.iloc[0] in ("cell_id", "id", "nucleus_id"):
        col = col.iloc[1:]
    return col.astype("int64").to_numpy()


def _build_frame(n: int, rng: np.random.Generator, cell_ids: Sequence[int] | None) -> pd.DataFrame:
    """Build the synthetic dataframe.

    Each row is assigned a subclass uniformly at random, then features are
    drawn around the subclass-specific means with non-trivial spread.
    """
    if cell_ids is None:
        cell_ids = np.arange(100_000, 100_000 + n, dtype=np.int64)
    else:
        cell_ids = np.asarray(cell_ids, dtype=np.int64)
        n = len(cell_ids)

    subclass_names = [s for s, _ in SUBCLASSES]
    subclass_idx = rng.integers(0, len(subclass_names), size=n)
    subclass = np.array([subclass_names[i] for i in subclass_idx])
    cls = np.array([dict(SUBCLASSES)[s] for s in subclass])

    centers = np.array([SUBCLASS_CENTERS[s] for s in subclass])
    umap_xy = centers + rng.normal(scale=0.5, size=(n, 2))

    soma_depth = np.array([SUBCLASS_FEATURES[s]["soma_depth_y"] for s in subclass])
    nucleus_vol = np.array([SUBCLASS_FEATURES[s]["nucleus_volume_um"] for s in subclass])
    soma_area = np.array([SUBCLASS_FEATURES[s]["soma_area_um"] for s in subclass])
    soma_depth += rng.normal(scale=40.0, size=n)
    nucleus_vol += rng.normal(scale=60.0, size=n)
    soma_area += rng.normal(scale=120.0, size=n)

    # Synthetic root_ids in the minnie65 range (18-digit). Not valid in CAVE;
    # the audit columns are for tooltip rendering and traceability only.
    source_root = (864_691_000_000_000_000 + rng.integers(0, 10**14, size=n)).astype(np.int64)

    return pd.DataFrame(
        {
            "cell_id": cell_ids,
            "umap_x": umap_xy[:, 0],
            "umap_y": umap_xy[:, 1],
            "predicted_class": cls,
            "predicted_subclass": subclass,
            "soma_depth_y": soma_depth,
            "nucleus_volume_um": nucleus_vol,
            "soma_area_um": soma_area,
            "source_root_id": source_root,
            "source_mat_version": np.full(n, 1718, dtype=np.int64),
        }
    )


def _build_feature_table(parquet_path: Path) -> dict:
    """One per-file FeatureTableSpec (schema v1) for the local parquet.

    `source.uri` is intentionally omitted; the loader default-fills it to
    `<prefix>/<id>.parquet` at load time so the committed YAML contains no
    host-absolute paths.
    """
    return {
        "schema_version": 1,
        "id": "morpho_sample",
        "title": "Morphology features (synthetic sample)",
        "description": (
            "Synthetic sample feature table for local Feature Explorer "
            "development. cell_ids do not correspond to real "
            "nucleus_detection_v0 rows unless the generator was run with "
            "--ids-csv."
        ),
        "source": {"kind": "parquet"},  # uri default-filled at load time to <prefix>/<id>.parquet
        "id_column": "cell_id",
        "cell_id_source_table": "nucleus_detection_v0",
        "feature_columns": [
            "soma_depth_y",
            "nucleus_volume_um",
            "soma_area_um",
        ],
        "categorical_columns": ["predicted_class", "predicted_subclass"],
        "spatial_post_columns": ["soma_depth_y"],
        "depth_columns": ["soma_depth_y"],
        "audit": {
            "source_root_column": "source_root_id",
            "source_mat_version_column": "source_mat_version",
        },
        # Categories group columns for the channel picker and the
        # manual-histogram menu. A column may appear in multiple
        # categories; columns not listed here render under an implicit
        # "Uncategorized" group.
        "categories": [
            {
                "id": "morphology",
                "title": "Morphology",
                "description": "Soma + nucleus geometry",
                "columns": [
                    "soma_depth_y",
                    "nucleus_volume_um",
                    "soma_area_um",
                ],
            },
            {
                "id": "classifier",
                "title": "Classifier",
                "description": "Predicted class labels",
                "columns": ["predicted_class", "predicted_subclass"],
            },
        ],
        # Similarity controls moved per-table in schema v1.
        "scaling": "zscore",
        "clip_percentiles": [0.1, 99.9],
        "embeddings": [
            {
                "id": "umap",
                "title": "UMAP",
                "axes": ["umap_x", "umap_y"],
                "default_color_by": "predicted_subclass",
            }
        ],
    }


def main(argv: Sequence[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--datastack", default="minnie65_public", help="datastack name (used to compute default --outdir)")
    p.add_argument("--outdir", type=Path, default=None, help="override output directory (default: <repo>/config/feature_tables/<datastack>/)")
    p.add_argument("--n", type=int, default=1000, help="number of cells (ignored when --ids-csv is given)")
    p.add_argument("--ids-csv", type=Path, default=None, help="one-column CSV of real cell_ids to use as keys")
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args(argv)

    # Resolve output dir: --outdir overrides; otherwise convention.
    if args.outdir is not None:
        outdir = args.outdir
    else:
        repo_root = Path(__file__).resolve().parents[1]
        outdir = repo_root / "config" / "feature_tables" / args.datastack
    outdir.mkdir(parents=True, exist_ok=True)

    rng = np.random.default_rng(args.seed)

    real_ids = _load_real_cell_ids(args.ids_csv) if args.ids_csv else None
    frame = _build_frame(args.n, rng, real_ids)

    parquet_path = outdir / "morpho_sample.parquet"
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


if __name__ == "__main__":
    sys.exit(main())
