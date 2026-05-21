import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useColumnHistogram,
  useEmbeddingColumn,
} from "../../api/embeddings";
import { useUrlParam } from "../../hooks/useUrlState";
import type {
  ColumnGroup,
  ColumnHistogramResponse,
  FeatureTableListItem,
} from "../../api/types";
import { ColumnPicker } from "./ColumnPicker";
import { formatTick, type HistogramData } from "./histogram";
import { LinLogToggle } from "./LinLogToggle";

interface Props {
  ds: string;
  featureTableId: string;
  featureTable: FeatureTableListItem | null;
  cellsColumnGroups?: ColumnGroup[];
  matVersion: number | "live" | null;
  decorationTables: string[];
  /** "Select" action — replaces the selection bag with the matching
   *  cell_ids. The bag's existing union/subtract path is reused for the
   *  "Union" action below. */
  onReplaceSelection: (cellIds: string[]) => void;
  onUnionIntoSelection: (cellIds: string[]) => void;
  /** "Filter scope" action — writes the predicates to the existing
   *  ``?cells=`` URL state in the format the backend already parses.
   *  Lets one builder serve both surfaces (selection bag + filter
   *  scope) without duplicating UI. */
  onApplyFilterScope: (cellsParam: string) => void;
}

/** One column-predicate row. Numeric → (lo, hi) range; categorical →
 *  set of accepted values. Both encode as a single AND-conjunct in the
 *  match computation and in the ``?cells=`` serialization. */
type Predicate =
  | { kind: "numeric"; lo: number | null; hi: number | null }
  | { kind: "categorical"; values: Set<string> }
  | { kind: "pending" }; // column response hasn't loaded yet

/**
 * Multi-column AND-predicate builder for the explorer rail.
 *
 * Same shape pattern as the GrowSelectionPanel: pick columns, configure
 * per-column knobs, apply to either the selection bag or the
 * ``?cells=`` filter scope. The two outputs share one builder so the
 * user doesn't have to learn two predicate UIs.
 *
 * v1 surface:
 *   - Numeric columns get a dual-handle range filter built from the
 *     ``/column`` raw_range.
 *   - Categorical columns get a checkbox list of distinct values seen
 *     in the response (deduped from the values array; up to a sensible
 *     cap so a column with thousands of distinct values doesn't blow
 *     up the rail).
 *   - All predicates are ANDed. No OR, no negation — keeping the model
 *     simple intentionally matches the user's "logical AND only"
 *     direction.
 *
 * URL state: ``?sel_filters=<csv of dotted column paths>`` persists
 * which columns are active. Per-column predicate values stay in local
 * state for v1 — sharing a link reproduces the picker shape but the
 * user re-sets the ranges. (Promoting predicates to URL is a small
 * follow-up if the workflow needs it.)
 */
