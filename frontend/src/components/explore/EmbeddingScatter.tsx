import { lazy, Suspense, useCallback, useMemo } from "react";
import type { EmbeddingPointsResponse } from "../../api/types";

// Mirror the lazy-plotly pattern from PlotPanel — the ~2MB plotly bundle is
// only fetched when the user actually opens /explore. Both views share the
// same chunk so opening /explore after /neuron is a cache hit.
const Plot = lazy(async () => {
  const [{ default: createPlotlyComponent }, Plotly] = await Promise.all([
    import("react-plotly.js/factory"),
    import("plotly.js-cartesian-dist-min"),
  ]);
  return { default: createPlotlyComponent(Plotly.default) };
});

const PLOTLY_CONFIG = { displaylogo: false, responsive: true };

// Fixed categorical palette. Picked for moderate-population scatters where
// 5-15 categories are typical (cell types in MICRONS). Avoids reds-on-greens
// for colorblind accessibility; first 8 entries come from Okabe-Ito.
const CATEGORICAL_PALETTE = [
  "#0072B2", "#E69F00", "#009E73", "#CC79A7",
  "#56B4E9", "#D55E00", "#F0E442", "#999999",
  // Extra steps if a dataset has >8 distinct categories.
  "#882255", "#117733", "#88CCEE", "#DDCC77",
  "#332288", "#AA4499", "#44AA99", "#661100",
];
const NULL_COLOR = "#bdbdbd";
const NUMERIC_COLORSCALE = "Viridis";

// Overlay colors. Reserved for the focus / neighbors / brush states so a
// user instantly reads "this is the cell I'm focused on" vs the (typically
// muted) base coloring. Sizes also bump up so the overlay reads at a glance.
const FOCUS_COLOR = "#E76F51";       // warm orange
const NEIGHBOR_COLOR = "#2A9D8F";    // teal
const BRUSH_COLOR = "#9D4EDD";       // purple
const OVERLAY_BASE_SIZE = 8;
const FOCUS_MARKER_SIZE = 14;

// Size-channel marker-pixel range. The size column's value range is
// linearly remapped onto these bounds so any numeric feature produces a
// readable scatter regardless of its native units (microns, areas, counts).
// Values outside the remapped range (null / non-finite) fall back to a
// medium-default; that keeps the legend consistent without dropping points.
const SIZE_MIN_PX = 3;
const SIZE_MAX_PX = 14;
const SIZE_DEFAULT_PX = 4;

interface Props {
  /** /points response. Caller passes `null`/`undefined` while loading or
   *  before a datastack is chosen; the component renders an empty plot. */
  data: EmbeddingPointsResponse | null | undefined;
  /** Currently-focused cell_id (the `?cell=` URL param). Drawn as a
   *  larger, opaque, distinctively-colored marker on top of the base. */
  focusCellId?: string | null;
  /** kNN result cell_ids (the `?neighbors=` URL param). Rendered as a
   *  separate overlay between the base and the focus. */
  neighborCellIds?: string[];
  /** Lasso/box-selected cell_ids (the `?sel=` URL param). Same overlay
   *  treatment, different color so the three highlight kinds read
   *  distinctly. */
  brushCellIds?: string[];
  /** Per-row pass/fail mask from the FeatureFilters component. Cells
   *  with `passing[i] === false` are dimmed (opacity drop) so the user
   *  can still see the population shape; clearing the filter unmutes
   *  them. `null`/undefined or all-true → no dimming. */
  filterMask?: boolean[] | null;
  /** Click on a point — receives that point's cell_id. */
  onCellClick?: (cellId: string) => void;
  /** Lasso/box selection — receives the deduped selected cell_ids. */
  onSelected?: (cellIds: string[]) => void;
  /** Visible axes labels. Defaults to the embedding's axes from the
   *  manifest, but the caller (FeatureExplorer) passes them in so the
   *  layout owns the labels rather than the data. */
  xLabel?: string;
  yLabel?: string;
  height?: number;
}

interface PlotlyClickEvent {
  points?: Array<{ customdata?: unknown } | undefined>;
}

interface PlotlySelectionEvent {
  points?: Array<{ customdata?: unknown } | undefined>;
}

