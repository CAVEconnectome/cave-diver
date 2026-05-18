# Configuring a Datastack

Each datastack the SPA exposes is described by a YAML file. This file is
where an operator declares everything that varies between deployments
of the same backend: which materialization modes are exposed, how the
cell-id input wires up, what gets pre-warmed in cache, and the
operator-curated *tours* (examples and recipes) that appear on the
landing page.

This document is the reference for that file. The schema is defined in
`services/datastack_config.py` (`DatastackConfig`); this doc gives you
working YAML to copy from for every field.

For the *aligned-volume* configuration (spatial transform, layer
boundaries, synapse-table conventions shared across all datastacks
mounted on the same volume), see [aligned-volumes.md](./aligned-volumes.md).
The per-datastack `synapse:` block here is a field-level override on
top of that.

## Cluster scoping (which datastacks to include)

The deployment's `CDV_DATASTACKS_ALLOWED` env var (or the
`DATASTACKS_ALLOWED` config default) names the datastacks the SPA's
picker offers. **Each deployment should list only datastacks that live
on its own CAVE cluster.**

Why: CAVE's per-datastack `local_server` field names which cluster
holds the data. A datastack from a different cluster will authenticate
fine against the global auth service, but the materialize /
chunkedgraph / image services it points at belong to a different
ingress — so partner queries land on the wrong cluster, and per-pod
caches, periodic warmer, GCS L2, and per-origin recipe storage all
become misaligned with the data the user actually sees.

Example: a deployment at `cdv.minnie.daf-apis.com` should list
`minnie65_public`, `minnie65_phase3_v1`, etc. — not `fanc_production`,
even though the auth service knows about both. A separate
`cdv.fanc.daf-apis.com` deployment handles the FANC datastacks with
its own allowlist.

The allowlist is a deployment-time decision, not runtime. The app
doesn't introspect `local_server` to filter at runtime; it trusts the
operator's curation. If catching a mis-cluster'd allowlist entry at
deploy time becomes a real concern, `cdv-check-config` could grow that
check (fetch each allowed datastack's info, compare `local_server`
against an expected value, fail on mismatch).

## Where the YAML lives

The loader checks three locations (last wins on conflict):

1. **Repo root** — `config/datastacks/<datastack>.yaml`. The bundled
   defaults that ship with the source tree and (via hatchling
   `force-include`) inside the wheel.
2. **In-wheel copy** — `cave_data_viewer/_bundled_config/datastacks/<datastack>.yaml`.
   Same content as the repo-root location; resolved this way for
   pure-wheel installs where the source tree isn't on disk.
3. **Operator override** — `$CDV_DATASTACK_CONFIG_DIR/<datastack>.yaml`,
   if the env var is set. Wins over both bundled locations, so a
   deployment can ship its own datastack configs without forking the
   package (typical Docker/K8s setup: bind-mount a ConfigMap onto
   `/etc/cdv/datastacks` — the default `CDV_DATASTACK_CONFIG_DIR`
   inside the published image).

Cache is keyed on the mtimes of all candidate paths, so editing any of
them in dev invalidates the entry on the next request — no server
restart.

A datastack with no YAML in any location falls back to schema defaults:
`live_mode: true`, no cell-id lookup, no synapse override (inherits
aligned-volume), no warming, no tours. That's a usable but bare-bones
configuration; the SPA loads, the partners table works, but the
landing page is empty and the cell-id input is hidden.

## Top-level structure

| Key | Type | Default | Required? | Notes |
| --- | --- | --- | --- | --- |
| `live_mode` | `bool` | `true` | optional | Whether the SPA's version picker offers "live" alongside the integer mat versions. Set `false` for release datastacks where only the published versions are meaningful. |
| `synapse` | `SynapseConfig?` | `null` (inherits) | optional | Field-level override on top of the aligned-volume's `synapse:` block. Omit entirely to inherit; set individual fields to override only those. |
| `cell_id_lookup` | `CellIdLookup?` | `null` | optional | Discriminated block (`kind: view\|table`, `name: <resource>`) naming a CAVE resource that maps cell_id → root_id. Forward direction of the cell-id ↔ root_id lookup. |
| `root_id_lookup_main_table` | `string?` | `null` | optional | Primary annotation table for the reverse direction (root_id → cell_id). |
| `root_id_lookup_alt_tables` | `[string]` | `[]` | optional | Additional annotation tables walked after the main table for the reverse lookup, typically for cells whose primary annotation has been split or merged out. |
| `decoration_warmup` | `DecorationWarmup?` | `null` (off) | optional | Periodic background refresh of decoration tables. K8s/HPA users probably want this on; dev users almost never. |
| `feature_explorer` | `FeatureExplorerConfig?` | `null` | optional | Enables /explore for this datastack. Block contains `enabled: bool` + optional `cell_id_source_table: string?`. The embedding catalog directory is computed from `CDV_FEATURE_TABLES_BASE_URI` + the datastack name — no per-datastack manifest URI to configure. |
| `examples` | `[Example]` | `[]` | optional | Fully-specified workspace states for the landing page. Click *Open* to land on the configured workspace. |
| `recipes` | `[Recipe]` | `[]` | optional | Configuration overlays for the landing page. Click *Apply* to merge the recipe into the user's current cell. |

