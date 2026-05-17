import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import type { ConnectivityBundle } from "../api/types";
import type { PlotBindings } from "../api/queries";
import { useUrlParam } from "../hooks/useUrlState";
import {
  type ColumnBoundPlotDescriptor,
  type PlotDescriptor,
  useResolvedPlotRegistry,
} from "../plots/registry";
import {
  STATIC_PLOT_PRESETS,
  availableColumns,
  availableMeasures,
  categoricalColumnsByTable,
  missingRequirements,
  presetIsAvailable,
  summaryAvailable,
  summaryUnavailableReason,
  type MeasureChoice,
  type SummaryKind,
} from "../plots/presets";
import {
  encodePlotsList,
  encodeSelParam,
  encodeVizParam,
  isSelKey,
  newPlotId,
  parsePlotsList,
  PLOTS_KEY,
  selKey,
  vizParamKey,
} from "../plots/urlState";
import { listVizColumns } from "../plots/vizColumns";
import { useTablesUniqueValues } from "../api/queries";
import { CellFilterMenu } from "./CellFilterMenu";
import { DynamicPlotPanel } from "./DynamicPlotPanel";
import { PlotPanel } from "./PlotPanel";
import {
  findSummaryPanel,
  SUMMARY_PANEL_RENDERERS,
  summaryKindFromPanelId,
} from "./SummaryPanels";

interface Props {
  ds: string;
  rootId: string;
  matVersion: number | "live";
  bundle: ConnectivityBundle;
  decorationTables: string[];
  /** Global cell filter from `?cells=` — applied uniformly to every plot in
   *  the rail. The CellFilterPanel sidebar control owns writes; AnalyticsRail
   *  is read-only here. */
  cells?: string | null;
}

/**
 * Renders the left-pane analytics rail.
 *
 * Three panel types:
 *   - **Static** (registry-defined): fixed backend spec, no runtime config.
 *   - **Column-bound** (registry-defined, legacy): single x-axis picker;
 *     auto-dispatches between bar and histogram backend specs based on
 *     column kind. Persists the binding via `?viz_<id>=<col>`.
 *   - **Dynamic** (runtime-creatable): user adds via "+ Add plot"; each
 *     panel exposes x/y/hue/size pickers; backend auto-picks chart kind
 *     (1 axis → histogram, 2 axes → scatter). Active dynamic panels live
 *     in URL state at `?plots=<id>,<id>,...`. Each panel's bindings live
 *     at `?viz_<id>={...json...}`.
 *
 * Adding a new panel = appending to the `?plots=` list with a fresh id.
 * Removing one = dropping the id and clearing its `?viz_<id>=` key.
 */
