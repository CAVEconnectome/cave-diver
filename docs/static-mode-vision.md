# Static deployments and the team-exploration vision

## What this is

A strategy sketch — *not* an implementation plan. The point is to name the
shape of the tool that falls out when four threads of cave-data-viewer's
current trajectory are taken together:

1. **Feature Explorer** — per-cell properties (morphology, predicted class,
   embeddings) keyed on stable `cell_id`, browsable as scatter + filter +
   kNN + saved sets ([[feature-explorer-v1-status]]).
2. **Multi-dataset embeddings** — joint UMAPs across datastacks; per-row
   `source_ds` tag; cross-nav routes each row to its home dataset
   (`docs/multi-dataset-plan.md`).
3. **CAVE-optional deployments** — feature parquets, decoration snapshots,
   and a frozen `cell_id ↔ root_id` lookup all live in GCS; the backend
   never constructs a `CAVEclient`.
4. **Project, not datastack, as the unit of deployment** — the top-level
   entity the viewer renders is a *project*: a named, published thing with
   a display name, a set of declared tool capabilities, and one or more
   underlying data bindings (CAVE-live, CAVE-snapshot, or a future
   non-CAVE source). Today's datastacks become one-binding projects under
   this model; the naming is honest about what's a workspace concern and
   what's a data-source concern.

Take all three together and the result isn't "the same tool, made more
flexible." It's a different tool. The closest analogues in the broader
single-cell ecosystem don't quite occupy this niche:

- **cellxgene** is the obvious reference shape — static-deployable, browser-
  native, URL-stateful — but it's gene-expression-centric and doesn't model
  connectomic primitives (synapses, morphology, depth stratification) or
  the proofreading-survives identity problem.
- **scvi-tools** does joint latent spaces across datasets, but it's a Python
  library for model authors, not an exploration tool for biologists.
- **FlyWire Codex** and **MICrONS Explorer** are bespoke per-volume dashboards
  with curated views, not a generic per-cell feature surface.
- **Neuroglancer** views image + segmentation, not per-cell features.

What's missing from that landscape: **a static-deployable, multi-dataset,
connectomics-native cell explorer with team-shareable URL state and the
hooks to host connectivity overlays in feature space.** That's the tool
cave-data-viewer is converging toward.

## Why CAVE-optional matters

A connectome's interesting moments are mostly published snapshots — a paper,
a release, a frozen mat_version. Forcing every reader to authenticate
against CAVE to browse a paper's data is friction. CAVE-optional mode lets
a dataset live on its own: a bucket prefix, a static config, and a deployed
SPA. Sharing the dataset becomes "copy this prefix."

The CAVE-coupled path (live mode, fresh mat versions, chunkedgraph-resolved
Neuroglancer links) is still the right answer for active proofreading and
in-progress research. CAVE-optional sits beside it for the published-snapshot
case, which is most of the readership.

## What's already CAVE-free

The boundary already exists in code — the explorer has been designed under
the [[feature-explorer-identity-principle]] cell-id rule precisely so this
generalization is small:

- `services/embeddings/loader.py` — "does *no* CAVE call." Reads a parquet,
  validates columns, fills `source_ds`. Pure GCS.
- `services/embeddings/manifest.py` — fetched directly from a URI; the
  datastack YAML carries only the manifest pointer.
- `services/embeddings/knn.py` — index built from the parquet's feature
  columns; no CAVE round-trip.
- Saved sets in `localStorage` (frontend `useNamedSelections`) — entirely
  client-side.
- URL state, decoration overlays, filter expressions, plot bindings, lasso
  selections, color-by-categorical — every part of the explorer's *interactive*
  surface operates in cell_id space without a CAVE call.

## What's CAVE-dependent today, but already snapshot-shaped

These already have a snapshot-friendly architecture; CAVE-optional is the
case where the snapshot is the only path:

- **Decoration tables** (`cell_type_mat`, `num_soma_mat`, `table_decorations_mat`)
  — already L2-cached via `services/swr.py::LayeredSwrCache`. The `fetched_at`
  metadata is preserved through L1↔L2 promotion (the
  `set_with_timestamp` rule), so a cold pod reading a snapshot doesn't reset
  the freshness clock.
- **`services/cell_id.py` universe cache** — built on-demand from a
  materialized view query, then cached per `(datastack, mat_version)`. The
  whole result is dict-shaped (~95k rows for minnie65) and trivially
  serializable to a parquet or JSON in GCS.