Nothing in this list is *required* — a strictly empty YAML is valid.
The fields you should think hardest about are `live_mode` (releases
should set it `false`) and the cell-id lookup trio (the SPA hides the
cell-id input without them).

## YAML conventions used throughout this doc

Before getting into the per-field reference, a few patterns appear over
and over and are worth pinning down:

**Lists.** YAML's two list forms are equivalent. Use the block form for
anything more than two short entries:

```yaml
# Block form — preferred for readability with longer entries.
root_id_lookup_alt_tables:
  - nucleus_alternative_points
  - nucleus_legacy_points

# Flow form — fine for short, simple lists.
decoration_tables: [aibs_metamodel_celltypes_v661, proofreading_status_and_strategy]
```

**Optional fields and inheritance.** Omitting a key entirely is
*different* from setting it to `null`. Pydantic treats absent fields as
"use default", which for inheriting fields means "fall through to the
aligned-volume value." Setting a field to `null` (`~` or empty in YAML)
explicitly clears it. The practical difference shows up most often in
the `synapse:` override:

```yaml
# Inherits ALL synapse settings from the aligned_volume YAML.
# (don't include a `synapse:` block at all)

# Inherits position_prefix and aggregation_rules; clears the
# columns projection — equivalent to "select every synapse column".
synapse:
  columns: ~

# Overrides only position_prefix. columns and aggregation_rules
# inherit from the aligned_volume.
synapse:
  position_prefix: anchor_pt
```

**Multi-line strings.** `description` fields (on tours, recipes, and
examples) accept YAML's folded-block scalar — the `>` syntax — which
joins the indented lines into one space-separated line, preserving
paragraph breaks where you leave a blank line:

```yaml
description: >
  Loads the Allen cell-type table plus the synapse-depth-profile and a
  partner-soma-depth histogram. Apply on any neuron to see its
  layered partner distribution.
```

