import { useCallback, useEffect, useMemo, useState } from "react";
import DeckGL from "@deck.gl/react";
import { OrthographicView } from "@deck.gl/core";
import { ScatterplotLayer } from "@deck.gl/layers";
import { useEmbeddingScatter } from "../../api/embeddings";
import type { EmbeddingScatterResponse } from "../../api/types";

// Color hexes used when no channel binding is active.
const BASE_RGBA_NO_HIGHLIGHT: [number, number, number, number] = [91, 139, 209, 230];   // #5b8bd1
const BASE_RGBA_WITH_HIGHLIGHT: [number, number, number, number] = [209, 213, 219, 200]; // #d1d5db
const HIGHLIGHT_RGBA: [number, number, number, number] = [245, 158, 11, 255]; // #f59e0b
const NULL_RGBA: [number, number, number, number] = [220, 220, 220, 220]; // #dcdcdc — null-color slot
const FOCUSED_VIEW_ZOOM = 0; // initial zoom; deck.gl tunes to fit via fitBounds below.

interface Props {
  ds: string;
  featureTableId: string;
  embeddingId: string;
  /** Channel bindings forwarded to /scatter. Same wire as before; the
   *  response carries per-point arrays + (for categorical color) a
   *  color_map so a value lands on the same hex as the rest of the
   *  project. */
  x?: string | null;
  y?: string | null;
  colorBy?: string | null;
  sizeBy?: string | null;
  decorationTables?: string[];
  matVersion?: number | "live" | null;
  /** Cell_ids to render in the highlight layer (orange or, when color
   *  is bound, the channel color). The complement renders in the base
   *  layer (light gray when highlighting, solid blue otherwise).
   *  Empty/null = no highlight; single base layer at full weight. */
  highlightedCellIds?: Set<string> | null;
  /** Called with the lasso-selected cell_ids. Suppressed on empty
   *  selections so a phantom drag doesn't clear a real selection. */
  onLassoSelect?: (cellIds: string[]) => void;
  /** Called when the user clicks a single point. */
  onPointClick?: (cellId: string) => void;
  height?: number;
}

// --- color helpers ----------------------------------------------------------

/** Parse "#rrggbb" → [r, g, b]. Tolerates bad input by falling back to NULL. */
function hexToRgb(hex: string | undefined | null): [number, number, number] {
  if (!hex || typeof hex !== "string" || hex.charAt(0) !== "#" || hex.length < 7) {
    return [NULL_RGBA[0], NULL_RGBA[1], NULL_RGBA[2]];
  }
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return [NULL_RGBA[0], NULL_RGBA[1], NULL_RGBA[2]];
  }
  return [r, g, b];
}

/** Linear-interpolate a numeric value to a 3-stop Viridis approximation.
 *  Not the official Viridis curve — a cheap stand-in until we want a real
 *  colorscale. Three control points: low (purple), mid (green), high (yellow). */
function numericToViridis(
  v: number | null | undefined,
  lo: number,
  hi: number,
): [number, number, number] {
  if (v === null || v === undefined || !Number.isFinite(v)) {
    return [NULL_RGBA[0], NULL_RGBA[1], NULL_RGBA[2]];
  }
  if (hi <= lo) return [99, 146, 67]; // mid-green for degenerate range
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  const stops: [number, [number, number, number]][] = [
    [0.0, [68, 1, 84]],     // dark purple
    [0.5, [33, 144, 141]],  // teal-green
    [1.0, [253, 231, 37]],  // yellow
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i];
    const [t1, c1] = stops[i + 1];
    if (t >= t0 && t <= t1) {
      const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * u),
        Math.round(c0[1] + (c1[1] - c0[1]) * u),
        Math.round(c0[2] + (c1[2] - c0[2]) * u),
      ];
    }
  }
  return [253, 231, 37];
}

// --- main component ---------------------------------------------------------

interface RenderRow {
  id: string;
  position: [number, number];
  /** [r, g, b, a] in 0-255. */
  color: [number, number, number, number];
  /** Pre-scaled marker radius in pixels (server gives 3-10px; we add a
   *  small bump for the highlight subset). */
  radius: number;
}

