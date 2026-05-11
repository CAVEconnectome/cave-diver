import { lazy, Suspense, useCallback, useMemo, type ReactNode } from "react";
import { usePlot, type PlotBindings } from "../api/queries";
import { applyTheme } from "../plots/theme";

// `displaylogo` / `responsive` never change at runtime, so a single shared
// instance keeps react-plotly's componentDidUpdate identity check happy and
// avoids one source of `Plotly.react()` thrash per render.
const PLOTLY_CONFIG = { displaylogo: false, responsive: true };

// Lazy-load react-plotly.js so the ~2MB plotly bundle is only fetched when a
// user actually views a plot — datastack picking, partner browsing, and link
// generation all stay snappy.
const Plot = lazy(async () => {
  const [{ default: createPlotlyComponent }, Plotly] = await Promise.all([
    import("react-plotly.js/factory"),
    import("plotly.js-cartesian-dist-min"),
  ]);
  return { default: createPlotlyComponent(Plotly.default) };
});

interface Props {
  ds: string;
  spec: string;
  rootId: string;
  matVersion: number | "live";
  decorationTables?: string[];
  /** Legacy single-column override. New code should pass `bindings` instead. */
  column?: string | null;
  /** Multi-channel binding for dynamic plots. */
  bindings?: PlotBindings | null;
  /** Cell filter to apply to *this* fetch. Sent verbatim to the
   *  backend's `?cells=` query param. The dynamic-panel layer can pass
   *  `null` here while leaving `cellsContext` set, expressing "this
   *  panel opts out of the global filter even though it exists." */
  cells?: string | null;
  /** The *global* cell filter value, even when this panel has opted
   *  out via `?unfilter=`. Drives the filter pill's render — without
   *  this, an opted-out panel would have no way to indicate that a
   *  filter exists elsewhere in the app. Pass-through callers (static
   *  / column-bound plots) leave it undefined; the pill falls back to
   *  using `cells` as the context. */
  cellsContext?: string | null;
  /** When set, the filter pill becomes a clickable button. The
   *  callback toggles this panel's membership in `?unfilter=`. */
  onToggleFilter?: () => void;
  /** True when this panel currently bypasses the global cell filter.
   *  Drives the pill's "filter off" presentation AND threads through
   *  to the plot fetch's queryKey so toggling the filter pill always
   *  invalidates the cache cleanly — even in edge cases where `cells`
   *  itself happens to compare equal across the toggle (e.g. when the
   *  global filter is unset). */
  filterOverridden?: boolean;
  height?: number;
  // Optional rendered into the panel above the figure — typically a title +
  // a column picker for column-bound plots. Always rendered, even during
  // loading / error, so the picker stays interactive.
  header?: ReactNode;
  /** Brush / lasso selection callback. Each emitted point's `customdata` is
   *  expected to be the underlying row's `root_id` string (the backend ships
   *  `customdata` on every scatter trace). Called with the deduped list of
   *  selected root_ids — never with `[]`. PlotPanel suppresses empty events
   *  so phantom listener-rebind events don't clear a real selection; users
   *  clear via the explicit "clear" button on the brush pill. */
  onSelected?: (rootIds: string[]) => void;
}

interface PlotlySelectionEvent {
  points?: Array<{ customdata?: unknown } | undefined>;
}

