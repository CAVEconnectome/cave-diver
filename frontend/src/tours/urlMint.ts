/**
 * URL minting for operator-curated tours (examples + recipes).
 *
 * The backend's tours endpoint returns YAML-shaped data; the SPA mints the
 * URL because the URL-state conventions (`?ds`, `?mv`, `?root`, `?dec`,
 * `?plots`, `?viz_<id>`, `?cells`, `?hide`, `?show`, `?coll`) live here. By
 * keeping URL construction frontend-only, the contract between backend and
 * frontend stays narrow: tours are configuration, not encoded URLs.
 *
 * Two flavors:
 *   - `buildExampleParams` produces the full param set for `/neuron?...`,
 *     including `ds`, `mv`, `root`. Landing-page "Open" CTA uses this.
 *   - `applyRecipeToParams` overlays a recipe onto an existing URLSearchParams,
 *     replacing the configuration keys (`dec`, `plots`, all `viz_*`, `cells`,
 *     `hide`, `show`, `coll`) but leaving navigation keys (`ds`, `mv`, `root`,
 *     `from`) intact. Sidebar Recipes widget uses this to overlay onto the
 *     currently-loaded cell.
 *
 * Panel ids: each tour plot generates a fresh panel id following the SPA's
 * existing convention — `dyn-<rand>` for bindings panels, `sum-<kind>-<rand>`
 * for summary panels (so the analytics rail's prefix-dispatch sees a normal
 * id and renders the right component).
 */

import type { ConnectivityExample, ConnectivityRecipe, TourPlot, TourPlotBindings } from "../api/types";
import {
  encodePlotsList,
  encodeVizParam,
  newPlotId,
  vizParamKey,
  type PlotBindings,
} from "../plots/urlState";

/** Mint a panel id matching the SPA's existing prefix convention. Random
 *  suffix so a tour applied twice in one session doesn't collide on URL keys
 *  with itself. Bindings panels → `dyn-<rand>`; summary panels →
 *  `sum-<kind>-<rand>` (the rail dispatches on the prefix). */