/**
 * Plotly scattergl renderer for one embedding.
 *
 * Trace strategy:
 *
 * - **No color**: one scattergl trace, uniform mid-gray.
 * - **Numeric color**: one scattergl trace with a continuous colorscale
 *   (`Viridis`) and a colorbar on the right.
 * - **Categorical color**: one scattergl trace per category. Plotly's
 *   built-in legend handles category labels + show/hide toggles for free.
 *
 * Future tasks (#9 selection / #10 decoration) extend by adding more
 * traces (focus / neighbors / brush) on top of the colored base — the
 * categorical split-per-category approach generalizes cleanly because
 * each state's points get a `name=` and a distinct color above the base.
 *
 * Why `customdata` carries the cell_id: plotly's click/selection events
 * expose `point.customdata` directly, so the component never has to
 * round-trip through the `pointIndex` → row map.
 */
export function EmbeddingScatter({
  data,
  focusCellId,
  neighborCellIds,
  brushCellIds,
  filterMask,
  onCellClick,
  onSelected,
  xLabel,
  yLabel,
  height = 600,
}: Props) {
  const traces = useMemo(
    () => buildTraces(data, { focusCellId, neighborCellIds, brushCellIds, filterMask }),
    [data, focusCellId, neighborCellIds, brushCellIds, filterMask],
  );

  // Axis labels follow the column actually rendered (which may differ
  // from the manifest's default `axes` once the user picks an override).
  // Prop fallback covers the loading-state render where `data` is still
  // null so layout still gets stable bounds.
  const xAxisLabel = data?.x.column ?? xLabel ?? "";
  const yAxisLabel = data?.y.column ?? yLabel ?? "";

  const layout = useMemo(
    () => ({
      autosize: true,
      // The colorbar in the numeric branch eats some horizontal real
      // estate; using `automargin` lets it size without us tuning by hand.
      xaxis: { title: { text: xAxisLabel }, zeroline: false, automargin: true },
      yaxis: { title: { text: yAxisLabel }, zeroline: false, automargin: true },
      margin: { l: 50, r: 20, t: 20, b: 50 },
      dragmode: "lasso" as const,
      hovermode: "closest" as const,
      // uirevision keeps zoom/pan state when only the data updates — so
      // re-coloring or re-fetching doesn't snap back to fitView. Include
      // the axes in the key so switching from UMAP to soma-depth-vs-area
      // DOES reset zoom (the new axes have entirely different ranges).
      uirevision: `embedding-scatter-${xAxisLabel}-${yAxisLabel}`,
      // Categorical traces render in the legend (one entry per category);
      // numeric / no-color leaves the legend empty. Showing it
      // unconditionally keeps the plot's bounding box stable across
      // dtype switches.
      showlegend: true,
      legend: { itemsizing: "constant" as const, font: { size: 11 } },
    }),
    [xAxisLabel, yAxisLabel],
  );

  const handleClick = useCallback(
    (event: PlotlyClickEvent) => {
      if (!onCellClick || !event.points?.length) return;
      const cd = event.points[0]?.customdata;
      if (typeof cd === "string") onCellClick(cd);
    },
    [onCellClick],
  );

  const handleSelected = useCallback(
    (event: PlotlySelectionEvent | undefined) => {
      if (!onSelected || !event?.points?.length) return;
      const ids: string[] = [];
      const seen = new Set<string>();
      for (const p of event.points) {
        const cd = p?.customdata;
        if (typeof cd === "string" && !seen.has(cd)) {
          seen.add(cd);
          ids.push(cd);
        }
      }
      if (ids.length) onSelected(ids);
    },
    [onSelected],
  );

  return (
    <Suspense fallback={<div className="explore-scatter-loading">Loading plot…</div>}>
      {/* Plotly's typed Data union doesn't cover scattergl trace objects
          cleanly (mixed marker/colorbar/colorscale shapes), so the trace
          builder emits `unknown[]` and we cast at the API boundary.
          The runtime types are validated by plotly itself. */}
      <Plot
        data={traces as never}
        layout={layout}
        config={PLOTLY_CONFIG}
        useResizeHandler
        style={{ width: "100%", height }}
        onClick={handleClick}
        onSelected={handleSelected}
      />
    </Suspense>
  );
}

// ---- trace construction ---------------------------------------------------

/** Plotly-friendly cell value type. Numeric axes ship floats; categorical
 *  axes ship strings/bools; both surface here so callers don't have to
 *  branch on dtype. Plotly's axis-type inference (`xaxis.type: '-'`)
 *  handles the rendering. */
type ChannelValue = number | string | boolean | null;

interface OverlayInputs {
  focusCellId?: string | null;
  neighborCellIds?: string[];
  brushCellIds?: string[];
  filterMask?: boolean[] | null;
}

