# Feature Explorer for cave-data-viewer

## Context

cave-data-viewer today is a workspace for single-cell connectivity and cell-type browsing: enter a root_id, get partners/synapse-depth/decoration plots, cross-link out to neuroglancer. There's no surface for browsing the population *by feature space* — e.g. "show me cells like this one in morphology space", "lasso a region of UMAP and feed those ids into connectivity".

The reference Dash app `lelabbady/cell_search_app` solves a small slice of that: load a precomputed parquet (root_ids + UMAP coords + soma features), find a cell, find its kNN, open neuroglancer. It's intentionally minimal — single-page, no lasso, no filters, one global dataframe.

We want to plant a richer version of that capability inside cave-data-viewer, reusing the existing per-datastack-config, caching, auth, and neuroglancer-link infrastructure, with the design split in two:

- **Part 1 (this plan):** a new `/explore` route — embedding scatter, color/filter by feature, kNN, lasso-to-id-list, cross-nav into `/neuron`.
- **Part 2 (sketched at the end, planned separately later):** expose feature columns as a joinable decoration source so the existing connectivity machinery (partners table, plot registry, `?cells=` filter) picks them up for free.

## Use cases v1 must support

These are the concrete workflows v1 should make smooth. They drive the decoration-integration decisions below.

1. **cell_search_app-style lookup.** "Here's a root_id from my Neuroglancer tab — find this cell on UMAP, show me 25 nearest neighbors in morphology space, copy their ids, open in NG."
2. **Feature-space exploration with cell-type overlay.** "Color the UMAP by `cell_type_multifeature_combo.cell_type` (a decoration table I already use elsewhere), not just by a column baked into the parquet. I want to see how predicted vs ground-truth cell types lay out in feature space."
3. **Quality-gated browsing.** "Add the `proofreading_status_and_strategy` table to the explorer; filter to cells with `status_axon == true`; everything else greys out; now I find clean exemplars in feature space."
4. **Mixed feature + decoration in one view.** "I have UMAP coords + soma features in the parquet AND cell-type + proofreading status as decoration tables, and I want to look at them together — color by one, filter by another, hover to see all of them in a tooltip."
5. **Lasso + connectivity batch.** "Lasso a region of UMAP, get a list of cell_ids; resolve them to root_ids at the current mat_version; open all of them as segments in a Neuroglancer state, OR click any one to go to its `/neuron` view with the same decoration tables already attached."
6. **Reverse direction (small affordance).** From `/neuron`, a "view in explorer" button on the IdentityStrip resolves the focal root_id → cell_id and opens `/explore?...&cell=<id>`, preserving the decoration tables.

All of these reduce to "the explorer can read both parquet-native columns AND existing decoration tables, in cell_id space, with one shared filter language and one shared decoration-table picker."

## Design decisions (settled)

| Question | Decision |
| --- | --- |
| Data source | Precomputed **parquet** per (datastack, embedding). v1 stores files in the same GCS bucket as the L2 cache. Loader sits behind an `EmbeddingSource` interface so a future "catalog" service can drop in without touching the explorer. |
| **Identity key** | Features are **indexed by `cell_id`** (stable across proofreading), not by `root_id`. Features are *computed* against a specific root_id at a specific mat_version, but stored/served keyed on cell_id. Crossing the boundary into `/neuron` or Neuroglancer requires translating cell_id → current root_id at the requested mat_version, using the existing `services/cell_id.py` infrastructure (`cell_id_lookup_view` in the datastack YAML). |
| Scale | 50k-500k cells per embedding. **Server-rendered Plotly with `scattergl`** (WebGL). Wire format is column-arrays, not per-point objects. The component is isolated enough that swapping to a custom deck.gl renderer later doesn't change the URL shape or the API. |
| Scope v1 | Find-cell + kNN, lasso/box select, color/filter by any feature column **OR any column from a decoration table the user has attached via `?dec=`**. Decoration values are joined onto cell_ids through the cell_id→root_id resolver at the current `?mv`. Distribution-overlay (selected vs rest histograms) is **deferred** (clean to add later). |
| Placement | New top-level route `/explore`, sibling to `/neuron` and `/tables`. |
| kNN | Lazy: on first request per `(ds, embedding_id, feature_subset)`, load parquet → standardize → build KDTree → cache in-memory. Cold pods rebuild from parquet. |

### Why cell_id, not root_id

Connectivity is inherently keyed on root_id — partner sets change with every edit, so "the neuron in front of me right now" is meaningful only at a specific mat_version (or live timestamp). Features (morphology summaries, predicted classes, embedding coordinates) are far more stable: re-running them after every proofreading edit is expensive and almost always redundant. Keying features on **cell_id** lets a feature row outlive arbitrarily many root_id changes — it just has to be reconciled to the current root_id when the user wants to do something connectivity-shaped with it.

