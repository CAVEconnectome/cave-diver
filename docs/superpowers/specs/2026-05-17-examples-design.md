# Examples + Operator-Recipe Migration — Design

**Status:** draft for review
**Date:** 2026-05-17
**Scope:** Add a curated `/examples` page backed by per-file YAMLs. Migrate operator recipes from inline `recipes:` blocks in datastack YAMLs to the same per-file layout, sharing a single registry. Surface inline YAML save/upload on the /explore share menu for parity with /connectivity.

---

## Background

The recipe model now supports two kinds (`connectivity`, `explorer`) via a kind-discriminator on the YAML body and a per-kind adapter registry on the frontend. Three distinct mechanisms move workspace state around today:

1. **URL deep-links** — user-controlled, free. Already works for both routes; the recipe-link variant strips mv/root for re-pinning at open time.
2. **YAML save / upload** — user-controlled, escape-hatch for state too big for a URL (notably the explorer Selection bag, capped at 100k cell_ids). Adapter `toYaml`/`fromYaml` plumbing landed; the connectivity share menu surfaces the buttons; the explorer share menu does not yet.
3. **Operator examples** — curated, prose-light, LTS-pinned. *This artifact does not exist yet.* Distinct from operator recipes (loose pinning, no prose) and from personal recipes (per-user, no prose, no LTS guarantee).

This spec adds (3), closes the inline-button gap on (2), and refactors operator recipes (already in the codebase as inline `recipes:` arrays inside datastack YAMLs) onto the same per-file layout that examples will use.

## Goals

- A curated, browseable shelf of examples per datastack, durable across mv churn within the long-lived-version window.
- Operator recipes and operator examples share a single on-disk layout and a single loader.
- Authoring is git/PR-driven; deployment is ConfigMap/helm-injected, matching the datastack-config pattern.
- Smallest viable schema; no markdown renderer, no didactic-page generator.

## Non-goals

- Self-service "promote to example" UI. PR review IS the LTS-pinning audit.
- In-app editing of examples or operator recipes. Read-only.
- Walkthrough/tutorial-style prose. Examples are cards linking to loadable workspace state; the learning happens *in* the explorer/viewer once an example is opened.
- Cross-datastack examples / cross-references. YAGNI; add later if needed.
- Markdown rendering anywhere in the prose. `full_text` is plain text with paragraph breaks preserved.

## Architecture

### Storage layout

```
config/
├── datastacks/
│   └── minnie65_public.yaml        # `recipes:` inline block removed
├── recipes/                         # NEW — operator recipes, one file per
│   └── minnie65_public/
│       ├── show-soma-and-cells.yaml
│       └── ...
└── examples/                        # NEW — curated, LTS-pinned
    └── minnie65_public/
        ├── l23p-depth-gradient.yaml
        ├── reciprocal-pyramidal-pairs.yaml
        └── _assets/
            ├── depth-gradient.png
            └── reciprocal-pairs.png
```

Both `config/recipes/` and `config/examples/` use the same loader pattern: repo → in-wheel `_bundled_config/` (via hatchling `force-include`) → `CDV_RECIPES_CONFIG_DIR` / `CDV_EXAMPLES_CONFIG_DIR` last-wins override, matching `services/datastack_config.py`'s tri-source pattern. In production both directories are injected as ConfigMaps.

Filename basename = recipe/example `id`. Filenames must match `^[a-z0-9][a-z0-9_-]{2,63}$`.

### Schema — examples

```yaml
version: 1
kind: explorer                       # or connectivity
id: l23p-depth-gradient              # filename minus .yaml; primary key

# ── card content (the only prose) ──
title: "L2/3 pyramidals colored by cortical depth"   # required
summary: "Quick tour of scatter color binding."      # required, 1–2 sentences
full_text: |                                          # optional, longer free text
  Loads a hand-curated set of L2/3 pyramidal cells in V1 with the
  embedding scatter colored by cortical depth.
thumbnail: depth-gradient.png                         # optional, basename in _assets/

# ── example-specific pinning (kind-dependent) ──
pinned:
  mv: 1078                                            # required for all examples
  root: "864691135123456789"                          # required for connectivity, forbidden for explorer

# ── recipe payload — same shape as personal recipes of this kind ──
explorer:
  ft: l23p_features
  emb: umap_default
  color: depth_um
  decoration_tables: [cell_type]
  scope:                                              # NEW first-class recipe field
    predicates:
      - column: cell_type
        op: in
        values: ["L23P"]
  selection: ["864691135123456789", ...]              # required + non-empty for explorer examples
```

