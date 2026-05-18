# Setting Up a Datastack

This guide walks you through everything needed to add a new CAVE datastack to the viewer, from scratch. Four config layers stack on top of each other; each section below covers one.

```
┌─────────────────────────────────────────────────────────────────────┐
│  config/aligned_volumes/<av>.yaml      spatial + synapse defaults   │
│      ↑ inherited by ↓                                               │
│  config/datastacks/<ds>.yaml          datastack-level config (1)   │
│      │   (CDV_FEATURE_TABLES_BASE_URI)/feature_tables/<ds>/         │
│      │       <id>.yaml + <id>.parquet  embedding catalog (2)        │
│      └── (no inline tours; per-file YAMLs below)                    │
│  config/recipes/<ds>/<id>.yaml         operator recipes (3)         │
│  config/examples/<ds>/<id>.yaml        operator examples (4)        │
└─────────────────────────────────────────────────────────────────────┘
```

All four are loaded once at app boot. Editing any of them requires a pod restart in production; the dev backend reloads YAML edits via mtime check.

In production these directories are injected as ConfigMaps via helm. Locally they live under `config/` in the repo and are bundled into the wheel via hatchling `force-include`. Environment-variable overrides (`CDV_DATASTACK_CONFIG_DIR`, `CDV_ALIGNED_VOLUME_CONFIG_DIR`, `CDV_RECIPES_CONFIG_DIR`, `CDV_EXAMPLES_CONFIG_DIR`) let a deployment point at an injected directory without changing the wheel.

Helper scripts:

- `scripts/scaffold_datastack.py` — emits a starter `config/datastacks/<ds>.yaml` with every knob commented in.
- `scripts/scaffold_feature_explorer.py` — opens a feature parquet, introspects its columns, and emits a starter feature-explorer manifest with feature/categorical/depth columns + axes pre-classified.

See the **Helper scripts** section at the bottom for usage.

---

## 1. Datastack configuration

**File:** `config/datastacks/<datastack-name>.yaml`
**Schema:** `cave_data_viewer/api/services/datastack_config.py::DatastackConfig`
**Field reference:** [`datastack-config.md`](./datastack-config.md) (older, but still accurate for everything *except* the inline `examples:` / `recipes:` blocks — those have moved to the per-file YAMLs in sections 3 & 4).

A datastack YAML carries only the facts tightly tied to one CAVE datastack: live-vs-released mode, cell-id lookup tables, cache aliasing, warmup behavior, and (optionally) a pointer at a feature-explorer manifest. Spatial transforms and synapse-table conventions are inherited from the aligned-volume YAML (see [`aligned-volumes.md`](./aligned-volumes.md)).

### Minimum viable datastack

```yaml
# config/datastacks/my_datastack.yaml

# false = only published mat versions are exposed; live mode is hidden.
# Set true for development / pre-release datastacks where you want users
# to see the latest data.
live_mode: false

# Cell-id ↔ root_id lookup. Cell ids (typically nucleus ids) survive
# proofreading splits/merges; root_ids do not.
#
# Forward direction (cell_id → root_id): the `cell_id_lookup` block
# names a CAVE resource and its kind. CAVE distinguishes views from
# tables at the API level (`query_view` vs `query_table`); the
# consuming code dispatches on `kind`. Carrying name + kind as one
# block keeps them from drifting at edit time.
#
#   cell_id_lookup:
#     kind: view   # or "table"
#     name: <resource name>
#
# Reverse direction (root_id → cell_id):
#   root_id_lookup_main_table  — primary annotation table
#   root_id_lookup_alt_tables  — additional fallback tables walked
#                                when the main table doesn't have a
#                                match (cells whose nucleus moved
#                                across edits, etc.)
#
# Omit the `cell_id_lookup:` block entirely if the datastack has no
# cell-id concept; the SPA hides the cell-id input automatically.
cell_id_lookup:
  kind: view
  name: nucleus_detection_lookup_v1
root_id_lookup_main_table: nucleus_detection_v0
root_id_lookup_alt_tables:
  - nucleus_alternative_points
```

That's enough to bring up `/neuron` for the datastack.

### Common additions

**Cache aliasing.** When two datastacks describe the same underlying data (e.g. a public release vs an internal version of the same volume), have one point at the other so they share a cache namespace. The CAVE call still uses the requesting datastack; only cache pathing redirects.