const DIMMED_OPACITY = 0.08;
const NORMAL_OPACITY = 0.7;

function buildTraces(
  data: EmbeddingPointsResponse | null | undefined,
  overlay: OverlayInputs,
): unknown[] {
  if (!data) return [];
  // x/y can be either numeric or categorical; plotly's axis-type
  // inference (`type: '-'`) handles both transparently. Typed widely
  // here so we don't need a branch per dtype downstream.
  const xVals = data.x.values as ChannelValue[];
  const yVals = data.y.values as ChannelValue[];
  // Precompute the size-pixel array once; null/missing falls back to a
  // medium-default so we never ship undefined into plotly.
  const sizePx = data.size
    ? scaleSizeArray(data.size.values as Array<number | null>)
    : null;
  const baseTraces = buildBaseTraces(
    data, xVals, yVals, sizePx, overlay.filterMask ?? null,
  );
  const overlayTraces = buildOverlayTraces(
    data.cell_ids, xVals, yVals, overlay,
  );
  return [...baseTraces, ...overlayTraces];
}

function scaleSizeArray(values: Array<number | null>): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
    // Degenerate column (all-null or zero-variance): everything renders
    // at the default size; the user just doesn't see a size mapping.
    return values.map(() => SIZE_DEFAULT_PX);
  }
  const range = max - min;
  return values.map((v) => {
    if (typeof v !== "number" || !Number.isFinite(v)) return SIZE_DEFAULT_PX;
    const frac = (v - min) / range;
    return SIZE_MIN_PX + frac * (SIZE_MAX_PX - SIZE_MIN_PX);
  });
}

function buildBaseTraces(
  data: EmbeddingPointsResponse,
  xVals: ChannelValue[],
  yVals: ChannelValue[],
  sizePx: number[] | null,
  filterMask: boolean[] | null,
): unknown[] {
  // Apply the filter mask by partitioning indices into "passing" (full
  // color) and "failing" (rendered as a dimmed background trace). Two
  // traces per styled-set rather than one because plotly's scattergl
  // backend doesn't honor per-point marker.opacity — uniform opacity per
  // trace is the WebGL-friendly path.
  const { cell_ids, color } = data;
  const passing = filterMask ? indexWhere(filterMask, true) : null;
  const failing = filterMask ? indexWhere(filterMask, false) : [];

  // Pull a marker-size for each row position (uniform fallback when no
  // size channel). Returned as a sub-array indexed by row-position.
  const sizeFor = (indices: number[]) =>
    sizePx ? indices.map((i) => sizePx[i]) : 4;

  const traces: unknown[] = [];

  if (failing.length > 0) {
    // Dimmed background trace — drawn first so the passing trace sits
    // on top. Uniform gray, low opacity, no legend entry.
    traces.push({
      type: "scattergl",
      mode: "markers",
      x: failing.map((i) => xVals[i]),
      y: failing.map((i) => yVals[i]),
      customdata: failing.map((i) => cell_ids[i]),
      marker: { size: 3, opacity: DIMMED_OPACITY, color: NULL_COLOR },
      hovertemplate: "(filtered) cell %{customdata}<extra></extra>",
      showlegend: false,
    });
  }

  if (!color) {
    const indices = passing ?? cell_ids.map((_, i) => i);
    traces.push({
      type: "scattergl",
      mode: "markers",
      x: indices.map((i) => xVals[i]),
      y: indices.map((i) => yVals[i]),
      customdata: indices.map((i) => cell_ids[i]),
      marker: {
        size: sizeFor(indices),
        opacity: NORMAL_OPACITY,
        color: NULL_COLOR,
      },
      hovertemplate: "cell %{customdata}<extra></extra>",
      showlegend: false,
    });
    return traces;
  }

  if (color.kind === "numeric") {
    const indices = passing ?? cell_ids.map((_, i) => i);
    const values = color.values as Array<number | null>;
    traces.push({
      type: "scattergl",
      mode: "markers",
      x: indices.map((i) => xVals[i]),
      y: indices.map((i) => yVals[i]),
      customdata: indices.map((i) => cell_ids[i]),
      marker: {
        size: sizeFor(indices),
        opacity: NORMAL_OPACITY,
        color: indices.map((i) => values[i]),
        colorscale: NUMERIC_COLORSCALE,
        showscale: true,
        colorbar: { title: { text: color.column, side: "right" }, thickness: 12 },
      },
      hovertemplate:
        `cell %{customdata}<br>${color.column}: %{marker.color}<extra></extra>`,
      showlegend: false,
    });
    return traces;
  }

  // Categorical: split into per-category traces. Stable ordering by first
  // occurrence so legend order matches what the user sees scanning the data.
  // Failing-mask cells already extracted into the dimmed background trace
  // above, so we only iterate passing indices here.
  const allowed = passing ? new Set(passing) : null;
  const byCategory = new Map<string, number[]>();
  const labelFor: Record<string, string> = {};
  color.values.forEach((v, i) => {
    if (allowed && !allowed.has(i)) return;
    const key = v == null ? "__null__" : String(v);
    if (!byCategory.has(key)) {
      byCategory.set(key, []);
      labelFor[key] = v == null ? "(null)" : String(v);
    }
    byCategory.get(key)!.push(i);
  });

  let paletteIdx = 0;
  for (const [key, indices] of byCategory.entries()) {
    const isNull = key === "__null__";
    const c = isNull ? NULL_COLOR : CATEGORICAL_PALETTE[paletteIdx++ % CATEGORICAL_PALETTE.length];
    traces.push({
      type: "scattergl",
      mode: "markers",
      x: indices.map((i) => xVals[i]),
      y: indices.map((i) => yVals[i]),
      customdata: indices.map((i) => cell_ids[i]),
      name: labelFor[key],
      marker: { size: sizeFor(indices), opacity: NORMAL_OPACITY, color: c },
      hovertemplate: `cell %{customdata}<br>${color.column}: ${labelFor[key]}<extra></extra>`,
      showlegend: true,
    });
  }
  return traces;
}