Connectivity examples differ in payload nesting (matching the existing connectivity recipe schema): the payload fields `decoration_tables`, `plots`, `cells`, `hide`, `show`, `coll` sit at the top level of the YAML, not under a `connectivity:` block. The kind-discriminator and the storage layer remain the same; only the body shape differs by kind, identical to how personal recipes already work today (see `_KNOWN_FIELDS` in `services/recipes.py`).

**Wire shape vs YAML shape.** The endpoint response normalizes both kinds into a uniform runtime shape: `{ id, kind, title, summary, full_text?, thumbnail?, pinned: { mv, root? }, payload: Recipe }`, where `payload` is a flat Recipe object of the matching kind (matching what the SPA's `Recipe` discriminated union already expects). For explorer the YAML's nested `explorer:` block becomes `payload`; for connectivity the YAML's top-level recipe fields become `payload`. The Open-mechanics snippet below refers to `example.payload` and `example.pinned.mv` against this wire shape.

### Schema — operator recipes (post-migration)

Same as a personal recipe of the same kind, minus the server-stamped `saved_at`. No `pinned:` block, no required card-metadata fields (though `title` and `description` remain optional). The same `kind`, `version`, `tags`, `id`, and kind-specific payload sections apply.

### First-class `scope:` field on recipes

Both `connectivity` and `explorer` recipe schemas grow a `scope:` field for Filter Scope predicates:

```yaml
scope:
  predicates:
    - column: cell_type
      op: in
      values: ["L23P"]
    - column: num_soma
      op: ">="
      value: 1
```

This is a recipe-level field, not example-only — scope predicates reference slow-moving column schema and are stable enough to survive across mv refreshes.

**Documented invariant:** scope-predicate column references must point at feature_table columns expected to outlive cell_id churn. No runtime check (the loader can't know which columns are stable), but the spec asserts the constraint; PR review enforces it for operator recipes/examples; personal recipes bear the user's own risk.

`_KNOWN_FIELDS` in `services/recipes.py` and `_EXPLORER_FIELD_LIMITS` gain `scope`. The connectivity and explorer adapters on the frontend pick up `scope` parsing/serialization the same way they handle `decoration_tables`.

### Validation rules

At load time (both operator recipes and examples), the new `services/recipe_registry.py` validates:

- `version` in `SUPPORTED_SCHEMA_VERSIONS`
- `kind` in `ALLOWED_KINDS`
- `id` matches filename basename
- For examples:
  - `title`, `summary` present, within bounds (`≤ 200`, `≤ 500`)
  - `full_text` ≤ 5000 chars
  - `thumbnail` (if present) matches `^[a-z0-9_-]+\.(png|jpg|webp)$` — basename-only path safety. Existence is **not** checked at load time (missing file is a request-time placeholder, not a validation failure; see Error handling).
  - `pinned.mv` present (integer)
  - `pinned.root` present iff `kind=connectivity`
  - For `kind=explorer`: `explorer.selection` present and non-empty
- For operator recipes: `pinned` absent (presence is the example marker)

LTS is **not** checked at load time. It's checked at request time via `LonglivedRegistry.longlived_set(ds)` — see "LTS gating" below.

### Loader — `services/recipe_registry.py`

```python
class RecipeRegistry:
    """In-memory cache of operator recipes + examples per datastack.

    Built at app boot from config/recipes/ and config/examples/ (+ wheel
    fallback, + env override). One file per recipe/example; basename =
    id. Read-only after construction; restart the pod to pick up edits.
    """

    def recipes(self, ds: str) -> list[dict]:
        """All operator recipes for ds. Empty list when ds has no
        recipes directory."""

    def examples(self, ds: str) -> list[dict]:
        """All examples for ds, unfiltered by LTS (caller filters)."""

    def example(self, ds: str, eid: str) -> dict | None:
        """One example, unfiltered."""

    def asset_path(self, ds: str, filename: str) -> Path | None:
        """Resolve a thumbnail asset under _assets/. Returns None if
        the basename doesn't match the allowlist or the file doesn't
        exist."""
```

The registry holds parsed examples in memory (a few KB each, single-digit count per datastack expected). Refresh is a pod restart — same model as datastack config.

### LTS gating

Examples consult `LonglivedRegistry.longlived_set(ds)` at request time:

- `GET /api/v1/examples?ds=...&kind=...` filters items to those whose `pinned.mv` is in the current LTS set. Hidden count is returned alongside (`hidden_count`, optionally `hidden_ids` for a debug-friendly response). The frontend renders a banner when `hidden_count > 0` ("3 examples are pinned to retired mat versions and won't load — operator can republish").
- `GET /api/v1/examples/<ds>/<id>` returns 410 Gone with a clear message when `pinned.mv` left LTS.
- Missing LTS marker file → empty set → all examples hidden, with an explanatory empty-state on the /examples page ("this datastack hasn't published its long-lived-version list yet").

Connectivity examples additionally require `pinned.root` to exist at the pinned mv. The /examples list endpoint does not pre-check this (avoids a live CAVE call per example per request); the /neuron page surfaces the standard "root not found" error if the user opens an example whose root has been merged/split since authoring.

### Endpoints

| Endpoint | Returns |
|----------|---------|
| `GET /api/v1/examples` | `{ items: [...], hidden_count: N }` (lightweight; strips `pinned.selection` and `explorer.selection`). Filters: `?ds=`, `?kind=`. |
| `GET /api/v1/examples/<ds>/<id>` | Full example body, incl. `explorer.selection` / `connectivity.*`. 404 on missing, 410 on LTS-retired. |
| `GET /api/v1/examples/<ds>/_assets/<file>` | The thumbnail. 404 on missing. Cache-control: 1 day. |

All three are auth-gated like every other endpoint (`CDV_DEV_AUTH_BYPASS` honored in dev).

Operator recipes are surfaced via the existing `/api/v1/datastacks/<ds>` endpoint (which historically returned the inline `recipes:` block from the datastack YAML). The post-migration behavior is identical from the client's perspective — the loader changes, the wire shape doesn't.

### Frontend

**Route:** `/examples` — top-level, alongside `/datastacks`, `/neuron`, `/explore`.

**Page layout:** card grid. Filter chips at top for `kind` (connectivity / explorer / both) and `datastack` (defaults to the user's last-picked ds; can be cleared to show all). Each card:

- Thumbnail (or placeholder block)
- Title
- Summary
- Small footer: `kind · datastack · mv N`
- Chevron in the corner to toggle inline `full_text` expansion

**Click behavior:**
- Click anywhere on the card body → opens in the target viewer (kind-derived: explorer → `/explore`, connectivity → `/neuron`).
- Click the chevron → expand/collapse `full_text` inline (no navigation).

**Open mechanics:** routes through the existing `adapterFor(kind)`:

```ts
function onOpen(example: Example) {
  const adapter = adapterFor(example.kind);
  const params = adapter.buildOpenParams(example.datastack, example.payload, example.pinned.mv);
  // pinned.root for connectivity is already in adapter.buildOpenParams output via the payload;
  // pinned.mv overrides any prior mv silently — examples are authored at a specific mv.
  navigate(`${adapter.openRoute}?${params}`, {
    state: { selection: example.payload.selection },
  });
}
```

`pinned.mv` is applied silently (no prompt). The card footer already shows the pinned mv; the user knows what they're opting into.

For explorer examples, `selection` travels via React Router state (same path as personal-recipe Open). FeatureExplorer's mount-time effect installs it into the Selection bag.

**Sidebar:** new top-level "Examples" link placed near the datastack picker. Visible from all routes. Counts of available examples per datastack are not shown (would require an extra fetch per render; not worth it).

**Empty states:**
- No examples bundled for the current datastack → "No examples have been published for this datastack yet."
- LTS marker file missing for the current datastack → "This datastack hasn't declared its long-lived materialization versions yet."
- All examples LTS-hidden → "All examples for this datastack are pinned to retired versions; operator can republish."

### ExplorerShareMenu — inline YAML buttons

`ExplorerShareMenu` gains two buttons, mirroring `ShareMenu`'s connectivity surface:

- **Download YAML** — calls `explorerAdapter.toYaml(currentRecipe)` and triggers a download. Same code path as the per-recipe Download button in the Sidebar's saved-recipe list.
- **Upload YAML** — opens a file picker; on file selection, parses via `explorerAdapter.fromYaml(...)` and routes through `useApplyRecipe`. Identical to LandingPage's upload handler, just inline.

This is a one-screen UX addition, no new plumbing. Closes a parity gap with the connectivity share menu.

### Operator-recipe migration

In the same change:

1. New `services/recipe_registry.py` parses `config/recipes/<ds>/*.yaml` into the same dict shape that the inline `recipes:` parser produced.
2. `services/datastack_config.py` stops parsing the inline `recipes:` block. The Pydantic `Recipe` union types it exports are reused by the new registry (no Pydantic-model duplication).
3. Existing operator recipes are extracted into `config/recipes/<ds>/<id>.yaml` files. This is mechanical (one file per array entry); included in the same PR.
4. The inline `recipes:` block is removed from `config/datastacks/<ds>.yaml` files in the same PR.
5. Per the no-wire-compat-shims memory: no fallback to the inline block; if a deployment ships the new wheel against an old ConfigMap, operator recipes are simply absent until the ConfigMap is republished. Acceptable for this codebase's deployment cadence.

## Data flow

**Browsing examples:**

```
User navigates to /examples
  → SPA fetches GET /api/v1/examples?ds=<current>&kind=<filter>
  → Backend: RecipeRegistry.examples(ds) → list
            ∩ LonglivedRegistry.longlived_set(ds) → filtered list
            → strip selection/heavy fields → response
  → SPA renders card grid
```

**Opening an example:**

```
User clicks card
  → SPA fetches GET /api/v1/examples/<ds>/<id>
  → Backend: RecipeRegistry.example(ds, id), LTS check (410 if retired)
  → SPA: adapterFor(kind).buildOpenParams(...) + navigate w/ selection in state
  → /explore (or /neuron) mounts, applies recipe payload, installs selection
```

**Authoring an example:**

```
Operator writes config/examples/<ds>/<id>.yaml + optional thumbnail in _assets/
  → PR review (manual LTS-pinning audit + predicate-stability check)
  → Merge → release → ConfigMap rebuild → pods pick up on restart
```

## Sizing / bounds

| Limit | Value | Reason |
|-------|-------|--------|
| `title` | 200 chars | Card heading bound |
| `summary` | 500 chars | 1–2 sentence card body |
| `full_text` | 5000 chars | Multi-paragraph long form; bounds memory + render cost |
| `thumbnail` filename | basename only, `[a-z0-9_-]+\.(png|jpg|webp)$` | Path safety + format allowlist |
| Thumbnail file size | 500 KB | Soft cap enforced at load time; logged warning above |
| Examples per datastack | No explicit cap; ConfigMap size is the practical bound | Operator-curated; small N expected |
| `selection` in examples | 100k cell_ids (existing cap) | Same as personal explorer recipes |

## Error handling

- Malformed YAML / unknown kind / failed validation at load time → log warning, skip the file. Other examples in the same directory still load.
- LTS marker missing or unparseable → empty LTS set → all examples for that ds hidden with an explanatory banner. No request fails.
- Thumbnail file missing → card renders with placeholder; no error.
- Connectivity example's `pinned.root` has been merged/split at the pinned mv → user sees the standard /neuron "root not found" error after clicking Open. No pre-check.
- User navigates to `/examples?ds=<unknown>` → standard "no examples for this datastack" empty state.

## Testing

No automated tests today in this repo. Manual test plan for this work:

- Load /examples on `minnie65_public` with at least one example bundled. Cards render, filter chips work.
- Open an explorer example. /explore mounts with the example's mv, scope, decorations, Selection bag.
- Open a connectivity example. /neuron mounts at the pinned root with the example's decorations/plots.
- Mv override: have a different mv selected in the sidebar, click Open, confirm the example loads at its pinned mv.
- LTS gating: remove a mv from `<ds>-longlived-versions.json` in the dev cache bucket; confirm matching examples disappear from the list and direct fetch returns 410.
- Thumbnail asset path traversal: probe `/examples/<ds>/_assets/../foo` and friends; confirm 404.
- Operator-recipe migration: confirm the post-migration `/api/v1/datastacks/<ds>` payload is byte-identical (ordering aside) to the pre-migration response. Confirm a personal-recipe round-trip (save → reload → apply) is unchanged.
- ExplorerShareMenu: Download YAML, edit, Upload YAML, confirm round-trip applies.

## Open questions / deferred

- Cross-datastack examples ("this technique works in MICrONS and FlyWire"): deferred. Add a `cross_datastack: true` flag and a different endpoint shape later if needed.
- Tooltips, hover-previews for cards: not in v1.
- Markdown in `full_text`: not in v1; CSS `white-space: pre-line` handles paragraph breaks.
- Example versioning / change history: examples carry a `version` field but no body migrations are expected at v1. The same `SUPPORTED_SCHEMA_VERSIONS` mechanism that recipes use applies.
- Server-side rendering of a static example shelf (for SEO / no-JS): deferred.

## Phasing

A reasonable PR split (writing-plans will refine):

1. **Recipe `scope:` field** — add `scope.predicates` to both kind schemas, plumb through `_KNOWN_FIELDS`, `_EXPLORER_FIELD_LIMITS`, the explorer adapter, the connectivity adapter, and the personal-recipe save/load paths. No examples yet. (Smallest meaningful slice; lets explorer recipes carry scope predicates immediately.)
2. **Operator-recipe migration** — `services/recipe_registry.py`, file-extraction of existing inline recipes, removal of inline-parsing path in `services/datastack_config.py`.
3. **Examples** — schema, endpoints, frontend page, sidebar link, mv-pinning + LTS gating.
4. **ExplorerShareMenu inline YAML buttons** — independent of the rest; can land anytime.

Phase 1 lands the scope field; phase 2 lands the directory layout for operator recipes; phase 3 lands examples on top of the shared loader; phase 4 closes the share-menu parity gap.