Concretely:
- The parquet's primary key is `cell_id`. Optionally a `source_root_id` + `source_mat_version` audit pair records which root the features were computed against, for traceability.
- The cell_id namespace is **anchored to a specific source table per datastack** (e.g. `nucleus_detection_v0` for minnie65). The embedding config names that source table explicitly so the resolver knows which lookup view to query and so we can validate at load time that the parquet's ids belong to the right namespace. Different datastacks have different source tables; the same parquet cannot be reused across datastacks unless the source table is identical.
- All explorer-internal flows (highlight, kNN, color, filter, lasso) stay in cell_id space — never call CAVE.
- Crossing into `/neuron` or Neuroglancer triggers a **cell_id → root_id resolve at the user's chosen mat_version** (or live timestamp), via `services/cell_id.py` using the per-datastack `cell_id_lookup_view`. Resolutions can be missing (cell deleted at this mat_version) or ambiguous (re-merged) — both cases need clear UI handling (greyed-out link + tooltip).

## Architecture summary

Mirrors the existing `connectivity` flow: declarative YAML config → loader+cache service → endpoint module → TanStack Query hook → React route component → URL-first state.

```
config/datastacks/<ds>.yaml          [+ feature_explorer: block]
        │
api/services/embeddings/
        ├── source.py    (EmbeddingSource interface + YAML impl + future catalog impl)
        ├── loader.py    (parquet -> DataFrame keyed by cell_id, cached)
        ├── knn.py       (StandardScaler + KDTree over feature subset, cached)
        ├── resolver.py  (cell_id -> root_id at mat_version/live, wraps services/cell_id.py)
        └── decoration_join.py  (join decoration-cache values onto positional cell_id order
                                 via resolver; produces a column vector aligned with /points)
        │
api/endpoints/embeddings.py
   GET  /datastacks/<ds>/embeddings                       -> list embeddings (cell_id source table named)
   GET  /datastacks/<ds>/embeddings/<id>/points           -> cell_ids + xy + color column
                                                            (color_by may name a parquet col OR a decoration col)
   GET  /datastacks/<ds>/embeddings/<id>/column/<name>    -> single column (parquet or decoration), positional
   POST /datastacks/<ds>/embeddings/<id>/knn              -> nearest neighbor cell_ids + distances
   POST /datastacks/<ds>/embeddings/<id>/resolve_roots    -> cell_id -> root_id at mat_version
        │
frontend/src/api/embeddings.ts
   useEmbeddingList / useEmbeddingPoints / useEmbeddingColumn
   useEmbeddingKnn   / useResolveRoots (batch translator with TanStack Query cache)
        │
frontend/src/components/explore/
   FeatureExplorer.tsx   (route component, owns URL state via useSetUrlParams)
   EmbeddingScatter.tsx  (react-plotly + scattergl, lazy-loaded)
   EmbeddingPicker.tsx / ColorByPicker.tsx / FeatureFilters.tsx
   KnnControls.tsx       (cell_id OR root_id input, k slider, Find buttons)
   SelectionPane.tsx     (Focus / Neighbors / Brush — links to /neuron via resolver)
```

## Backend implementation

### Parquet schema (one file per embedding)

Required columns:
- `cell_id` — int (typically int64). Stringified at the JSON boundary for consistency with the project's root_id-as-string convention, even though cell_ids fit in `Number.MAX_SAFE_INTEGER` comfortably. Values must come from a single named source table per datastack (e.g. `nucleus_detection_v0` for minnie65). The loader validates the parquet's id namespace against the YAML's declared `cell_id_source_table` at load time.
- Two named axis columns, e.g. `umap_x`, `umap_y`.

Optional columns:
- `source_root_id` (int) + `source_mat_version` (int) — audit pair: which root_id at which mat_version the features were computed against. Surfaced in the UI as a tooltip on the cell-detail row so a user can see when the features may be stale.
- Categorical labels (e.g. `predicted_class`, `predicted_subclass`).
- Numeric features (anything not in the axis list or audit columns is a candidate for kNN / filter / color).

Different embeddings (UMAP vs PCA, full-features vs morphology-only) = different parquets. Feature columns may overlap between parquets — that's fine, they're independently cached. The `cell_id_source_table` MUST match across embeddings within a datastack; mixing namespaces in the same datastack is not supported in v1.

### Datastack YAML extension

Add a new top-level `feature_explorer:` block in `config/datastacks/<ds>.yaml`. Schema lives in `api/services/datastack_config.py` alongside existing Pydantic models (`SynapseConfig`, `SpatialConfig`, etc.).