export function AnalyticsRail({ ds, rootId, matVersion, bundle, decorationTables, cells }: Props) {
  const [plotsRaw] = useUrlParam(PLOTS_KEY);
  const [searchParams, setSearchParams] = useSearchParams();
  const dynamicPanelIds = useMemo(() => parsePlotsList(plotsRaw), [plotsRaw]);
  const resolvedRegistry = useResolvedPlotRegistry();

  // react-router's setSearchParams gets a fresh identity on every URL change
  // (its useCallback deps include the current search). Latching it through a
  // ref gives us a stable indirection so downstream callbacks (and the per-plot
  // handlers below) don't churn whenever the URL changes — which would defeat
  // the whole point of memoizing them.
  const setSearchParamsRef = useRef(setSearchParams);
  useEffect(() => {
    setSearchParamsRef.current = setSearchParams;
  }, [setSearchParams]);

  // Add a new analytics-rail panel. Three flavours, distinguished by
  // the panel id prefix the SPA generates here:
  //   - `dyn-<rand>`  : bindings-driven dynamic panel. `bindings` set →
  //                     seed `?viz_<id>=` so the chart renders configured
  //                     on first paint. `bindings` absent → blank panel
  //                     for the user to configure ("Custom plot…").
  //   - `sum-<kind>-<rand>` : summary panel (per-cell figure rendered
  //                     by a dedicated component). No `?viz_<id>=` —
  //                     the data comes from `bundle.<kind>` directly.
  // Either way it's a single navigation entry — no double history push,
  // no flicker between blank and seeded states.
  const addDynamicPanel = useCallback(
    (opts?: { bindings?: PlotBindings; summaryKind?: SummaryKind }) => {
      const id = opts?.summaryKind
        ? `sum-${opts.summaryKind.replace(/_/g, "-")}-${Math.random().toString(36).slice(2, 8)}`
        : newPlotId();
      setSearchParamsRef.current((prev) => {
        const next = new URLSearchParams(prev);
        next.set(PLOTS_KEY, encodePlotsList([...dynamicPanelIds, id]));
        if (opts?.bindings) {
          const encoded = encodeVizParam(opts.bindings);
          if (encoded !== "{}") next.set(vizParamKey(id), encoded);
        }
        return next;
      });
    },
    [dynamicPanelIds],
  );

  // Reorder a panel by swapping it with its immediate neighbor. The
  // panel order lives in `?plots=` (comma-separated id list), so a
  // reorder is just a single URL write — no cross-component state to
  // keep in sync. `delta` is -1 for move-up, +1 for move-down. No-ops
  // at the edges so the caller can wire onMoveUp/onMoveDown directly
  // without first checking position.
  const movePanel = useCallback((id: string, delta: -1 | 1) => {
    setSearchParamsRef.current((prev) => {
      const params = new URLSearchParams(prev);
      const list = parsePlotsList(params.get(PLOTS_KEY));
      const i = list.indexOf(id);
      if (i < 0) return params;
      const j = i + delta;
      if (j < 0 || j >= list.length) return params;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      params.set(PLOTS_KEY, encodePlotsList(next));
      return params;
    });
  }, []);

  // Drop the panel id from `?plots=` and clear its `?viz_<id>=` / `?sel_<id>=`
  // keys atomically. One setSearchParams call so the three writes don't race
  // against each other (each call's `prev` is the latest react-router state,
  // but multiple calls in the same tick stack functional updaters).
  const removeDynamicPanel = (id: string) => {
    const remaining = dynamicPanelIds.filter((p) => p !== id);
    setSearchParamsRef.current(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (remaining.length > 0) next.set(PLOTS_KEY, encodePlotsList(remaining));
        else next.delete(PLOTS_KEY);
        next.delete(vizParamKey(id));
        next.delete(selKey(id));
        return next;
      },
      { replace: true },
    );
  };

  /**
   * Write a brush selection from a dynamic panel into the URL. PlotPanel
   * never hands us an empty list (clearing is the brush-pill button), so
   * this only ever sets the key. `replace: true` keeps the back button
   * from filling with brush events.
   */
  const writePlotSelection = useCallback(
    (plotId: string, source: "partners_in" | "partners_out" | "partners_both", ids: string[]) => {
      const key = selKey(plotId);
      setSearchParamsRef.current(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(key, encodeSelParam({ source, ids }));
          return next;
        },
        { replace: true },
      );
    },
    [],
  );

  // Per-plot selection handlers — memoized so each `<DynamicPlotPanel>` sees a
  // stable `onSelected` reference, which keeps PlotPanel's `handleSelected`
  // stable, which prevents react-plotly's syncEventHandlers from unbinding /
  // rebinding the listener on every parent re-render. (See the phantom-event
  // explanation in PlotPanel.)
  const selectionHandlers = useMemo(() => {
    const map = new Map<string, (ids: string[]) => void>();
    for (const id of dynamicPanelIds) {
      map.set(id, (ids) => writePlotSelection(id, "partners_both", ids));
    }
    return map;
  }, [dynamicPanelIds, writePlotSelection]);

  // Column space the bundle currently exposes — drives the
  // preset-availability check. Memoized on `bundle.column_groups` so adding
  // a decoration table re-evaluates which presets enable / disable.
  const available = useMemo(() => availableColumns(bundle), [bundle]);

  // Open/close state for the "+ Add plot" menu. Lives in React state
  // (not a `<details>` element) so the popover can render via a portal —
  // necessary because the rail itself has `overflow-y: auto`, which
  // clips an absolutely-positioned popover anchored to a child. The
  // portal escapes the scroll container; the position is computed from
  // the trigger's bounding rect each time the menu opens.
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const handleAddPanel = useCallback(
    (opts?: { bindings?: PlotBindings; summaryKind?: SummaryKind }) => {
      addDynamicPanel(opts);
      setAddMenuOpen(false);
    },
    [addDynamicPanel],
  );

  // Brush selections live at `?sel_<id>=` URL keys. Counting how many
  // panels currently contribute a selection drives a top-of-rail
  // "Clear all brushes" button — discoverable enough that the user
  // doesn't have to remember which panel they brushed when they want
  // to start fresh. Per-tab brush pills in PartnersPane still work
  // for tab-scoped clears; this is the global escape hatch.
  const activeBrushPanels = useMemo(() => {
    let n = 0;
    for (const k of searchParams.keys()) if (isSelKey(k)) n += 1;
    return n;
  }, [searchParams]);

  const clearAllBrushes = useCallback(() => {
    setSearchParamsRef.current((prev) => {
      const next = new URLSearchParams(prev);
      for (const k of [...next.keys()]) {
        if (isSelKey(k)) next.delete(k);
      }
      return next;
    });
  }, []);

  // Sample rows for the cell-filter column-kind inference. The filter
  // scopes every plot in the rail, so its column-type evidence comes
  // from the same connectivity bundle the plots themselves render.
  const filterSampleRows = useMemo(
    () => [...(bundle.partners_in ?? []), ...(bundle.partners_out ?? [])],
    [bundle.partners_in, bundle.partners_out],
  );
  // Distinct-value universe for every attached decoration table so the
  // predicate builder shows categorical dropdowns / checkbox lists
  // instead of free-text. Reuses the 7-day immutable
  // `dcv_unique_values_cache` keyed by (ds, mv, table); the same fetch
  // backs the table view's column filters, so cross-navigated pages
  // typically have warm cache hits.
  const tableValues = useTablesUniqueValues(ds, decorationTables, matVersion);

  return (
    <div className="plots">
      <div className="rail-header">
        {/* Cell filter sits at the LEFT of the rail header. In the
            connectivity context, `?cells=` is the per-plot filter that
            decides which cells contribute to each plot — called "Plot
            Scope" here to distinguish from the explorer's
            workspace-wide scope semantics. The popover keeps the
            editing UI compact so it doesn't displace the plots
            themselves. */}
        <CellFilterMenu
          label="Plot Scope"
          columnGroups={bundle.column_groups}
          sampleRows={filterSampleRows}
          availableValues={tableValues.values}
        />
        <button
          type="button"
          className="rail-clear-brushes"
          onClick={clearAllBrushes}
          disabled={activeBrushPanels === 0}
          title={
            activeBrushPanels === 0
              ? "No active plot brushes"
              : `Clear plot brush selection on ${activeBrushPanels} panel${activeBrushPanels === 1 ? "" : "s"}`
          }
        >
          {activeBrushPanels === 0
            ? "No brushes"
            : `Clear ${activeBrushPanels} brush${activeBrushPanels === 1 ? "" : "es"}`}
        </button>
      </div>
      {resolvedRegistry.map((d) =>
        d.kind === "static" ? (
          <PlotPanel
            key={d.id}
            ds={ds}
            spec={d.spec}
            rootId={rootId}
            matVersion={matVersion}
            cells={cells}
            height={260}
          />
        ) : d.kind === "column-bound" ? (
          <ColumnBoundPlot
            key={d.id}
            descriptor={d}
            ds={ds}
            rootId={rootId}
            matVersion={matVersion}
            bundle={bundle}
            decorationTables={decorationTables}
            cells={cells}
          />
        ) : null,
      )}
      {dynamicPanelIds.map((id, idx) => {
        // Reorder controls: ↑ disabled at top, ↓ disabled at bottom.
        // Both pass through to `movePanel` which writes the swapped
        // list to `?plots=`.
        const onMoveUp = idx > 0 ? () => movePanel(id, -1) : undefined;
        const onMoveDown = idx < dynamicPanelIds.length - 1 ? () => movePanel(id, 1) : undefined;
        // Summary panels — id-prefix dispatch via the registry in
        // `SummaryPanels.tsx`. The renderer renders null on its own when
        // its bundle data is absent, so a stale `?plots=` from a prior
        // datastack with a configured profile won't crash on a new
        // datastack without one — just silently disappears.
        const summaryKind = summaryKindFromPanelId(id);
        if (summaryKind) {
          const Renderer = SUMMARY_PANEL_RENDERERS[summaryKind];
          if (Renderer) {
            return (
              <Renderer
                key={id}
                panel={findSummaryPanel(bundle, summaryKind)}
                bundle={bundle}
                onClose={() => removeDynamicPanel(id)}
                onMoveUp={onMoveUp}
                onMoveDown={onMoveDown}
              />
            );
          }
        }
        return (
          <DynamicPlotPanel
            key={id}
            descriptor={{
              id,
              title: "Custom plot",
              kind: "dynamic",
              spec: "dynamic",
            }}
            ds={ds}
            rootId={rootId}
            matVersion={matVersion}
            bundle={bundle}
            decorationTables={decorationTables}
            cells={cells}
            onClose={() => removeDynamicPanel(id)}
            onMoveUp={onMoveUp}
            onMoveDown={onMoveDown}
            onSelected={selectionHandlers.get(id)}
          />
        );
      })}
      <div className="add-plot-row">
        <button
          ref={addButtonRef}
          type="button"
          className={`add-plot-button${addMenuOpen ? " open" : ""}`}
          title="Add a new plot panel"
          aria-expanded={addMenuOpen}
          aria-haspopup="menu"
          onClick={() => setAddMenuOpen((v) => !v)}
        >
          + Add plot <span className="chevron">▾</span>
        </button>
      </div>
      {addMenuOpen && (
        <AddPlotPopover
          anchorRef={addButtonRef}
          bundle={bundle}
          available={available}
          onClose={() => setAddMenuOpen(false)}
          onPick={handleAddPanel}
        />
      )}
    </div>
  );
}