function mintPanelId(plot: TourPlot): string {
  if (plot.summary_kind) {
    return `sum-${plot.summary_kind.replace(/_/g, "-")}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;
  }
  return newPlotId();
}

/** Inverse of `mintPanelId`'s prefix grammar: classify a panel id and, for
 *  summary panels, recover the `summary_kind` by stripping the trailing
 *  6-char random suffix and reversing the `_`→`-` substitution.
 *
 *  Co-located with `mintPanelId` so both sides of the round-trip share one
 *  source of truth. Callers reading a URL back into a Recipe object (see
 *  `recipeFromUrl.ts`) use this rather than re-parsing the prefix grammar
 *  themselves. */
export function parsePanelId(id: string): { kind: "sum" | "dyn"; summaryKind?: string } {
  if (id.startsWith("sum-")) {
    // Strip "sum-" prefix and the trailing "-<6char>" random suffix.
    const inner = id.slice(4).replace(/-[a-z0-9]{6}$/i, "");
    return { kind: "sum", summaryKind: inner.replace(/-/g, "_") };
  }
  return { kind: "dyn" };
}

/** Strip nulls / empties from `TourPlotBindings` so the encoded URL only
 *  carries set fields. The wire types allow `null`; the SPA's PlotBindings
 *  shape uses `undefined` for absent. Convert here so encodeVizParam stays
 *  the single source of truth for URL encoding. */
function bindingsToPlotBindings(b: TourPlotBindings): PlotBindings {
  const out: PlotBindings = {};
  if (b.x) out.x = b.x;
  if (b.y) out.y = b.y;
  if (b.hue) out.hue = b.hue;
  if (b.size) out.size = b.size;
  if (b.weight) out.weight = b.weight;
  if (
    b.scope === "input" ||
    b.scope === "output" ||
    b.scope === "both" ||
    b.scope === "reciprocal"
  ) {
    out.scope = b.scope;
  }
  if (b.show_cell_depth === false) out.show_cell_depth = false;
  return out;
}

/** Configuration keys this helper sets/clears. Anything not listed here
 *  passes through untouched so navigation state (ds/mv/root/from) survives
 *  a recipe apply. */
const CONFIG_KEYS = ["dec", "plots", "cells", "hide", "show", "coll", "unfilter"] as const;

/**
 * Overlay a tour's configuration onto an existing URLSearchParams. Replaces
 * the configuration keys completely (per design decision: replace + confirm,
 * not merge). Strips any pre-existing per-panel keys (`viz_*`, `sel_*`)
 * because their ids reference the previous configuration's panels and
 * leaving them around would dangle.
 *
 * Returns a fresh URLSearchParams; callers wire it via `setSearchParams`
 * or by stringifying for `useNavigate`.
 */
export function applyTourConfigToParams(
  prev: URLSearchParams,
  tour: {
    // Required by the wire schema but treated defensively here: operator
    // recipes loaded from RecipeRegistry come straight from YAML, and a
    // recipe YAML that simply omits `hide:` / `show:` / `coll:` (or
    // `plots:` / `decoration_tables:`) arrives with those keys absent
    // rather than as empty arrays. The static TypeScript shape claims
    // `string[]`, but the runtime can be `undefined`.
    decoration_tables?: string[];
    plots?: TourPlot[];
    cells?: string | null;
    hide?: string[];
    show?: string[];
    coll?: string[];
  },
): URLSearchParams {
  const next = new URLSearchParams(prev);

  // Drop old per-panel state — viz_<id>, sel_<id> are tied to the previous
  // panel set and would dangle when we replace the panel list below.
  for (const key of [...next.keys()]) {
    if (key.startsWith("viz_") || key.startsWith("sel_")) next.delete(key);
  }
  // Reset the configuration keys; we'll repopulate from the tour.
  for (const key of CONFIG_KEYS) next.delete(key);

  const decorationTables = tour.decoration_tables ?? [];
  const plots = tour.plots ?? [];
  const hide = tour.hide ?? [];
  const show = tour.show ?? [];
  const coll = tour.coll ?? [];

  if (decorationTables.length > 0) {
    next.set("dec", decorationTables.join(","));
  }
  if (tour.cells) {
    next.set("cells", tour.cells);
  }
  if (hide.length > 0) next.set("hide", hide.join(","));
  if (show.length > 0) next.set("show", show.join(","));
  if (coll.length > 0) next.set("coll", coll.join(","));

  if (plots.length > 0) {
    const panelIds: string[] = [];
    const unfilteredIds: string[] = [];
    for (const plot of plots) {
      const panelId = mintPanelId(plot);
      panelIds.push(panelId);
      // Summary panels carry no viz key — they read straight from the bundle.
      if (!plot.summary_kind && plot.bindings) {
        const encoded = encodeVizParam(bindingsToPlotBindings(plot.bindings));
        if (encoded !== "{}") next.set(vizParamKey(panelId), encoded);
      }
      if (plot.unfiltered) unfilteredIds.push(panelId);
    }
    next.set("plots", encodePlotsList(panelIds));
    // `?unfilter=` lists panel ids that opt out of the global cell filter.
    // Only emit when at least one panel asked to opt out — otherwise leave
    // the key absent so the URL stays tight in the common case.
    if (unfilteredIds.length > 0) {
      next.set("unfilter", unfilteredIds.join(","));
    }
  }

  return next;
}

/**
 * Build URL params for a ConnectivityExample: full workspace state including
 * ds, mv, root. Returns a URLSearchParams ready to stringify into a
 * `/neuron?…` navigation. The caller adds the `ds` param too (Examples are
 * rendered grouped by datastack on the landing page, but the helper accepts it
 * explicitly so apply-from-sidebar paths can pass the current datastack
 * without re-deriving it).
 */
export function buildExampleParams(ds: string, example: ConnectivityExample): URLSearchParams {
  const params = new URLSearchParams();
  params.set("ds", ds);
  params.set("mv", String(example.pinned.mv));
  if (example.pinned.root) params.set("root", example.pinned.root);
  return applyTourConfigToParams(params, {
    decoration_tables: example.decoration_tables ?? [],
    plots: example.plots ?? [],
    cells: example.cells,
    hide: example.hide ?? [],
    show: example.show ?? [],
    coll: example.coll ?? [],
  });
}

/**
 * Apply a Recipe by overlaying its configuration onto the user's current
 * URL state. Distinct from `buildExampleParams` because recipes preserve
 * navigation state (ds/mv/root) — that's the whole point.
 */
export function applyRecipeToParams(
  prev: URLSearchParams,
  recipe: ConnectivityRecipe,
): URLSearchParams {
  return applyTourConfigToParams(prev, recipe);
}

/**
 * Open a Recipe with no cell selected: navigates to /neuron with the
 * recipe's decorations + plots + filters preconfigured, but no root id.
 * The user sees the empty form prefilled and types in their own cell.
 *
 * Used by the landing page when no cell is loaded — Apply has nothing
 * to overlay onto, but the user can still get value from the recipe's
 * configuration. Matches the UX of Example.Open: "preset the workspace,
 * land on /neuron." The difference is that an Example pins a specific
 * neuron whereas a Recipe stays cell-agnostic.
 *
 * `mv` is preserved from the user's current sidebar selection (passed
 * in by the caller) rather than baked into the recipe — recipes
 * deliberately don't pin mat_version.
 */
export function buildRecipeOpenParams(
  ds: string,
  recipe: ConnectivityRecipe,
  mv: string | null,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("ds", ds);
  if (mv) params.set("mv", mv);
  return applyTourConfigToParams(params, recipe);
}

/**
 * Diff helper for the apply-confirmation toast. Returns a short human-
 * readable summary of what'll change when the recipe is applied: how many
 * decoration tables come and go, how many panels are added vs replaced,
 * whether the cell filter is being set or cleared. Pure — no side effects.
 *
 * Used by the confirmation UI; the actual apply just calls
 * `applyRecipeToParams` regardless of what the diff shows. The diff is
 * disclosure, not gating.
 */
export interface RecipeDiff {
  decorationsAdded: string[];
  decorationsRemoved: string[];
  panelsBefore: number;
  panelsAfter: number;
  cellsChanged: boolean;
  hideChanged: boolean;
}

export function diffRecipe(prev: URLSearchParams, recipe: ConnectivityRecipe): RecipeDiff {
  // Same defensive normalization as `applyTourConfigToParams`: operator
  // recipes from the registry are raw YAML dicts and may omit any of
  // these array fields when empty.
  const prevDec = (prev.get("dec") ?? "").split(",").filter(Boolean);
  const nextDec = recipe.decoration_tables ?? [];
  const recipePlots = recipe.plots ?? [];
  const recipeHide = recipe.hide ?? [];
  const recipeShow = recipe.show ?? [];
  const recipeColl = recipe.coll ?? [];
  const prevSet = new Set(prevDec);
  const nextSet = new Set(nextDec);
  const decorationsAdded = nextDec.filter((d) => !prevSet.has(d));
  const decorationsRemoved = prevDec.filter((d) => !nextSet.has(d));

  const prevPlots = (prev.get("plots") ?? "").split(",").filter(Boolean);

  return {
    decorationsAdded,
    decorationsRemoved,
    panelsBefore: prevPlots.length,
    panelsAfter: recipePlots.length,
    cellsChanged: (prev.get("cells") ?? "") !== (recipe.cells ?? ""),
    hideChanged:
      (prev.get("hide") ?? "") !== recipeHide.join(",") ||
      (prev.get("show") ?? "") !== recipeShow.join(",") ||
      (prev.get("coll") ?? "") !== recipeColl.join(","),
  };
}
