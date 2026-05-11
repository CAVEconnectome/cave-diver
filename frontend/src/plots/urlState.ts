/**
 * URL-state encoding for dynamic plots.
 *
 * Each dynamic plot panel's config is a single JSON-encoded URL parameter:
 *
 *     ?viz_<plot_id>={"x":"col","y":"col","hue":"col","size":"col"}
 *
 * Encoded with `encodeURIComponent`. Empty / missing keys are omitted from
 * the JSON, so an unbound plot's URL value is `{}` (or the key is absent
 * entirely, treated as "no bindings yet").
 *
 * The list of *active* dynamic panels is a comma-separated id list:
 *
 *     ?plots=p1,p2,p3
 *
 * Why JSON-as-single-key (vs separate `?viz_<id>_x=`, `?viz_<id>_y=`):
 *   - Empty `{}` is the natural "no bindings yet" state.
 *   - Removing a panel = drop a single key, not 4.
 *   - Future-proof — `chart_type`, `bins`, `colorscale` slot in cleanly.
 *   - `useSearchParams` doesn't have to register N hooks per panel.
 */

export type PanelScope = "input" | "output" | "both" | "reciprocal";

export const PANEL_SCOPES: PanelScope[] = ["both", "input", "output", "reciprocal"];

export interface PlotBindings {
  x?: string | null;
  y?: string | null;
  hue?: string | null;
  size?: string | null;
  /** Numeric column to sum on bar plots. Replaces the implicit row-count so
   *  `x=cell_type, weight=n_syn_in` shows synapses-per-cell-type instead of
   *  partners-per-cell-type. Silently ignored on scatter / histogram. */
  weight?: string | null;
  /** Panel-level direction scope on the unified frame. Applied uniformly to
   *  every channel — replaces the legacy per-axis x_scope/y_scope pair.
   *    - `input`      keeps rows where `n_syn_in > 0` (loose, includes recip).
   *    - `output`     keeps rows where `n_syn_out > 0` (loose, includes recip).
   *    - `reciprocal` keeps rows where both > 0 (strict intersection).
   *    - `both`       no-op default; bind `hue=direction` to recover the
   *                   direction split visually instead of as a row filter. */
  scope?: PanelScope | null;
  /** When at least one bound axis is depth-shaped, draw the target neuron's
   *  own soma depth as a reference glyph (dashed line on one axis, open
   *  circle on the diagonal when both axes are depth). Default ON when
   *  omitted; only set to `false` to suppress the marker. The toggle is
   *  hidden in the UI when no bound axis is depth-shaped, but the param is
   *  still respected on the backend if present. */
  show_cell_depth?: boolean | null;
}

const URL_KEY_PREFIX = "viz_";
const PLOTS_LIST_KEY = "plots";

export function vizParamKey(plotId: string): string {
  return `${URL_KEY_PREFIX}${plotId}`;
}

export const PLOTS_KEY = PLOTS_LIST_KEY;

/** Parse a URL viz-param value into bindings; tolerant of malformed JSON. */
export function parseVizParam(raw: string | null): PlotBindings {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const out: PlotBindings = {};
      for (const k of ["x", "y", "hue", "size", "weight"] as const) {
        const v = (obj as Record<string, unknown>)[k];
        if (typeof v === "string" && v.length > 0) out[k] = v;
      }
      const scope = (obj as Record<string, unknown>).scope;
      if (
        scope === "input" ||
        scope === "output" ||
        scope === "both" ||
        scope === "reciprocal"
      ) {
        out.scope = scope;
      }
      // `show_cell_depth` only persists when explicitly false — the default
      // is ON, so omitting the key keeps the URL tight in the common case.
      const scd = (obj as Record<string, unknown>).show_cell_depth;
      if (scd === false) out.show_cell_depth = false;
      return out;
    }
  } catch {
    // Malformed → treat as empty so a stale URL doesn't crash the page.
  }
  return {};
}

