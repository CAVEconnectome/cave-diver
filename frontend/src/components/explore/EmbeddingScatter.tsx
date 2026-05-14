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

interface Props {
  /** /points response. Caller passes `null`/`undefined` while loading or
   *  before a datastack is chosen; the component renders an empty plot. */
  data: EmbeddingPointsResponse | null | undefined;
  /** Currently-focused cell_id (the `?cell=` URL param). Just stored
   *  here so a future EmbeddingScatter task (#9) can add a focus trace
   *  without reshaping the API — v1 single-trace doesn't render it. */
  focusCellId?: string | null;
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
  focusCellId: _focusCellId,
  onCellClick,
  onSelected,
  xLabel,
  yLabel,
  height = 600,
}: Props) {
  const traces = useMemo(() => buildTraces(data), [data]);

  const layout = useMemo(
    () => ({
      autosize: true,
      // The colorbar in the numeric branch eats some horizontal real
      // estate; using `automargin` lets it size without us tuning by hand.
      xaxis: { title: { text: xLabel ?? "" }, zeroline: false, automargin: true },
      yaxis: { title: { text: yLabel ?? "" }, zeroline: false, automargin: true },
      margin: { l: 50, r: 20, t: 20, b: 50 },
      dragmode: "lasso" as const,
      hovermode: "closest" as const,
      // uirevision keeps zoom/pan state when only the data updates — so
      // re-coloring or re-fetching doesn't snap back to fitView.
      uirevision: "embedding-scatter",
      // Categorical traces render in the legend (one entry per category);
      // numeric / no-color leaves the legend empty. Showing it
      // unconditionally keeps the plot's bounding box stable across
      // dtype switches.
      showlegend: true,
      legend: { itemsizing: "constant" as const, font: { size: 11 } },
    }),
    [xLabel, yLabel],
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

function buildTraces(data: EmbeddingPointsResponse | null | undefined): unknown[] {
  if (!data) return [];
  const { cell_ids, x, y, color } = data;

  if (!color) {
    return [
      {
        type: "scattergl",
        mode: "markers",
        x,
        y,
        customdata: cell_ids,
        marker: { size: 4, opacity: 0.7, color: NULL_COLOR },
        hovertemplate: "cell %{customdata}<extra></extra>",
        showlegend: false,
      },
    ];
  }

  if (color.kind === "numeric") {
    return [
      {
        type: "scattergl",
        mode: "markers",
        x,
        y,
        customdata: cell_ids,
        marker: {
          size: 4,
          opacity: 0.7,
          color: color.values as number[],
          colorscale: NUMERIC_COLORSCALE,
          showscale: true,
          colorbar: { title: { text: color.column, side: "right" }, thickness: 12 },
        },
        hovertemplate:
          `cell %{customdata}<br>${color.column}: %{marker.color}<extra></extra>`,
        showlegend: false,
      },
    ];
  }

  // Categorical: split into per-category traces. Stable ordering by first
  // occurrence so legend order matches what the user sees scanning the data.
  const byCategory = new Map<string, number[]>();
  const labelFor: Record<string, string> = {};
  color.values.forEach((v, i) => {
    const key = v == null ? "__null__" : String(v);
    if (!byCategory.has(key)) {
      byCategory.set(key, []);
      labelFor[key] = v == null ? "(null)" : String(v);
    }
    byCategory.get(key)!.push(i);
  });

  let paletteIdx = 0;
  return [...byCategory.entries()].map(([key, indices]) => {
    const isNull = key === "__null__";
    const c = isNull ? NULL_COLOR : CATEGORICAL_PALETTE[paletteIdx++ % CATEGORICAL_PALETTE.length];
    return {
      type: "scattergl",
      mode: "markers",
      x: indices.map((i) => x[i]),
      y: indices.map((i) => y[i]),
      customdata: indices.map((i) => cell_ids[i]),
      name: labelFor[key],
      marker: { size: 4, opacity: 0.7, color: c },
      hovertemplate: `cell %{customdata}<br>${color.column}: ${labelFor[key]}<extra></extra>`,
      showlegend: true,
    };
  });
}