- **`cached_datastack_info()`** — 24h-TTL'd one-shot dict containing image
  source, segmentation source, soma table, viewer resolution. The snapshot
  is the same shape, just persisted.
- **Aligned-volume config** — already a YAML; the snapshot version is the
  same file bundled into the snapshot prefix.

The pre-baking job is small: take a real CAVE datastack at one mat_version,
fetch each of the above, and write them under `gs://snapshot/<ds>/...`.

## What's lost in snapshot mode (and is fine)

- **Live mode** — already opt-in per datastack (`live_mode: false`).
- **"Latest" mv discovery** — snapshot pins one.
- **Chunkedgraph-resolved Neuroglancer links** — the
  "supervoxel-id-in-annotation-segments" trick that keeps links correct across
  proofreading. Snapshot links use pre-resolved root_ids only, frozen at the
  snapshot's mv. Fine for published datasets; not fine for in-progress work.
- **Auth gating** via `middle_auth_client` — replaced by bucket IAM (or
  fully public). Much simpler.

## Deployment shapes — the connectivity viewer is optional

The snapshot binding makes one further factoring obvious: **the
connectivity viewer (`/neuron`) is itself optional in static mode**. The
explorer + tables surface stands alone — feature parquets and decoration
snapshots are enough to build a useful tool — and pre-baking per-cell
partner sets is order-of-magnitude more expensive than pre-baking
whole-table decorations (a 95k-cell volume with ~1k partners per cell is
~95M rows of synapse data, vs ~95k rows for a decoration table). For many
deployments — public demos, paper supplements, a "first look at the
features" page — the connectivity bake is overkill.

This produces a small ladder of deployment shapes:

1. **Live** — today's deployment. CAVE-bound. `/explore`, `/neuron`,
   `/tables` all backed by live queries + L1/L2 caches.
2. **Snapshot, full** — snapshot bake includes feature parquets, decoration
   snapshots, cell_id↔root_id lookup, **and** per-cell partner sets.
   `/neuron` works on frozen data. Best for "publish this dataset
   permanently."
3. **Snapshot, explorer-only** — feature parquets + decoration snapshots +
   cell_id lookup. **No** per-cell partner pre-bake. `/neuron` and
   connectivity cross-nav are disabled in the UI; only `/explore` and
   `/tables` are exposed. Smallest deployment; suitable for "demo what's in
   the data" or "ship the feature surface before paying the connectivity
   bake cost."
4. **Snapshot, multi-dataset** — orthogonal: any of the above per
   participating datastack. A joint manifest can mix a live datastack, a
   full-snapshot datastack, and an explorer-only snapshot datastack in the
   same `/explore` view, with cross-nav routing each row to its home
   binding's available views (and greying out `/neuron` cross-nav for rows
   whose home is explorer-only).

The capability block lives on the **project**, not on the binding (a
project chooses its tool surface; the bindings underneath just declare
what they can support). See the next section for how the two layers
compose.

The capabilities block flows through to the SPA via the project-info
endpoint: when `connectivity: false`, the workspace shell hides `/neuron`
from the sidebar, the "Open neuron" cross-nav action greys out, and
breadcrumb navigation that would have landed in `/neuron` falls back to
`/explore`'s SelectionPane.

This is also a graceful degradation story: a project can ship without
connectivity, see whether users miss it, and add the partner pre-bake later
without changing any client code or data model — just dropping new files
into the snapshot prefix and flipping `connectivity: true` in the project
YAML.

## From "datastacks" to **projects** as the unit of deployment

"Datastack" is a CAVE term that leaks CAVE-ness into everything downstream.
Once a deployment can be CAVE-free *and* span multiple data sources *and*
declare which tools it supports, the right top-level entity isn't "a CAVE
datastack that happens to have a snapshot binding" — it's a **project**:
a named, published thing the viewer knows how to show you. A project
might be:

- "MICrONS minnie65, public release at mv=1718" — one underlying CAVE
  datastack, frozen-snapshot bound.
- "Layer 4 cross-volume comparison" — features from minnie65 + V1 + H01,
  joint UMAP, no connectivity surface, fully static.
- "Lab atlas Q3 2026" — a curated set of cells from one volume with team
  labels and a few annotated tours, live-bound for ongoing work.