interface AddPlotPopoverProps {
  anchorRef: React.RefObject<HTMLButtonElement>;
  bundle: ConnectivityBundle;
  available: Set<string>;
  onClose: () => void;
  onPick: (opts?: { bindings?: PlotBindings; summaryKind?: SummaryKind }) => void;
}

/**
 * Portal-rendered popover for the "+ Add plot" menu. Positions itself
 * with `position: fixed` from the trigger button's bounding rect, so
 * it isn't clipped by the analytics rail's `overflow-y: auto`. Picks
 * direction based on space available below the trigger — opens upward
 * only when the menu's natural height won't fit underneath. Closes on
 * Escape, click-outside, and window resize / scroll (so a stale fixed
 * position doesn't drift away from the trigger).
 */
function AddPlotPopover({ anchorRef, bundle, available, onClose, onPick }: AddPlotPopoverProps) {
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);

  // Recompute the popover's fixed position from the trigger's rect.
  // Runs whenever the popover mounts or its measured height changes,
  // and whenever the viewport scrolls/resizes.
  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const gap = 4;
    const margin = 8;  // breathing room from viewport edges
    const popHeight = popoverRef.current?.offsetHeight ?? 0;
    const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
    const spaceAbove = rect.top - gap - margin;
    // Open downward by default; flip up only when the natural height
    // doesn't fit below AND there's clearly more room above. The
    // popover has its own scroll, so when neither direction fits we
    // prefer downward (the user expects the menu to open under the
    // button) and let max-height clamp it.
    const openUp = popHeight > spaceBelow && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, openUp ? spaceAbove : spaceBelow);
    setPos({
      left: rect.left,
      top: openUp ? Math.max(margin, rect.top - gap - Math.min(popHeight, maxHeight)) : rect.bottom + gap,
      width: rect.width,
      maxHeight,
    });
  }, [anchorRef]);

  // Position on mount, then again once the popover has its natural
  // height (so the up/down decision uses the real measurement).
  useLayoutEffect(() => {
    reposition();
  }, [reposition]);
  useEffect(() => {
    // Second pass after first paint — popoverRef.current.offsetHeight
    // is now meaningful, so the up/down flip can use it.
    reposition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reposition on viewport changes. Don't auto-close on scroll inside
  // the rail — the user might scroll a long preset list and that
  // shouldn't dismiss the menu.
  useEffect(() => {
    const onResize = () => reposition();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);  // capture so any nested scroll triggers
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [reposition]);

  // Click-outside + Escape to close. Click-outside listens on
  // `mousedown` so it fires before any inner button's `click`, but
  // we exclude both the popover and the trigger so clicking the
  // trigger again toggles cleanly.
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchorRef, onClose]);

  const style: React.CSSProperties = pos
    ? {
        position: "fixed",
        left: pos.left,
        top: pos.top,
        minWidth: pos.width,
        maxHeight: pos.maxHeight,
      }
    : { position: "fixed", visibility: "hidden" };  // first paint, before measurement

  return createPortal(
    <div ref={popoverRef} className="add-plot-popover" style={style} role="menu">
      <DrillContent
        bundle={bundle}
        available={available}
        onPick={onPick}
        onLevelChange={reposition}
      />
    </div>,
    document.body,
  );
}