```yaml
feature_explorer:
  enabled: true
  # The CAVE table that defines the cell_id namespace used by every parquet
  # in this datastack. cell_id values in the parquets are validated to be a
  # subset of this table's rows (at the parquet's source_mat_version). The
  # cell_id -> root_id resolver uses the datastack's existing
  # `cell_id_lookup_view` to translate at query time.
  cell_id_source_table: nucleus_detection_v0
  embeddings:
    - id: morpho_umap                                 # URL-safe internal id
      title: "Morphology features — UMAP"            # for the picker
      source:
        kind: parquet                                 # v1; future: { kind: catalog, ref: "..." }
        uri: "gs://<bucket>/embeddings/minnie65_phase3_v1/morpho_umap_v661.parquet"
      id_column: cell_id                              # primary key in the parquet
      axes: [umap_x, umap_y]                          # 2 columns -> 2D scatter
      default_color_by: predicted_subclass
      feature_columns:                                # used for kNN + filtering. Omit -> all non-axis numerics.
        - soma_depth_y
        - nucleus_volume_um
        - soma_area_um
        # ...
      categorical_columns:                            # excluded from kNN; usable for color/filter
        - predicted_class
        - predicted_subclass
      # Optional audit columns surfaced in the cell-detail tooltip:
      audit:
        source_root_column: source_root_id
        source_mat_version_column: source_mat_version
  knn:
    default_k: 25
    max_k: 200
    standardize: true                                 # StandardScaler on feature subset
```

Notes:
- `cell_id_source_table` lives at the `feature_explorer:` block level (not per-embedding) — v1 assumes one cell_id namespace per datastack. If a future need arises to mix sources, this field can be lifted to per-embedding without breaking existing configs.
- `source.kind: parquet` is the only v1 implementation. Adding `kind: catalog` later means writing a second `EmbeddingSource` and toggling on the kind field — no schema migration for existing configs.
- The `uri` is a `gs://...` URL even for the v1 same-bucket case, so a future per-embedding bucket override is a one-line change. For local dev without GCS, `file://...` or a path resolved via `CDV_LOCAL_EMBEDDINGS_DIR` is supported by the loader.

### New backend files

| File | Purpose |
| --- | --- |
| `cave_data_viewer/api/services/embeddings/__init__.py` | Package marker. |
| `cave_data_viewer/api/services/embeddings/source.py` | `EmbeddingSource` Protocol + `YamlEmbeddingSource` (resolves spec from the datastack YAML). Future `CatalogEmbeddingSource` drops in here. |
| `cave_data_viewer/api/services/embeddings/loader.py` | `load_embedding_frame(ref) -> pd.DataFrame` indexed by `cell_id`. Reads parquet via `services/object_store.py`'s existing GCS layer (auth, retries) and `file://` for local dev. Validates the parquet's id namespace against `cell_id_source_table`. Cached. |
| `cave_data_viewer/api/services/embeddings/knn.py` | `EmbeddingIndex` class wrapping `StandardScaler` + `KDTree`. `build_index(frame, feature_columns)` + `query(cell_id, k)`. Cached separately from the frame. |
| `cave_data_viewer/api/services/embeddings/resolver.py` | Thin wrapper over `services/cell_id.py`'s `cell_ids_to_root_ids()` that adds: (a) batching for many ids, (b) per-(ds, mv) caching for materialized mode (live mode is uncached or short-TTL), (c) clear `{cell_id, root_id, status}` return shape where status ∈ {`ok`, `missing`, `ambiguous`}. |
| `cave_data_viewer/api/services/embeddings/decoration_join.py` | Joins values from an existing decoration cache onto the embedding's positional `cell_id` order. Steps: (1) resolve all `cell_ids` → `root_ids` at the requested `mv` via the resolver; (2) fetch the decoration column via `services/decoration.py`'s `lookup_decorations()` (which already returns `{root_id: value}`); (3) emit a positionally-aligned column vector with `null` for missing/ambiguous. Cached: `(cache_ds, mv, embedding_id, decoration_table, column)`. The SWR semantics inherit from the underlying decoration cache; the join layer is a thin projection on top. |
| `cave_data_viewer/api/endpoints/embeddings.py` | Blueprint with the endpoints below. Registers in `api/endpoints/__init__.py`. |

**Future optimization (not v1):** many decoration tables — especially cell-type tables sourced directly from nucleus rows — are themselves keyed by `cell_id` in CAVE, not by `root_id`. For those tables the join can skip the resolver entirely and look the value up directly. v1 takes the universally-correct resolver path for all tables; a follow-up can detect cell_id-keyed tables (via table metadata or a per-table flag in the datastack YAML) and short-circuit the join. Faster + cuts the CAVE call out of the hot path for these tables.

