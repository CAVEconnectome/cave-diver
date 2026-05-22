import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useCellList,
  useEmbeddingList,
  useEmbeddingScatter,
  useResolveRoots,
} from "../../api/embeddings";
import { useTablesUniqueValues } from "../../api/queries";
import { useCrossNavHref } from "../../hooks/useCrossNavHref";
import {
  parseMatVersion,
  useSetUrlParams,
  useUrlParam,
} from "../../hooks/useUrlState";
import { randomSubsample, useNglLink } from "../../hooks/useNglLink";
import type { PartnerRecord } from "../../api/types";

/** Hard cap on the cells handed to /links/segments at once. The server
 *  allows up to 1000; the explorer caps lower (500) because Neuroglancer
 *  itself starts feeling sluggish past a few hundred segments and the
 *  user rarely needs more for a "look at this group" workflow. Sets
 *  above the cap get randomly sub-sampled — `Open in NGL` on a 50k
 *  filter result is meaningful as a sample, not as a full enumeration. */
/** Cells visible (rendered) by default when the user opens a large set
 *  in Neuroglancer. The rest of the set still loads into the
 *  segmentation layer's state — they're toggleable inside NG without
 *  re-fetching — but the viewer doesn't try to render geometry for
 *  thousands of cells on arrival. */
const NGL_VISIBLE_CAP = 20;
/** Total cells loaded into the NG state. Matches the backend cap on
 *  `_SEGMENTS_LINK_MAX_IDS`; anything past this gets uniformly
 *  subsampled before the request leaves the SPA. */
const NGL_LOADED_CAP = 10000;

interface ClearPillProps {
  label: string;
  /** True when there's something to clear. Drives the active vs greyed
   *  visual. */
  active: boolean;
  onClear: () => void;
  /** Pill color variant — "lasso" reads orange (matches the scatter
   *  highlight); "rowsel" reads blue (matches row-checkbox semantics). */
  variant: "lasso" | "rowsel";
}

function ClearPill({ label, active, onClear, variant }: ClearPillProps) {
  return (
    <span
      role="button"
      className={`explore-clear-pill explore-clear-pill-${variant}${
        active ? "" : " disabled"
      }`}
      aria-disabled={!active}
      title={active ? `Clear the active ${label} (Esc)` : `No active ${label} to clear`}
      onClick={(e) => {
        e.stopPropagation();
        if (!active) return;
        onClear();
      }}
    >
      × Clear<span className="explore-pill-suffix"> {label}</span>
    </span>
  );
}

interface NglActionPillProps {
  label: string;
  count: number;
  /** Optional total bag size for the "selected" pill — when the user's
   *  selection bag contains members that are out of scope, the pill
   *  reads `selected (40 of 52)` so the divergence is visible. Omit
   *  for pills (like "visible") where count is the only meaningful
   *  number. */
  bagTotal?: number;
  disabled: boolean;
  liveDisabled: boolean;
  onOpen: () => void;
  /** Visual accent. "warm" tints the pill terracotta to mark it as a
   *  personal-action affordance (the Selected pill — acts on the user's
   *  curated bag); default leaves the pill in its neutral palette. */
  accent?: "warm";
}

/** Pill-shaped NGL action button used in the drawer header. Lives
 *  next to the count + clear-pills so the user finds all the
 *  "current cell set" actions in one place. Always rendered (even
 *  when its action isn't available) so the user knows the feature
 *  exists — disabled state vs missing element is a clearer signal
 *  than a button popping in only when conditions align.
 *
 *  Tooltip explains why the button is disabled: empty set vs live
 *  mode vs pending request.
 */
function NglActionPill({
  label,
  count,
  bagTotal,
  disabled,
  liveDisabled,
  onOpen,
  accent,
}: NglActionPillProps) {
  const hasOutOfScope = bagTotal !== undefined && bagTotal > count;
  const loaded = Math.min(count, NGL_LOADED_CAP);
  const visible = Math.min(loaded, NGL_VISIBLE_CAP);
  const truncating = count > NGL_LOADED_CAP;
  const hidingSome = loaded > NGL_VISIBLE_CAP;
  // Tooltip explains the visible/hidden split + any truncation cap.
  // The pill shows the true count; the load/visible split is an
  // implementation detail surfaced only on hover.
  const title = liveDisabled
    ? "Switch to a materialized version to open in Neuroglancer"
    : count === 0
      ? hasOutOfScope
        ? `Your selection has ${bagTotal!.toLocaleString()} cells but none are in scope — widen the Scope to open them`
        : `No ${label} cells to open`
      : truncating
        ? `Open ${loaded.toLocaleString()} of ${count.toLocaleString()} cells in Neuroglancer (random sample; ${visible.toLocaleString()} shown by default, toggle the rest inside NG)`
        : hidingSome
          ? `Open ${loaded.toLocaleString()} cells in Neuroglancer (${visible.toLocaleString()} shown by default, toggle the rest inside NG)${
              hasOutOfScope ? ` — ${(bagTotal! - count).toLocaleString()} more in selection but out of scope` : ""
            }`
          : hasOutOfScope
            ? `Open ${count.toLocaleString()} in-scope ${label} cells in Neuroglancer (${(bagTotal! - count).toLocaleString()} more in selection but out of scope)`
            : `Open ${count.toLocaleString()} ${label} cells in Neuroglancer`;
  return (
    <span
      role="button"
      className={`explore-ngl-pill${disabled ? " disabled" : ""}${accent === "warm" ? " is-warm" : ""}`}
      aria-disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onOpen();
      }}
    >
      ↗ {label.charAt(0).toUpperCase() + label.slice(1)}
      <span className="explore-pill-count">
        {" "}({count.toLocaleString()}
        {hasOutOfScope && (
          <> of {bagTotal!.toLocaleString()}</>
        )}
        )
      </span>
    </span>
  );
}

import { CellFilterMenu } from "../CellFilterMenu";
import { PartnersTable } from "../PartnersTable";
import { CellIdSearch } from "./CellIdSearch";
import { ChannelPicker } from "./ChannelPicker";
import { CollapsibleSection } from "./CollapsibleSection";
import { ConnectivitySeedWidget } from "./ConnectivitySeedWidget";
import { useResolveCellIds } from "../../api/cellIds";
import { DecorationPicker } from "./DecorationPicker";
import { EmbeddingPicker } from "./EmbeddingPicker";
import { FeatureTablePicker } from "./FeatureTablePicker";
import { useExplorerSelection } from "../../tours/explorerSelection";
import { useSessionRecipe } from "../../tours/sessionRecipe";
import { consumePendingApplyExtras } from "../../tours/useApplyRecipe";
import {
  GrowSelectionPanel,
  type DistanceProbe,
} from "./GrowSelectionPanel";
import { SavedSetsMenu } from "./SavedSetsPanel";
import { SelectionBuilderPanel } from "./SelectionBuilderPanel";
import { SummaryPanel } from "./SummaryPanel";
import {
  UniverseScatter,
  type UniverseScatterHandle,
} from "./UniverseScatter";
import {
  useNamedSelections,
  type NamedSelection,
} from "../../hooks/useNamedSelections";
import { useResizableRailWidth } from "../../hooks/useResizableRailWidth";

/**
 * Route component for `/explore`.
 *
 * Composes the explorer onto the shared toolkit: the same
 * PartnersTable that renders /neuron's partners renders the cell
 * list here, the same CellFilterPanel writes `?cells=` here, the same
 * DecorationPicker writes `?dec=` here. The explorer-specific surface
 * is the universe scatter (a first-class page element, not a rail
 * panel) and the feature-table + embedding pickers.
 *
 * Highlight set computation: `?cells=` filter result is the highlight
 * — those are the cells the user's filter selected. Plus any lasso
 * selection from the universe scatter (`?sel_universe=`). Without a
 * filter or lasso, the scatter renders the universe at full opacity
 * with no overlay (everything is "in scope").
 */