```yaml
cache_alias: my_other_datastack
```

**Synapse override.** Override one or more fields of the aligned-volume's synapse config. Field-by-field — anything you don't set inherits the aligned-volume default.

```yaml
synapse:
  position_prefix: anchor_pt    # default is "ctr_pt"
  aggregation_rules:
    median_size:
      column: size
      agg: median
```

**Decoration warmup.** Periodically refresh whole-decoration-table caches against the latest valid mat version. Off by default.

```yaml
decoration_warmup:
  enabled: true
  tables:
    - aibs_metamodel_celltypes_v661
  warm_soma_table: true         # also warms the datastack's default soma table
  interval_seconds: 3600        # every hour
  startup_delay_seconds: 180    # wait 3 min after pod boot — avoids
                                # thundering-herd in autoscaling deployments
```

**Synapse warmup.** Same idea for synapse tables but driven off a proofreading-status table (declares *which cells* are worth warming).

```yaml
synapse_warmup:
  source:
    table: proofreading_status_and_strategy
    root_id_column: pt_root_id
    filters: {status_axon: "eq:true"}
  max_cells: 2000
  parallel_workers: 8
```

**Feature explorer.** Enables `/explore` for this datastack. The embedding catalog directory is derived from `CDV_FEATURE_TABLES_BASE_URI` + the datastack name — no per-datastack manifest URI. See **Section 2** for the per-FT YAML schema and deployment layout.

```yaml
feature_explorer:
  enabled: true
  cell_id_source_table: nucleus_detection_v0   # optional fallback
```

### LTS marker (for examples to surface)

Examples are LTS-gated — an example pinned to a materialization version that's not in your datastack's `<ds>-longlived-versions.json` marker file gets hidden from the `/examples` page. This file lives in the GCS cache bucket, NOT in the datastack YAML:

```
gs://<CDV_GCS_CACHE_BUCKET>/<CDV_GCS_CACHE_PREFIX>info/<ds>-longlived-versions.json
```

Minimal shape (the parser tolerates both flat ints and `{"version": N}` dicts):

```json
{"longlived_versions": [1718]}
```

Without this file, every example for the datastack is hidden behind the "no LTS published" empty state. See `cave_data_viewer/api/services/longlived_registry.py` for the parser.

---

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

---

## 3. Recipe configuration

**Directory:** `config/recipes/<datastack-name>/<recipe-id>.yaml` (one file per recipe)
**Schema:** loaded by `services/recipe_registry.py`; same body shape that personal recipes use in storage.

Operator recipes are configuration overlays — applied onto the user's currently-loaded cell to give it a specific decoration / plot / filter profile. Unlike examples, they don't pin a materialization version or a root id.

### Connectivity recipe

```yaml
# config/recipes/my_datastack/comprehensive-view.yaml

version: 1
kind: connectivity                # required
id: comprehensive-view            # MUST match the filename basename
title: "Comprehensive View"
description: "Cell type + proofreading + connectivity plots."

# All array fields below are OPTIONAL when empty — omit the key
# entirely, don't write an empty `[]`.

decoration_tables:
  - proofreading_status_and_strategy
  - cell_type_multifeature_combo

plots:
  - id: depth-profile             # author-facing; SPA mints fresh ids on apply
    summary_kind: synapse_depth_profile
  - id: connectivity-spatial
    bindings:
      x: soma_x
      y: soma_depth
      hue: cell_type_multifeature_combo.cell_type
      size: net_size_out
  - id: outputs-by-type
    bindings:
      x: cell_type_multifeature_combo.cell_type
      weight: net_size_out
    unfiltered: true              # this panel ignores the recipe's `cells:` filter

# Cell filter expression. Shape: `<table>.<col>:<op>:<val>[,...]`.
cells: "proofreading_status_and_strategy.status_axon:eq:true"

# Optional. Per-recipe column-visibility lists for the partner table.
# hide: hide these columns initially
# show: force-show columns that the table's default hides
# coll: collapse these column groups
hide: [some_column]
show: []
coll: []

# Optional. Filter Scope predicates. Reference columns that are part of
# the feature_table's stable schema — predicates do NOT survive a column
# rename. PR review enforces this; there's no runtime check.
scope:
  predicates:
    - column: cell_type
      op: in
      values: [L23P, L4P]
    - column: num_soma
      op: ">="
      value: 1
```

### Explorer recipe