The project is the entity with a name, a description, a landing page, a
declared set of supported tools, and a list of data bindings (one per
participating data source). The CAVE-bound case is one binding; the
snapshot case is another; multi-dataset projects mix them.

The project YAML declares everything needed to render the workspace:

```yaml
# config/projects/static_project_x.yaml
display_name: "Layer 4 cross-volume comparison"
description: |
  Joint UMAP of L4 pyramidal cells from minnie65 and V1, with predicted
  cell-type labels harmonized across the two source schemas.
capabilities:
  explorer: true
  tables: true
  connectivity: false
manifest_uri: gs://my-bucket/projects/static_project_x/manifest.yaml
bindings:
  - name: minnie65_public
    kind: snapshot
    uri: gs://my-bucket/snapshots/minnie65_public_v1718/
    mat_version: 1718
  - name: v1_release_1
    kind: snapshot
    uri: gs://my-bucket/snapshots/v1_release_1_v42/
    mat_version: 42
```

The URL key `?ds=` is preserved (it's short and entrenched) but now
addresses a project id, not necessarily a CAVE datastack. A project with
exactly one CAVE-live binding looks identical to today's datastack-mode
deployment. A project with multiple snapshot bindings is the
joint-embedding-of-frozen-data case.

This consolidates several concepts the codebase grows in parallel:

| Today | After projects |
|-------|----------------|
| Datastack YAML | Project YAML |
| `?ds` = CAVE datastack name | `?ds` = project id |
| `feature_explorer.enabled` toggle | `capabilities.explorer` in project YAML |
| Implicit "connectivity is always on" | `capabilities.connectivity` declared |
| Manifest's `datastacks: [...]` | Project's `bindings: [...]` |
| `cache_alias` for aliasing CAVE data | Bindings can share underlying data sources explicitly |

The sidebar's datastack picker becomes a **project picker**; each entry
shows its `display_name` and `description` rather than the CAVE-shaped
slug. The /landing page (today's tour gallery) becomes a project gallery
when no `?ds` is set.

## The binding abstraction (per-project, per-source)

Inside a project, each entry in `bindings:` resolves to a runtime
implementation of a `DataBinding` Protocol:

```python
class DataBinding(Protocol):
    """How the backend gets data for one source within a project."""
    name: str                          # binding id; what `source_ds` cells carry
    def datastack_info(self) -> dict: ...
    def resolve_cell_ids(
        self, cell_ids: Sequence[int], mat_version: int | "live"
    ) -> list[Resolution]: ...
    def reverse_resolve_root_id(
        self, root_id: int, mat_version: int | "live"
    ) -> int | None: ...
    def decoration_snapshot(
        self, table: str, mat_version: int
    ) -> dict[int, dict]: ...
    def supports_live(self) -> bool: ...
    def supports_connectivity(self) -> bool: ...
    def available_mat_versions(self) -> list[int]: ...
```

Implementations:

- `LiveCaveBinding` — builds a real `CAVEclient`, allows live mode, resolves
  in real time. Equivalent to today's path.
- `SnapshotCaveBinding` — reads pre-baked GCS artifacts; rejects live mode;
  rejects mat_versions not in the snapshot; never constructs a
  `CAVEclient`.

The endpoint layer doesn't branch on binding kind — it calls
`binding.resolve_cell_ids(...)` and gets the same `Resolution` shape from
either. The multi-dataset path composes cleanly: a project's
`resolve_pairs_to_root_ids` (already added in phase 1) dispatches by
`source_ds`, which corresponds 1:1 with a binding's `name` — so each shard
just picks up its declared binding's implementation.

Project-level capabilities gate the SPA's tool surface; per-binding
capabilities further constrain what each row in a multi-source view can
do. A row whose home binding doesn't support connectivity has its
"Open neuron" cross-nav greyed out individually, even if the project
allows connectivity for other rows.

### Migration: today's datastacks become projects 1:1

The current `config/datastacks/<name>.yaml` files map directly onto the
new project model. Each existing datastack becomes a one-binding project:

```yaml
# config/projects/minnie65_public.yaml  (was: config/datastacks/minnie65_public.yaml)
display_name: "MINNIE65 (public release)"
description: ~
capabilities:
  explorer: true
  tables: true
  connectivity: true
manifest_uri: gs://.../minnie65/manifest.yaml   # was feature_explorer.manifest_uri
bindings:
  - name: minnie65_public                       # binding id == old ds name
    kind: live
    cave_datastack: minnie65_public             # CAVE-facing name (often same)
    live_mode: false                            # was top-level
    cache_alias: minnie65_phase3_v1             # was top-level
    cell_id_lookup: ...                         # was top-level (block)
    root_id_lookup_main_table: ...
    root_id_lookup_alt_tables: [...]
    synapse: {...}                              # was top-level
    decoration_warmup: {...}
    synapse_warmup: {...}
  # examples + recipes stay at project level (workspace-shaped, not binding-shaped)
examples: [...]
recipes: [...]
```

Several things consolidate naturally:

- **Everything that's a property of the *workspace*** (examples, recipes,
  display name, description, capability flags, the manifest pointer) moves
  to project level.
- **Everything that's a property of *how we talk to a specific data
  source*** (CAVE datastack name, mat-version policy, synapse table conv-
  entions, cell-id lookup tables, warmup schedule, cache_alias) moves to
  the per-binding block.
- **Feature explorer config** flattens: today's
  `feature_explorer: {enabled, cell_id_source_table, manifest_uri}` becomes
  `capabilities.explorer` (enabled-ness) + `manifest_uri` (project-level)
  + a per-binding `cell_id_source_table` override (already added in
  phase 1 as `DatastackEntry.cell_id_source_table`).

Behavior is unchanged: the URL still uses `?ds=minnie65_public`, the same
endpoints work, the same single-datastack workspace renders. The
indirection from "datastack" to "project with one binding" is invisible to
end users.

What this unlocks even for single-binding projects:

- **Capability gating without a CAVE flag** — turn `/neuron` off for a
  public read-only deployment of a live datastack without modifying the
  CAVE side.
- **Cleaner names** — `display_name: "MINNIE65 (public release)"` shows up
  in the sidebar instead of `minnie65_public`. The CAVE-style slug stays
  as the binding id (which is what `source_ds` on rows carries).
- **A natural place for project-scoped tours/recipes/team labels** — those
  are workspace-shaped, not binding-shaped, and have always sat awkwardly
  on the datastack YAML.
- **An obvious upgrade path** — add a second binding entry (snapshot or
  live) to turn a single-source project into a multi-source one without
  any other change. The manifest's `datastacks: [...]` block names which
  bindings participate in the joint embedding.

### Capabilities aren't a new concept — just a consolidated one

The project model isn't *introducing* per-datastack heterogeneity in tool
support; it's renaming heterogeneity that already exists. Today's
codebase already encodes capability information as a constellation of
optional fields whose presence/absence acts as a hidden capability flag:

| Today's implicit flag | What it gates | Future explicit form |
|----------------------|---------------|----------------------|
| `feature_explorer.enabled: true` | `/explore` route | `capabilities.explorer` |
| `cell_id_lookup` set | Cell-id input box in `/neuron` + the resolver | `capabilities.cell_id_resolution` (forward) |
| `root_id_lookup_main_table` set | Reverse cell-id lookup; the `?cell_id=` URL key on `/neuron` | `capabilities.cell_id_resolution` (reverse) |
| `live_mode: true` | "live" entry in the mat-version picker | binding kind `live` (live mode is binding-shaped) |

The SPA already branches on each of these (`DecorationPicker` filters by
table availability; the cell-id input is hidden when the lookup fields are
absent; `/explore` is hidden when feature explorer is off). The project
YAML is the place these decisions *should* live — a single declared block
the SPA reads once, not a half-dozen "did the operator set X?" checks
scattered across endpoints.

Concretely: **not every CAVE datastack today has a feature explorer
enabled**, and that's already represented in the YAML. The project model
doesn't change this fact — it just gives it a name (`capabilities.explorer`)
and a single declaration point, and extends the same pattern to
`connectivity`, `tables`, `live_queries`, and whatever future tools land
that some projects support and others don't.

## The team-exploration angle

Static deployments + multi-dataset embeddings + cell-id-stable identity makes
team-based exploration of single-cell connectomic data tractable in a way
that the current ecosystem doesn't cover:

### Shareable URLs as the collaboration primitive

cave-data-viewer's URL is already a fully reproducible view spec
([[explorer-uses-shared-toolkit]]'s "URL-first state" rule): `?ds`, `?dss`,
`?ft`, `?emb`, color/size channel bindings, `?cells` filter expression,
`?sel_<id>` brush selections, `?viz_<id>` plot bindings, column visibility.
A URL pasted in Slack reproduces the sender's view exactly.

For static deployments this is qualitatively different from
genomics-explorer tools where URL state captures a few global toggles. Here
it captures the entire analytical hypothesis the user was looking at — the
embedding, the active filter, the comparison cells, the plot panels. Two
team members can iterate on a hypothesis by trading URLs.

### Persistent labeled selections

`SavedSetsPanel` and `useNamedSelections` (already in the explorer) keep
selections in `localStorage` keyed by `(ds, ft)`. The natural next step is
**writing selections back to GCS** under a per-team prefix so they're
shareable:

```
gs://bucket/labels/<team>/<dataset>/
  alice/inhibitory_v3.json
  bob/martinotti_candidates.json
```

Each labeled set is a small JSON: `{cell_ids: [...], notes: "...", created_at: ...}`.
The SPA gains a "publish to team" action on a saved set; the backend gains
a `GET /labels/<team>/<dataset>/<name>` endpoint that just reads from GCS.
No database, no auth handshake beyond the bucket's IAM.

A labeled set is *also* a manifest of cell_ids: it can decorate any other
view via `?cells=` filtering, drive a kNN seed, become a comparison group
in a differential-features plot. The same primitive serves "tag a set" and
"reuse a tag."

### Cross-dataset comparison as a first-class workflow

The multi-dataset work makes "compare my dataset's L4 to minnie65's L4" a
URL — `?dss=minnie65_public,mydataset`, color by `source_ds`, lasso a region.
The cross-nav rule (row's `source_ds` wins, not the workspace's) means
clicking through to inspect a single cell lands in *its* home dataset's
`/neuron` view without the user having to switch datasets first.

This is the workflow that no current connectomics tool covers and that
cellxgene-style genomics tools handle only via pre-composed atlases. With
the cell-id-keyed identity rule, a new dataset doesn't have to be
"integrated" — just published as a parquet with the same embedding
coordinates.

### Comparison of labelings

If team labels are addressable URLs/files, "show me where Alice's
`inhibitory_v3` disagrees with Bob's `martinotti_candidates`" becomes a
set-operation overlay on the scatter — same machinery as the existing
filter+selection intersection, just sourced from two named sets instead of
one filter expression. The differential-features panel (already a deferred
roadmap item) lights up here: compute mean(feature) on `Alice − Bob`,
ranked by Welch's t-stat. This is the kind of workflow scientific teams
actually do but currently have to script ad-hoc in notebooks.

### Operator-curated tours

The `examples` / `recipes` mechanism in `services/datastack_config.py` is
already a primitive for "open this configured workspace": a tour bundles
`(ds, mv, root)` + decoration + plots + filter into a clickable card. For
static deployments this is the natural way to point new readers at the
intended entry points — "click here to start with the inhibitory population"
— without forcing them to construct the URL themselves.

## What's novel about the position

The three threads together produce a tool with characteristics no current
ecosystem entry has:

| Characteristic | cellxgene | FlyWire Codex | MICrONS Explorer | cave-data-viewer (target) |
|----------------|-----------|---------------|------------------|---------------------------|
| Per-cell features as first-class data | ✓ | partial | partial | ✓ |
| Connectomic primitives (synapses, morphology) | ✗ | ✓ | ✓ | ✓ |
| Multi-dataset joint embeddings | ✗ (per-atlas) | ✗ | ✗ | ✓ |
| Identity survives proofreading | n/a | partial | partial | ✓ (cell-id rule) |
| Static deployable | ✓ | ✗ | ✗ | ✓ (with snapshot binding) |
| Fully reproducible URL state | partial | partial | partial | ✓ |
| Team-shareable labeled selections | ✗ | ✗ | ✗ | natural extension |
| Connectivity overlays in feature space | n/a | ✗ | ✗ | future (`connectivity_in_embedding`) |

The cells in the rightmost column that are already ticked are not
aspirational — they're what the current branch ships once the multi-dataset
work lands. The rest is a small follow-on.

## Phasing relative to the multi-dataset plan

Working from `docs/multi-dataset-plan.md`:

- **Phase 1** (done): identity primitive plumbed. Single-ds workflows
  unchanged.
- **Phase 2** (next): joint embedding `/explore`. The headline multi-ds
  feature.
- **Phase 2.5 — Projects and binding abstraction**: introduce the project
  model. Convert `config/datastacks/*.yaml` to `config/projects/*.yaml` 1:1
  (each becomes a single-binding project). Lift `examples` / `recipes` /
  `manifest_uri` / capability flags to the project level; push CAVE /
  synapse / cell-id-lookup / warmup config into the per-binding block.
  Introduce the `DataBinding` Protocol with `LiveCaveBinding` extracted
  from today's code path. SPA reads `display_name` + capabilities from a
  new `GET /projects/<id>` endpoint and gates the sidebar on them.
  No new user features yet — this is the rename + structural lift that
  unblocks everything downstream.
- **Phase 2.75 — Snapshot binding**: add `SnapshotCaveBinding`. Write the
  pre-baking script (`scripts/bake_snapshot.py`) that takes a live CAVE
  datastack + a mat_version and produces a snapshot prefix (cell_id↔root
  lookup table, datastack_info dict, aligned_volume config, decoration
  snapshots, optionally per-cell partner sets). One sample snapshot for
  minnie65_public to validate the path. This goes *before* Phase 3 so
  decoration aliasing can be specified once over the binding abstraction.
- **Phase 3** (then): decoration column aliases.
- **Phase 4** (then): side-by-side fallout.
- **Phase 5 — Team labels**: write-back of saved sets to GCS. Read-back via
  `GET /projects/<id>/labels/<team>/<name>`. UI: "publish to team" button
  on SavedSetsPanel; "load from team" picker.
- **Phase 6 — Comparison overlays**: differential features and set-operation
  visualization across team labels.

The dependency that matters: the project rename + binding abstraction lands
before the snapshot binding (because the snapshot binding *is* an
implementation of that Protocol), and both land before decoration aliases
(so the aliasing layer can be specified once over the binding abstraction,
not twice).

## Open questions

- **Auth model for team labels.** Bucket IAM gets us "team can read/write."
  For finer grain (Alice can edit her own labels; everyone reads) we'd want
  per-prefix IAM or a small auth shim. Probably defer until a real team
  needs it; bucket-level read+write is the v0.
- **Snapshot drift.** A snapshot pinned to mv=1718 stays valid forever, but
  Neuroglancer links to "root_id 864..." also stay frozen. Users expect to
  see the *current* cell when clicking through to Neuroglancer; in snapshot
  mode they see the snapshot's view. Surface this in the link UI ("snapshot
  view, frozen at mv=1718, may not reflect current segmentation") rather
  than hiding it.
- **Manifest-declared decoration aliases interact with the binding.** When
  the manifest says "for ds X, decoration column `cell_type` comes from
  table T column C," that table lookup goes through the binding —
  `binding.decoration_snapshot(T, mv)`. Live binding queries CAVE; snapshot
  binding reads GCS. The aliasing layer doesn't care.
- **Label provenance.** When Alice publishes `inhibitory_v3`, the saved set
  records `?ds`, `?mv`, `?ft`, `?emb`, plus the filter/lasso that produced
  it. That provenance is the natural audit trail; it should ride along in
  the saved-set JSON so a future reader can re-derive Alice's selection if
  the source columns change. Cell_ids are stable; the *derivation* may not
  be.

## What this isn't

- Not a replacement for cellxgene or scvi-tools. Single-cell genomics has
  its own scaling story (millions of cells, gene-expression matrices), and
  the connectomics-native primitives here would be dead weight for that use
  case. Different niche, different tool.
- Not a replacement for Neuroglancer. Cross-nav into Neuroglancer is the
  intended pattern; this tool is the *feature* surface that points users at
  the right cell to view in Neuroglancer.
- Not a database. Team labels are files in a bucket. If a team needs query
  semantics ("find labels containing cell X"), that's the moment to
  consider a thin index — but probably not before the workflow is
  exercised.

## Verification of the vision

The test of whether this becomes a real tool: ship one snapshot project
("MINNIE65 public, frozen at mv=1718, no CAVE required") with two
team-shared labeled sets, and have a non-engineer biologist use it to find
cells that match one set but not the other and then click through to
Neuroglancer to view them. If that flow works without any "you need to
install X" steps, the tool exists. The engineering above is the path to
that test.

A stronger second test, once Phase 3 lands: ship a multi-binding project
that spans two snapshotted datasets with a harmonized `cell_type`
decoration column, and have the same biologist find a cluster in one
dataset that has no counterpart in the other. That's the joint-embedding
discovery workflow the tool exists to support — and the one the broader
single-cell ecosystem doesn't currently make easy in connectomics.