type Direction = "out" | "in";
type DrillStage = "direction" | "measure" | "table" | "column";
interface DrillState {
  direction?: Direction;
  measure?: MeasureChoice;
  table?: string;
}

interface DrillContentProps {
  bundle: ConnectivityBundle;
  available: Set<string>;
  onPick: (opts?: { bindings?: PlotBindings; summaryKind?: SummaryKind }) => void;
  /** Called whenever the visible level changes — the popover's height
   *  shifts so the parent should re-measure & reposition (otherwise an
   *  upward-opening menu drifts as content grows/shrinks). */
  onLevelChange: () => void;
}

/**
 * Drill-down navigation inside the "+ Add plot" popover.
 *
 * Levels: direction → measure → table → column. At the leaf (column
 * click) the final `PlotBindings` is materialized from the picks and
 * handed to `onPick`. The "direction" level also hosts the Custom plot
 * shortcut and the table-agnostic static presets (soma depth, top-down
 * layout, synapse depth profile) — those don't fit the breakdown axis,
 * so they live alongside the drill-in entries rather than inside one.
 *
 * Levels with a single available option auto-skip: e.g. when the
 * datastack has no `net_size` aggregation, "measure" silently advances
 * past itself with `count` selected. The `userActions` stack remembers
 * which level the user explicitly clicked, so back undoes the visible
 * step (and wipes the auto-set field with it) instead of going back
 * one logical level and immediately auto-skipping forward again.
 */