/**
 * Universe scatter for the Feature Explorer, deck.gl edition.
 *
 * Renders every cell in a feature table at its 2D embedding coordinates
 * (or user-bound x/y channels). Uses two ScatterplotLayer instances —
 * `base` (universe \ highlight) and `highlight` — so the highlight set
 * renders on top with its own color + size.
 *
 * The component owns:
 *   - data fetch via `useEmbeddingScatter` (same hook as before)
 *   - color/size resolution into per-point RGBA + radius
 *   - viewport state (deck.gl OrthographicView, pan + zoom)
 *   - hover / click via deck.gl's picking
 *
 * Lasso is wired in a follow-up commit; this one focuses on getting
 * the engine swap clean and the rendering equivalent to the Plotly
 * version. Public props are unchanged so FeatureExplorer doesn't move.
 */
export function UniverseScatter({
  ds,
  featureTableId,
  embeddingId,
  x: xBinding,
  y: yBinding,
  colorBy,
  sizeBy,
  decorationTables,
  matVersion,
  highlightedCellIds,
  onLassoSelect: _onLassoSelect, // wired in the next commit
  onPointClick,
  height = 480,
}: Props) {
  const query = useEmbeddingScatter({
    ds,
    featureTableId,
    embeddingId,
    x: xBinding,
    y: yBinding,
    colorBy,
    sizeBy,
    decorationTables,
    matVersion,
  });

  // Compute the per-axis extents once per data update. Used both to
  // normalize positions before they hit the layer (so x and y can
  // scale independently — OrthographicView itself is uniform-aspect)
  // and to seed the initial view state.
  const extent = useMemo(
    () => (query.data ? computeExtent(query.data) : null),
    [query.data],
  );

  // Per-point resolved color/size arrays + base/highlight partition.
  // Positions are pre-normalized to a unit square so the
  // OrthographicView's uniform scaling doesn't squash one axis flat
  // when the data ranges differ wildly (depth: 1–1500 vs folding ratio:
  // 0–2). Pan/zoom operate in normalized space; axis labels (when we
  // add them) inverse-transform tick positions through `extent`.
  const partition = useMemo(
    () => buildPartition(query.data, highlightedCellIds, extent),
    [query.data, highlightedCellIds, extent],
  );

  // Initial view state — fit the unit square into the canvas with a
  // small padding margin. Independent of `extent` because the data is
  // pre-normalized; pan/zoom write back through `onViewStateChange`
  // after the initial fit. Re-fits when the axes change (binding swap)
  // even though the destination view is identical — keeps the user
  // oriented when they swap embedding-vs-feature views.
  const [viewState, setViewState] = useState<{
    target: [number, number, number];
    zoom: number;
  } | null>(null);
  const axesKey = `${query.data?.axes.x ?? ""}/${query.data?.axes.y ?? ""}`;
  useEffect(() => {
    if (!extent) return;
    setViewState(unitSquareViewState(height));
    // axesKey changes when the user picks different x/y channels; that
    // re-fires this effect and re-fits. `height` re-fits too if the
    // container resizes, which is the right behavior.
  }, [axesKey, height, extent]);

  const layers = useMemo(() => {
    if (!partition) return [];
    const base = new ScatterplotLayer({
      id: "universe-base",
      data: partition.base,
      pickable: true,
      stroked: false,
      filled: true,
      radiusUnits: "pixels",
      // `getPosition` returns native [x, y] from each row; ditto color/radius.
      getPosition: (d: RenderRow) => d.position,
      getFillColor: (d: RenderRow) => d.color,
      getRadius: (d: RenderRow) => d.radius,
      // Picking is cheap regardless of layer size — deck.gl reads a 1×1
      // pixel from the picking buffer rather than iterating points in JS.
      updateTriggers: {
        getFillColor: partition.colorRevision,
        getRadius: partition.sizeRevision,
      },
    });
    if (partition.highlight.length === 0) return [base];
    const hl = new ScatterplotLayer({
      id: "universe-highlight",
      data: partition.highlight,
      pickable: true,
      stroked: false,
      filled: true,
      radiusUnits: "pixels",
      getPosition: (d: RenderRow) => d.position,
      getFillColor: (d: RenderRow) => d.color,
      getRadius: (d: RenderRow) => d.radius,
      updateTriggers: {
        getFillColor: partition.colorRevision,
        getRadius: partition.sizeRevision,
      },
    });
    return [base, hl];
  }, [partition]);

  const handleClick = useCallback(
    (info: { object?: unknown }) => {
      if (!info?.object) return;
      const row = info.object as RenderRow;
      onPointClick?.(row.id);
    },
    [onPointClick],
  );

  if (query.isLoading) {
    return (
      <div className="universe-scatter loading" style={{ height }}>
        Loading universe scatter…
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="universe-scatter error" style={{ height }}>
        Failed to load scatter: {String(query.error)}
      </div>
    );
  }
  if (!query.data || query.data.n_cells === 0) {
    return (
      <div className="universe-scatter empty" style={{ height }}>
        No cells in this embedding.
      </div>
    );
  }

  return (
    <div className="universe-scatter" style={{ position: "relative", height }}>
      <DeckGL
        views={new OrthographicView({ id: "ortho" })}
        viewState={viewState ?? undefined}
        controller={true}
        onViewStateChange={({ viewState: next }) => {
          // OrthographicView's viewState shape is {target, zoom, ...}.
          setViewState({
            target: (next as { target: [number, number, number] }).target ?? [0, 0, 0],
            zoom: (next as { zoom: number }).zoom ?? FOCUSED_VIEW_ZOOM,
          });
        }}
        layers={layers}
        onClick={handleClick}
        style={{ position: "absolute", left: "0", top: "0", right: "0", bottom: "0" }}
      />
    </div>
  );
}