Explorer recipes use a nested `explorer:` block instead of the top-level connectivity fields. Personal explorer recipes use this shape; operator-published explorer recipes are rare (most reusable explorer workflows are better as examples).

```yaml
version: 1
kind: explorer
id: l23-pyramidal-population
title: "L2/3 pyramidal population"
description: "Common scatter binding for L2/3 pyramidals."

explorer:
  ft: morpho_v1
  emb: umap
  decoration_tables: [cell_type_multifeature_combo]
  color: depth_um
  cmap: viridis
  scope_mode: ghost           # how out-of-scope cells render: "ghost" | "hide"
  # selection: [...]          # cell_id list; only when you intend to ship a
                              # specific set rather than let the user build one

scope:
  predicates:
    - column: predicted_class
      op: eq
      value: EXC
```

### Validation rules (registry-side)

- `id` must match `^[a-z0-9][a-z0-9_-]{2,63}$` AND equal the filename basename.
- `kind` must be `connectivity` or `explorer`.
- `version` must be in `SUPPORTED_SCHEMA_VERSIONS` (currently `{1}`).
- An operator recipe must NOT carry a `pinned:` block — `pinned:` is the example marker.

A file that fails any of these is logged as a warning at boot and skipped; the rest of the directory loads normally.

### Authoring workflow

1. Build the desired state interactively in `/neuron` (or `/explore`).
2. Open the Sidebar's Share/Save section, click "Save as my recipe".
3. Click the YAML button on the saved recipe row → download.
4. Move the downloaded file into `config/recipes/<ds>/<id>.yaml`, rename the file to match the recipe's `id` field.
5. Open a PR. The shipped recipe loads on the next pod restart.

---

## 4. Example configuration

**Directory:** `config/examples/<datastack-name>/<example-id>.yaml`
**Optional:** `config/examples/<datastack-name>/_assets/` for thumbnails.
**Schema:** loaded by `services/recipe_registry.py`; surfaced via `/api/v1/examples`.

Examples are LTS-pinned, prose-light tour entries surfaced on `/examples`. Each example is a fully-defined workspace state plus the metadata needed to render a card.

### Connectivity example

```yaml
# config/examples/my_datastack/l23-pyramidal-deep-dive.yaml

version: 1
kind: connectivity
id: l23-pyramidal-deep-dive       # MUST match filename basename

# ── card content ──
title: "L2/3 pyramidal — depth + cell-type deep dive"
summary: "A canonical L2/3 excitatory cell with cortical-depth and cell-type decorations."
full_text: >
  Demonstrates the synapse-depth profile and a partner cell-type
  breakdown. A good starting point for understanding the workspace's
  depth-aware analytics.
thumbnail: l23-pyramidal-deep-dive.png

# ── example-specific pinning ──
# `mv` is required and MUST be in the datastack's LTS marker. `root`
# is required for connectivity examples (it's the specific cell loaded
# when the user clicks "Open").
pinned:
  mv: 1718
  root: "864691135492749415"

# ── recipe body (same shape as a connectivity recipe) ──
decoration_tables:
  - proofreading_status_and_strategy
  - cell_type_multifeature_combo
plots:
  - id: depth-profile
    summary_kind: synapse_depth_profile
  - id: connectivity-spatial
    bindings:
      x: soma_x
      y: soma_depth
      hue: cell_type_multifeature_combo.cell_type
      size: net_size_out
cells: "proofreading_status_and_strategy.status_axon:eq:true"
```

### Explorer example

```yaml
version: 1
kind: explorer
id: morpho-umap-by-subclass

title: "Morphology UMAP colored by subclass"
summary: "Quick tour of the morphology feature table with categorical color."
full_text: >
  Loads a hand-curated set of L2/3 pyramidal cells in the morphology
  feature table. Good starting point for exploring decoration-driven color.

# Explorer pinning carries only `mv` — there's no root_id concept.
pinned:
  mv: 1718

explorer:
  ft: morpho_v1
  emb: umap
  color: predicted_subclass
  decoration_tables: [cell_type_multifeature_combo]
  # selection: required + non-empty for explorer examples; this is the
  # resolved cell_id set the example renders.
  selection:
    - "864691135123456789"
    - "864691135987654321"
    - …                       # operator-curated set
```

### Validation rules (registry-side)

In addition to the operator-recipe rules above:

- `title` and `summary` are required non-empty strings (bounded 200 / 500 chars).
- `full_text` is optional (≤ 5000 chars).
- `thumbnail` is optional; the basename must match `^[a-z0-9_-]+\.(png|jpg|webp)$`. Existence isn't checked at load time — missing file at request time renders a placeholder card.
- `pinned.mv` is required (integer); LTS-gated at request time (NOT at load time).
- `pinned.root` is required when `kind: connectivity`, forbidden when `kind: explorer`.
- `explorer.selection` is required and non-empty for `kind: explorer`.

### LTS gating

Examples are filtered against `LonglivedRegistry.longlived_set(ds)` at every list/serve request:

- An example whose `pinned.mv` isn't in the current LTS set is hidden from `/examples` (counted in the response's `hidden_count` so the SPA can show a banner).
- Direct fetch of an LTS-retired example returns 410 Gone.

Bring an LTS-retired example back by adding its mv to the `<ds>-longlived-versions.json` marker file (no pod restart needed; the registry's TTL is short).

### Thumbnails

Place image files under `config/examples/<ds>/_assets/<filename>`. Reference by bare basename in the example YAML:

```yaml
thumbnail: l23-pyramidal-deep-dive.png
```

The asset endpoint (`GET /api/v1/examples/<ds>/_assets/<file>`) serves them with `Cache-Control: max-age=86400`. The filename allowlist `^[a-z0-9_-]+\.(png|jpg|webp)$` enforces basename-only paths — no traversal possible.

### Authoring workflow

1. Set up the desired workspace state interactively against a specific mat version + (for connectivity) a specific root.
2. Confirm the mv is in the datastack's LTS marker (add it if not).
3. For explorer: resolve the desired filter scope into an explicit `selection:` list of cell_ids (the LTS guarantee is on cell_ids' persistence; you don't want the example to drift if a column rename invalidates predicate-based scoping).
4. Hand-author the YAML (no UI export today) or download via the connectivity Share menu and add the `summary`/`full_text`/`pinned` block manually.
5. Drop a thumbnail under `_assets/` if you want one.
6. Open a PR; the example surfaces on `/examples` after the next pod restart.

---

## Helper scripts

Both scripts are idempotent: they write to a target path and refuse to overwrite unless you pass `--force`.

### `scripts/scaffold_datastack.py`

Emits a starter `config/datastacks/<ds>.yaml` with every common knob present and commented in. Defaults match the public-release shape (live_mode off, cache aliasing prompt, warmup disabled).

```bash
uv run python scripts/scaffold_datastack.py \
    --datastack my_new_datastack \
    --aligned-volume minnie65_phase3
```

Options:
- `--datastack <name>` (required) — datastack name; used as filename.
- `--aligned-volume <name>` — aligned-volume name (informational; used in a generated comment).
- `--public` / `--internal` — toggles `live_mode` default (`false` for public, `true` for internal).
- `--out <path>` — output path (default: `config/datastacks/<datastack>.yaml`).
- `--force` — overwrite an existing file.

The generated file is a heavily commented skeleton; edit, uncomment, and commit. The script doesn't try to validate against CAVE — there's no auth dependency.

### `scripts/scaffold_feature_explorer.py`

Opens a feature-table parquet, introspects its schema, and walks you through an interactive review (built with `rich`) before emitting a starter manifest. The script validates the output against the Pydantic `Manifest` schema before writing, so an authored manifest is parseable by the running backend by construction.

```bash
# Interactive (recommended) — only the parquet and datastack are required
uv run python scripts/scaffold_feature_explorer.py \
    --parquet path/to/features.parquet \
    --datastack minnie65_public

# Non-interactive — accept all heuristic defaults, no prompts
uv run python scripts/scaffold_feature_explorer.py \
    --parquet path/to/features.parquet \
    --datastack minnie65_public \
    --feature-table-id morpho_v1 \
    --non-interactive --id-column cell_id
```

The interactive flow is six steps:

1. **Feature table identity.** Picks the manifest's `feature_tables[].id` (the stable handle the SPA uses in URLs `?ft=<id>`, recipes, and examples — distinct from datastack name and parquet filename), a human-readable title, and an optional description. The id defaults to a slugified parquet basename and is normalized to lowercase kebab/underscore on submit.
2. **Pick id column.** Candidates (canonical `cell_id`/`id`, then any int column ending in `_id`, then any int column) are shown with dtype + a head sample. Pick by number or by name.
3. **Review column classification.** A `rich` table lists every column with its dtype, auto-detected bucket (feature / categorical / depth / audit / id_like / axis / unclassified), and a head sample. You can reassign any column to any bucket.
4. **Embeddings.** Each auto-detected axis pair is shown; you confirm + pick a `default_color_by` from the categorical columns. You can also add embeddings manually.
5. **Category groups** for the UI channel picker. Define as many as you want; columns are picked by number (with range syntax like `1-5,7,9-12`), bare name, or the special token `all`.
6. **kNN scaling + clip percentiles** for the manifest's `knn:` block. Defaults are `zscore` + `(0.1, 99.9)` clip.

After step 6 the script runs Pydantic validation; on success it writes the YAML and prints a copy-pasteable `feature_explorer:` block for the datastack YAML.

Options:
- `--parquet <path>` (required) — the feature parquet to inspect.
- `--datastack <name>` (required) — the datastack name; used to compute the output path under `CDV_FEATURE_TABLES_BASE_URI/feature_tables/<ds>/`.
- `--feature-table-id <id>` (optional in interactive mode; required with `--non-interactive`) — the per-FT YAML's `id` field. When omitted interactively, the script prompts with a slugified parquet basename as the default.
- `--parquet-uri <uri>` — the URI to embed in `source.uri`. Defaults to `file://<absolute-path>` for local development; pass `gs://...` for production manifests.
- `--id-column <name>` — pre-resolve the id column (skips the prompt).
- `--non-interactive` — accept all heuristic defaults, no prompts. Useful for scripted regeneration. Requires `--feature-table-id` and `--id-column` (or a canonical `cell_id`/`id` column).
- `--force` — overwrite an existing output file.

The classification heuristic uses these rules (reviewable interactively in step 3):

| Column heuristic | Bucket |
|------------------|--------------|
| Named `cell_id` / `id`, integer-typed | `id_column` |
| Other integer columns ending in `_id` | id-like (excluded from features) |
| Numeric, name contains `depth` | **spatial (depth)** — added to `feature_columns`, `spatial_post_columns`, AND `depth_columns` |
| Numeric, name contains `pt_position` (CAVE convention for raw segmentation point) | **spatial (pre)** — added to `feature_columns` and `spatial_pre_columns` (Neuroglancer-space). The only automatic pre-transform signal; other pre-transform columns need to be tagged via the interactive review (Step 3). |
| Numeric, name matches `_dist` / `radial_` / has generic `_x/_y/_z` suffix | **spatial (post)** — added to `feature_columns` and `spatial_post_columns` (biological-space; default for ambiguous spatial-looking columns). Note: `_um` alone isn't a signal — it's a unit suffix that catches non-spatial volume / area columns. |
| Numeric, name contains `_dist` or `radial_` | **spatial** — same as above |
| Pair `<prefix>_x` / `<prefix>_y` where the prefix contains `umap`/`tsne`/`pca`/`phate`/`mds`/`isomap`/`lle` | one `embeddings:` entry with that axis pair (consumed before the spatial check, so embedding axes don't double-classify) |
| Named matching `source[_-]?root` / `source[_-]?mat[_-]?version` | `audit.source_root_column` / `audit.source_mat_version_column` |
| Other numeric | plain `feature` — added to `feature_columns` only |
| Object / string / categorical / bool | `categorical_columns` |

**On the spatial vs feature vs depth model.** `spatial_pre_columns` and `spatial_post_columns` are both tag overlays on `feature_columns` (a spatial column is still a feature — kNN-eligible, range-filterable). Pre-transform = the volume's native frame (used for Neuroglancer linking); post-transform = biological-space (used for analysis). `depth_columns` is a strict subset of `spatial_post_columns` — the *rendering special case* the backend already consumes (axis flip + cortical layer markers). Depth is necessarily post-transform — the cortical axis is what the aligned-volume transform produces. The label `spatial (depth)` in the review table means "this column is in `feature_columns`, `spatial_post_columns`, AND `depth_columns`." Plain `spatial (post)` (no depth) means "in `feature_columns` and `spatial_post_columns`, but the renderer treats it as a normal axis." Plain `spatial (pre)` means "in `feature_columns` and `spatial_pre_columns` — useful for Neuroglancer cross-nav, not for biological analysis." Plain `feature` means "in `feature_columns` only."