### Endpoint shapes

All endpoints sit under `/api/v1/datastacks/<ds>/embeddings/` and use the standard `request_client()` auth dispatch (`api/cave.py:request_client`) — same as `/connectivity`. The points/column/knn endpoints don't need CAVE; the `resolve_roots` endpoint does. `?mv=` is what the resolver consults; for the data-only endpoints it flows into cache keys and audit logs only (parquet content is pinned by `uri`).

**`GET /datastacks/<ds>/embeddings`** — list available embeddings:
```json
{
  "cell_id_source_table": "nucleus_detection_v0",
  "embeddings": [
    { "id": "morpho_umap",
      "title": "Morphology features — UMAP",
      "axes": ["umap_x", "umap_y"],
      "default_color_by": "predicted_subclass",
      "feature_columns": ["soma_depth_y", ...],
      "categorical_columns": ["predicted_class", "predicted_subclass"],
      "n_cells": 87432
    }
  ]
}
```
`cell_id_source_table` is surfaced so the SPA can label provenance in tooltips and reuse it when constructing kNN inputs.

**`GET /datastacks/<ds>/embeddings/<id>/points?color_by=<col>&mv=<v>`** — scatter payload (all ids are **cell_ids**).

`color_by` accepts:
- a parquet column name (e.g. `predicted_subclass`, `soma_depth_y`) — served from the loaded frame, no CAVE call;
- a decoration-table column in `table.column` form (e.g. `cell_type_multifeature_combo.cell_type`) — routed through `decoration_join.py` using the request's `mv`. The decoration table must be attached via `?dec=` (or the call returns 400).

```json
{
  "cell_ids": ["12345", "12346", ...],
  "x": [1.23, 2.34, ...],
  "y": [-0.12, 4.21, ...],
  "color": {
    "kind": "categorical" | "numeric",
    "column": "cell_type_multifeature_combo.cell_type",
    "source": "decoration" | "parquet",
    "values": ["L23_PYR", "L4_PYR", null, ...],
    "resolution_stats": { "ok": 87000, "missing": 432, "ambiguous": 0 }
  }
}
```
`resolution_stats` is only present for decoration-sourced columns. Payload is encoded as parallel arrays, not per-point objects, to keep the 500k-row payload to a few MB.

**`GET /datastacks/<ds>/embeddings/<id>/column/<name>?mv=<v>`** — single column for client-side filter / recolor / tooltip enrichment. Same name resolution rules as `color_by` (parquet or `table.column`):
```json
{
  "column": "proofreading_status_and_strategy.status_axon",
  "kind": "categorical",
  "source": "decoration",
  "values": [true, false, null, true, ...],
  "resolution_stats": { "ok": 87000, "missing": 432, "ambiguous": 0 }
}
```
Indexed positionally — same order as `cell_ids` from `/points`. Cached per column on both server and TanStack Query side; decoration-sourced columns additionally depend on `mv`.

**`POST /datastacks/<ds>/embeddings/<id>/knn`** — body accepts either a stable `cell_id` or a `root_id` that the server will reverse-resolve via `services/cell_id.py`:
```json
// Request
{ "cell_id": "12345", "k": 25, "feature_columns": ["..."] }
// or
{ "root_id": "864691...", "mat_version": 1718, "k": 25 }

// Response
{
  "query_cell_id": "12345",
  "neighbors": [
    { "cell_id": "12346", "distance": 0.04 }
  ]
}
```
`k` is clamped to `knn.max_k`. `feature_columns` defaults to the embedding's `feature_columns`. Standardization is applied per the YAML. Reverse resolution (root → cell) at a specific mat_version is required when the caller only has root_ids; if missing, the endpoint returns 404 with the resolution-status detail.

**`POST /datastacks/<ds>/embeddings/<id>/resolve_roots`** — cell_id → root_id at a specific mat_version. Body:
```json
{ "cell_ids": ["12345", "12346"], "mat_version": 1718 }
```
`mat_version` may be an int or the string `"live"`. Response:
```json
{
  "mat_version": 1718,
  "resolutions": [
    { "cell_id": "12345", "root_id": "864691...", "status": "ok" },
    { "cell_id": "12346", "root_id": null,        "status": "missing" },
    { "cell_id": "12347", "root_id": null,        "status": "ambiguous", "candidates": ["864...", "864..."] }
  ]
}
```
Batched — accept up to a few thousand cell_ids per call. Server-side cache keyed by `(ds, mat_version, cell_id)` to amortize repeated single-cell resolutions across views.

### Caches