function DrillContent({ bundle, available, onPick, onLevelChange }: DrillContentProps) {
  const [state, setState] = useState<DrillState>({});
  const [userActions, setUserActions] = useState<DrillStage[]>([]);

  const measures = useMemo(() => availableMeasures(bundle), [bundle]);
  const tables = useMemo(() => categoricalColumnsByTable(bundle), [bundle]);

  const stage: DrillStage =
    !state.direction ? "direction"
      : !state.measure ? "measure"
        : !state.table ? "table"
          : "column";

  // Auto-skip levels with a single option. Runs after each setState
  // so a manual pick that lands on a one-option level descends one
  // more rung without requiring the user to click "the only choice".
  useEffect(() => {
    if (stage === "measure" && measures.length === 1) {
      setState((s) => ({ ...s, measure: measures[0] }));
      return;
    }
    if (stage === "table" && tables.length === 1) {
      setState((s) => ({ ...s, table: tables[0].table }));
      return;
    }
  }, [stage, measures, tables]);

  // Reposition the parent popover whenever the level changes — content
  // height shifts (the column list is much taller than the direction
  // picker), and an upward-opening menu would otherwise drift up off
  // the screen as it grew.
  useEffect(() => {
    onLevelChange();
  }, [stage, onLevelChange]);

  const advance = (action: DrillStage, value: Direction | MeasureChoice | string) => {
    setUserActions((prev) => [...prev, action]);
    setState((prev) => ({ ...prev, [action]: value }));
  };

  // Back wipes everything from the last user-set field onward — that
  // way an auto-skipped child field clears alongside its parent, and
  // the auto-skip effect re-fires cleanly on the new (earlier) stage.
  const back = () => {
    if (userActions.length === 0) return;
    const last = userActions[userActions.length - 1];
    setUserActions((prev) => prev.slice(0, -1));
    setState((prev) => {
      const next = { ...prev };
      const order: DrillStage[] = ["direction", "measure", "table", "column"];
      const idx = order.indexOf(last);
      for (let i = idx; i < order.length; i++) {
        delete next[order[i] as keyof DrillState];
      }
      return next;
    });
  };

  // Friendly verb form per direction; reused in breadcrumbs + buttons
  // so the menu reads consistently.
  const directionLabel = (d: Direction) => (d === "out" ? "Output" : "Input");

  // Breadcrumb shown above non-root levels. The ← button is the back
  // affordance; the path text is informational.
  const Crumb = () => {
    if (stage === "direction") return null;
    const parts: string[] = [];
    if (state.direction) parts.push(directionLabel(state.direction));
    if (state.measure) parts.push(state.measure.label.split(" ")[0]);  // "Number" / "Mass"
    if (state.table) parts.push(state.table);
    return (
      <div className="add-plot-crumb">
        <button
          type="button"
          className="add-plot-back"
          onClick={back}
          title="Back"
          aria-label="Back"
        >
          ←
        </button>
        <span className="add-plot-crumb-path">{parts.join(" › ")}</span>
      </div>
    );
  };

  if (stage === "direction") {
    return (
      <>
        <button
          type="button"
          className="add-plot-option"
          onClick={() => onPick()}
          title="Empty panel — pick channels yourself"
        >
          Custom plot…
        </button>
        <div className="add-plot-divider">Categorical bar charts</div>
        {tables.length === 0 ? (
          <div className="add-plot-empty">No categorical decoration columns loaded</div>
        ) : (
          <>
            <button
              type="button"
              className="add-plot-option drill"
              onClick={() => advance("direction", "out")}
              title="Bar chart of output partners grouped by a categorical column"
            >
              Output partners… <span className="chevron">▸</span>
            </button>
            <button
              type="button"
              className="add-plot-option drill"
              onClick={() => advance("direction", "in")}
              title="Bar chart of input partners grouped by a categorical column"
            >
              Input partners… <span className="chevron">▸</span>
            </button>
          </>
        )}
        <div className="add-plot-divider">Other plots</div>
        {STATIC_PLOT_PRESETS.map((p) => {
          const summary = summaryAvailable(p, bundle);
          const isSummary = summary !== null;
          const enabled = isSummary ? !!summary : presetIsAvailable(p, available);
          const tooltip = enabled
            ? p.description ?? p.label
            : isSummary
              ? summaryUnavailableReason(p, bundle) ?? "Unavailable"
              : `Needs: ${missingRequirements(p, available).join(", ")}`;
          return (
            <button
              key={p.id}
              type="button"
              className="add-plot-option"
              disabled={!enabled}
              title={tooltip}
              onClick={() =>
                onPick(
                  p.summaryKind ? { summaryKind: p.summaryKind } : { bindings: p.bindings },
                )
              }
            >
              {p.label}
            </button>
          );
        })}
      </>
    );
  }

  if (stage === "measure") {
    return (
      <>
        <Crumb />
        {measures.map((m) => (
          <button
            key={m.id}
            type="button"
            className="add-plot-option drill"
            onClick={() => advance("measure", m)}
            title={m.description}
          >
            {m.label} <span className="chevron">▸</span>
          </button>
        ))}
      </>
    );
  }

  if (stage === "table") {
    return (
      <>
        <Crumb />
        {tables.map((t) => (
          <button
            key={t.table}
            type="button"
            className="add-plot-option drill"
            onClick={() => advance("table", t.table)}
            title={`Group by a categorical column from ${t.table}`}
          >
            {t.table} <span className="chevron">▸</span>
          </button>
        ))}
      </>
    );
  }

  // stage === "column" — leaf. Build the bindings on click.
  const tableEntry = tables.find((t) => t.table === state.table);
  const cols = tableEntry?.columns ?? [];
  const direction = state.direction!;
  const measure = state.measure!;
  const weightCol = `${measure.colPrefix}_${direction}`;
  return (
    <>
      <Crumb />
      {cols.map((c) => (
        <button
          key={c.key}
          type="button"
          className="add-plot-option"
          onClick={() => onPick({ bindings: { x: c.key, weight: weightCol } })}
          title={`Bar chart — ${measure.label.toLowerCase()} of ${directionLabel(direction).toLowerCase()} partners grouped by ${c.display}`}
        >
          {c.display}
        </button>
      ))}
    </>
  );
}