/** Encode bindings into the URL viz-param string, dropping empty / default keys. */
export function encodeVizParam(bindings: PlotBindings): string {
  const out: Record<string, string | boolean> = {};
  for (const k of ["x", "y", "hue", "size", "weight"] as const) {
    const v = bindings[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  if (bindings.scope && bindings.scope !== "both") {
    // Default `both` is implicit; only persist the non-default scopes.
    out.scope = bindings.scope;
  }
  // Only emit when explicitly off — default is ON, so the URL stays tight
  // in the common case. Matches `parseVizParam`'s asymmetric handling.
  if (bindings.show_cell_depth === false) out.show_cell_depth = false;
  return JSON.stringify(out);
}

/** Parse the active-plots list (`?plots=p1,p2,p3`). Empty / missing → []. */
export function parsePlotsList(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function encodePlotsList(ids: string[]): string {
  return ids.join(",");
}

/** Produce a fresh, never-collide id for a new dynamic panel.
 *  Pattern: `dyn-<short-random>` so the id is stable in URL state but
 *  deterministically unique across sessions. */
export function newPlotId(): string {
  return `dyn-${Math.random().toString(36).slice(2, 8)}`;
}


// --- per-panel filter override -----------------------------------------------

/**
 * `?unfilter=<id1>,<id2>` lists panels that opt OUT of the global
 * `?cells=` cell filter. The cell filter is otherwise applied to every
 * plot panel uniformly. The override is per-plot and per-session;
 * shareable via the URL like everything else.
 *
 * Why a single comma-separated key rather than a flag per panel: keeps
 * the URL surface tight (one extra key regardless of how many panels
 * the user toggles), and parses the same way as `?plots=`.
 */
const UNFILTER_KEY = "unfilter";

export function parseUnfilterList(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export function encodeUnfilterList(ids: string[]): string {
  return ids.join(",");
}

export function isPanelUnfiltered(params: URLSearchParams, panelId: string): boolean {
  return parseUnfilterList(params.get(UNFILTER_KEY)).includes(panelId);
}

/** Returns the toggled list — id removed if present, appended if not.
 *  Caller writes the result back to `?unfilter=` (or deletes the key
 *  when the list becomes empty). */
export function toggleUnfilter(params: URLSearchParams, panelId: string): string[] {
  const current = parseUnfilterList(params.get(UNFILTER_KEY));
  if (current.includes(panelId)) return current.filter((id) => id !== panelId);
  return [...current, panelId];
}

export const UNFILTER_PARAM_KEY = UNFILTER_KEY;


// --- selection (brushing) URL state -----------------------------------------

/**
 * Brush / lasso selections from each plot live at `?sel_<plot_id>=` keys
 * with this JSON shape:
 *
 *     {"source": "partners_out", "ids": ["8646...", "8646..."]}
 *
 * `source` matches the plot's data source so PartnersPane can union
 * selections from multiple plots that share a source. URL-persistence makes
 * brush selections reload-safe and shareable. Keys are dropped (rather than
 * set to `{}`) when the user clears a selection.
 */
const SEL_KEY_PREFIX = "sel_";

/**
 * `source` values:
 *   - `partners_in`  — plot drew from the input-partners frame; the brush
 *     ids contribute to the input-tab filter only.
 *   - `partners_out` — same, output side only.
 *   - `partners_both` — plot drew from the unified frame; the brush ids
 *     contribute to *both* tabs (each id is in either or both directions).
 */
export interface PlotSelection {
  source: "partners_in" | "partners_out" | "partners_both";
  ids: string[];
}

export function selKey(plotId: string): string {
  return `${SEL_KEY_PREFIX}${plotId}`;
}

export function isSelKey(key: string): boolean {
  return key.startsWith(SEL_KEY_PREFIX);
}

export function selPlotIdFromKey(key: string): string {
  return key.slice(SEL_KEY_PREFIX.length);
}

export function parseSelParam(raw: string | null): PlotSelection | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return null;
    const source = (obj as { source?: unknown }).source;
    const ids = (obj as { ids?: unknown }).ids;
    if (
      source !== "partners_in" &&
      source !== "partners_out" &&
      source !== "partners_both"
    ) {
      return null;
    }
    if (!Array.isArray(ids)) return null;
    const stringIds = ids.filter((x): x is string => typeof x === "string");
    return { source, ids: stringIds };
  } catch {
    return null;
  }
}

export function encodeSelParam(sel: PlotSelection): string {
  return JSON.stringify({ source: sel.source, ids: sel.ids });
}

/**
 * Walk all `sel_*` URL params, group selected ids by source. Multiple plots
 * over the same source contribute to the same set (union semantics — the
 * most permissive option; user clears individually).
 *
 * `partners_both` selections (from unified plots) contribute to *both*
 * buckets, so a brush on a unified scatter filters the Output tab AND the
 * Input tab AND the Both tab.
 */
export function gatherSelections(
  params: URLSearchParams,
): { partners_in: Set<string>; partners_out: Set<string> } {
  const out = {
    partners_in: new Set<string>(),
    partners_out: new Set<string>(),
  };
  for (const [key, value] of params.entries()) {
    if (!isSelKey(key)) continue;
    const sel = parseSelParam(value);
    if (!sel) continue;
    if (sel.source === "partners_both") {
      for (const id of sel.ids) {
        out.partners_in.add(id);
        out.partners_out.add(id);
      }
    } else {
      for (const id of sel.ids) out[sel.source].add(id);
    }
  }
  return out;
}