export function FeatureExplorer() {
  const [ds] = useUrlParam("ds");
  const [mv] = useUrlParam("mv");
  const [ft] = useUrlParam("ft");
  const [emb] = useUrlParam("emb");
  const [decRaw] = useUrlParam("dec");
  const [cells, setCells] = useUrlParam("cells");
  // Connectivity seed: a single root_id whose cached partners bundle
  // sources server-derived `seed_*` columns (`seed_is_partner`,
  // `seed_n_syn_out`, etc.) for binding on the scatter and plots.
  // Multi-seed is a planned future; today the URL carries one root_id.
  const [seedRootId, setSeedRootId] = useUrlParam("seed");
  // Raw `?sel_filters=` — read here (not just in SelectionBuilderPanel)
  // so the stale-seed-reference cleanup effect can prune it.
  const [selFiltersRaw] = useUrlParam("sel_filters");
  // Client-side "Seed view" filter for the cell-list table — when ON,
  // hides cells that aren't partners of the active seed. Only visible
  // (and only meaningful) when a seed is set. Local state — survives
  // table drawer collapses but doesn't pollute the URL.
  const [seedViewActive, setSeedViewActive] = useState(false);
  // Whether to mark the seed cell itself on the scatter with a ring
  // overlay. Default on — a seed is most useful when you can see where
  // it sits. Local state; toggled from the Connectivity seed widget.
  const [markSeed, setMarkSeed] = useState(true);
  // Out-of-scope cell rendering mode for the universe scatter. "ghost"
  // (default) shows them desaturated in the background as context;
  // "hide" omits them entirely. In both modes out-of-scope cells are
  // non-pickable — out of scope is out of scope, period.
  const [scopeModeRaw, setScopeModeRaw] = useUrlParam("scope_mode");
  const scopeMode: "ghost" | "hide" = scopeModeRaw === "hide" ? "hide" : "ghost";
  // Selection bag — cell_ids the user has chosen, by any mechanism:
  // row checkboxes in the table, lassoing on the scatter, Cell ID
  // Search. The bag is the *stable* user-marked set: Filter Scope
  // changes never mutate it. At render time the visible "selected"
  // set is derived as `bag ∩ inScopeCellIds` so the user can narrow
  // the scope, see fewer marked cells, then widen and the rest come
  // back. Without this preservation, every filter tweak would silently
  // lose work.
  //
  // Lives in local component state (not URL) — large lassos overflow
  // Node's 8KB header limit when the URL becomes a request line on
  // page refresh (HTTP 431). Selections are inherently transient and
  // the user opted out of URL persistence here. The rest of the view
  // config — ?cells, ?dec, ?ft, ?emb, channel bindings — stays in
  // URL state for shareability.
  const [selectionBag, setSelectionBag] = useExplorerSelection();
  // Per-(ds, kind) session-recipe save/restore for /explore. Mirrors
  // /neuron's call. The Selection bag itself is NOT in session state
  // — only URL-shaped overlay. Cross-session restore of a curated
  // selection is what "Save as my recipe" + ExplorerShareMenu is for.
  useSessionRecipe("explorer");
  // Pending "save as a named selection on landing" payload, populated
  // when a connectivity → explorer cross-nav stages a selection blob
  // via pendingApplyExtras. We defer the actual save() call until ft is
  // known because useNamedSelections is keyed on (ds, ft); the bag
  // itself is applied immediately at ds-time below (it's just local
  // state and doesn't need ft).
  const [pendingNamedSave, setPendingNamedSave] = useState<{
    name: string;
    cellIds: string[];
  } | null>(null);
  // One-shot: when an explorer recipe was just applied via
  // useApplyRecipe, OR when /neuron's "Open in Explorer" button staged
  // a connectivity-origin payload, the Selection bag is staged in
  // localStorage. Consume it on first ds-bearing render and push it
  // into component state. If the extras carry a `save_as_named` block
  // (connectivity origin), also defer a useNamedSelections save until
  // ft becomes available.
  useEffect(() => {
    if (!ds) return;
    const extras = consumePendingApplyExtras(ds, "explorer");
    if (!extras) return;
    const sel = Array.isArray(extras.selection)
      ? (extras.selection.filter((x) => typeof x === "string") as string[])
      : null;
    if (sel && sel.length > 0) {
      setSelectionBag(sel);
    }
    const saveBlock = extras.save_as_named;
    if (
      saveBlock &&
      typeof saveBlock === "object" &&
      sel &&
      sel.length > 0
    ) {
      const name =
        typeof (saveBlock as Record<string, unknown>).name === "string"
          ? ((saveBlock as Record<string, unknown>).name as string)
          : "From connectivity";
      setPendingNamedSave({ name, cellIds: sel });
    }
    // ds is the only dep we care about — the consumer is intentionally
    // one-shot per ds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ds]);
  // Direct-scope snapshot — the bag at the moment "Filter to selection"
  // was clicked, frozen into the active scope. Local state for the same
  // overflow reason: a 5k-cell snapshot can't ride the URL. Direct scope
  // overrides the predicate-based ?cells= scope when set; the popover
  // header reflects which source is active. The bag itself is untouched
  // by this action — snapshot is a *copy*, not a move.
  const [directScopeBag, setDirectScopeBag] = useState<string[]>([]);
  // Set-typed mutators for the named-set algebra below — operating on
  // raw arrays would require redundant split-and-join on every call.
  const replaceSelection = useCallback((cellIds: string[]) => {
    setSelectionBag(cellIds);
  }, []);
  const unionIntoSelection = useCallback((cellIds: string[]) => {
    setSelectionBag((prev) => {
      const seen = new Set(prev);
      const out = [...prev];
      for (const c of cellIds) {
        if (!seen.has(c)) {
          seen.add(c);
          out.push(c);
        }
      }
      return out;
    });
  }, []);
  const subtractFromSelection = useCallback((cellIds: string[]) => {
    setSelectionBag((prev) => {
      const drop = new Set(cellIds);
      return prev.filter((c) => !drop.has(c));
    });
  }, []);

  // Selection-growth probe state. Local (not URL) — the universe-aligned
  // distance arrays for ~94k cells overflow the URL-as-request-line limit
  // and are inherently transient anyway. The probe's *settings* live in
  // `?growth_*` URL params via GrowSelectionPanel.
  const [distanceProbe, setDistanceProbe] = useState<DistanceProbe | null>(
    null,
  );
  // Probe is sticky — it survives bag mutations (deselect, lasso
  // replace, Esc clear). The seed list captured on the probe is the
  // user's frozen reference; "Reset to seeds" in the panel restores
  // the bag back to it. The probe goes away only on explicit "Clear
  // probe" or when a new Compute lands. (Earlier versions auto-cleared
  // the probe whenever a seed left the bag; that made the chart, the
  // synthetic __distance channel, and the threshold actions vanish the
  // moment the user lassoed onto a sub-population to inspect it —
  // which is the most useful moment to keep them.)

  // Esc clears the selection bag. Window-level so the user doesn't
  // have to chase a focus target on the canvas, but skipped whenever
  // a typing surface (input/textarea/contenteditable) is focused so
  // it doesn't fight with form-cancel behavior. No-op when the bag is
  // already empty so we don't suppress an Esc the user meant for a
  // popover.
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== "Escape") return;
      if (selectionBag.length === 0) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable
        || el.tagName === "INPUT"
        || el.tagName === "TEXTAREA"
        || el.tagName === "SELECT")) return;
      setSelectionBag([]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectionBag.length]);

  // Seaborn-style channel bindings. Each is the dotted column name
  // (parquet columns are prefixed with the feature_table id; decoration
  // columns are `<dec_table>.<col>`) or null to fall back to the
  // embedding's default.
  const [xBinding] = useUrlParam("x");
  const [yBinding] = useUrlParam("y");
  const [colorBinding] = useUrlParam("color");
  const [sizeBinding] = useUrlParam("size");
  const [sizeMinRaw] = useUrlParam("size_min");
  const [sizeMaxRaw] = useUrlParam("size_max");
  // Data range for the size channel — mirrors color_min / color_max
  // for the color channel. Null defers to the data extent (no
  // clipping); explicit values clamp out-of-range cells to the size
  // endpoints so a long-tail outlier doesn't compress the size
  // gradient onto a few cells.
  const [sizeDataMinRaw] = useUrlParam("size_data_min");
  const [sizeDataMaxRaw] = useUrlParam("size_data_max");
  const [colorMinRaw] = useUrlParam("color_min");
  const [colorMaxRaw] = useUrlParam("color_max");
  const [colormapId] = useUrlParam("cmap");
  const [colorCenterRaw] = useUrlParam("color_center");
  // Uniform fill color for the explicit no-color state (?color=__none__).
  // Ignored when a real color column is bound or when color falls back
  // to the manifest default.
  const [colorValue] = useUrlParam("cv");
  // Drawer state for the cell-list table. Closed by default so the
  // scatter owns the full canvas on first arrival; user clicks the
  // drawer handle to pull up the table.
  const [tableRaw, setTable] = useUrlParam("table");
  const tableOpen = tableRaw === "open";
  // Size range falls back to client defaults when URL is silent.
  const sizeMinPx = sizeMinRaw ? parseFloat(sizeMinRaw) : 2.0;
  const sizeMaxPx = sizeMaxRaw ? parseFloat(sizeMaxRaw) : 18.0;
  // Size data-range clipping — null-default same as color. Values
  // outside [sizeDataMin, sizeDataMax] clamp to the size endpoints
  // so a long-tail outlier doesn't squash the size gradient onto a
  // few cells.
  const sizeDataMin = sizeDataMinRaw ? parseFloat(sizeDataMinRaw) : null;
  const sizeDataMax = sizeDataMaxRaw ? parseFloat(sizeDataMaxRaw) : null;
  // Color clipping is null-default — the slider's bounds come from
  // the data extent at render time, and null means "use the full
  // extent." Explicit URL values clamp the colorscale endpoints.
  const colorMin = colorMinRaw ? parseFloat(colorMinRaw) : null;
  const colorMax = colorMaxRaw ? parseFloat(colorMaxRaw) : null;
  // Center for diverging colormaps. Null = "no explicit pick" → renderer
  // falls back to the range midpoint, which is a visual no-op until the
  // user moves it. Numeric URL values clamp the gradient pivot.
  const colorCenter = colorCenterRaw ? parseFloat(colorCenterRaw) : null;
  const setUrl = useSetUrlParams();

  const matVersion = parseMatVersion(mv);
  const decorationTables = decRaw ? decRaw.split(",").filter(Boolean) : [];
  // Resolve the connectivity seed root_id → cell_id. Drives the
  // seed-cell ring marker on the scatter and the widget breadcrumb.
  // Skipped in live mode (no universe cache backs the resolver).
  const seedResolve = useResolveCellIds(
    seedRootId && ds && matVersion !== "live"
      ? { ds, matVersion, rootIds: [seedRootId] }
      : null,
  );
  const seedCellId: string | null = seedRootId
    ? seedResolve.data?.root_to_cell?.[seedRootId] ?? null
    : null;
  // Distinct-value universe for every attached decoration table, merged
  // into a single `${table}.${col}` map. Feeds the Filter Scope
  // predicate builder so string columns get a dropdown / checkbox list
  // instead of free-text — same UX as the table view. Backed by the
  // 7-day immutable `dcv_unique_values_cache`, so warm pages pay
  // nothing here.
  const tableValues = useTablesUniqueValues(ds, decorationTables, matVersion);

  // Resizable rail width. Persists to localStorage so reloads + cross-
  // nav preserve it; clamped to [260, 640] inside the hook.
  const {
    width: railWidth,
    beginDrag: beginRailResize,
    isDragging: railResizing,
  } = useResizableRailWidth();

  // Imperative handle on the universe scatter. Used by CellIdSearch to
  // re-frame the camera onto a freshly-resolved cell (or set of cells)
  // after `replaceSelection(...)` writes to the bag. The scatter's
  // `fitView` reads `partition.selected` which depends on the
  // `selectedCellIds` prop (= effectiveSelection = bag ∩ in-scope) —
  // so the call has to be deferred until React has flushed the
  // selection state change and the scatter has re-committed its
  // partition. `requestAnimationFrame` is enough: the state update
  // fires synchronously, React schedules a render, then rAF runs after
  // the commit phase, and `ref.current.fitView` is the latest closure
  // (useImperativeHandle re-binds on fitView change). Note that if the
  // searched cell is out of scope, effectiveSelection won't include it
  // and fitView will frame the full universe — out of scope is out of
  // scope, period.
  const scatterRef = useRef<UniverseScatterHandle | null>(null);
  const fitToSelection = useCallback(() => {
    requestAnimationFrame(() => {
      scatterRef.current?.fitView();
    });
  }, []);

  // Named cell sets — per (ds, ft) localStorage layer. The hook is
  // disabled gracefully when ds/ft are null (initial render before
  // catalog defaults kick in) so the panel just renders the empty
  // state during that brief window.
  const namedSelections = useNamedSelections(ds, ft);
  // Flush the deferred connectivity-origin save once ft is known. Same
  // (ds, ft) scope as namedSelections so the saved set lands in the
  // right localStorage slot.
  useEffect(() => {
    if (!pendingNamedSave || !ds || !ft) return;
    namedSelections.save(pendingNamedSave.name, pendingNamedSave.cellIds);
    setPendingNamedSave(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingNamedSave, ds, ft]);
  // "Save selection" affordance: the drawer header pill opens an
  // anchored popover containing the name input. Local state holds the
  // draft + open flag so the input doesn't fight with the pill's
  // click toggle.
  const [savePromptOpen, setSavePromptOpen] = useState(false);
  const [saveDraftName, setSaveDraftName] = useState("");
  const saveMenuRef = useRef<HTMLSpanElement>(null);
  const openSavePrompt = () => {
    setSaveDraftName(namedSelections.suggestName());
    setSavePromptOpen(true);
  };
  const closeSavePrompt = () => {
    setSavePromptOpen(false);
  };
  const commitSavePrompt = () => {
    if (selectionBag.length === 0) {
      setSavePromptOpen(false);
      return;
    }
    namedSelections.save(saveDraftName, selectionBag);
    setSavePromptOpen(false);
  };
  // Outside-click + Escape dismissal — same idiom as SavedSetsMenu so
  // both sibling pills behave identically.
  useEffect(() => {
    if (!savePromptOpen) return;
    const onMouseDown = (e: MouseEvent) => {
      if (
        saveMenuRef.current &&
        !saveMenuRef.current.contains(e.target as Node)
      ) {
        setSavePromptOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSavePromptOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [savePromptOpen]);

  // Catalog — drives both pickers + tells us if the explorer is even
  // configured for this datastack.
  const catalog = useEmbeddingList(ds);
  const featureTables = catalog.data?.feature_tables ?? [];
  const currentFt = featureTables.find((t) => t.id === ft) ?? null;
  const currentEmbeddings = currentFt?.embeddings ?? [];
  const currentEmb = currentEmbeddings.find((e) => e.id === emb) ?? null;

  // Default the picks to the first available feature_table + its first
  // embedding when the URL is silent. Replaces the URL so the back
  // button doesn't bounce through the "no pick" state.
  useEffect(() => {
    if (!catalog.data?.enabled) return;
    if (featureTables.length === 0) return;
    const ftMissing = !ft || !featureTables.find((t) => t.id === ft);
    const defaultFt = featureTables[0];
    const targetFt = ftMissing ? defaultFt : featureTables.find((t) => t.id === ft)!;
    const embMissing = !emb || !targetFt.embeddings.find((e) => e.id === emb);
    const defaultEmb = targetFt.embeddings[0];
    if (ftMissing || embMissing) {
      setUrl(
        {
          ft: ftMissing ? defaultFt.id : ft,
          emb: embMissing ? defaultEmb?.id ?? null : emb,
        },
        { replace: true },
      );
    }
  }, [catalog.data, featureTables, ft, emb, setUrl]);

  // Resolve the channel bindings that actually go to /scatter. The
  // synthetic ``__distance`` channel is computed client-side from the
  // active distance probe, so it never reaches the server — strip it
  // and let UniverseScatter inject its own color/size block.
  //
  // Color resolution has three states:
  //   - ?color=__none__   → explicit user "no color" → uniform user-
  //                         picked baseColor (?cv=). Doesn't fall
  //                         back to default.
  //   - ?color=<column>   → that column.
  //   - (key absent)      → fall back to embedding manifest's
  //                         `default_color_by` so the YAML default
  //                         actually paints the scatter on first view.
  // The picker's empty option reads "default (<col>)" so the user
  // knows the implicit fallback; a separate "(no color)" option
  // explicitly writes __none__ for users who want to opt out.
  const defaultColorBy =
    currentEmb?.default_color_by && ft
      ? `${ft}.${currentEmb.default_color_by}`
      : null;
  const effectiveColorBinding =
    colorBinding === "__distance" || colorBinding === "__none__"
      ? null
      : (colorBinding ?? defaultColorBy);
  const effectiveSizeBinding =
    sizeBinding === "__distance" ? null : sizeBinding;

  // Scatter response — fetched by UniverseScatter too, but TanStack
  // Query dedupes by queryKey so there's only one network call. We
  // read it here to feed the SummaryPanel's universe counts + the
  // ChannelPicker's color-slider bounds without prop-drilling from
  // UniverseScatter.
  const scatter = useEmbeddingScatter(
    ds && ft && emb
      ? {
          ds,
          featureTableId: ft,
          embeddingId: emb,
          x: xBinding,
          y: yBinding,
          colorBy: effectiveColorBinding,
          sizeBy: effectiveSizeBinding,
          decorationTables,
          matVersion,
          seedRootId,
        }
      : null,
  );

  // Data extent of all distances in the active probe — used to feed
  // the color/size range slider when the user binds the synthetic
  // ``__distance`` channel. Distinct from the fetched-column bound
  // below because the fetched response has no block for ``__distance``
  // (the binding is stripped before /scatter is called).
  const distanceBound = useMemo(() => {
    if (!distanceProbe) return null;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const v of distanceProbe.byCellId.values()) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) return null;
    return { lo, hi };
  }, [distanceProbe]);

  // Color slider bounds: data extent of the bound numeric column.
  // Recomputed on each response so the slider always reflects the
  // current column's range, not a stale one from a previous binding.
  // The ``__distance`` branch uses the synthetic probe-derived bound
  // so the same range/colormap affordances appear for it as for any
  // other numeric column.
  const colorBound = useMemo(() => {
    if (colorBinding === "__distance") return distanceBound;
    const c = scatter.data?.color;
    if (!c || c.kind !== "numeric") return null;
    // Seed columns: 0 means "not connected" and is rendered as
    // background, not on the colormap — exclude it from the slider /
    // legend bounds so they match the gradient the scatter draws.
    const seedCol =
      typeof c.column === "string" && c.column.startsWith("seed_");
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const v of c.values) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (seedCol && v === 0) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) return null;
    return { lo, hi };
  }, [colorBinding, distanceBound, scatter.data?.color]);
  // Size slider bounds: data extent of the bound size column. Mirrors
  // colorBound — used to seed the data-range slider and to provide
  // the slider's full-range endpoints. The ``__distance`` branch uses
  // the synthetic probe-derived bound (same data as the color path).
  const sizeBound = useMemo(() => {
    if (sizeBinding === "__distance") return distanceBound;
    const s = scatter.data?.size;
    if (!s) return null;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const v of s.values) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) return null;
    return { lo, hi };
  }, [sizeBinding, distanceBound, scatter.data?.size]);

  // Universe Set for the Cell ID Search's `cell_id` mode. The scatter
  // already loaded the cell_id array; wrap it in a Set so membership
  // checks are O(1) per token rather than O(n) per token. Re-builds
  // only when the underlying array reference changes (TanStack Query
  // hands us a stable reference per response).
  const universeCellIds = useMemo<Set<string> | null>(() => {
    const ids = scatter.data?.cell_ids;
    if (!ids) return null;
    return new Set(ids);
  }, [scatter.data?.cell_ids]);

  // /cells fetch — the cell-list table reads from this. Two scope
  // sources can narrow the result:
  //   - `cells` (predicate): ?cells= URL param edited via the
  //     CellFilterPanel inside the Filter Scope popover.
  //   - `directScopeBag`: in-memory snapshot from "Filter to selection."
  // The backend ANDs both server-side via `cell_ids` so we don't
  // need a separate code path for the snapshot.
  // matched_count reflects "everything in the active scope."
  const cellList = useCellList(
    ds && ft
      ? {
          ds,
          featureTableId: ft,
          matVersion,
          decorationTables,
          cells,
          cellIds: directScopeBag.length > 0 ? directScopeBag : null,
          seedRootId,
        }
      : null,
  );

  // In-scope set (the "view" in scope/view/mark) — null means the full
  // universe is in scope (no filter, no snapshot). When any scope is
  // active, the cellList response carries the in-scope cell_ids
  // (backend has already done predicate + snapshot intersection).
  const hasScope = !!cells || directScopeBag.length > 0;
  const inScopeCellIds = useMemo<Set<string> | null>(() => {
    if (!hasScope) return null;
    if (!cellList.data) return null;
    return new Set(cellList.data.cell_ids);
  }, [hasScope, cellList.data]);

  // Prune stale connectivity-seed references from URL state. When the
  // seed is cleared (or a seed column is removed from the schema), any
  // `seed_*` predicate in `?sel_filters=` or `seed.*` clause in
  // `?cells=` becomes invalid — leaving them would render broken
  // Build-Selection rows and show an inert scope clause as if it were
  // active. Strip them so the displayed filters stay coherent. The
  // `seed` column group only appears once /cells has loaded with a
  // seed, so the "group loaded" guard avoids pruning a still-valid
  // seed reference during the brief pre-load window.
  useEffect(() => {
    const seedCols = new Set(
      (cellList.data?.column_groups ?? []).find((g) => g.name === "seed")
        ?.columns ?? [],
    );
    const seedGroupLoaded = seedCols.size > 0;
    const seedColInvalid = (col: string): boolean => {
      if (!col.startsWith("seed_")) return false;
      if (!seedRootId) return true;
      if (seedGroupLoaded && !seedCols.has(col)) return true;
      return false;
    };
    const updates: Record<string, string | null> = {};
    if (selFiltersRaw) {
      const kept = selFiltersRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((c) => !seedColInvalid(c));
      const next = kept.join(",");
      if (next !== selFiltersRaw) updates.sel_filters = next || null;
    }
    if (cells) {
      const kept = cells
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((clause) => {
          const body = clause.startsWith("~") ? clause.slice(1) : clause;
          const head = body.split(":", 1)[0];
          if (!head.startsWith("seed.")) return true;
          return !seedColInvalid("seed_" + head.slice(5));
        });
      const next = kept.join(",");
      if (next !== cells) updates.cells = next || null;
    }
    if (Object.keys(updates).length > 0) setUrl(updates);
  }, [seedRootId, cells, selFiltersRaw, cellList.data, setUrl]);

  // Effective selection (the "mark" set) — the bag intersected with the
  // active scope. Drives the orange highlight overlay, the NGL
  // "selected" pill count, and the table's checked-row state. The bag
  // itself is preserved across scope changes; this intersection is
  // recomputed every render so widening the scope re-surfaces members
  // that were temporarily inactive.
  const effectiveSelection = useMemo<Set<string> | null>(() => {
    if (selectionBag.length === 0) return null;
    if (!inScopeCellIds) return new Set(selectionBag);
    const out = new Set<string>();
    for (const id of selectionBag) {
      if (inScopeCellIds.has(id)) out.add(id);
    }
    return out;
  }, [selectionBag, inScopeCellIds]);
  // Visible selection as an ordered array — same content as
  // effectiveSelection but in the bag's insertion order. Used by the
  // table (selectedIds prop) and the NGL "selected" action.
  const effectiveSelectionList = useMemo<string[]>(() => {
    if (!effectiveSelection) return [];
    return selectionBag.filter((id) => effectiveSelection.has(id));
  }, [selectionBag, effectiveSelection]);

  // Batch cell_id → root_id resolution for the visible rows. The
  // resolver universe-caches per (ds, mv) server-side so a 94k-cell
  // resolution is a single CAVE round-trip; subsequent requests within
  // the same mv are dict reads. Disabled in live mode (resolver is
  // materialization-keyed in v1).
  const resolveCellIds = cellList.data?.cell_ids ?? [];
  const resolveQuery = useResolveRoots(
    ds && ft && matVersion !== "live" && resolveCellIds.length > 0
      ? {
          ds,
          featureTableId: ft,
          cellIds: resolveCellIds,
          matVersion,
        }
      : null,
  );

  // Map cell_id → resolved root_id (or null when missing/ambiguous).
  // Keyed by stringified cell_id to match the wire convention.
  const rootByCellId = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const r of resolveQuery.data?.resolutions ?? []) {
      m.set(r.cell_id, r.status === "ok" ? r.root_id : null);
    }
    return m;
  }, [resolveQuery.data]);

  // Helper: project a cell_id list through the resolver map and
  // discard unresolved ids. Used by both NGL buttons.
  const resolveRoots = (cellIds: string[]): string[] => {
    const out: string[] = [];
    for (const cid of cellIds) {
      const root = rootByCellId.get(cid);
      if (root) out.push(root);
    }
    return out;
  };

  // Cross-nav builder for the per-row "→" link in the cell-list table.
  // Inter-view (explore → neuron) so explorer URL state (ft/emb/x/y/…)
  // stays put. cells + decorations carry forward — the user's filter
  // and decoration choices belong on both sides.
  const cellCrossNavHref = useCrossNavHref({
    ds: ds ?? "",
    matVersion,
    from: `explore:${ft ?? ""}/${emb ?? ""}`,
    decorationTables,
    cells,
    inheritParams: false,
    resolveRoot: (cellId) => rootByCellId.get(cellId) ?? null,
  });

  const ngl = useNglLink();
  const openInNgl = async (cellIds: string[]) => {
    if (matVersion === "live" || !ds) return;
    const roots = resolveRoots(cellIds);
    if (roots.length === 0) return;
    // Two-stage cap: load up to NGL_LOADED_CAP into the NG state, of
    // which NGL_VISIBLE_CAP render on arrival. The user gets all the
    // ids in one click (toggle the rest inside NG) without the viewer
    // choking on geometry. When the visible cap covers the loaded set,
    // omit visibleRootIds so everything renders by default.
    const loaded = randomSubsample(roots, NGL_LOADED_CAP);
    const visible =
      loaded.length > NGL_VISIBLE_CAP
        ? randomSubsample(loaded, NGL_VISIBLE_CAP)
        : undefined;
    await ngl.open({
      kind: "segments",
      ds,
      matVersion,
      rootIds: loaded,
      visibleRootIds: visible,
    });
  };
  // Per-row NGL action — opens a single cell as a segment. Wraps the
  // bulk handler with a one-id list; reuses the same mutation +
  // error-surface so the user sees "NGL link failed" if it errors.
  const openCellInNgl = (cellId: string) => {
    void openInNgl([cellId]);
  };

  // Enrich cellList rows with the resolved root_id so PartnersTable's
  // existing rendering machinery picks it up like any other column.
  // The augmented column_groups carries a "current root" group so the
  // user can see the resolution alongside cell_id. When a selection-
  // growth probe is active, every row also gets a `__distance` field
  // pulling from the probe's per-cell-id map so the table is sortable
  // / filterable by distance immediately.
  const enrichedCells = useMemo(() => {
    if (!cellList.data) return null;
    // PartnerRecord.root_id is typed as string (non-null) for the
    // /neuron use case. In /explore the field is a *resolution* —
    // null is meaningful ("didn't resolve at this mv"). The cast
    // is safe because the cell-list table renders root_id via the
    // CopyableId path which handles null; nothing else in the
    // explorer reads this field as a non-null string.
    const rows = cellList.data.rows.map((row) => {
      // row.cell_id can be null on partner-table rows that didn't join into
      // the feature table. Skip enrichment so we never key the lookup map
      // on the literal string "null" (multiple null-cell_id rows would
      // collide on the same key and look spuriously enriched).
      const cid = row.cell_id == null ? null : String(row.cell_id);
      const enriched: Record<string, unknown> = {
        ...row,
        root_id: cid == null ? null : rootByCellId.get(cid) ?? null,
      };
      if (distanceProbe && cid != null) {
        const d = distanceProbe.byCellId.get(cid);
        // Cells outside the top-K returned by /distance_to_set (or
        // null-dropped on matrix build) have no distance value. Surface
        // as `undefined` (not `null`) so TanStack's column-level
        // `sortUndefined: "last"` sends them to the end regardless of
        // sort direction. With `null`, TanStack's "basic" sort treats
        // them as < every number ("null > x" is false for any x), so
        // ascending-by-distance puts every distance-less row at the
        // top — burying the actually-closest cells.
        enriched.__distance = d == null ? undefined : d;
      }
      return enriched;
    }) as unknown as PartnerRecord[];
    let groups = cellList.data.column_groups.map((g) =>
      g.name === "id" ? { ...g, columns: [...g.columns, "root_id"] } : g,
    );
    if (distanceProbe) {
      // Prepend a synthetic group so the distance column reads as
      // explicitly growth-driven, not part of any other namespace.
      groups = [
        {
          name: "growth",
          kind: "synthetic" as const,
          columns: ["__distance"],
        },
        ...groups,
      ];
    }
    return { rows, column_groups: groups };
  }, [cellList.data, rootByCellId, distanceProbe]);

  if (!ds) {
    return (
      <div className="explore-empty">
        <h2>Feature Explorer</h2>
        <p>Pick a datastack to begin.</p>
      </div>
    );
  }
  if (catalog.isLoading) {
    return (
      <div className="explore-empty">
        <h2>Feature Explorer</h2>
        <p>Loading catalog…</p>
      </div>
    );
  }
  if (catalog.data && !catalog.data.enabled) {
    return (
      <div className="explore-empty">
        <h2>Feature Explorer</h2>
        <p>
          The feature explorer is not configured for <code>{ds}</code>.
        </p>
      </div>
    );
  }
  if (catalog.isError) {
    return (
      <div className="explore-empty">
        <h2>Feature Explorer</h2>
        <p>Failed to load the catalog: {String(catalog.error)}</p>
      </div>
    );
  }
  if (!ft || !emb) {
    // Effect above will fill these in on the next tick.
    return (
      <div className="explore-empty">
        <h2>Feature Explorer</h2>
        <p>Initializing…</p>
      </div>
    );
  }

  return (
    <div
      className="explore"
      style={{ gridTemplateColumns: `${railWidth}px 6px 1fr` }}
    >
      <aside className="explore-rail">
        <CollapsibleSection
          title="Configuration"
          enabled
          defaultOpen
          badge={ds ?? undefined}
          summary={
            <>
              <div>
                <code>{currentFt?.title ?? ft ?? "(no feature table)"}</code>
                {" · "}
                <code>{currentEmb?.title ?? emb ?? "(no embedding)"}</code>
              </div>
              {decorationTables.map((name) => (
                <div key={name}>
                  <code>+ {name}</code>
                </div>
              ))}
            </>
          }
        >
          <FeatureTablePicker
            featureTables={featureTables}
            value={ft}
            onChange={(next) => {
              // Switching feature tables clears the embedding pick — the
              // next table has a different list. The effect above will
              // re-default emb on the following tick.
              setUrl({ ft: next, emb: null, sel_universe: null });
            }}
          />
          <EmbeddingPicker
            embeddings={currentEmbeddings}
            value={emb}
            onChange={(next) =>
              setUrl({ emb: next, sel_universe: null })
            }
          />
          {matVersion !== "live" && (
            <DecorationPicker
              ds={ds}
              matVersion={matVersion}
              attached={decorationTables}
              onChange={(next) =>
                setUrl({ dec: next.length > 0 ? next.join(",") : null })
              }
            />
          )}
        </CollapsibleSection>
        <CollapsibleSection
          title="Channels"
          enabled={!!currentFt}
          disabledHint="Pick a feature table first"
          defaultOpen
          summary={(() => {
            // Effective bindings: x/y fall back to the embedding's
            // axes when the URL hasn't overridden them; color/size are
            // pure overrides. `__distance` is a synthetic channel auto-
            // bound when the distance probe is active — it's a Grow-
            // selection side-effect rather than a user-chosen channel,
            // so don't surface it in the summary (matches the strip
            // in effectiveColorBinding).
            const effectiveX = xBinding ?? currentEmb?.axes?.[0] ?? null;
            const effectiveY = yBinding ?? currentEmb?.axes?.[1] ?? null;
            const summaryColor =
              colorBinding && colorBinding !== "__distance"
                ? colorBinding
                : null;
            const summarySize =
              sizeBinding && sizeBinding !== "__distance" ? sizeBinding : null;
            const parts: Array<[string, string]> = [];
            if (effectiveX) parts.push(["x", effectiveX]);
            if (effectiveY) parts.push(["y", effectiveY]);
            if (summaryColor) parts.push(["color", summaryColor]);
            if (summarySize) parts.push(["size", summarySize]);
            if (parts.length === 0) {
              return <span style={{ fontStyle: "italic" }}>none</span>;
            }
            return (
              <>
                {parts.map(([label, value]) => (
                  <div key={label}>
                    <code>
                      {label}: {value}
                    </code>
                  </div>
                ))}
              </>
            );
          })()}
        >
        <ChannelPicker
          featureTable={currentFt}
          cellsColumnGroups={cellList.data?.column_groups}
          hasDistanceProbe={distanceProbe != null}
          hasSeed={!!seedRootId}
          x={xBinding}
          y={yBinding}
          colorBy={colorBinding}
          sizeBy={sizeBinding}
          sizeMinPx={sizeMinPx}
          sizeMaxPx={sizeMaxPx}
          sizeBound={sizeBound}
          sizeDataMin={sizeDataMin}
          sizeDataMax={sizeDataMax}
          colorBound={colorBound}
          colorMin={colorMin}
          colorMax={colorMax}
          colorIsNumeric={
            colorBinding === "__distance"
              ? distanceProbe != null
              : scatter.data?.color?.kind === "numeric"
          }
          colormapId={colormapId}
          colorCenter={colorCenter}
          defaultXLabel={currentEmb?.axes?.[0]}
          defaultYLabel={currentEmb?.axes?.[1]}
          defaultColorLabel={currentEmb?.default_color_by ?? null}
          colorValue={colorValue}
          onRestoreDefaults={() =>
            setUrl({
              x: null,
              y: null,
              color: null,
              cv: null,
              size: null,
              size_min: null,
              size_max: null,
              size_data_min: null,
              size_data_max: null,
              color_min: null,
              color_max: null,
              cmap: null,
              color_center: null,
            })
          }
          onChange={(next) =>
            setUrl({
              ...(next.x !== undefined ? { x: next.x } : {}),
              ...(next.y !== undefined ? { y: next.y } : {}),
              ...(next.colorBy !== undefined ? { color: next.colorBy } : {}),
              ...(next.sizeBy !== undefined ? { size: next.sizeBy } : {}),
              ...(next.sizeMinPx !== undefined
                ? { size_min: String(next.sizeMinPx) }
                : {}),
              ...(next.sizeMaxPx !== undefined
                ? { size_max: String(next.sizeMaxPx) }
                : {}),
              ...(next.sizeDataMin !== undefined
                ? { size_data_min: next.sizeDataMin === null ? null : String(next.sizeDataMin) }
                : {}),
              ...(next.sizeDataMax !== undefined
                ? { size_data_max: next.sizeDataMax === null ? null : String(next.sizeDataMax) }
                : {}),
              ...(next.colorMin !== undefined
                ? { color_min: next.colorMin === null ? null : String(next.colorMin) }
                : {}),
              ...(next.colorMax !== undefined
                ? { color_max: next.colorMax === null ? null : String(next.colorMax) }
                : {}),
              ...(next.colormapId !== undefined ? { cmap: next.colormapId } : {}),
              ...(next.colorCenter !== undefined
                ? {
                    color_center:
                      next.colorCenter === null ? null : String(next.colorCenter),
                  }
                : {}),
              ...(next.colorValue !== undefined ? { cv: next.colorValue } : {}),
            })
          }
        />
        </CollapsibleSection>
        <CollapsibleSection
          title="Summary"
          enabled={!!scatter.data}
          disabledHint="Waiting for scatter data to load"
          badge={
            scatter.data
              ? `${scatter.data.n_cells.toLocaleString()} cells`
              : undefined
          }
          defaultOpen
        >
          <SummaryPanel
            scatter={scatter.data}
            inScopeCellIds={inScopeCellIds}
            selectedCellIds={effectiveSelection}
            ds={ds}
            featureTable={currentFt}
            cellsColumnGroups={cellList.data?.column_groups}
            matVersion={matVersion}
            decorationTables={decorationTables}
          />
        </CollapsibleSection>
        {ds && ft && (
          <CollapsibleSection
            title="Build selection"
            enabled
            headerAction={
              // Find cells lives in this header because it's
              // structurally another way to build a selection — paste
              // ids in, get cells resolved into the bag. Same destination
              // as the predicate builder below, different input path.
              <CellIdSearch
                ds={ds}
                featureTableId={ft}
                matVersion={matVersion}
                universeCellIds={universeCellIds}
                onReplaceSelection={replaceSelection}
                onUnionIntoSelection={unionIntoSelection}
                onFitToSelection={fitToSelection}
              />
            }
          >
            <SelectionBuilderPanel
              ds={ds}
              featureTableId={ft}
              featureTable={currentFt}
              cellsColumnGroups={cellList.data?.column_groups}
              matVersion={matVersion}
              decorationTables={decorationTables}
              seedRootId={seedRootId}
              onReplaceSelection={replaceSelection}
              onUnionIntoSelection={unionIntoSelection}
              onApplyFilterScope={(s) => setCells(s.length > 0 ? s : null)}
            />
          </CollapsibleSection>
        )}
        {ds && ft && (
          <CollapsibleSection
            title="Grow selection"
            // Always enabled — the user can tune options (space, K, PCA
            // variance, feature checklist) without having a selection
            // yet. Only "Compute distances" needs a populated bag, and
            // that button gates itself via `computeDisabled` inside
            // GrowSelectionPanel.
            enabled
            badge={`${selectionBag.length.toLocaleString()} seed${
              selectionBag.length === 1 ? "" : "s"
            }`}
          >
            <GrowSelectionPanel
              ds={ds}
              featureTableId={ft}
              featureTable={currentFt}
              embeddingId={emb}
              selectionBag={selectionBag}
              distanceProbe={distanceProbe}
              onDistanceProbe={setDistanceProbe}
              onUnionIntoSelection={unionIntoSelection}
              onReplaceSelection={replaceSelection}
            />
          </CollapsibleSection>
        )}
        {/* Connectivity seed sits last in the rail — it's an optional
            cross-tool input layered on top of the embedding workflow,
            not part of the core configure → channels → select flow. */}
        <CollapsibleSection
          title="Connectivity seed"
          // Disabled in live mode — the seed mechanism resolves cell_ids
          // through the universe cache, which only exists at frozen
          // materialization versions.
          enabled={matVersion !== "live"}
          disabledHint="Set a materialization version first (live mode has no universe cache)"
          defaultOpen={!!seedRootId}
          badge={seedRootId ? "seeded" : undefined}
          summary={
            seedRootId ? (
              <div>
                <code>{seedRootId}</code>
              </div>
            ) : undefined
          }
        >
          <ConnectivitySeedWidget
            ds={ds}
            featureTableId={ft}
            matVersion={matVersion}
            seedRootId={seedRootId}
            onChange={(next) => setSeedRootId(next)}
            markSeed={markSeed}
            onMarkSeedChange={setMarkSeed}
          />
        </CollapsibleSection>
      </aside>
      {/* Vertical drag handle between rail and scatter. Hover state in
          CSS; the active class comes from the hook's isDragging flag
          so the handle stays highlighted while the user is mid-drag
          even after the cursor leaves its bounds. */}
      <div
        className={`explore-rail-handle${railResizing ? " dragging" : ""}`}
        onMouseDown={beginRailResize}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize feature explorer rail"
        title="Drag to resize rail"
      />
      <section className={`explore-center${tableOpen ? " table-open" : ""}`}>
        <div className="explore-scatter-wrap">
          <UniverseScatter
            ref={scatterRef}
            ds={ds}
            featureTableId={ft}
            embeddingId={emb}
            x={xBinding}
            y={yBinding}
            colorBy={effectiveColorBinding}
            sizeBy={effectiveSizeBinding}
            seedRootId={seedRootId}
            seedCellId={markSeed ? seedCellId : null}
            baseColor={colorBinding === "__none__" ? colorValue : null}
            distanceColorMap={
              colorBinding === "__distance" && distanceProbe
                ? distanceProbe.byCellId
                : null
            }
            distanceSizeMap={
              sizeBinding === "__distance" && distanceProbe
                ? distanceProbe.byCellId
                : null
            }
            sizeMinPx={sizeMinPx}
            sizeMaxPx={sizeMaxPx}
            sizeDataMin={sizeDataMin}
            sizeDataMax={sizeDataMax}
            colorMin={colorMin}
            colorMax={colorMax}
            colormapId={colormapId}
            colorCenter={colorCenter}
            decorationTables={decorationTables}
            matVersion={matVersion}
            inScopeCellIds={inScopeCellIds}
            selectedCellIds={effectiveSelection}
            scopeMode={scopeMode}
            onLassoSelect={(polygonIds, mode) => {
              // Modifier semantics, Photoshop/Figma/Finder-style:
              //   replace (no modifier) — drop the in-scope portion of
              //     the bag and replace it with the lasso (out-of-scope
              //     members from e.g. Cell ID Search are preserved).
              //   add (Shift)          — union the lasso into the bag.
              //   subtract (Alt/Option) — remove the lassoed cells.
              // polygonIds are guaranteed in-scope (hit-test filters
              // out-of-scope), so add/subtract can ignore the in-scope
              // partition.
              if (mode === "add") {
                unionIntoSelection(polygonIds);
              } else if (mode === "subtract") {
                subtractFromSelection(polygonIds);
              } else {
                setSelectionBag((prev) => {
                  if (!inScopeCellIds) return polygonIds;
                  const preserved = prev.filter(
                    (id) => !inScopeCellIds.has(id),
                  );
                  return [...preserved, ...polygonIds];
                });
              }
            }}
          />
        </div>
        {/* Drawer: handle always visible; body only when open. */}
        <div className={`explore-drawer${tableOpen ? " open" : ""}`}>
          <button
            type="button"
            className="explore-drawer-handle"
            onClick={() => setTable(tableOpen ? null : "open")}
            aria-expanded={tableOpen}
            title={tableOpen ? "Hide cell table" : "Show cell table"}
          >
            {/* Table-shaped icon so the handle reads as "tabular cell
                data" rather than just a generic expand chevron. Inline
                SVG (rather than a Unicode glyph) so it renders
                consistently across platforms at this small size. */}
            <svg
              className="explore-drawer-icon"
              width="14"
              height="14"
              viewBox="0 0 14 14"
              aria-hidden="true"
            >
              <rect
                x="1.5"
                y="1.5"
                width="11"
                height="11"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                rx="1.5"
              />
              <line x1="1.5" y1="5" x2="12.5" y2="5" stroke="currentColor" strokeWidth="1" />
              <line x1="1.5" y1="9" x2="12.5" y2="9" stroke="currentColor" strokeWidth="1" />
              <line x1="6" y1="1.5" x2="6" y2="12.5" stroke="currentColor" strokeWidth="1" />
            </svg>
            <span className="explore-drawer-toggle">{tableOpen ? "▾" : "▴"}</span>
            <span className="explore-drawer-count">
              {cellList.data ? (
                <>
                  <strong>{cellList.data.matched_count.toLocaleString()}</strong>
                  {" of "}
                  <strong>{cellList.data.total_count.toLocaleString()}</strong>
                  {" cells"}
                  {cellList.data.limit_hit && (
                    <em>
                      {" "}— capped at {cellList.data.limit.toLocaleString()}
                    </em>
                  )}
                </>
              ) : cellList.isLoading ? (
                "Loading cells…"
              ) : cellList.isError ? (
                <span className="error">Failed: {String(cellList.error)}</span>
              ) : (
                ""
              )}
            </span>
            {/* Filter menu — popover lives in the drawer header so the
                user edits the filter next to the table the filter
                affects. The whole drawer-handle is a button, so the
                pill wrapper stops propagation to prevent a filter
                click from toggling the drawer open/closed. */}
            <span
              className="explore-pill-wrap"
              onClick={(e) => e.stopPropagation()}
              role="presentation"
            >
              <CellFilterMenu
                columnGroups={cellList.data?.column_groups}
                sampleRows={cellList.data?.rows}
                className="explore-filter-pill"
                placement="up"
                categoriesByTable={
                  currentFt && currentFt.categories.length > 0
                    ? { [currentFt.id]: currentFt.categories }
                    : undefined
                }
                availableValues={tableValues.values}
                scopeMode={scopeMode}
                onScopeModeChange={(next) =>
                  // Default ghost: only emit "hide" to URL state, so the
                  // common case stays out of the share-link param soup.
                  setScopeModeRaw(next === "hide" ? "hide" : null)
                }
                selectionBagCount={selectionBag.length}
                onFilterToSelection={() => {
                  // Snapshot copies the bag; the bag itself is untouched.
                  // If a predicate scope is also active, snapshotting
                  // wins (CellFilterMenu's header reflects "snapshot"
                  // and the predicate editor greys out). Clearing scope
                  // returns to predicate / universe — bag survives both.
                  setDirectScopeBag([...selectionBag]);
                }}
                directScopeCount={directScopeBag.length}
                onClearScope={() => {
                  // Clear both sources in one click — the most common
                  // "back to the full universe" gesture. Bag is
                  // untouched; widening the scope re-surfaces any
                  // previously inactive members.
                  setDirectScopeBag([]);
                  setCells(null);
                }}
              />
            </span>
            {/* NGL group — visible + selected open cells in
                Neuroglancer. Internal flex-wrap: nowrap keeps the
                two pills together; the outer toolbar wraps on group
                boundaries. */}
            <span className="explore-pill-group">
              <NglActionPill
                label="visible"
                count={cellList.data?.matched_count ?? 0}
                disabled={
                  !cellList.data ||
                  cellList.data.matched_count === 0 ||
                  matVersion === "live" ||
                  ngl.isPending
                }
                liveDisabled={matVersion === "live"}
                onOpen={() =>
                  cellList.data && openInNgl(cellList.data.cell_ids)
                }
              />
              <NglActionPill
                label="selected"
                count={effectiveSelectionList.length}
                bagTotal={selectionBag.length}
                disabled={
                  effectiveSelectionList.length === 0 ||
                  matVersion === "live" ||
                  ngl.isPending
                }
                liveDisabled={matVersion === "live"}
                onOpen={() => openInNgl(effectiveSelectionList)}
                accent="warm"
              />
            </span>
            {/* Selection group — clear + save + sets. Kept together
                because they're "things that act on the selection bag"
                and reading them as a cluster is clearer than reading
                them next to the NGL actions. */}
            <span className="explore-pill-group">
              <ClearPill
                label="selection"
                active={selectionBag.length > 0}
                onClear={() => setSelectionBag([])}
                variant="rowsel"
              />
              {/* Save the current selection as a named cell set. The
                  prompt renders as an anchored popover (no layout shift
                  on the sibling pills); mirrors SavedSetsMenu's idiom. */}
              <span
                ref={saveMenuRef}
                className="save-selection-menu"
                onClick={(e) => e.stopPropagation()}
                role="presentation"
              >
                <span
                  role="button"
                  className={`explore-save-pill${
                    selectionBag.length === 0 ? " disabled" : ""
                  }`}
                  aria-disabled={selectionBag.length === 0}
                  aria-expanded={savePromptOpen}
                  title={
                    selectionBag.length === 0
                      ? "Make a selection first"
                      : `Save all ${selectionBag.length.toLocaleString()} selected cells as a named set (includes any out-of-scope members)`
                  }
                  onClick={() => {
                    if (selectionBag.length === 0) return;
                    if (savePromptOpen) {
                      closeSavePrompt();
                    } else {
                      openSavePrompt();
                    }
                  }}
                >
                  ★ Save<span className="explore-pill-suffix"> selection</span>
                </span>
                {savePromptOpen && selectionBag.length > 0 && (
                  <div className="save-selection-popover cell-filter-menu-popover-up">
                    <input
                      type="text"
                      className="explore-save-prompt-input"
                      value={saveDraftName}
                      autoFocus
                      onChange={(e) => setSaveDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitSavePrompt();
                        if (e.key === "Escape") closeSavePrompt();
                      }}
                    />
                    <button
                      type="button"
                      className="explore-save-prompt-ok"
                      onClick={commitSavePrompt}
                      title="Save"
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      className="explore-save-prompt-cancel"
                      onClick={closeSavePrompt}
                      title="Cancel"
                    >
                      ×
                    </button>
                  </div>
                )}
              </span>
              {/* Saved sets popover — sibling to Save selection. */}
              <span
                className="explore-pill-wrap"
                onClick={(e) => e.stopPropagation()}
                role="presentation"
              >
                <SavedSetsMenu
                  selections={namedSelections.selections}
                  currentSelection={selectionBag}
                  onLoad={(s: NamedSelection) => replaceSelection(s.cellIds)}
                  onAdd={(s: NamedSelection) => unionIntoSelection(s.cellIds)}
                  onSubtract={(s: NamedSelection) => subtractFromSelection(s.cellIds)}
                  onRename={(s: NamedSelection, name: string) =>
                    namedSelections.rename(s.id, name)
                  }
                  onRemove={(s: NamedSelection) => namedSelections.remove(s.id)}
                />
              </span>
            </span>
          </button>
          {tableOpen && enrichedCells && enrichedCells.rows.length > 0 && (
            <div className="explore-drawer-body">
              {ngl.isError && (
                <div className="explore-ngl-error">
                  NGL link failed: {String(ngl.error)}
                </div>
              )}
              <PartnersTable
                ds={ds}
                rootId={ft}
                matVersion={matVersion}
                direction="both"
                rows={
                  seedViewActive && seedRootId
                    ? enrichedCells.rows.filter(
                        (r) => (r.seed_is_partner as number | undefined) === 1,
                      )
                    : enrichedCells.rows
                }
                columnGroups={enrichedCells.column_groups}
                extraActions={
                  seedRootId ? (
                    <button
                      type="button"
                      className={`seed-view-toggle${seedViewActive ? " active" : ""}`}
                      onClick={() => setSeedViewActive((v) => !v)}
                      title={
                        seedViewActive
                          ? "Showing only cells that are partners of the seed — click to clear"
                          : "Filter to cells that are partners of the active seed"
                      }
                    >
                      {seedViewActive ? "Seed view ✓" : "Seed view"}
                    </button>
                  ) : undefined
                }
                decorationTables={decorationTables}
                keyColumn="cell_id"
                // Resolve cell_id → root_id at the active mv. Cells
                // that didn't resolve (missing / ambiguous / not yet
                // resolved / live mode) get a "#" href from the
                // resolver below so the link is visually present but
                // doesn't navigate. Inter-view cross-nav: explorer URL
                // state stays put rather than polluting /neuron.
                crossNavHref={cellCrossNavHref}
                enableNglAction={false}
                rowsLabel="cells"
                selectedIds={effectiveSelectionList}
                onSelectedIdsChange={(ids) => {
                  // Table row checkboxes only report the in-scope subset
                  // (only in-scope rows are visible). Preserve any
                  // out-of-scope bag members across the update so a
                  // row-toggle doesn't silently drop them.
                  setSelectionBag((prev) => {
                    if (!inScopeCellIds) return ids;
                    const preserved = prev.filter(
                      (id) => !inScopeCellIds.has(id),
                    );
                    return [...preserved, ...ids];
                  });
                }}
                onRowNglClick={openCellInNgl}
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