interface ColumnBoundProps {
  descriptor: ColumnBoundPlotDescriptor;
  ds: string;
  rootId: string;
  matVersion: number | "live";
  bundle: ConnectivityBundle;
  decorationTables: string[];
  cells?: string | null;
}

/**
 * Column-bound plot: column choices are computed from the descriptor's
 * `source` frame in the bundle (partners_out by default). The picker self-
 * disables when no decoration columns are loaded — the user has to add a
 * decoration table or cell-type table for the picker to populate.
 *
 * If the persisted column from the URL no longer matches an available choice
 * (e.g. user removed the decoration table that supplied it), the picker
 * resets to "no selection" and the plot renders an empty placeholder rather
 * than 422-ing the backend.
 */
function ColumnBoundPlot({
  descriptor,
  ds,
  rootId,
  matVersion,
  bundle,
  decorationTables,
  cells,
}: ColumnBoundProps) {
  const [col, setCol] = useUrlParam(`viz_${descriptor.id}`);

  const rows = (bundle[descriptor.source] ?? []) as Record<string, unknown>[];
  const choices = useMemo(
    () => listVizColumns(rows, bundle.column_groups),
    [rows, bundle.column_groups],
  );
  const validChoice = choices.find((c) => c.key === col);

  const header = (
    <div className="plot-panel-header">
      <span className="plot-panel-title">{descriptor.title}</span>
      <select
        value={validChoice?.key ?? ""}
        onChange={(e) => setCol(e.target.value || null)}
        disabled={choices.length === 0}
      >
        <option value="">— pick a column —</option>
        {choices.map((c) => (
          <option key={c.key} value={c.key}>
            {c.group} / {c.display}  ({c.kind})
          </option>
        ))}
      </select>
    </div>
  );

  if (!validChoice) {
    return (
      <div className="plot-panel">
        {header}
        <div className="loading">
          {choices.length === 0
            ? "Add a decoration table to plot a column."
            : "Pick a column to plot."}
        </div>
      </div>
    );
  }

  const spec = validChoice.kind === "histogram" ? descriptor.histogramSpec : descriptor.barSpec;

  return (
    <PlotPanel
      ds={ds}
      spec={spec}
      rootId={rootId}
      matVersion={matVersion}
      decorationTables={decorationTables}
      cells={cells}
      column={validChoice.key}
      height={260}
      header={header}
    />
  );
}

// re-export for the type contract — PlotDescriptor isn't used directly here but
// callers may want to import alongside.
export type { PlotDescriptor };