New entries in `api/caches.py`, initialized in `_init_l2_immutable_caches()` in `api/__init__.py` (same place as `dcv_synapse_cache`, `dcv_spatial_features_cache`, `dcv_unique_values_cache`). The embedding data is **immutable** — pinned to a specific parquet URI — so we use the same `immutable=True` pattern with no soft-TTL gating.

| Cache | Backing | Key | Holds |
| --- | --- | --- | --- |
| `dcv_embedding_frame_cache` | LayeredSwrCache, L1 (small LRU, ~32) + L2 GCS (`embeddings_frames/` partition, immutable) | `(cache_ds, embedding_id, parquet_uri)` | Full `pd.DataFrame` after parquet read. |
| `dcv_embedding_index_cache` | SwrCache, **L1 only** | `(cache_ds, embedding_id, feature_columns_digest)` | `EmbeddingIndex` (scaler + KDTree). Rebuild from frame on cold pod — KDTree isn't worth serializing. |

Lifecycle: embedding parquets sit under a separate GCS prefix (e.g. `embeddings/`) **outside** the 7-day lifecycle rule used for the regular L2 partitions — they're long-lived inputs, not cache outputs. The L2 frame cache reads them and writes a pickled copy back into the regular cache prefix where lifecycle applies.

### CAVE client interaction

The **points / column / knn-by-cell_id** endpoints do not need a CAVEclient — they're pure reads of the cached parquet/index. They still go through the standard auth decorator chain so that `CDV_DEV_AUTH_BYPASS=1` works locally and `middle_auth_client` gates production access exactly like every other endpoint.