// --- partition + extent helpers --------------------------------------------

interface Partition {
  base: RenderRow[];
  highlight: RenderRow[];
  /** Bumps when color resolution changes so deck.gl's updateTriggers
   *  invalidate the GPU buffer. Identity-stable when color is unchanged. */
  colorRevision: string;
  sizeRevision: string;
}

function buildPartition(
  data: EmbeddingScatterResponse | undefined,
  highlight: Set<string> | null | undefined,
  extent: Extent | null,
): Partition | null {
  if (!data || !extent) return null;
  const n = data.cell_ids.length;
  // Per-axis linear scalers to [0, 1]. Constant-axis (xMax === xMin)
  // collapses to 0.5 so every point lands at the middle of that axis
  // rather than NaN'ing the position.
  const xSpan = extent.xMax - extent.xMin;
  const ySpan = extent.yMax - extent.yMin;
  const xScale = xSpan > 0 ? 1 / xSpan : 0;
  const yScale = ySpan > 0 ? 1 / ySpan : 0;
  const colorBlock = data.color;
  const sizeBlock = data.size;
  const hasHighlight = !!highlight && highlight.size > 0;

  // Precompute per-point color RGBA. Categorical → lookup color_map;
  // numeric → continuous Viridis; unbound → fall back to base/highlight
  // hexes depending on partition membership (decided per-point below).
  let numericLo = 0;
  let numericHi = 1;
  if (colorBlock?.kind === "numeric") {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const v of colorBlock.values) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (Number.isFinite(lo)) {
      numericLo = lo;
      numericHi = hi;
    }
  }

  const base: RenderRow[] = [];
  const hl: RenderRow[] = [];
  for (let i = 0; i < n; i++) {
    const id = data.cell_ids[i];
    const x = data.x[i];
    const y = data.y[i];
    if (x === null || y === null || x === undefined || y === undefined) continue;
    const isHighlight = hasHighlight && highlight!.has(id);

    let rgb: [number, number, number];
    if (colorBlock?.kind === "categorical") {
      const value = colorBlock.values[i];
      const hex = value === null || value === undefined
        ? colorBlock.color_map?.["(none)"] ?? "#dcdcdc"
        : colorBlock.color_map?.[String(value)] ?? "#dcdcdc";
      rgb = hexToRgb(hex);
    } else if (colorBlock?.kind === "numeric") {
      rgb = numericToViridis(colorBlock.values[i] as number | null, numericLo, numericHi);
    } else {
      // No color binding: base layer uses one of the project's solid
      // hexes; partition decides which.
      const fallback = hasHighlight ? BASE_RGBA_WITH_HIGHLIGHT : BASE_RGBA_NO_HIGHLIGHT;
      rgb = [fallback[0], fallback[1], fallback[2]];
    }
    // Highlight alpha is full; base alpha varies by mode.
    let alpha: number;
    if (isHighlight) {
      alpha = 255;
    } else if (hasHighlight) {
      alpha = BASE_RGBA_WITH_HIGHLIGHT[3];
    } else {
      alpha = BASE_RGBA_NO_HIGHLIGHT[3];
    }
    // When color isn't bound and the point is in the highlight set,
    // use the saturated orange highlight color instead of the channel-
    // less base color so the highlight reads clearly.
    if (isHighlight && !colorBlock) {
      rgb = [HIGHLIGHT_RGBA[0], HIGHLIGHT_RGBA[1], HIGHLIGHT_RGBA[2]];
      alpha = HIGHLIGHT_RGBA[3];
    }

    // Size: server-scaled value (3-10px) when bound; otherwise small for
    // base, slightly larger for highlight. Highlight bumps by +1px when
    // size is bound so the highlight set still reads above the base.
    let radius: number;
    if (sizeBlock) {
      radius = sizeBlock.values[i] ?? 3;
      if (isHighlight) radius += 1;
    } else {
      radius = isHighlight ? 4 : hasHighlight ? 2 : 3;
    }

    const nx = xScale > 0 ? ((x as number) - extent.xMin) * xScale : 0.5;
    const ny = yScale > 0 ? ((y as number) - extent.yMin) * yScale : 0.5;
    const row: RenderRow = {
      id,
      position: [nx, ny],
      color: [rgb[0], rgb[1], rgb[2], alpha],
      radius,
    };
    if (isHighlight) hl.push(row);
    else base.push(row);
  }

  // Revision strings drive deck.gl's updateTriggers — change ⇒ rebuild
  // the GPU buffers. Including the binding identity here is enough; the
  // per-point arrays are immutable for a given binding set.
  const colorRevision = `${colorBlock?.column ?? ""}|${colorBlock?.kind ?? ""}|${hasHighlight ? "hl" : "no-hl"}`;
  const sizeRevision = `${sizeBlock?.column ?? ""}|${hasHighlight ? "hl" : "no-hl"}`;
  return { base, highlight: hl, colorRevision, sizeRevision };
}

