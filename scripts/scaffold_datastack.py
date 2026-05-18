"""Emit a starter `config/datastacks/<ds>.yaml` skeleton.

The output is a heavily commented YAML file — every common knob is
present but commented out so an operator can uncomment + edit the
ones they need. Defaults match the public-release shape (live_mode
off, warmup disabled, feature_explorer disabled).

Companion to ``docs/setting-up-a-datastack.md``.

Usage:
    uv run python scripts/scaffold_datastack.py \\
        --datastack my_new_datastack \\
        --aligned-volume minnie65_phase3

    uv run python scripts/scaffold_datastack.py \\
        --datastack my_internal_ds --internal
"""

from __future__ import annotations

import argparse
import sys
import textwrap
from pathlib import Path

# Repo root, resolved from this file's location so the script works regardless
# of the caller's working directory.
_REPO_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_CONFIG_DIR = _REPO_ROOT / "config" / "datastacks"


def _render_yaml(datastack: str, aligned_volume: str | None, public: bool) -> str:
    """Render the skeleton YAML body.

    Indentation is preserved verbatim — the file is meant to be edited by
    hand so we lean into "comments-as-prose" rather than a tight schema.
    """
    av_note = (
        f"# Aligned volume: `{aligned_volume}`. Spatial transform + synapse-table\n"
        f"# defaults come from `config/aligned_volumes/{aligned_volume}.yaml`.\n"
        if aligned_volume
        else "# Spatial transform + synapse defaults are inherited from the\n"
        "# datastack's aligned_volume YAML (see config/aligned_volumes/).\n"
    )

    live_mode_block = (
        "# false = only published mat versions are exposed; live mode is hidden.\n"
        "# Public/release datastacks should leave this false.\n"
        "live_mode: false\n"
        if public
        else "# true = the SPA exposes \"live\" mode (latest CAVE state). Internal\n"
        "# / pre-release datastacks usually want this; public/release datastacks\n"
        "# should set false so users don't see unstable data.\n"
        "live_mode: true\n"
    )

    body = f"""\
# Datastack: {datastack}
#
{av_note}#
# Reference: docs/setting-up-a-datastack.md (Section 1)
# Schema:    cave_data_viewer/api/services/datastack_config.py::DatastackConfig

{live_mode_block}
# Cache namespace alias. Use when this datastack describes the same
# underlying data as another datastack (e.g. a public release of an
# internal volume). Cache reads/writes redirect to the alias target;
# CAVE calls still use *this* datastack name.
#
# cache_alias: minnie65_phase3_v1

# ---- cell-id lookup -----------------------------------------------------
# Cell ids (typically nucleus ids) are persistent identifiers that
# survive proofreading splits/merges; root ids are not. The forward
# direction (cell_id → current root_id) uses a materialized view; the
# reverse direction walks one or more annotation tables. Omit all three
# keys if the datastack has no cell-id concept — the SPA hides the
# cell-id input automatically.
#
# cell_id_lookup_view: nucleus_detection_lookup_v1
# root_id_lookup_main_table: nucleus_detection_v0
# root_id_lookup_alt_tables:
#   - nucleus_alternative_points

# ---- synapse-table override -------------------------------------------
# Override individual fields of the aligned-volume's `synapse:` config.
# Omitted fields inherit. Omit the whole block to inherit everything.
#
# synapse:
#   position_prefix: anchor_pt        # aligned-volume default is usually ctr_pt
#   aggregation_rules:
#     median_size:
#       column: size
#       agg: median

# ---- decoration warmup ------------------------------------------------
# Periodic refresh of whole-decoration-table caches at the latest valid
# mat version. Off by default. Set `startup_delay_seconds` to a few
# minutes in autoscaling deployments so pod scale-up doesn't thunder
# into CAVE.
#
# decoration_warmup:
#   enabled: true
#   tables:
#     - aibs_metamodel_celltypes_v661
#   warm_soma_table: true
#   interval_seconds: 3600
#   startup_delay_seconds: 180

# ---- synapse warmup ----------------------------------------------------
# Same idea but driven off a proofreading-status table that names which
# cells are worth warming.
#
# synapse_warmup:
#   source:
#     table: proofreading_status_and_strategy
#     root_id_column: pt_root_id
#     filters: {{status_axon: "eq:true"}}
#   max_cells: 2000
#   parallel_workers: 8

# ---- feature explorer -------------------------------------------------
# Enables /explore for this datastack. The embedding catalog lives in
# the manifest at `manifest_uri` — see docs/setting-up-a-datastack.md
# Section 2 (or run scripts/scaffold_feature_explorer.py to generate a
# starter manifest from a parquet).
#
# feature_explorer:
#   enabled: true
#   cell_id_source_table: nucleus_detection_v0
#   manifest_uri: "gs://my-bucket/my-prefix/feature-manifest.yaml"

# ---- LTS marker (NOT in this file) ------------------------------------
# Examples are filtered against `<ds>-longlived-versions.json` in the
# GCS cache bucket:
#     gs://<CDV_GCS_CACHE_BUCKET>/<CDV_GCS_CACHE_PREFIX>info/{datastack}-longlived-versions.json
# Minimal shape:
#     {{"longlived_versions": [<mv-int>, ...]}}
# Without this file, all examples for this datastack are hidden behind
# the "no LTS published" empty state.
"""
    return body


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=textwrap.dedent(__doc__ or "").strip(),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--datastack", required=True, help="datastack name (used as filename)")
    parser.add_argument("--aligned-volume", help="aligned_volume name (informational; used in a generated comment)")

    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--public", action="store_true", help="public/release datastack (live_mode false; default)")
    mode.add_argument("--internal", action="store_true", help="internal/dev datastack (live_mode true)")

    parser.add_argument("--out", type=Path, help="output path (default: config/datastacks/<datastack>.yaml)")
    parser.add_argument("--force", action="store_true", help="overwrite existing file")
    args = parser.parse_args(argv)

    # Default to public unless --internal explicitly given.
    is_public = not args.internal

    out_path = args.out or (_DEFAULT_CONFIG_DIR / f"{args.datastack}.yaml")
    if out_path.exists() and not args.force:
        print(f"refusing to overwrite existing file: {out_path}", file=sys.stderr)
        print("(pass --force to overwrite, or --out <path> to write elsewhere)", file=sys.stderr)
        return 2

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(_render_yaml(args.datastack, args.aligned_volume, is_public))
    print(f"wrote {out_path}")
    print()
    print("Next:")
    print(f"  1. Edit {out_path} — uncomment + fill the blocks you need.")
    print("  2. If using the feature explorer, generate a manifest:")
    print("       uv run python scripts/scaffold_feature_explorer.py --parquet <path>")
    print("  3. Restart the backend; the new datastack appears in /datastacks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