The **resolve_roots** endpoint (and the `knn` endpoint's optional reverse `root_id` → `cell_id` path) **does** call CAVE via `services/cell_id.py`. The cell_id ↔ root_id machinery is already in place — see `endpoints/cell_ids.py`, `services/cell_id.py`, and the datastack YAML's `cell_id_lookup_view` / `root_id_lookup_main_table` / `root_id_lookup_alt_tables` fields. The new resolver service wraps those calls with batching and caching tuned to the explorer's access patterns (many ids, materialized mode dominant).

## Frontend implementation

### New routes & files

Add the route in `frontend/src/App.tsx`:

```tsx
<Route path="explore" element={<FeatureExplorer />} />
```

(immediately below the `tables/:name` line — `frontend/src/App.tsx:33`).

| File | Purpose |
| --- | --- |
| `frontend/src/api/embeddings.ts` | TanStack Query hooks: `useEmbeddingList`, `useEmbeddingPoints`, `useEmbeddingColumn`, `useEmbeddingKnn`, `useResolveRoots`. Follows the `useConnectivity` convention (`frontend/src/api/queries.ts:185`). `useResolveRoots` is batched + memoized — selection-pane visibility triggers a background resolve so cross-nav links resolve to root_ids before the user clicks. |
| `frontend/src/components/explore/FeatureExplorer.tsx` | Route component. Owns the page layout and reads URL state. |
| `frontend/src/components/explore/EmbeddingScatter.tsx` | `react-plotly.js` wrapper with `scattergl`, lazy-imported the same way as `PlotPanel.tsx`. Multi-trace: default (gray, low opacity), focus (orange), neighbors (teal), brush (purple). Cell_ids are the unit of identity in the trace data; root_id resolution happens only at cross-nav time. |
| `frontend/src/components/explore/EmbeddingPicker.tsx` | Dropdown when a datastack has >1 embedding. |
| **DecorationPicker (reuse existing)** | The same decoration-table picker used by `/neuron`. Reuses the existing `?dec=` URL param so the user sees the same attached tables across views. Attached tables expand the menu of columns offered by ColorByPicker / FeatureFilters / the cell-detail tooltip. |
| `frontend/src/components/explore/ColorByPicker.tsx` | Categorical + numeric column picker. Items are merged from (a) the embedding's `feature_columns` + `categorical_columns` (parquet-native) and (b) every column from every decoration table currently in `?dec=`. Each item is labeled with its source. Triggers `/points?color_by=` refetch. |
| `frontend/src/components/explore/FeatureFilters.tsx` | Filter rows are clauses in the unified `?cells=` filter-expression (same syntax + parser used by `/neuron`). Each clause references either a parquet column or a decoration column (`table.column`). UI parses the expression, exposes per-clause add/remove with type-aware controls (range slider for numeric, multi-select chips for categorical), and re-serializes. Hidden vs greyed-out for filter-failing points is a per-view toggle. |
| `frontend/src/components/explore/KnnControls.tsx` | Accepts **either a cell_id or a root_id** (radio toggle, mirroring cell_search_app). On root_id input, server reverse-resolves to cell_id at the current `?mv`. `k` numeric input, "Find cell" + "Find neighbors" buttons. Optional "feature subset" picker (folds out from a gear icon). |
| `frontend/src/components/explore/SelectionPane.tsx` | Right rail. Three sections (Focus, Neighbors, Brush). Each shows cell_ids with an inline resolution status: `<Link to="/neuron?root=...&from=explore:<embedding>">` when resolution is `ok`, a greyed-out row with tooltip when `missing`/`ambiguous`. Bulk action "Open in Neuroglancer" calls `useResolveRoots` then hands the root_ids to the existing `/links` endpoint via `services/links.py`. |

### URL state for `/explore`

All state is in URL params. Use `useSetUrlParams()` (`frontend/src/hooks/useUrlState.ts:63`) for any multi-key update — chained `setSearchParams` calls race on react-router v6.

| Param | Meaning |
| --- | --- |
| `ds` | datastack (inherited convention) |
| `mv` | mat version (or `live`) — used by the resolver for any cross-nav out of the explorer, AND for any decoration-column join inside the explorer. Independently selectable from the parquet's `source_mat_version`. |
| `emb` | embedding id (e.g. `morpho_umap`) |
| `dec` | comma-separated decoration table names — same param and same meaning as on `/neuron`. Attached tables become available in ColorByPicker / FeatureFilters / cell-detail tooltip. |
| `color` | color-by column. Bare name = parquet column; `table.column` = decoration column (the table must appear in `?dec=`). |
| `cells` | unified filter-expression (same syntax as the existing `/neuron` `?cells=`). Clauses may reference parquet columns or decoration columns (`table.column`). |
| `cell` | focus cell_id (single id, mirrors cell_search_app's "find my cell"). Always a cell_id, never a root_id — the SPA reverse-resolves root_id → cell_id on input before writing this param. |
| `neighbors` | comma-separated **neighbor cell_ids** returned by kNN |
| `k` | k for kNN |
| `knn_features` | comma-separated feature subset for kNN, or omitted = embedding default |
| `sel` | comma-separated brush/lasso-selected **cell_ids** |
| `hide` | bool — toggle hide-vs-gray for filter-failing points |

Notes:
- Every id in URL state is a cell_id. Root_ids exist only ephemerally in click handlers / cross-nav hrefs / Neuroglancer link bodies, never persisted in the URL of `/explore`. Shared links therefore stay valid across proofreading edits even when individual cells get re-rooted.
- `?dec=` and `?cells=` share their syntax and semantics with `/neuron`, so a link from explorer → neuron preserves both verbatim — the user lands on the connectivity view with the same tables attached and the same filter applied to the partners pane.

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Workspace shell (sidebar + breadcrumb — inherited)              │
├─────────────────┬───────────────────────────┬───────────────────┤
│ Left rail 280px │ Center: EmbeddingScatter  │ Right rail 360px  │
│                 │                           │ (collapsible)     │
│ EmbeddingPicker │  (Plotly scattergl)       │ SelectionPane     │
│ ColorByPicker   │                           │  Focus            │
│ FeatureFilters  │  hover: id + color column │  Neighbors (k)    │
│ KnnControls     │  click: set ?cell         │  Brush selection  │
│                 │  lasso: set ?sel          │   - link to /neuron│
│                 │                           │   - Open in NG     │
└─────────────────┴───────────────────────────┴───────────────────┘
```

### Scatter implementation notes

- `react-plotly.js` is already lazy-imported via the `PlotPanel.tsx` pattern — reuse the same dynamic import.
- Use `type: "scattergl"` (WebGL). Plotly's scattergl handles 500k points in single-digit MB of GPU memory.
- Multi-trace approach for state visualization rather than per-point recoloring: 4 traces with disjoint `ids` arrays. Updating a state = swapping which ids belong to which trace. Cheaper than rebuilding the figure.
- `onSelected` (lasso/box) writes to `?sel=`. Same selection plumbing the existing dynamic plot panels use today (`frontend/src/components/PlotPanel.tsx`).
- Hover: show id + color-column value. Disable hover when point count > 200k to keep frame rates up (toggle exposed in a "render quality" widget if useful).
- Filter-failing points: either `marker.opacity` adjusted (gray) or `visible: false` (hide), controlled by `?hide=`. Both are cheap.

### Cross-navigation

Crossing the explorer → connectivity boundary requires a **resolution step** because everything inside `/explore` is in cell_id space and `/neuron` and Neuroglancer are in root_id space.

Pattern:
1. The SelectionPane prefetches a resolution for every cell_id currently visible in any of its three sections via `useResolveRoots(cell_ids, mv)`. This is a TanStack-Query-cached batched call keyed on `(ds, mv, cell_id_set_hash)`.
2. For each cell_id, the pane reads the resolved root_id and builds an href with the same pattern as `partnerHref` (`frontend/src/components/PartnersTable.tsx:401`) — **preserve `ds`/`mv`/`dec`/`cells`/`plots`/`viz_*`** verbatim; set `root` to the resolved root_id; set `from=explore:<embedding_id>` for the breadcrumb. The user lands on the connectivity view with their decoration tables and filter expression still attached.
3. Rows whose resolution is `missing` or `ambiguous` render as a greyed-out non-link with a tooltip explaining the status. The user can change `?mv` to retry against a different mat_version where the cell may still exist.
4. Bulk "Open in Neuroglancer" gathers all resolved root_ids from the active section, calls the existing `/links` endpoint (`services/links.py`) with a generic ids-as-segments template, and opens the returned state URL. Unresolved ids are dropped with a count surfaced in the UI ("3 of 47 cells couldn't be resolved at mv=1718").

Reverse direction (small v1 affordance, since the resolver and `?cell=` are both already in place): a "View in explorer" button on the neuron view's IdentityStrip reverse-resolves the focal root_id → cell_id and navigates to `/explore?...&cell=<cell_id>`, preserving `?dec`/`?cells`/`?mv`. Cheap to add once everything else is wired.

## Verification (no automated tests yet — manual walk-through)

1. **Local sample parquet.** Put a small parquet at `/tmp/cdv-embeddings/morpho_umap_sample.parquet` with `cell_id`, `umap_x`, `umap_y`, `predicted_subclass`, `source_root_id`, `source_mat_version`, and a couple of numeric features for ~1000 cells. The cell_ids should be real ids drawn from `nucleus_detection_v0` at a known mat_version so the resolver has something to translate.
2. **Wire YAML.** Add a `feature_explorer:` block to `config/datastacks/minnie65_public.yaml` with `cell_id_source_table: nucleus_detection_v0` and one embedding entry pointing at `file:///tmp/cdv-embeddings/morpho_umap_sample.parquet`.
3. **Start backend:** `CDV_DEV_AUTH_BYPASS=1 CDV_PORT=5001 uv run python run_api.py`.
4. **Smoke the endpoints with curl:**
   - `GET /api/v1/datastacks/minnie65_public/embeddings` returns the one entry, including `cell_id_source_table`.
   - `GET .../embeddings/morpho_umap/points?color_by=predicted_subclass` returns parallel arrays — first array is `cell_ids` (strings), not `pt_root_ids`.
   - `POST .../embeddings/morpho_umap/knn` with `{cell_id: <any from cell_ids>, k: 5}` returns 5 neighbor `{cell_id, distance}` pairs.
   - `POST .../embeddings/morpho_umap/knn` with `{root_id: <some root_id>, mat_version: 1718, k: 5}` reverse-resolves to a cell_id and returns the same neighbor list.
   - `POST .../embeddings/morpho_umap/resolve_roots` with `{cell_ids: [<a, b, c>], mat_version: 1718}` returns per-id `{root_id, status}` triples — at least one of `missing`/`ambiguous` should exercise the non-`ok` paths.
5. **Start SPA:** `cd frontend && npm run dev`.
6. **Click-through:**
   - Navigate to `/explore?ds=minnie65_public&emb=morpho_umap`. Scatter renders, colored by `predicted_subclass` (parquet-native).
   - Switch `?color=` to a numeric parquet feature → continuous colorscale.
   - **Attach a decoration table.** Open the decoration picker (same one as `/neuron`); add `cell_type_multifeature_combo`. URL gains `?dec=cell_type_multifeature_combo`. ColorByPicker now offers `cell_type_multifeature_combo.cell_type` as an option. Pick it → scatter re-colors using values joined through the resolver at the current `?mv`. Watch the response's `resolution_stats` for how many cells were missing/ambiguous.
   - **Layer in proofreading.** Add `proofreading_status_and_strategy` to `?dec=`. FeatureFilters menu now includes its columns. Add a clause `proofreading_status_and_strategy.status_axon:eq:true` → non-matching points grey out (or hide, per `?hide=`). Combine with a numeric parquet-feature clause like `soma_depth_y:between:100,300` in the same `?cells=` expression — both clauses AND together.
   - In `KnnControls`, toggle to "Root ID", paste a root id from a CAVE tab → server reverse-resolves to a cell_id, `?cell=` populates, orange dot appears.
   - Press "Find neighbors" → teal dots, neighbor list appears in right rail. Hovering a row shows the `source_root_id`/`source_mat_version` audit tooltip AND the values from any attached decoration tables.
   - Click a neighbor row → opens `/neuron?root=<resolved_root_id>&dec=cell_type_multifeature_combo,proofreading_status_and_strategy&cells=...&from=explore:morpho_umap`. Decoration tables and filter are preserved verbatim — partners view lands fully configured.
   - Change `?mv` to a stale version where some cells are missing → those rows in the SelectionPane gray out with the resolution-status tooltip; bulk Open in NG reports how many cells dropped; decoration-column values also flip to null for the missing cells.
   - Drag a lasso → brush-selected cell_ids appear in right rail; clicking one navigates to `/neuron` (with resolution); selecting "Open in Neuroglancer" opens a state with all resolvable roots as segments.
   - From `/neuron`, click the new IdentityStrip "View in explorer" button → reverse-resolves to a cell_id and lands on `/explore?...&cell=<cell_id>` with the same `?dec` / `?cells` / `?mv`.
   - Hard refresh → entire view state (selection, filters, focus cell_id, neighbor cell_ids, color, k, decoration tables) restored from URL. Confirm no root_ids appear in the URL.
7. **Scale check.** Repeat step 6 against a real ~100k-point parquet, then a ~500k one. Watch DevTools network for the `/points` payload size, the `resolve_roots` latency on lasso, decoration-join latency on first color-by-decoration switch, and that `scattergl` interactions stay responsive.
8. **Cache sanity.** Restart the API; first `/points` call rebuilds from parquet (visible in timing), second is L1-hot. First `/knn` rebuilds the KDTree (visible in timing), second is hot. Hit `/resolve_roots` for the same cell_ids at the same mat_version twice — second call is L1-hot. First decoration-join for a `(table, column, mv)` triple rebuilds; second is hot. Delete the L1 cache (restart again) and confirm L2 GCS read serves the frame quickly.

## Part 2 sketch (planned separately)

Part 1 already covers the **decoration → explorer** direction (joining decoration values onto cell_ids for color/filter/tooltip inside `/explore`). Part 2 is the reverse direction: **features → connectivity**, where parquet feature columns appear in partner tables, plot bindings, and the connectivity-view `?cells=` filter, indistinguishable from any other decoration column.

The cell_id-as-key choice means the Part 2 adapter has to go the other way through the resolver:

- Add a `feature_table` mode to the existing decoration service (`services/decoration.py`). For a requested set of `(mat_version, root_id)` pairs (the partner set), the adapter runs `root_id → cell_id` (reverse resolution, batched), then projects the requested feature columns from the cached embedding DataFrame. The result still ships as `{root_id: value}`, transparent to downstream code.
- Cache: the join result is keyed `(cache_ds, mat_version, embedding_id, column_name)`. Materialized → immutable, L2-backed. Live → short-TTL, L1-only.
- The decoration table picker in the SPA gets a "Features" section listing the per-datastack feature columns. They appear in the partners table, the plot picker, and `?cells=` filters with no further work — the column infrastructure is column-name-agnostic once the adapter ships `{root_id: value}`.
- Missing/ambiguous resolutions show up as `null` (same as today's decoration cache when a partner isn't in the cell-type table). Filterable like any other null.
- The SelectionPane's "Open as connectivity batch" action seeds a `?cells=ids:...` filter on the neuron / partners view, resolving the selected cell_ids to root_ids at the current `?mv` first.

This part shouldn't require new endpoints, new caches beyond the join result, or new components — only the inverse adapter (and a small reuse of the existing decoration picker UI to surface the new column source). Will be planned in detail after Part 1 lands.

## Critical files to read before starting

| Pattern to mirror | File |
| --- | --- |
| Endpoint structure + auth | `cave_data_viewer/api/endpoints/connectivity.py` |
| Service-class orchestration | `cave_data_viewer/api/services/neuron.py` |
| Layered immutable cache + GCS L2 | `cave_data_viewer/api/services/swr.py`, `cave_data_viewer/api/services/object_store.py`, `cave_data_viewer/api/__init__.py` (`_init_l2_immutable_caches`) |
| Per-datastack YAML model | `cave_data_viewer/api/services/datastack_config.py` |
| cell_id ↔ root_id translation | `cave_data_viewer/api/services/cell_id.py`, `cave_data_viewer/api/endpoints/cell_ids.py` (forward + reverse lookups; the new resolver wraps this) |
| TanStack Query hook convention | `frontend/src/api/queries.ts` (`useConnectivity` at ~line 185) |
| Lazy plotly + onSelected wiring | `frontend/src/components/PlotPanel.tsx` |
| URL-batched state updates | `frontend/src/hooks/useUrlState.ts` (`useSetUrlParams`) |
| Cross-nav href construction | `frontend/src/components/PartnersTable.tsx:401` (`partnerHref`) |
| Neuroglancer link composition | `cave_data_viewer/api/services/links.py`, `cave_data_viewer/api/templates/links/*.yaml` |
