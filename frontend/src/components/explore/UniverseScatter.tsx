import { lazy, Suspense, useCallback, useMemo } from "react";
import { useEmbeddingScatter } from "../../api/embeddings";

// Lazy-load react-plotly the same way PlotPanel does — keeps the ~2MB
// plotly bundle out of the landing-page / partner-browsing critical path.
// Same Plotly cartesian dist for parity; scattergl is included.
const Plot = lazy(async () => {
  const [{ default: createPlotlyComponent }, Plotly] = await Promise.all([
    import("react-plotly.js/factory"),
    import("plotly.js-cartesian-dist-min"),
  ]);
  return { default: createPlotlyComponent(Plotly.default) };
});

const PLOTLY_CONFIG = { displaylogo: false, responsive: true };
const BASE_COLOR_NO_HIGHLIGHT = "#5b8bd1";
const BASE_COLOR_WITH_HIGHLIGHT = "#d1d5db";
const HIGHLIGHT_COLOR = "#f59e0b";
const NUMERIC_COLORSCALE = "Viridis";

interface Props {
  ds: string;
  featureTableId: string;
  embeddingId: string;
  /** Channel bindings forwarded to /scatter — passed through verbatim
   *  to `useEmbeddingScatter`. The response carries the resolved
   *  per-point arrays + (for categorical color) a color_map so the
   *  same value lands on the same hex everywhere in the project. */
  x?: string | null;
  y?: string | null;
  colorBy?: string | null;
  sizeBy?: string | null;
  decorationTables?: string[];
  matVersion?: number | "live" | null;
  /** Cell_ids to render in the highlight trace (orange, full opacity).
   *  The complement (universe \ highlight) renders in the base trace
   *  (gray, low opacity). Empty or null → everything is in the base. */
  highlightedCellIds?: Set<string> | null;
  /** Called with cell_ids when the user box/lasso selects on the
   *  scatter. Suppressed when the selection is empty so a phantom
   *  Plotly event doesn't clear a real selection. */
  onLassoSelect?: (cellIds: string[]) => void;
  /** Called when the user clicks a single point — typically used to
   *  set a focal cell_id in URL state. */
  onPointClick?: (cellId: string) => void;
  height?: number;
}