export function PlotPanel({
  ds, spec, rootId, matVersion, decorationTables, column, bindings,
  cells, cellsContext, onToggleFilter, filterOverridden,
  height = 320, header, onSelected,
}: Props) {
  const plot = usePlot({
    ds, spec, rootId, matVersion, decorationTables, column, bindings, cells,
    // Thread the per-panel unfilter state into the queryKey so toggling
    // the filter pill always cuts a new cache entry, even when the
    // effective `cells` value happens to match across the toggle.
    unfiltered: filterOverridden,
  });

  // Theme-merged figure: inject our colorway / fonts / gridlines from CSS
  // tokens. PlotPanel still owns `margin` after this, so the header-aware
  // top spacing stays under one owner.
  const themed = useMemo(
    () => (plot.data ? applyTheme(plot.data.figure) : null),
    [plot.data],
  );

  // Stable layout. react-plotly's componentDidUpdate compares prevProps.layout
  // with this.props.layout by **reference** (not deep equality) — when the ref
  // changes it calls Plotly.react(), which on a fresh layout object resets the
  // selection rect even with matching uirevision (plotly v3 quirk). Memoizing
  // here means the layout reference only changes when something the user can
  // see changes, so the chart's selection state survives unrelated re-renders.
  const hasHeader = !!header;
  const enableSelect = !!onSelected;
  const bindingsKey = bindings ? `${bindings.x ?? ""}|${bindings.y ?? ""}|${bindings.hue ?? ""}|${bindings.size ?? ""}|${bindings.scope ?? ""}` : "";
  const layout = useMemo(() => {
    if (!themed) return null;
    return {
      ...(themed.layout as object),
      autosize: true,
      margin: { l: 50, r: 16, t: hasHeader ? 16 : 36, b: 40 },
      // Box / lasso are the conventional selection tools. Showing
      // them in the modebar lets the user choose; either fires
      // `onSelected` with the same payload shape.
      dragmode: (enableSelect ? "select" : undefined) as "select" | undefined,
      // Keep brush / zoom / dragmode state across re-renders that don't
      // change the underlying data. The revision key includes every prop
      // that legitimately invalidates the brush: when the user picks a
      // different column / binding / cell filter the selected ids no
      // longer correspond to anything plotted, so resetting selection is
      // the right behavior.
      uirevision: `${rootId}:${spec}:${column ?? ""}:${cells ?? ""}:${bindingsKey}`,
    };
  }, [themed, hasHeader, enableSelect, rootId, spec, column, cells, bindingsKey]);

  const style = useMemo(() => ({ width: "100%", height: `${height}px` }), [height]);

  // Stable selection handler. Without this, every parent render hands Plot a
  // new function reference; react-plotly's `syncEventHandlers` then unbinds
  // and rebinds the listener — which on plotly v3 can race with an in-flight
  // selection event and emit a phantom `plotly_selected` with no points right
  // after a real one. That phantom is what produced the "table flashes and
  // reverts" bug: real selection sets the URL, phantom immediately clears it.
  const handleSelected = useCallback(
    (event: PlotlySelectionEvent | undefined) => {
      if (!onSelected) return;
      const points = event?.points ?? [];
      const ids = points
        .map((p) => (p && typeof p.customdata === "string" ? p.customdata : null))
        .filter((x): x is string => !!x);
      // Dedupe — a single point can appear in multiple traces (e.g. categorical
      // hue split sub-traces for the same row).
      const deduped = [...new Set(ids)];
      // Critical: do NOT propagate empty selections. plotly v3 fires a
      // `plotly_selected` with `points: []` in two cases:
      //   1) handler-rebind race after a real selection event (phantom)
      //   2) lasso over a histogram / bar where traces lack `customdata`
      // Both would clear the URL key we just wrote and the table would
      // unfilter. Deselect goes through the explicit "clear" button on the
      // brush pill, not through this path.
      if (deduped.length === 0) return;
      onSelected(deduped);
    },
    [onSelected],
  );

  return (
    <div className={`plot-panel${plot.error ? " error" : ""}`}>
      {header}
      {plot.isFetching && <div className="loading">Loading {spec}…</div>}
      {plot.error && (
        <div className="error">
          <strong>{spec}:</strong> {(plot.error as Error).message}
        </div>
      )}
      {(() => {
        // Filter-pill render policy. Three states:
        //   1. Backend returned `meta.filtered: true` → filter is
        //      currently applied to this panel. Pill shows
        //      "filter: X / Y cells", clickable when `onToggleFilter`
        //      is wired to disable it.
        //   2. Filter exists globally but this panel has opted out
        //      (`filterOverridden`). Pill shows "filter: off",
        //      clickable to re-enable.
        //   3. No filter exists anywhere → no pill.
        // Hide while loading / errored to avoid flicker between fetches.
        if (plot.isFetching || plot.error) return null;
        const isFilteredHere = !!plot.data?.meta?.filtered;
        const filterExistsGlobally = !!cellsContext || !!cells;
        if (!isFilteredHere && !filterOverridden) return null;
        if (!filterExistsGlobally) return null;

        const clickable = !!onToggleFilter;
        const Tag = clickable ? "button" : "div";
        if (filterOverridden) {
          return (
            <Tag
              type={clickable ? "button" : undefined}
              className="plot-filter-badge off"
              onClick={onToggleFilter}
              title={clickable ? "Re-enable cell filter on this panel" : undefined}
            >
              filter: off{clickable ? " ↻" : ""}
            </Tag>
          );
        }
        const meta = plot.data!.meta!;
        return (
          <Tag
            type={clickable ? "button" : undefined}
            className={`plot-filter-badge${meta.matched_count === 0 ? " empty" : ""}${clickable ? " clickable" : ""}`}
            onClick={onToggleFilter}
            title={clickable ? "Disable cell filter on this panel" : undefined}
          >
            filter: {meta.matched_count} / {meta.pre_filter_count} cells{clickable ? " ⨯" : ""}
          </Tag>
        );
      })()}
      {themed && layout && !plot.isFetching && !plot.error && (
        <Suspense fallback={<div className="loading">Loading plot library…</div>}>
          <Plot
            data={themed.data as never}
            layout={layout}
            style={style}
            useResizeHandler
            config={PLOTLY_CONFIG}
            onSelected={onSelected ? (handleSelected as never) : undefined}
            // onDeselect intentionally omitted — clearing is the explicit
            // "clear" button on the brush pill, not a plot event.
          />
        </Suspense>
      )}
    </div>
  );
}