export function SelectionBuilderPanel({
  ds,
  featureTableId,
  featureTable,
  cellsColumnGroups,
  matVersion,
  decorationTables,
  onReplaceSelection,
  onUnionIntoSelection,
  onApplyFilterScope,
}: Props) {
  const [columnsRaw, setColumnsRaw] = useUrlParam("sel_filters");
  const columns = useMemo<string[]>(
    () =>
      columnsRaw
        ? Array.from(new Set(columnsRaw.split(",").map((s) => s.trim()).filter(Boolean)))
        : [],
    [columnsRaw],
  );
  const updateColumns = (next: string[]) =>
    setColumnsRaw(next.length > 0 ? next.join(",") : null);

  const [picking, setPicking] = useState(false);
  // Per-column predicate state. Map keyed on the dotted column path so
  // adding/removing columns doesn't lose unrelated predicates. Wrapped
  // in useCallback so the child rows' useEffect deps stay stable —
  // without that, every parent render thrashes the match computation
  // (re-binning 94k values per render, which made categorical feel
  // unresponsive).
  const [predicates, setPredicates] = useState<Map<string, Predicate>>(
    () => new Map(),
  );
  const setPredicate = useCallback((col: string, p: Predicate) => {
    setPredicates((prev) => {
      const next = new Map(prev);
      next.set(col, p);
      return next;
    });
  }, []);

  // Match computation: for each active column, derive a Set<cell_id>
  // of cells passing that column's predicate. Intersect all sets to
  // get the AND result. Computed in the rows themselves and lifted up
  // via callbacks below; the panel maintains the running intersection.
  const [perColumnMatches, setPerColumnMatches] = useState<
    Map<string, Set<string>>
  >(() => new Map());
  const reportMatches = useCallback(
    (col: string, ids: Set<string> | null) => {
      setPerColumnMatches((prev) => {
        const next = new Map(prev);
        if (ids === null) next.delete(col);
        else next.set(col, ids);
        return next;
      });
    },
    [],
  );

  // AND intersection across every active column's matches. Columns that
  // haven't loaded yet (no entry in perColumnMatches) are treated as
  // "no constraint" — same behavior the user would see if they were
  // mid-typing in another row.
  const matchingCellIds = useMemo<string[] | null>(() => {
    if (columns.length === 0) return null;
    const sets: Set<string>[] = [];
    for (const c of columns) {
      const s = perColumnMatches.get(c);
      if (s) sets.push(s);
    }
    if (sets.length === 0) return null;
    sets.sort((a, b) => a.size - b.size); // intersect smallest-first
    const base = sets[0];
    const out: string[] = [];
    for (const id of base) {
      let inAll = true;
      for (let i = 1; i < sets.length; i++) {
        if (!sets[i].has(id)) {
          inAll = false;
          break;
        }
      }
      if (inAll) out.push(id);
    }
    return out;
  }, [columns, perColumnMatches]);

  const matchCount = matchingCellIds?.length ?? 0;
  const ready = matchingCellIds != null && columns.length > 0;

  const handleSelect = () => {
    if (matchingCellIds) onReplaceSelection(matchingCellIds);
  };
  const handleUnion = () => {
    if (matchingCellIds) onUnionIntoSelection(matchingCellIds);
  };
  const handleFilterScope = () => {
    // Build the ?cells= string. Numeric range → two clauses (gte + lte)
    // with the same dotted column; categorical set → one `in` clause
    // with pipe-separated values. Matches the format documented in
    // services/plots.py and the CellFilterPanel encoder.
    const clauses: string[] = [];
    for (const col of columns) {
      const p = predicates.get(col);
      if (!p || p.kind === "pending") continue;
      if (p.kind === "numeric") {
        if (p.lo != null && Number.isFinite(p.lo))
          clauses.push(`${col}:gte:${p.lo}`);
        if (p.hi != null && Number.isFinite(p.hi))
          clauses.push(`${col}:lte:${p.hi}`);
      } else {
        if (p.values.size > 0) {
          clauses.push(`${col}:in:${Array.from(p.values).join("|")}`);
        }
      }
    }
    onApplyFilterScope(clauses.join(","));
  };

  const removeColumn = (col: string) => {
    updateColumns(columns.filter((c) => c !== col));
    setPredicates((prev) => {
      const next = new Map(prev);
      next.delete(col);
      return next;
    });
    reportMatches(col, null);
  };

  return (
    <div className="explore-select-builder">
      {columns.length === 0 && (
        <div className="explore-grow-help">
          Add one or more columns to build an AND-predicate. Numeric
          columns get a range filter; categorical get a value list.
        </div>
      )}
      {columns.map((col) => (
        <PredicateRow
          key={col}
          ds={ds}
          featureTableId={featureTableId}
          column={col}
          decorationTables={decorationTables}
          matVersion={matVersion}
          predicate={predicates.get(col)}
          // Memoized setters with the column key baked in are owned by
          // the row — keeps the row's useEffect deps stable across
          // parent renders.
          setPredicate={setPredicate}
          reportMatches={reportMatches}
          onRemove={() => removeColumn(col)}
        />
      ))}

      <div className="explore-grow-actions">
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          title={picking ? "Close the column picker" : "Pick a column to add as a filter"}
        >
          {picking ? "× cancel" : "+ add column"}
        </button>
      </div>

      {picking && (
        <ColumnPicker
          featureTable={featureTable}
          cellsColumnGroups={cellsColumnGroups}
          selectedValues={new Set(columns)}
          onAdd={(col) => {
            updateColumns([...columns, col]);
            setPicking(false);
          }}
          onRemove={(col) => removeColumn(col)}
          onClose={() => setPicking(false)}
        />
      )}

      {columns.length > 0 && (
        <>
          <div className="explore-grow-stats">
            {ready
              ? `${matchCount.toLocaleString()} cells match all filters`
              : "loading column data…"}
          </div>
          {/* Two clusters split by a flex spacer: the "selection bag"
              actions (Select, Add) live on the left because they
              operate on the same surface as the count line above
              them; "Set scope" pushes to the right and gets its own
              color because it writes to a different surface entirely
              (the ?cells= Scope) and has a different undo path. */}
          <div className="explore-grow-actions explore-grow-actions-split">
            <button
              type="button"
              className="primary"
              onClick={handleSelect}
              disabled={!ready || matchCount === 0}
              title="Replace the selection bag with the matching cells"
            >
              Select
            </button>
            <button
              type="button"
              onClick={handleUnion}
              disabled={!ready || matchCount === 0}
              title="Add the matching cells to the existing selection bag"
            >
              Add
            </button>
            <span className="explore-grow-actions-spacer" />
            <button
              type="button"
              className="scope-action"
              onClick={handleFilterScope}
              disabled={!ready}
              title="Apply the filter as the active Scope (?cells=) — narrows what the scatter / table render and what subsequent lasso / select actions see"
            >
              Set scope
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ----- per-column row --------------------------------------------------

interface RowProps {
  ds: string;
  featureTableId: string;
  column: string;
  decorationTables: string[];
  matVersion: number | "live" | null;
  predicate: Predicate | undefined;
  /** Parent's memoized setters. The row binds the column key before
   *  use so the per-row callbacks identity-stable across renders. */
  setPredicate: (col: string, p: Predicate) => void;
  reportMatches: (col: string, ids: Set<string> | null) => void;
  onRemove: () => void;
}

function PredicateRow({
  ds,
  featureTableId,
  column,
  decorationTables,
  matVersion,
  predicate,
  setPredicate,
  reportMatches,
  onRemove,
}: RowProps) {
  // Per-row binning mode. Local state so each predicate's histogram
  // remembers its own scale across re-renders; defaults to linear so
  // the first paint matches what most users expect. Toggling re-keys
  // the histogram query (different cache slot per binning) so the
  // switch pays at most one cold fetch per (column, mode).
  const [binning, setBinning] = useState<"linear" | "log">("linear");

  // Two-tier fetch: the tiny L2-cached histogram drives first-paint of
  // the predicate widget (chart + categorical bars); the heavier full-
  // column response drives the actual per-cell-id matching. They fire
  // in parallel — histogram lands in tens of ms on a warm L2 hit, the
  // column response streams in for the AND intersection without
  // blocking the visual.
  const histogramQuery = useColumnHistogram({
    ds,
    featureTableId,
    column,
    decorationTables,
    matVersion,
    bins: 60,
    binning,
  });
  const query = useEmbeddingColumn({
    ds,
    featureTableId,
    column,
    decorationTables,
    matVersion,
  });
  const resp = query.data;
  const histogram = histogramQuery.data;

  // Bind the column key into the parent's memoized setters so the
  // closure identity stays stable per (column, parent-callback) tuple
  // — without this the useEffect below treats every parent render as
  // a reason to recompute (re-bin 94k values), which caused the
  // categorical sluggishness the user reported.
  const onPredicateChange = useCallback(
    (p: Predicate) => setPredicate(column, p),
    [setPredicate, column],
  );
  const onMatchesChange = useCallback(
    (ids: Set<string> | null) => reportMatches(column, ids),
    [reportMatches, column],
  );

  // Initialize predicate from the histogram response (which arrives
  // first — small + L2-cached). Default to the everything-selected
  // shape for both kinds: numeric → full range, categorical → every
  // distinct value checked. The user opts *out* of values they don't
  // want, mirroring the numeric "drag to narrow" gesture. Categorical
  // previously defaulted to empty, which made it confusing whether
  // adding a categorical predicate was supposed to do anything.
  useEffect(() => {
    if (!histogram) return;
    if (predicate && predicate.kind !== "pending") return;
    if (histogram.kind === "numeric") {
      onPredicateChange({
        kind: "numeric",
        lo: histogram.bin_min,
        hi: histogram.bin_max,
      });
    } else {
      const everyValue = new Set(histogram.value_counts.map((r) => r.value));
      onPredicateChange({ kind: "categorical", values: everyValue });
    }
  }, [histogram, predicate, onPredicateChange]);

  // Compute the cell_id mask for this predicate over the column values.
  // Reports a Set<cell_id> upward so the parent can intersect across
  // rows; reports null while the column is still loading (treated as
  // "no constraint" by the parent — same as a fresh empty predicate).
  useMatchUpdater(resp, predicate, onMatchesChange);

  if (query.isLoading) {
    return (
      <div className="explore-select-row">
        <div className="explore-select-row-head">
          <span className="explore-select-row-col">{column}</span>
          <button type="button" onClick={onRemove} title="Remove this column">×</button>
        </div>
        <div className="explore-grow-stats">loading…</div>
      </div>
    );
  }
  if (query.isError || !resp) {
    return (
      <div className="explore-select-row">
        <div className="explore-select-row-head">
          <span className="explore-select-row-col">{column}</span>
          <button type="button" onClick={onRemove} title="Remove this column">×</button>
        </div>
        <div className="explore-grow-error">
          Failed to load column.
        </div>
      </div>
    );
  }

  return (
    <div className="explore-select-row">
      <div className="explore-select-row-head">
        <span className="explore-select-row-col">{column}</span>
        <button type="button" onClick={onRemove} title="Remove this column">
          ×
        </button>
      </div>
      {resp.kind === "numeric" && predicate?.kind === "numeric" ? (
        <NumericPredicate
          range={resp.raw_range ?? [0, 1]}
          predicate={predicate}
          histogram={
            histogram?.kind === "numeric" ? histogram : null
          }
          binning={binning}
          onBinningChange={setBinning}
          onChange={onPredicateChange}
        />
      ) : resp.kind === "categorical" && predicate?.kind === "categorical" ? (
        <CategoricalPredicate
          histogram={
            histogram?.kind === "categorical" ? histogram : null
          }
          predicate={predicate}
          onChange={onPredicateChange}
        />
      ) : null}
    </div>
  );
}

/** Pushes the per-row Set<cell_id> mask upward whenever the predicate
 *  or column response changes. Wrapped in an effect (not useMemo) so the
 *  parent's setState happens after render commit, not during. */
function useMatchUpdater(
  resp: import("../../api/types").EmbeddingColumnResponse | undefined,
  predicate: Predicate | undefined,
  onMatchesChange: (ids: Set<string> | null) => void,
) {
  useEffect(() => {
    if (!resp || !predicate || predicate.kind === "pending") {
      onMatchesChange(null);
      return;
    }
    const matches = new Set<string>();
    const ids = resp.cell_ids;
    const vals = resp.values;
    if (predicate.kind === "numeric") {
      const lo = predicate.lo ?? Number.NEGATIVE_INFINITY;
      const hi = predicate.hi ?? Number.POSITIVE_INFINITY;
      for (let i = 0; i < ids.length; i++) {
        const v = vals[i] as number | null;
        if (v === null || typeof v !== "number" || !Number.isFinite(v)) continue;
        if (v >= lo && v <= hi) matches.add(ids[i]);
      }
    } else if (predicate.values.size > 0) {
      // Categorical with no values selected → empty match set
      // (intentional default; see PredicateRow init comment).
      for (let i = 0; i < ids.length; i++) {
        const v = vals[i] as string | null;
        if (v === null) continue;
        if (predicate.values.has(v)) matches.add(ids[i]);
      }
    }
    onMatchesChange(matches);
  }, [resp, predicate, onMatchesChange]);
}

// ----- predicate widgets ----------------------------------------------

/** Interactive histogram for a numeric predicate.
 *
 *  The histogram IS the control — no separate slider. Interaction:
 *
 *  - **Drag** anywhere on the chart to define a fresh range. Mousedown
 *    starts the drag; mousemove updates the far end; mouseup commits.
 *    The lo / hi flip naturally when you drag right-to-left.
 *  - **Click** (no drag) sets the *nearest* bound to the click x.
 *    Move just the lo or just the hi with one click each.
 *
 *  The min / max tick labels under the histogram are click-to-edit
 *  number inputs — for cases where the histogram drag isn't precise
 *  enough or the user wants to type a known threshold directly.
 */
function NumericPredicate({
  range,
  predicate,
  histogram,
  binning,
  onBinningChange,
  onChange,
}: {
  range: [number, number];
  predicate: Extract<Predicate, { kind: "numeric" }>;
  histogram: Extract<ColumnHistogramResponse, { kind: "numeric" }> | null;
  binning: "linear" | "log";
  onBinningChange: (b: "linear" | "log") => void;
  onChange: (p: Predicate) => void;
}) {
  const [lo, hi] = range;

  // Adapt the wire-shape numeric histogram into the HistogramData
  // shape the renderer expects. ``bin_edges`` carries the full edge
  // sequence (log-spaced when binning=log, equal-width when linear)
  // so the renderer doesn't need to know the binning mode — it just
  // positions bars at the edges given.
  const bins = useMemo<HistogramData | null>(() => {
    if (!histogram) return null;
    const total = histogram.n_finite || 1;
    return {
      bgDensity: histogram.bin_counts.map((c) => c / total),
      fgDensity: histogram.bin_counts.map(() => 0),
      bgCounts: histogram.bin_counts,
      binEdges: histogram.bin_edges,
      binMin: histogram.bin_min,
      binMax: histogram.bin_max,
      binning: histogram.binning,
      logFallback: histogram.log_fallback,
    };
  }, [histogram]);

  const selectedLo = predicate.lo ?? lo;
  const selectedHi = predicate.hi ?? hi;
  const isClipped = selectedLo > lo || selectedHi < hi;

  const setRange = useCallback(
    (newLo: number, newHi: number) => {
      // Always normalize so lo <= hi — drag right-to-left should still
      // produce a valid range. Clamp to the column's full bounds so
      // the user can't accidentally write predicates outside the
      // observed data.
      const a = Math.max(lo, Math.min(hi, newLo));
      const b = Math.max(lo, Math.min(hi, newHi));
      onChange({
        kind: "numeric",
        lo: Math.min(a, b),
        hi: Math.max(a, b),
      });
    },
    [lo, hi, onChange],
  );

  const setOneBound = useCallback(
    (clickedValue: number) => {
      // Move whichever bound is closer to the click. Lets the user
      // dial in either end with single clicks without a separate
      // mode toggle.
      const dLo = Math.abs(clickedValue - selectedLo);
      const dHi = Math.abs(clickedValue - selectedHi);
      if (dLo <= dHi) setRange(clickedValue, selectedHi);
      else setRange(selectedLo, clickedValue);
    },
    [selectedLo, selectedHi, setRange],
  );

  return (
    <div className="explore-select-numeric">
      {bins && (
        <InteractiveHistogram
          bins={bins}
          selectedLo={selectedLo}
          selectedHi={selectedHi}
          rangeLo={lo}
          rangeHi={hi}
          binning={binning}
          onBinningChange={onBinningChange}
          onDragRange={setRange}
          onClickPoint={setOneBound}
          onEditLo={(v) => setRange(v, selectedHi)}
          onEditHi={(v) => setRange(selectedLo, v)}
        />
      )}
      {isClipped && (
        <div className="explore-grow-stats">
          <button
            type="button"
            className="explore-grow-feature-reset"
            onClick={() => onChange({ kind: "numeric", lo, hi })}
            title="Reset to the column's full range"
          >
            reset to full range
          </button>
        </div>
      )}
    </div>
  );
}

interface InteractiveHistogramProps {
  bins: HistogramData | null;
  selectedLo: number;
  selectedHi: number;
  rangeLo: number;
  rangeHi: number;
  /** Binning mode (linear / log). Owned by the parent because flipping
   *  it re-fires the histogram fetch with a different cache key. */
  binning: "linear" | "log";
  onBinningChange: (b: "linear" | "log") => void;
  /** Continuous-update callback during a drag-define-range gesture. */
  onDragRange: (lo: number, hi: number) => void;
  /** Click-without-drag callback — moves the nearest bound to the
   *  clicked point. */
  onClickPoint: (value: number) => void;
  /** Commits an edited lower / upper tick value. */
  onEditLo: (v: number) => void;
  onEditHi: (v: number) => void;
}

const DRAG_THRESHOLD_PX = 3;

/** Histogram with drag-to-define-range + click-nearest-bound +
 *  editable tick labels. Self-contained: owns pointer-event state
 *  and gates whether a gesture commits as a drag (range replace) or
 *  a click (single-bound move). */
function InteractiveHistogram({
  bins,
  selectedLo,
  selectedHi,
  rangeLo,
  rangeHi,
  binning,
  onBinningChange,
  onDragRange,
  onClickPoint,
  onEditLo,
  onEditHi,
}: InteractiveHistogramProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{
    startX: number;
    startValue: number;
    moved: boolean;
  } | null>(null);

  // value-space ↔ pixel-space mapping. For linear binning this is
  // affine; for log binning we work in log-space so drag/click
  // positions reflect the visual position of the bars (which are
  // also log-positioned). All consumers — bar positioning, click
  // handler, threshold lines — route through these two helpers so
  // the linear / log split is in one place.
  const xMapping = useMemo(() => {
    if (!bins) return null;
    const mn = bins.binMin;
    const mx = bins.binMax;
    if (bins.binning === "log" && mn > 0) {
      const logMn = Math.log(mn);
      const logMx = Math.log(mx);
      const logSpan = logMx - logMn || 1;
      return {
        valueToFrac: (v: number) =>
          v <= 0 ? 0 : (Math.log(Math.max(v, mn)) - logMn) / logSpan,
        fracToValue: (t: number) => Math.exp(logMn + t * logSpan),
      };
    }
    const span = mx - mn || 1;
    return {
      valueToFrac: (v: number) => (v - mn) / span,
      fracToValue: (t: number) => mn + t * span,
    };
  }, [bins]);

  // Convert a clientX pixel position to a data value in [binMin, binMax].
  const pixelToValue = useCallback(
    (clientX: number): number | null => {
      if (!svgRef.current || !bins || !xMapping) return null;
      const rect = svgRef.current.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      return xMapping.fracToValue(t);
    },
    [bins, xMapping],
  );

  // Drag-define-range gesture. Mousedown captures the anchor; mousemove
  // emits a fresh (anchor, current) range continuously; mouseup either
  // commits the drag or, if the gesture stayed under DRAG_THRESHOLD_PX,
  // treats it as a click and moves the nearest bound. Bound mousemove
  // / mouseup at the window level so dragging outside the SVG still
  // tracks (standard pattern for slider-like SVG widgets).
  const handleMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    const v = pixelToValue(e.clientX);
    if (v == null) return;
    dragRef.current = { startX: e.clientX, startValue: v, moved: false };

    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = Math.abs(ev.clientX - dragRef.current.startX);
      if (dx >= DRAG_THRESHOLD_PX) dragRef.current.moved = true;
      const current = pixelToValue(ev.clientX);
      if (current == null || !dragRef.current.moved) return;
      onDragRange(dragRef.current.startValue, current);
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      if (!dragRef.current) return;
      if (!dragRef.current.moved) {
        // Pure click → set the nearest existing bound.
        const v2 = pixelToValue(ev.clientX) ?? dragRef.current.startValue;
        onClickPoint(v2);
      }
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  if (!bins || bins.bgDensity.length === 0 || !xMapping) return null;
  const W = 240;
  const H = 38;

  // Bar heights stay linear in count — the X axis is where log binning
  // does its work. Counts (not density) so a one-cell bin still
  // registers as a thin line; max-count normalization keeps the
  // tallest bar at H.
  const maxCount = bins.bgCounts.length > 0 ? Math.max(...bins.bgCounts) : 1;
  const heightFor = (i: number): number =>
    maxCount > 0 ? (bins.bgCounts[i] / maxCount) * H : 0;

  const loX = xMapping.valueToFrac(selectedLo) * W;
  const hiX = xMapping.valueToFrac(selectedHi) * W;

  // Log toggle disables when the column has non-positive values and
  // the server fell back to linear, or when the original-space min is
  // <= 0 (log binning request would fall back anyway). Showing a
  // disabled toggle is more discoverable than hiding the affordance.
  const logUnavailable = bins.binMin <= 0;
  const toggleTitle = logUnavailable
    ? "Log binning needs all positive values; this column has values ≤ 0"
    : bins.binning === "log"
      ? "X-axis bins are log-spaced — click for linear"
      : "X-axis bins are linear — click for log";

  return (
    <div className="explore-select-histogram">
      <svg
        ref={svgRef}
        className="explore-select-histogram-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        onMouseDown={handleMouseDown}
      >
        {bins.bgCounts.map((_c, i) => {
          // Bar X position derives from the explicit edges so log
          // binning produces narrow bars at the small end and wider
          // bars at the large end automatically.
          const xLeft = xMapping.valueToFrac(bins.binEdges[i]) * W;
          const xRight = xMapping.valueToFrac(bins.binEdges[i + 1]) * W;
          const barW = Math.max(0, xRight - xLeft);
          const h = heightFor(i);
          // Bin counted as inside the selection if it overlaps —
          // straddling bins highlight rather than gray for visual
          // continuity at the boundary.
          const inside =
            bins.binEdges[i + 1] >= selectedLo &&
            bins.binEdges[i] <= selectedHi;
          return (
            <rect
              key={i}
              x={xLeft + 0.5}
              y={H - h}
              width={Math.max(0, barW - 1)}
              height={h}
              className={
                inside
                  ? "explore-select-histogram-bar-in"
                  : "explore-select-histogram-bar-out"
              }
            />
          );
        })}
        {/* Bound markers — thin vertical lines at lo + hi so the user
            can see where the cut actually lands when bin edges don't
            line up. Skipped when the bound equals the full range edge
            (no useful info, would clutter). */}
        {selectedLo > rangeLo && (
          <line
            x1={loX}
            x2={loX}
            y1={0}
            y2={H}
            className="explore-select-histogram-bound"
          />
        )}
        {selectedHi < rangeHi && (
          <line
            x1={hiX}
            x2={hiX}
            y1={0}
            y2={H}
            className="explore-select-histogram-bound"
          />
        )}
      </svg>
      <div className="explore-select-histogram-ticks">
        <EditableTick value={bins.binMin} onCommit={onEditLo} />
        <span className="explore-select-histogram-ticks-right">
          <EditableTick value={bins.binMax} onCommit={onEditHi} />
          <LinLogToggle
            value={binning === "log" ? "log" : "lin"}
            onChange={(v) => onBinningChange(v === "log" ? "log" : "linear")}
            disabled={logUnavailable}
            title={toggleTitle}
          />
        </span>
      </div>
    </div>
  );
}

/** Click-to-edit numeric tick label. Shows the formatted value as a
 *  plain span; clicking turns it into a number input. Commits on
 *  Enter or blur; Escape reverts without committing. Lets the user
 *  type a precise bound when the histogram drag isn't fine enough. */
function EditableTick({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (v: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const commit = () => {
    const v = parseFloat(draft);
    if (Number.isFinite(v)) onCommit(v);
    setEditing(false);
  };
  if (editing) {
    return (
      <input
        type="number"
        className="explore-select-tick-input"
        value={draft}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <span
      role="button"
      tabIndex={0}
      className="explore-select-tick"
      title="Click to edit"
      onClick={() => {
        setDraft(String(value));
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          setDraft(String(value));
          setEditing(true);
        }
      }}
    >
      {formatTick(value)}
    </span>
  );
}

/** Categorical predicate widget — checkbox + universe count bar per
 *  value. Same visual language as the SummaryPanel category rows: the
 *  bar shows population count, the checkbox drives membership, and
 *  rows sort descending by count so the dominant categories surface
 *  first. Reads from the L2-cached histogram endpoint so the per-value
 *  count enumeration is one cheap fetch instead of a full /column
 *  download. */
function CategoricalPredicate({
  histogram,
  predicate,
  onChange,
}: {
  histogram:
    | Extract<ColumnHistogramResponse, { kind: "categorical" }>
    | null;
  predicate: Extract<Predicate, { kind: "categorical" }>;
  onChange: (p: Predicate) => void;
}) {
  // The histogram endpoint already returns value_counts sorted
  // descending and capped server-side, so the panel reads them as-is.
  const rows = useMemo(() => {
    if (!histogram) return { rows: [], truncated: false };
    return {
      rows: histogram.value_counts,
      truncated: histogram.truncated,
    };
  }, [histogram]);
  const maxCount = rows.rows[0]?.count ?? 1;

  const toggle = (v: string) => {
    const next = new Set(predicate.values);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange({ kind: "categorical", values: next });
  };
  const selectAll = () =>
    onChange({
      kind: "categorical",
      values: new Set(rows.rows.map((r) => r.value)),
    });
  const selectNone = () =>
    onChange({ kind: "categorical", values: new Set() });

  return (
    <div className="explore-select-categorical">
      <div className="explore-grow-feature-section-actions">
        <button
          type="button"
          onClick={selectAll}
          disabled={predicate.values.size === rows.rows.length}
          title="Check every value"
        >
          all
        </button>
        <button
          type="button"
          onClick={selectNone}
          disabled={predicate.values.size === 0}
          title="Uncheck every value"
        >
          none
        </button>
        <span className="explore-grow-stats">
          {predicate.values.size}/{rows.rows.length}
          {rows.truncated && " (capped)"}
        </span>
      </div>
      <div className="explore-select-cat-rows">
        {rows.rows.map((r) => {
          const checked = predicate.values.has(r.value);
          const pct = (r.count / maxCount) * 100;
          return (
            <label
              key={r.value}
              className={`explore-select-cat-row${checked ? " checked" : ""}`}
              title={r.value}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(r.value)}
              />
              <span className="explore-select-cat-row-name">{r.value}</span>
              <span className="explore-select-cat-row-bar-wrap">
                <span
                  className="explore-select-cat-row-bar"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="explore-select-cat-row-count">
                {r.count.toLocaleString()}
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