interface Extent {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

function computeExtent(data: EmbeddingScatterResponse): Extent {
  let xMin = Number.POSITIVE_INFINITY;
  let xMax = Number.NEGATIVE_INFINITY;
  let yMin = Number.POSITIVE_INFINITY;
  let yMax = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.cell_ids.length; i++) {
    const x = data.x[i];
    const y = data.y[i];
    if (x === null || x === undefined || !Number.isFinite(x)) continue;
    if (y === null || y === undefined || !Number.isFinite(y)) continue;
    if (x < xMin) xMin = x;
    if (x > xMax) xMax = x;
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  if (!Number.isFinite(xMin)) {
    return { xMin: -1, xMax: 1, yMin: -1, yMax: 1 };
  }
  return { xMin, xMax, yMin, yMax };
}

function unitSquareViewState(heightPx: number): {
  target: [number, number, number];
  zoom: number;
} {
  // Data is pre-normalized to a unit square in `buildPartition`, so
  // the view always targets (0.5, 0.5) and the zoom that fits the y
  // axis depends only on the canvas height. OrthographicView's zoom
  // is log2-pixels-per-data-unit; with a 1-unit-tall data extent and a
  // 10% padding, we want heightPx * (1 - 2*padding) pixels to cover
  // the 1-unit span.
  const padding = 0.1;
  const fitHeightPx = heightPx * (1 - 2 * padding);
  const zoom = Math.log2(fitHeightPx);
  return {
    target: [0.5, 0.5, 0],
    zoom: Math.max(-10, Math.min(20, zoom)),
  };
}