**Comments.** YAML comments (`#`) are stripped at load time and don't
reach the SPA. Use them liberally to document operator decisions ("we
warm aibs_metamodel_celltypes_v661 because it's loaded by every tour").

**Stringified int64s.** Anywhere a root_id appears (only in `examples`
right now), wrap it in quotes — `"864691135571440006"`. Root ids
exceed JS Number precision (2⁵³) and the API serializes them as
strings; YAML without quotes parses to a Python int but the SPA's
TanStack Query never compares the two so the round-trip is silently
lossy without quoting.

---

## `live_mode` — exposing live queries

```yaml
live_mode: true   # default
```

Type: `bool`. Default: `true`.

Whether the SPA's version picker shows a "live" entry alongside the
integer materialization versions. CAVE always *can* serve live queries
against any datastack — `live_mode` is purely a UX gate.

**Set `false` on release datastacks.** Public/release datastacks
publish a finite set of mat versions; the live segmentation is what
the proofreading team is currently working on, which can drift from
what's officially documented. Surfacing "live" misleads users into
thinking it's a sanctioned mode for the dataset.

**Set `true` (or omit) on working/internal datastacks.** Proofreading
lands continuously and the working frontend wants the latest
segmentation, not a frozen snapshot.

Examples in `examples:` must always pin an integer `mat_version` —
"live" is rejected at YAML-load even when `live_mode: true`. Curated
tours pinned to live would drift, defeating the purpose.

---

## `synapse` — per-datastack synapse-table override

```yaml
synapse:
  position_prefix: ctr_pt
  columns:
    - id
    - pre_pt_root_id
    - post_pt_root_id
    - size
    - ctr_pt_position
  aggregation_rules:
    mean_size:
      column: size
      agg: mean
```

Type: `SynapseConfig?`. Default: `null` (inherit everything from the
aligned-volume YAML).

Schema is identical to the aligned-volume `synapse:` block — see
[aligned-volumes.md](./aligned-volumes.md#synapse-fields) for the full
field reference. The merge is *field-level*: any field set here wins;
any field omitted inherits.

**When to override.** Three common cases:

1. **The volume has no aligned-volume YAML.** Without it, the
   schema-level defaults apply (minimal columns, no aggregation rules)
   and the partner table loses informative columns like `mean_size`.
   `brain_and_nerve_cord.yaml` does this — it ships the synapse block
   inline because the BANC volume isn't characterized.
2. **One datastack on a shared volume needs a tweak.** A datastack
   that wants to add an extra aggregation rule without disturbing
   sibling datastacks on the same volume. Override only the
   `aggregation_rules` field; everything else inherits.
3. **Experimenting with column projections.** Setting `columns: ~`
   pulls every synapse column for ad-hoc exploration. Don't ship this
   — the synapse cache footprint balloons and the partner table gets
   noisy.

**Override examples.**

```yaml
# Override only the position prefix; everything else inherits.
synapse:
  position_prefix: anchor_pt

# Add an aggregation rule on top of the aligned-volume's defaults.
# WARNING: this REPLACES the aggregation_rules dict — it doesn't merge
# entry-by-entry. To preserve the aligned-volume's mean_size + net_size
# while adding a new rule, restate the existing entries here.
synapse:
  aggregation_rules:
    mean_size: { column: size, agg: mean }
    net_size:  { column: size, agg: sum }
    median_size: { column: size, agg: median }   # new

# Project a non-default set of columns, with an aggregation rule that
# references a column not in the default projection. The query layer
# auto-extends `columns` to include any column referenced by an
# aggregation rule, so you don't have to mirror it in `columns`.
synapse:
  columns: [id, pre_pt_root_id, post_pt_root_id, ctr_pt_position]
  aggregation_rules:
    classifier_score_max:
      column: classifier_score
      agg: max
```

The dict-vs-dict merge gotcha bears repeating: `aggregation_rules` is
treated as a single value. If you set it on the datastack, the
aligned-volume's rules are dropped — restate everything you want to
keep.

---

## Cell-id lookup

```yaml
cell_id_lookup:
  kind: view
  name: nucleus_detection_lookup_v1
root_id_lookup_main_table: nucleus_detection_v0
root_id_lookup_alt_tables:
  - nucleus_alternative_points
```

Three related fields. All are optional, all default to null/empty. The
SPA hides the cell-id input box entirely when both `cell_id_lookup`
and `root_id_lookup_main_table` are absent — so a datastack with no
cell-id concept (BANC currently) just omits the whole block.

**The two directions.** Cell ids (typically nucleus-table ids) are
persistent across proofreading splits/merges; root ids are not. The
forward direction (cell_id → current root_id) reads from a CAVE
resource — either a materialized **view** or an annotation **table**.
The reverse direction (root_id → cell_id) walks one or more annotation
tables (no view counterpart in this codebase).

| Field | Type | Direction | Required for that direction |
| --- | --- | --- | --- |
| `cell_id_lookup` | `{kind: view\|table, name: string}?` | cell_id → root_id | Yes — names the CAVE resource that answers the forward direction. `kind` picks `query_view` vs `query_table` at the API layer. |
| `root_id_lookup_main_table` | `string?` | root_id → cell_id (primary) | Yes — primary table for the reverse lookup. |
| `root_id_lookup_alt_tables` | `[string]` | root_id → cell_id (fallback) | No — searched after the main table for cells whose primary annotation has been split or merged out. |

**Why a block instead of two top-level fields.** Carrying `kind` and
`name` as one block means Pydantic structurally enforces "both present
or neither" — there's no way to set just one. The previous shape
(separate `cell_id_lookup_view` / `cell_id_lookup_table` XOR fields)
let copy-paste edits land in the wrong field and silently mis-dispatch.

**The view is not the same as the main table.** They typically share a
prefix (`nucleus_detection_v0` and `nucleus_detection_lookup_v1`) but
the view is a materialized join that includes the supervoxel_id column,
which is what makes live-mode lookups work without a chunkedgraph
round-trip on every request.

**Alt tables matter at scale.** A working dataset accumulates cells
whose original nucleus has been split into two via proofreading; one
of the resulting cells inherits the original cell_id, the other gets a
new entry in an `nucleus_alternative_points` table. Without the alt
table, root_ids on the split-off cells fail to look up.

**Asymmetric configurations are valid but unusual.** A datastack that
publishes only the forward direction (no reverse lookup):

```yaml
cell_id_lookup:
  kind: view
  name: nucleus_detection_lookup_v1
# no root_id_lookup_main_table — reverse lookups return "not found"
# but the SPA still shows the cell-id input.
```

The SPA shows the input as long as *either* field is set. The reverse
direction silently no-ops on a root_id with no annotation. You'd
prefer this when a dataset's reverse-lookup table isn't yet
materialized but the forward view is.

---

## `decoration_warmup` — periodic background refresh

```yaml
decoration_warmup:
  enabled: false              # OFF by default
  cell_type_tables:
    - aibs_metamodel_celltypes_v661
  warm_soma_table: true
  interval_seconds: 3600      # one hour
  startup_delay_seconds: 180  # three minutes
```

Type: `DecorationWarmup?`. Default: `null` (off).

Schedules a background job per registered table that re-fetches
`(datastack, latest_valid_mat_version, table)` on a fixed interval and
writes the result into the SwrCache. Without warming, the first user
to ask for a decoration table after server start (or after a cache
expiry) waits for the cold fetch — for a 50k-row cell-type table on a
slow link that's tens of seconds. With warming, the cache is always
fresh by the time anyone asks.

**When to enable.**

- Production / autoscaled deployments — yes, almost always. Combined
  with a sticky-session ingress, warming smooths the user-facing
  latency curve.
- Dev / single-user — almost never. The dev workflow doesn't justify a
  background CAVE round-trip every hour, and the cold-fetch latency
  is a development feedback signal you usually want to see.

**Field reference.**

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | `bool` | `false` | Master switch. The other fields are read regardless but no jobs are registered while this is `false`. |
| `cell_type_tables` | `[string]` | `[]` | Decoration tables to warm. Anything here gets a fresh fetch on every interval. |
| `warm_soma_table` | `bool` | `false` | Also warm the datastack's default soma table (resolved from `client.info.get_datastack_info()['soma_table']`). |
| `interval_seconds` | `float` | `3600.0` | Refresh cadence. One hour is reasonable; shorter gets diminishing returns since CAVE materializations don't update that fast. |
| `startup_delay_seconds` | `float` | `0.0` | Defer the first run after pod boot. Critical for HPA-scaled deployments — without it, a scale-up burst means N new pods all hit CAVE simultaneously the moment they come up. Set to a few minutes (jittered up to +60s automatically). |

**Auth.** The warmer needs CAVE credentials to run. In production set
`CDV_WARMUP_AUTH_TOKEN` to a CAVE service token; locally CAVEclient
falls back to `~/.cloudvolume/secrets/cave-secret.json`. The warmer
runs without a request context, so the per-request `flask.g.auth_token`
isn't available.

**Live-mode datastacks aren't warmed.** Live queries don't have a
stable cache key (they're keyed on the request timestamp), so warming
them would just burn CAVE round-trips that nothing reads. The warmer
silently skips datastacks where the resolved-latest is "live."

**Warming examples.**

```yaml
# Production cortex datastack with three decoration tables and the
# default soma table. Three-minute startup delay for HPA safety.
decoration_warmup:
  enabled: true
  cell_type_tables:
    - aibs_metamodel_celltypes_v661
    - cell_type_multifeature_combo
    - allen_v1_column_types_v2
  warm_soma_table: true
  interval_seconds: 3600
  startup_delay_seconds: 180

# Empty cell_type_tables but warm_soma_table on — warms only the
# default soma table on the configured cadence.
decoration_warmup:
  enabled: true
  warm_soma_table: true
  interval_seconds: 7200

# Configured-but-disabled. Useful as documentation of intent: "this
# is what we'd warm if we turned warming on." Flip enabled: true to
# activate.
decoration_warmup:
  enabled: false
  cell_type_tables:
    - aibs_metamodel_celltypes_v661
```

---

## Operator-curated tours: `examples` and `recipes`

Operator-curated *tours* let you ship pre-baked workspace
configurations with each datastack. Tours appear on the landing page
(`/`) when the SPA loads. There are two flavors:

- **Examples** — fully-specified workspaces. Pin a `mat_version`, a `root`
  id, decoration tables, plots, filters. Click *Open* to land on a
  configured workspace looking at a real neuron. Use these to demonstrate
  end-to-end workflows on a known interesting cell.
- **Recipes** — configuration overlays. Decorations + plots + filters,
  *no* `mat_version` or `root`. Click *Apply* in the sidebar (or on a
  Recipe card) to overlay onto whatever cell the user has loaded. Use
  these to bottle up "the way I always look at a cell."

The SPA fetches tours from `GET /api/v1/datastacks/<ds>/tours` and mints
URLs client-side, so the YAML is the single source of truth — no separate
URL string to maintain.

### Field reference

Common fields (both `Example` and `Recipe`):

| Field | Type | Notes |
| --- | --- | --- |
| `id` | `string` | Stable; used as the React key. **Must be unique within the datastack** (Examples and Recipes share an id namespace — duplicates fail at YAML-load time). |
| `title` | `string` | Card heading. Keep it scannable. |
| `description` | `string?` | One paragraph. Renders under the title; supports YAML block-folding (`>`) for readable multi-line text. |
| `decoration_tables` | `[string]` | CAVE table names that get joined into the partner view. Same list the SPA writes to `?dec=`. |
| `plots` | `[TourPlot]` | List of analytics-rail panels. See *Plot entries* below. |
| `cells` | `string?` | Raw `?cells=` filter expression. Shape: `<table>.<col>:<op>:<val>[,...]`. Same parser as the workspace's cell-filter panel. |
| `hide` | `[string]` | Column names to hide by default in the partners table. |
| `show` | `[string]` | Column names to force-show (overrides default-hidden columns). |
| `coll` | `[string]` | Column-group names to render collapsed. |

Examples additionally require:

| Field | Type | Notes |
| --- | --- | --- |
| `mat_version` | `int` | Materialization version. Integer only — `"live"` is not allowed for curated tours (it would drift). |
| `root` | `string` | Stringified int64 root id. Always quote it in YAML — int64 root ids exceed JS Number precision. If proofreading edits the cell, the existing stale-root translation flow translates to the current root and surfaces a banner; you don't need to update the YAML. |

### Plot entries (`TourPlot`)

Each entry is one panel in the analytics rail. Three flavors, mutually
exclusive:

```yaml
# 1. Summary panel — reads directly from the connectivity bundle.
- id: depth-profile                  # author-facing label only
  summary_kind: synapse_depth_profile

# 2. Bindings panel — fully configured analytic plot.
#    `x` references a decoration-table column (qualified `table.column`);
#    `weight` references a bundle column (`n_syn_out`, bare).
- id: ct-by-out
  bindings:
    x: "aibs_metamodel_celltypes_v661.cell_type"
    weight: n_syn_out

# 3. Blank panel — neither set; renders an empty editor for the user to configure.
- id: scratch

# 4. Any of the above with the global `cells:` filter disabled for this panel.
- id: ct-overview-all
  bindings:
    x: "aibs_metamodel_celltypes_v661.cell_type"
    weight: n_syn_out
  unfiltered: true                   # opts out of the recipe's cells: filter
```

The `id` on a plot entry is for *YAML readability* only. The SPA mints
fresh panel ids on apply (`dyn-<rand>` for bindings, `sum-<kind>-<rand>`
for summaries) so opening the same tour twice doesn't collide on URL keys.

`unfiltered: true` opts the panel out of the tour's `cells:` filter (see
*Cell-filter syntax* below). Use this when shipping a recipe that compares
a filtered population against an unfiltered reference — e.g. "show me
cell-type breakdown of confident-axon partners alongside the same chart
for all partners." The opt-out is per-panel; mix freely with filtered
panels in the same `plots:` list.

`bindings` fields mirror the SPA's `PlotBindings` shape (see
`frontend/src/api/queries.ts`). Common keys:

| Key | Purpose |
| --- | --- |
| `x`, `y` | Axis bindings. 1 axis → histogram, 2 axes → scatter. |
| `weight` | Numeric column to sum on bar plots (replaces implicit row count). Use when `x` is categorical. |
| `hue` | Categorical column for color encoding. |
| `size` | Numeric column for marker-size encoding (scatter only). |
| `scope` | `input`, `output`, `both`, or `reciprocal`. Panel-level direction filter applied to every channel. `reciprocal` is the strict both-directions intersection. |
| `show_cell_depth` | Default ON for depth-axis plots. Set to `false` to suppress the focal cell's depth marker. |

#### Column naming in bindings

Two conventions, depending on where the column comes from:

- **Decoration-table columns must be qualified** as `<table>.<column>`,
  and `<table>` must appear in the same tour's `decoration_tables`
  list. A bare `cell_type` won't resolve — it's ambiguous which table
  to pull from, and the partner table can carry the same column from
  multiple decoration tables joined onto the same query.
- **Built-in connectivity-bundle columns stay bare.** These are the
  columns the connectivity service emits for every partner regardless
  of decoration: `n_syn_in`, `n_syn_out`, `net_size_in`, `net_size_out`,
  `mean_size_in`, `mean_size_out` (and any other aggregation rule
  declared on the synapse config), plus the spatial features
  `soma_depth`, `soma_x`, `soma_z`, `radial_dist_root_soma`,
  `median_dist_to_target_soma`, `median_syn_depth_in`,
  `median_syn_depth_out` (when the aligned-volume has a `transform`).

Quoting the dotted form is optional in YAML but recommended for
readability — it visually distinguishes the qualified columns from
the bare ones at a glance:

```yaml
bindings:
  x: "aibs_metamodel_celltypes_v661.cell_type"   # decoration: qualified
  weight: n_syn_out                              # bundle: bare
  hue: "aibs_metamodel_celltypes_v661.cell_type" # decoration: qualified
```

#### Direction handling: input vs output

There are two distinct mechanisms for restricting a plot to input
partners (presynaptic to the focal cell) or output partners
(postsynaptic to it), depending on whether the column carries
direction in its name.

**Direction-encoded columns** carry the direction in the column name
itself — pick the column you want, no `*_scope` needed. These are the
bundle columns suffixed `_in` or `_out`:

| Pair | Meaning |
| --- | --- |
| `n_syn_in` / `n_syn_out` | synapse counts |
| `net_size_in` / `net_size_out` | summed synapse size |
| `mean_size_in` / `mean_size_out` | mean synapse size |
| `median_syn_depth_in` / `median_syn_depth_out` | median synapse-position depth |

Plus any custom aggregation rule from the synapse config, which gets
the same `_in` / `_out` suffix treatment automatically.

**Direction-agnostic columns** are properties of the partner itself —
the value doesn't change with synapse direction. To restrict the plot
to inputs or outputs, set the panel-level `scope`:

| `scope` | Keeps rows where | Means |
| --- | --- | --- |
| `input` | `n_syn_in > 0` | input partners (loose; includes reciprocal) |
| `output` | `n_syn_out > 0` | output partners (loose; includes reciprocal) |
| `reciprocal` | `n_syn_in > 0 AND n_syn_out > 0` | strict both-directions only |
| `both` | always | every partner (default; can omit) |

Direction-agnostic columns include the partner's spatial features
(`soma_depth`, `soma_x`, `soma_z`, `radial_dist_root_soma`,
`median_dist_to_target_soma`) and every decoration-table column
(`cell_type`, etc.).

```yaml
# Histogram: soma depths of partners we receive INPUT from
bindings:
  x: soma_depth
  scope: input

# Histogram: soma depths of partners we send OUTPUT to
bindings:
  x: soma_depth
  scope: output

# Reciprocal-partners-only scatter — partner soma depth on x, partner's
# median output-synapse depth on y, restricted to partners with edges
# in both directions:
bindings:
  x: soma_depth                  # bundle, direction-agnostic
  y: median_syn_depth_out        # bundle, direction-encoded
  scope: reciprocal              # both directions present per row
```

`scope: reciprocal` is what makes the *Both* tab useful for
reciprocal-pair analysis. Under `scope: both` the same panel can split
direction visually instead by binding `hue: direction` — a synthetic
column on the unified frame whose values are `in only` / `out only` /
`reciprocal`.

`summary_kind` accepts the values declared in
`frontend/src/plots/presets.ts::SummaryKind`. Currently the only summary
kind is `synapse_depth_profile`.

### Simple tour examples

#### A minimal Example

Anchor users on a known interesting cell. No filters, no plots — just
opens the workspace looking at this neuron with one decoration table.

```yaml
examples:
  - id: starter-pyr
    title: "L2/3 pyramidal — starter cell"
    description: A canonical L2/3 excitatory cell with cell types loaded.
    mat_version: 1078
    root: "864691135571440006"
    decoration_tables:
      - aibs_metamodel_celltypes_v661
```

#### A minimal Recipe

Bottle up "show me partner cell types as a bar chart." Apply on any cell.

```yaml
recipes:
  - id: ct-overview
    title: "Cell-type overview"
    description: Partner counts grouped by Allen cell type.
    decoration_tables:
      - aibs_metamodel_celltypes_v661
    plots:
      - id: ct-out
        bindings:
          x: "aibs_metamodel_celltypes_v661.cell_type"
          weight: n_syn_out
```

#### Just a depth profile

The simplest summary plot — one panel, no decorations, no bindings.

```yaml
recipes:
  - id: depth-profile-only
    title: "Just the synapse depth profile"
    plots:
      - id: depth
        summary_kind: synapse_depth_profile
```

### Complex tour examples

#### A reciprocal-partner deep-dive Example

Demonstrates the *Both* tab's reciprocal-pair workflow. Loads at a
specific materialization, filters partners by direction, hides the
default proofreading columns, and ships a depth-vs-soma scatter colored
by cell type.

```yaml
examples:
  - id: reciprocal-pyr-deep-dive
    title: "L2/3 pyr — reciprocal pairs by depth"
    description: >
      A canonical L2/3 cell, partners filtered to those with both
      input AND output edges (i.e. reciprocal pairs). Scatter shows
      partner soma depth vs. median output-synapse depth, colored by
      Allen cell type. Useful for asking "which reciprocal partners
      target which depths."
    mat_version: 1078
    root: "864691135571440006"
    decoration_tables:
      - aibs_metamodel_celltypes_v661
      - proofreading_status_and_strategy
    plots:
      - id: depth-profile
        summary_kind: synapse_depth_profile
      - id: scatter-recip
        bindings:
          x: soma_depth                                           # bundle column: bare
          y: median_syn_depth_out                                 # bundle column: bare
          hue: "aibs_metamodel_celltypes_v661.cell_type"          # decoration column: qualified
          size: net_size_out                                      # bundle column: bare
          scope: reciprocal  # restrict to partners with edges in both directions
      - id: ct-bar-recip
        bindings:
          x: "aibs_metamodel_celltypes_v661.cell_type"
          weight: n_syn_out
          # scope omitted → defaults to `both` (every partner)
    # Filter the partners table to confident proofread axons only.
    cells: "proofreading_status_and_strategy.status_axon:eq:t"
    # Hide the proofreading admin columns once the filter has done its job —
    # they're noise in the table view.
    hide:
      - "proofreading_status_and_strategy.valid_id"
      - "proofreading_status_and_strategy.status_dendrite"
    coll:
      - "proofreading_status_and_strategy"
```

#### A Recipe with mixed filtered + unfiltered panels

Demonstrates per-panel filter opt-out: the same cell-type bar chart twice,
once across confident-cell-type partners (filter applied) and once across
all partners (filter ignored). Useful for "is this filtered subset
representative of the whole population?" questions.

```yaml
recipes:
  - id: confident-vs-all-comparison
    title: "Confident vs. all-partner comparison"
    description: >
      Side-by-side bar charts of partner cell types — top panel
      thresholds the multifeature classifier confidence at 0.8, bottom
      panel shows the same chart over every partner. Quick visual check
      for selection bias from the confidence threshold.
    decoration_tables:
      - cell_type_multifeature_combo
    plots:
      - id: ct-confident
        bindings:
          x: cell_type_multifeature_combo.cell_type
          weight: n_syn_out
        # Inherits the recipe's cells: filter below.
      - id: ct-all
        bindings:
          x: cell_type_multifeature_combo.cell_type
          weight: n_syn_out
        unfiltered: true            # opts out — same chart, no filter
    cells: "cell_type_multifeature_combo.classification_score:gte:0.8"
```

#### A multi-table Recipe with a cell filter

Three cell-type tables, a filter that thresholds confidence on one of
them, and three coordinated plots for the same partner population.

```yaml
recipes:
  - id: confident-ct-stratification
    title: "Confident cell-type stratification"
    description: >
      Shows depth-stratified partner distributions, but only across
      partners whose cell-type call has score ≥ 0.8 in the multifeature
      classifier. Loads three cell-type tables so you can compare them
      side-by-side in the Cell tab.
    decoration_tables:
      - aibs_metamodel_celltypes_v661
      - cell_type_multifeature_combo
      - allen_v1_column_types_v2
    plots:
      - id: depth-profile
        summary_kind: synapse_depth_profile
      - id: depth-by-ct
        bindings:
          x: soma_depth
          y: median_syn_depth_out
          hue: cell_type_multifeature_combo.cell_type
      - id: ct-bar
        bindings:
          x: cell_type_multifeature_combo.cell_type
          weight: n_syn_out
    cells: "cell_type_multifeature_combo.classification_score:gte:0.8"
```

#### Multiple Examples + Recipes side by side

A complete `examples` + `recipes` block as it would land in
`minnie65_public.yaml`:

```yaml
examples:
  - id: l23-pyr-deep-dive
    title: "L2/3 pyramidal — depth + cell-type deep dive"
    mat_version: 1078
    root: "864691135571440006"
    decoration_tables: [aibs_metamodel_celltypes_v661]
    plots:
      - id: depth-profile
        summary_kind: synapse_depth_profile
      - id: ct-by-out
        bindings: {x: "aibs_metamodel_celltypes_v661.cell_type", weight: n_syn_out}

  - id: martinotti-cell
    title: "Martinotti cell — long-range output"
    mat_version: 1078
    root: "864691135123456789"
    decoration_tables: [aibs_metamodel_celltypes_v661]
    plots:
      - id: scatter-pos
        bindings: {x: soma_x, y: soma_z, hue: "aibs_metamodel_celltypes_v661.cell_type"}

recipes:
  - id: depth-stratification
    title: "Depth stratification"
    decoration_tables: [aibs_metamodel_celltypes_v661]
    plots:
      - id: depth-profile
        summary_kind: synapse_depth_profile
      - id: soma-depth-hist
        bindings: {x: soma_depth}

  - id: ct-overview
    title: "Cell-type overview"
    decoration_tables: [aibs_metamodel_celltypes_v661]
    plots:
      - id: ct-out
        bindings: {x: "aibs_metamodel_celltypes_v661.cell_type", weight: n_syn_out}
      - id: ct-in
        bindings: {x: "aibs_metamodel_celltypes_v661.cell_type", weight: n_syn_in}
```

### Cell-filter syntax (`cells:`)

The `cells` field is the raw URL value of `?cells=`. Shape:

```
<table>.<column>:<op>:<value>[,<table>.<column>:<op>:<value>,...]
```

Common operators (full list in
`api/services/plots.py::_parse_cells_param`):

| Op | Meaning | Example |
| --- | --- | --- |
| `eq` | Equal | `cell_type:eq:6P-IT` |
| `neq` | Not equal | `cell_type:neq:Unsure` |
| `in` | One of `\|`-separated values | `cell_type:in:6P-IT\|6P-CT` |
| `gte`, `lte`, `gt`, `lt` | Numeric thresholds | `classification_score:gte:0.8` |
| `notnull` | Field is set | `cell_type:notnull:` |

Multiple clauses are AND-combined. Decoration tables referenced by a
filter are auto-extended onto the request, so you don't have to mirror
them in `decoration_tables` — but it's good practice to list them
anyway, since the SPA also uses `decoration_tables` to drive the
partners-table column groups.

### Hidden columns (`hide`, `show`, `coll`)

These map directly to the SPA's `?hide=`, `?show=`, `?coll=` URL keys.
They're authored as YAML lists; the SPA joins them with commas when
minting the URL.

- `hide` — column names that start hidden. Useful for noisy admin
  columns from a decoration table you only loaded for filtering
  purposes.
- `show` — column names that override the default-hidden behavior.
  Mainly used for the directional aggregation columns on the *Both*
  partner tab (`n_syn_in`, `n_syn_out`, etc.) when the recipe wants
  them visible without the user having to flip them on.
- `coll` — column-group *names* (not column names) to render
  collapsed. The collapsed state is a presentation default; the user
  can still expand a group to access its columns.

For dotted column names from decoration tables, use the full dotted
form (`<table>.<column>`):

```yaml
hide:
  - proofreading_status_and_strategy.valid_id
  - proofreading_status_and_strategy.status_dendrite
```

---

## A complete worked example

A realistic public-release datastack that exercises every top-level
key:

```yaml
# Release datastack — only published mat versions are meaningful.
live_mode: false

# Cell-id lookup (forward + reverse).
cell_id_lookup:
  kind: view
  name: nucleus_detection_lookup_v1
root_id_lookup_main_table: nucleus_detection_v0
root_id_lookup_alt_tables:
  - nucleus_alternative_points

# No `synapse:` block — inherits everything from the aligned-volume
# YAML at config/aligned_volumes/minnie65_phase3.yaml.

# Production warming: refresh three decoration tables and the soma
# table once an hour, with a three-minute startup delay so HPA-driven
# scale-up doesn't hammer CAVE.
decoration_warmup:
  enabled: true
  cell_type_tables:
    - aibs_metamodel_celltypes_v661
    - cell_type_multifeature_combo
  warm_soma_table: true
  interval_seconds: 3600
  startup_delay_seconds: 180

# One example to anchor first-time users; one recipe for ongoing use.
examples:
  - id: l23-pyr-deep-dive
    title: "L2/3 pyramidal — depth + cell-type deep dive"
    description: >
      A canonical L2/3 excitatory cell with cortical-depth and
      cell-type decorations loaded.
    mat_version: 1078
    root: "864691135571440006"
    decoration_tables: [aibs_metamodel_celltypes_v661]
    plots:
      - id: depth-profile
        summary_kind: synapse_depth_profile
      - id: ct-by-out
        bindings: {x: "aibs_metamodel_celltypes_v661.cell_type", weight: n_syn_out}

recipes:
  - id: depth-stratification
    title: "Depth stratification starter"
    description: >
      Loads the Allen cell-type table plus the synapse-depth-profile
      and a partner-soma-depth histogram.
    decoration_tables: [aibs_metamodel_celltypes_v661]
    plots:
      - id: depth-profile
        summary_kind: synapse_depth_profile
      - id: soma-depth-hist
        bindings: {x: soma_depth}
```

---

## Validation and operational notes

- **The hot-reload cache works for every field, not just tours.** The
  loader is keyed on YAML mtime, so editing `<datastack>.yaml` in dev
  invalidates the cache on the next request. No server restart needed.
  This applies to all top-level keys: live_mode flips, warmer
  reconfiguration, tour edits, the lot.
- **Tour ids must be unique within a datastack.** Examples and recipes
  share the namespace because they render side-by-side on the landing
  page. A duplicate raises `ValueError` at YAML-load time, which surfaces
  as an HTTP 500 the first time anyone hits a `/datastacks/<ds>/*` route.
  Catch this in CI by exercising the tours endpoint on each shipped
  datastack.
- **Pydantic validates the schema; CAVE state is NOT checked.** Typos in
  decoration table names, plot bindings, filter expressions, or the
  cell-id lookup table names don't fail at YAML-load — they surface
  when the SPA actually issues the query. Test against a real
  datastack before shipping, and watch the request log for 422s on
  the `/connectivity` endpoint.
- **Warmer changes need a process restart.** The hot-reload mtime
  detection invalidates the *config cache*, but the warmer has
  already been registered against the scheduler when the app booted.
  Re-registering on the fly is not implemented; if you flip
  `decoration_warmup.enabled` or change the interval, restart the
  process.
- **Stale-root handling is automatic.** If an Example's `root` is no
  longer current at its `mat_version`, the existing stale-root
  translation flow (`chunkedgraph.suggest_latest_roots` →
  `root_id_updated` on the bundle → `.root-swap-notice` banner)
  takes over. You don't need to chase the YAML on every proofreading
  edit, but a tour pinned to a long-deleted root will eventually fail
  to translate and should be retired.
- **`live_mode: false` datastacks can still ship examples**, but the
  example must pin an integer `mat_version` (the schema enforces
  this). The SPA's "live" picker is unaffected — examples are
  navigation entries, not picker state.
- **An empty cell-id-lookup configuration is silently valid.** The
  SPA hides the input when both forward and reverse are absent;
  there's no warning, no error, no log line. If you expect cell-id
  lookup to work and it doesn't, check this block first.