function indexWhere(mask: boolean[], value: boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i] === value) out.push(i);
  return out;
}

/**
 * Build overlay traces (brush → neighbors → focus, declared in that order
 * so plotly draws focus on top).
 *
 * Each overlay subsets the base data by cell_id; the lookup map is built
 * once per call so an overlay containing 1000 cells is O(N + N) rather
 * than O(N * M).
 */
function buildOverlayTraces(
  cellIds: string[],
  x: Array<number | null | string | boolean>,
  y: Array<number | null | string | boolean>,
  overlay: OverlayInputs,
): unknown[] {
  const indexById = new Map<string, number>();
  cellIds.forEach((c, i) => indexById.set(c, i));

  const traces: unknown[] = [];

  const brush = (overlay.brushCellIds ?? []).filter((id) => indexById.has(id));
  if (brush.length > 0) {
    traces.push(_subsetTrace(brush, indexById, x, y, {
      color: BRUSH_COLOR,
      name: `Brush (${brush.length})`,
      size: OVERLAY_BASE_SIZE,
    }));
  }

  const neighbors = (overlay.neighborCellIds ?? []).filter(
    (id) => indexById.has(id) && id !== overlay.focusCellId,
  );
  if (neighbors.length > 0) {
    traces.push(_subsetTrace(neighbors, indexById, x, y, {
      color: NEIGHBOR_COLOR,
      name: `Neighbors (${neighbors.length})`,
      size: OVERLAY_BASE_SIZE,
    }));
  }

  if (overlay.focusCellId && indexById.has(overlay.focusCellId)) {
    traces.push(_subsetTrace([overlay.focusCellId], indexById, x, y, {
      color: FOCUS_COLOR,
      name: "Focus",
      size: FOCUS_MARKER_SIZE,
      borderColor: "#1a1a1a",
    }));
  }

  return traces;
}

interface OverlayStyle {
  color: string;
  name: string;
  size: number;
  borderColor?: string;
}

function _subsetTrace(
  ids: string[],
  indexById: Map<string, number>,
  x: Array<ChannelValue>,
  y: Array<ChannelValue>,
  style: OverlayStyle,
): unknown {
  const subX: Array<ChannelValue> = [];
  const subY: Array<ChannelValue> = [];
  for (const id of ids) {
    const i = indexById.get(id)!;
    subX.push(x[i]);
    subY.push(y[i]);
  }
  return {
    type: "scattergl",
    mode: "markers",
    x: subX,
    y: subY,
    customdata: ids,
    name: style.name,
    marker: {
      size: style.size,
      opacity: 1,
      color: style.color,
      line: style.borderColor
        ? { color: style.borderColor, width: 1 }
        : undefined,
    },
    hovertemplate: `${style.name.replace(/\s\(\d+\)$/, "")}: cell %{customdata}<extra></extra>`,
    showlegend: true,
  };
}