/**
 * Universe scatter for the Feature Explorer.
 *
 * Renders every cell in a feature table at its 2D embedding coordinates
 * (or user-bound x/y channels), with optional per-point color/size
 * channels and a highlight overlay. Built around two scattergl traces:
 *
 * - **base** — universe \ highlight, lower visual weight.
 * - **highlight** — the active highlight set, saturated.
 *
 * Splitting into two traces (rather than per-point opacity changes on a
 * single trace) lets Plotly skip re-layout on selection changes — only
 * the trace `x`/`y`/`customdata` arrays swap, which is cheap.
 *
 * Selection plumbing: each point's `customdata` carries the cell_id, so
 * the parent reads the lasso/click result without consulting any side
 * channel. Empty selections are suppressed (phantom event from Plotly's
 * deselect handler).
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
  onLassoSelect,
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

  // Resolve per-point marker color from the color channel, if bound.
  // Categorical: map values → hex via the response's color_map (the
  // backend builds this with resolve_categorical_color_map so the same
  // value lands on the same color everywhere). Numeric: pass values
  // through; Plotly applies a continuous colorscale.
  const colorVector = useMemo<{
    colors?: string[];
    numeric?: Array<number | null>;
    kind: "categorical" | "numeric" | null;
  }>(() => {
    const c = query.data?.color;
    if (!c) return { kind: null };
    if (c.kind === "categorical") {
      const cm = c.color_map ?? {};
      const nullColor = cm["(none)"] ?? "#dcdcdc";
      const colors = c.values.map((v) =>
        v === null || v === undefined ? nullColor : cm[String(v)] ?? nullColor,
      );
      return { colors, kind: "categorical" };
    }
    return {
      numeric: c.values as Array<number | null>,
      kind: "numeric",
    };
  }, [query.data?.color]);

  const sizeVector = query.data?.size?.values ?? null;
  // Hover should fire only when a channel binding gives the user
  // something to read. With no color/size binding the base layer is a
  // dense uniform cloud — hover hit-testing on 94k points is wasted
  // every mousemove.
  const hoverEnabledOnBase = !!(query.data?.color || query.data?.size);
  const hoverTemplate = useMemo(() => {
    const lines = ["cell_id: %{customdata}"];
    const c = query.data?.color;
    if (c) {
      // %{marker.color} is the resolved hex, not the source value; the
      // source value comes from customdata if we pack it. To keep things
      // simple we surface the textual value via a parallel `text`
      // attribute on each trace below (see {base,highlight}Trace).
      lines.push(`${c.column}: %{text}`);
    }
    const s = query.data?.size;
    if (s) {
      lines.push(`${s.column}: (size-scaled)`);
    }
    return `${lines.join("<br>")}<extra></extra>`;
  }, [query.data?.color, query.data?.size]);

  // `text` field carries the textual color-channel value per point so
  // the hover template can show it (`%{text}`). Falls back to empty
  // strings when no color binding so the template degrades cleanly.
  const colorText = useMemo<string[] | null>(() => {
    const c = query.data?.color;
    if (!c) return null;
    return c.values.map((v) =>
      v === null || v === undefined ? "(none)" : String(v),
    );
  }, [query.data?.color]);

  const { baseTrace, highlightTrace, partitioned } = useMemo(() => {
    const data = query.data;
    if (!data) {
      return { baseTrace: null, highlightTrace: null, partitioned: false };
    }
    const hl = highlightedCellIds;
    const hasHighlight = hl != null && hl.size > 0;

    if (!hasHighlight) {
      // Single trace — channel bindings drive color/size; otherwise
      // solid project blue + uniform 3px.
      const baseMarker: Record<string, unknown> = { size: 3 };
      if (colorVector.kind === "categorical" && colorVector.colors) {
        baseMarker.color = colorVector.colors;
      } else if (colorVector.kind === "numeric") {
        baseMarker.color = colorVector.numeric;
        baseMarker.colorscale = NUMERIC_COLORSCALE;
        baseMarker.showscale = true;
      } else {
        baseMarker.color = BASE_COLOR_NO_HIGHLIGHT;
      }
      if (sizeVector) baseMarker.size = sizeVector;
      // selected/unselected pinned so Plotly's lasso-completion fade
      // doesn't fire. Critically, the pinned config must match the
      // *shape* of `baseMarker` — color and size both pin to whatever
      // the main marker uses (array or scalar). A shape mismatch
      // (e.g. main marker uses size-array but pinned marker leaves
      // size undefined) corrupts scattergl's WebGL buffer state and
      // produces visual glitches when selection state toggles.
      const pinnedColor =
        colorVector.kind === "categorical" && colorVector.colors
          ? colorVector.colors
          : colorVector.kind === "numeric"
            ? colorVector.numeric
            : BASE_COLOR_NO_HIGHLIGHT;
      const pinnedSize = sizeVector ?? 3;
      const pinned = { color: pinnedColor, size: pinnedSize, opacity: 1 };
      return {
        baseTrace: {
          type: "scattergl",
          mode: "markers",
          x: data.x,
          y: data.y,
          customdata: data.cell_ids,
          text: colorText ?? undefined,
          marker: baseMarker,
          selected: { marker: pinned },
          unselected: { marker: pinned },
          hoverinfo: hoverEnabledOnBase ? undefined : "skip",
          hovertemplate: hoverEnabledOnBase ? hoverTemplate : undefined,
          name: "universe",
        },
        highlightTrace: null,
        partitioned: false,
      };
    }

    // Partition by cell_id into base + highlight. We carry the same
    // channel arrays into each partition by index so colors/sizes stay
    // aligned with their rows.
    const baseIdx: number[] = [];
    const hlIdx: number[] = [];
    for (let i = 0; i < data.cell_ids.length; i++) {
      if (hl!.has(data.cell_ids[i])) hlIdx.push(i);
      else baseIdx.push(i);
    }
    const pick = <T,>(arr: ArrayLike<T>, idx: number[]): T[] =>
      idx.map((i) => arr[i]);
    const baseXs = pick(data.x as number[], baseIdx);
    const baseYs = pick(data.y as number[], baseIdx);
    const baseIds = pick(data.cell_ids, baseIdx);
    const hlXs = pick(data.x as number[], hlIdx);
    const hlYs = pick(data.y as number[], hlIdx);
    const hlIds = pick(data.cell_ids, hlIdx);
    const baseColors = colorVector.colors
      ? pick(colorVector.colors, baseIdx)
      : colorVector.numeric
        ? pick(colorVector.numeric, baseIdx)
        : null;
    const hlColors = colorVector.colors
      ? pick(colorVector.colors, hlIdx)
      : colorVector.numeric
        ? pick(colorVector.numeric, hlIdx)
        : null;
    const baseSizes = sizeVector ? pick(sizeVector, baseIdx) : null;
    const hlSizes = sizeVector ? pick(sizeVector, hlIdx) : null;
    const baseColorText = colorText ? pick(colorText, baseIdx) : undefined;
    const hlColorText = colorText ? pick(colorText, hlIdx) : undefined;

    // When color is bound, the base trace uses the resolved channel
    // colors (slightly muted by Plotly's scale through grayscale isn't
    // automatic — we keep the categorical hex as-is). When unbound,
    // base goes light gray so the orange highlight reads on top.
    const baseColor =
      colorVector.kind === "categorical" && baseColors
        ? baseColors
        : colorVector.kind === "numeric" && baseColors
          ? baseColors
          : BASE_COLOR_WITH_HIGHLIGHT;
    // When sizeBy is bound the size channel is the user's intended
    // visual encoding — don't add a constant bump on top of it. When
    // not bound, the highlight gets a 2× size step for visual lift.
    const baseSize = baseSizes ?? 2;
    const hlSize = hlSizes ?? 4;
    const baseMarkerCfg: Record<string, unknown> = {
      size: baseSize,
      color: baseColor,
    };
    if (colorVector.kind === "numeric" && baseColors) {
      baseMarkerCfg.colorscale = NUMERIC_COLORSCALE;
    }
    const hlColor =
      colorVector.kind === "categorical" && hlColors
        ? hlColors
        : colorVector.kind === "numeric" && hlColors
          ? hlColors
          : HIGHLIGHT_COLOR;
    const hlMarkerCfg: Record<string, unknown> = {
      size: hlSize,
      color: hlColor,
    };
    if (colorVector.kind === "numeric" && hlColors) {
      hlMarkerCfg.colorscale = NUMERIC_COLORSCALE;
    }
    // Pin color AND size in selected/unselected so the scattergl
    // WebGL buffer state stays consistent across selection toggles.
    // A pinned-marker that lacks one of color/size while the main
    // marker has it causes Plotly to construct a malformed buffer —
    // observed as huge visual glitches on per-point size arrays.
    return {
      baseTrace: {
        type: "scattergl",
        mode: "markers",
        x: baseXs,
        y: baseYs,
        customdata: baseIds,
        text: baseColorText,
        marker: baseMarkerCfg,
        selected: { marker: { color: baseColor, size: baseSize, opacity: 1 } },
        unselected: { marker: { color: baseColor, size: baseSize, opacity: 1 } },
        hoverinfo: hoverEnabledOnBase ? undefined : "skip",
        hovertemplate: hoverEnabledOnBase ? hoverTemplate : undefined,
        name: "other",
      },
      highlightTrace: {
        type: "scattergl",
        mode: "markers",
        x: hlXs,
        y: hlYs,
        customdata: hlIds,
        text: hlColorText,
        marker: hlMarkerCfg,
        selected: { marker: { color: hlColor, size: hlSize, opacity: 1 } },
        unselected: { marker: { color: hlColor, size: hlSize, opacity: 1 } },
        hovertemplate: hoverTemplate,
        name: "selected",
      },
      partitioned: true,
    };
  }, [
    query.data,
    highlightedCellIds,
    colorVector,
    sizeVector,
    colorText,
    hoverEnabledOnBase,
    hoverTemplate,
  ]);

  const traces = useMemo(() => {
    const out: unknown[] = [];
    if (baseTrace) out.push(baseTrace);
    if (highlightTrace) out.push(highlightTrace);
    return out;
  }, [baseTrace, highlightTrace]);

  const layout = useMemo(
    () => ({
      autosize: true,
      height,
      margin: { l: 40, r: 12, t: 8, b: 36 },
      xaxis: { title: { text: query.data?.axes.x ?? "" }, zeroline: false },
      yaxis: { title: { text: query.data?.axes.y ?? "" }, zeroline: false },
      // `dragmode: 'lasso'` gives users selection on the first interaction
      // — pan stays available via the toolbar.
      dragmode: "lasso" as const,
      hovermode: "closest" as const,
      showlegend: false,
      // `uirevision` keeps Plotly from resetting zoom/pan when the
      // partition swaps between {only-base, base+highlight} on highlight
      // set changes. Tying it to the axis columns means a real axis
      // change (user picked different x/y) DOES reset the view.
      uirevision: `${query.data?.axes.x ?? ""}/${query.data?.axes.y ?? ""}`,
    }),
    [height, query.data?.axes.x, query.data?.axes.y],
  );
  // suppress unused-var lint for `partitioned` (kept for future debug)
  void partitioned;

  const handleSelected = useCallback(
    (ev: { points?: Array<{ customdata?: unknown } | undefined> } | undefined) => {
      if (!ev || !ev.points) return;
      const ids = new Set<string>();
      for (const p of ev.points) {
        const cd = p?.customdata;
        if (typeof cd === "string") ids.add(cd);
      }
      if (ids.size === 0) return; // suppress phantom deselect events
      onLassoSelect?.(Array.from(ids));
    },
    [onLassoSelect],
  );

  const handleClick = useCallback(
    (ev: { points?: Array<{ customdata?: unknown } | undefined> } | undefined) => {
      if (!ev || !ev.points || ev.points.length === 0) return;
      const cd = ev.points[0]?.customdata;
      if (typeof cd === "string") onPointClick?.(cd);
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
    <Suspense
      fallback={
        <div className="universe-scatter loading" style={{ height }}>
          Loading plotly…
        </div>
      }
    >
      <Plot
        data={traces as Parameters<typeof Plot>[0]["data"]}
        layout={layout}
        config={PLOTLY_CONFIG}
        style={{ width: "100%", height }}
        useResizeHandler
        onSelected={handleSelected}
        onClick={handleClick}
      />
    </Suspense>
  );
}
