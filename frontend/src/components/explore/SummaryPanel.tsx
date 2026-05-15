import { useMemo } from "react";
import type { EmbeddingScatterResponse } from "../../api/types";

interface Props {
  /** Universe scatter response — provides `cell_ids` and the bound
   *  color channel's per-point values + color_map. Null while
   *  loading. */
  scatter?: EmbeddingScatterResponse | null;
  /** The highlight set — typically (filter ∩ lasso). Null when nothing
   *  narrows the universe; bars then show universe counts only. */
  highlightedCellIds?: Set<string> | null;
}

interface CategoryRow {
  label: string;
  hex: string;
  universeCount: number;
  highlightCount: number;
}

/**
 * Summary panel for the explorer's left rail.
 *
 * Renders a contextual readout based on what's *currently bound* to
 * the color channel:
 *
 * - **Categorical color** → one bar per category. Bar length scales
 *   to the largest universe count; the highlight portion fills from
 *   the left in the category's color. Lets the user see, at a glance,
 *   "I lassoed mostly L23_PYR cells" or "my filter is biased toward
 *   excitatory neurons."
 *
 * - **Numeric color** → deferred (histogram overlay is a follow-up).
 *
 * - **Nothing bound** → just the highlight/universe count text. Avoids
 *   an empty panel when there's nothing meaningful to summarize.
 *
 * Sits at the bottom of the left rail because the data it presents
 * mirrors what's bound *in the rail* (the color channel). Reading
 * top-to-bottom: pickers → channels → filter → "here's what's in
 * scope right now."
 */
export function SummaryPanel({ scatter, highlightedCellIds }: Props) {
  const totalCells = scatter?.n_cells ?? 0;
  const highlightSize = highlightedCellIds?.size ?? 0;

  // Compute category counts (universe + highlight). Memoized because
  // it's O(n) over potentially 100k+ values; the n_cells/highlight
  // identity captures everything that affects the result.
  const categories = useMemo<CategoryRow[] | null>(() => {
    const color = scatter?.color;
    if (!color || color.kind !== "categorical") return null;
    const cm = color.color_map ?? {};
    const universe = new Map<string, number>();
    const highlight = new Map<string, number>();
    const hl = highlightedCellIds;
    for (let i = 0; i < color.values.length; i++) {
      const raw = color.values[i];
      const key = raw === null || raw === undefined ? "(none)" : String(raw);
      universe.set(key, (universe.get(key) ?? 0) + 1);
      if (hl && hl.has(scatter!.cell_ids[i])) {
        highlight.set(key, (highlight.get(key) ?? 0) + 1);
      }
    }
    const out: CategoryRow[] = [];
    for (const [label, count] of universe.entries()) {
      // Drop the "(none)" / null slot from the displayed rows when it
      // would be visually noisy. Keep it when it's a meaningful slice
      // (>5% of the universe) so the user knows it exists.
      if (label === "(none)" && count / totalCells < 0.05) continue;
      out.push({
        label,
        hex: cm[label] ?? "#dcdcdc",
        universeCount: count,
        highlightCount: highlight.get(label) ?? 0,
      });
    }
    // Sort by universe count desc.
    out.sort((a, b) => b.universeCount - a.universeCount);
    return out;
  }, [scatter, highlightedCellIds, totalCells]);

  if (!scatter) return null;

  // Numeric channel selection for the histogram view:
  //   1. Color, when bound numerically — color's the user's primary
  //      visual encoding, so it gets the panel.
  //   2. Size, when bound (always numeric) and color isn't categorical.
  //   3. Nothing — falls back to the categorical/empty case above.
  // The histogram color matches whatever channel is in play: numeric-
  // color uses a Viridis mid-stop; size uses the project accent
  // because there's no "color of the size encoding."
  const numericChannel = (() => {
    const c = scatter.color;
    if (c && c.kind === "numeric") {
      return {
        column: c.column,
        values: c.values as Array<number | null>,
        color: "#21908d", // mid-Viridis teal
      };
    }
    const s = scatter.size;
    if (s && c?.kind !== "categorical") {
      return {
        column: s.column,
        values: s.values,
        color: "#f59e0b",
      };
    }
    return null;
  })();

  const maxUniverse = categories
    ? Math.max(...categories.map((c) => c.universeCount), 1)
    : 1;

  return (
    <div className="summary-panel">
      <div className="explore-picker-label">Summary</div>
      <div className="summary-panel-count">
        {highlightedCellIds && highlightSize > 0 ? (
          <>
            <strong>{highlightSize.toLocaleString()}</strong> of{" "}
            <strong>{totalCells.toLocaleString()}</strong> cells in scope
          </>
        ) : (
          <>
            <strong>{totalCells.toLocaleString()}</strong> cells total
          </>
        )}
      </div>
      {categories && categories.length > 0 && (
        <div
          className="summary-panel-categories"
          title={scatter.color?.column}
        >
          <div className="summary-panel-cat-title">{bareCol(scatter.color!.column)}</div>
          {categories.map((cat) => (
            <SummaryRow key={cat.label} cat={cat} maxUniverse={maxUniverse} />
          ))}
        </div>
      )}
      {numericChannel && (
        <NumericHistogram
          column={numericChannel.column}
          values={numericChannel.values}
          cellIds={scatter.cell_ids}
          highlightedCellIds={highlightedCellIds ?? null}
          color={numericChannel.color}
        />
      )}
    </div>
  );
}

// --- numeric histogram view -------------------------------------------------

interface NumericHistogramProps {
  column: string;
  values: Array<number | null>;
  cellIds: string[];
  highlightedCellIds: Set<string> | null;
  /** Hex color for the highlight bars. Defaults to the project's
   *  accent orange so unbound (e.g. lasso-only) cases still read. */
  color?: string;
}

function NumericHistogram({
  column,
  values,
  cellIds,
  highlightedCellIds,
  color = "#f59e0b",
}: NumericHistogramProps) {
  const bins = useMemo(
    () => buildHistogram(values, cellIds, highlightedCellIds, 24),
    [values, cellIds, highlightedCellIds],
  );

  if (!bins || bins.universeDensity.length === 0) return null;

  const width = 240;
  const height = 60;
  const padLeft = 0;
  const padBottom = 14;
  const innerW = width - padLeft;
  const innerH = height - padBottom;
  // Both distributions are area-normalized to sum 1; the y-axis is
  // shared and scales to the larger of the two distributions' max
  // bin. Result: subset bars and universe bars are visually
  // comparable as *shapes* — the user can see a distribution shift
  // even when the subset is 444 cells out of 94k. Absolute counts
  // are shown above the histogram in the "N of M cells in scope"
  // line.
  const maxDensity = Math.max(
    1e-9,
    ...bins.universeDensity,
    ...bins.highlightDensity,
  );
  const barW = innerW / bins.universeDensity.length;
  const hasHighlight = bins.highlightDensity.some((d) => d > 0);

  return (
    <div className="summary-histogram" title={column}>
      <div className="summary-panel-cat-title">{bareCol(column)}</div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="summary-histogram-svg"
        preserveAspectRatio="none"
      >
        {bins.universeDensity.map((u, i) => {
          const h = (u / maxDensity) * innerH;
          const hl = bins.highlightDensity[i];
          const hlH = (hl / maxDensity) * innerH;
          const x = padLeft + i * barW;
          return (
            <g key={i}>
              {/* Universe bar (gray). */}
              <rect
                x={x + 0.5}
                y={innerH - h}
                width={Math.max(0, barW - 1)}
                height={h}
                fill="rgba(0, 0, 0, 0.18)"
              />
              {/* Highlight overlay (in the channel color). Density-
                  normalized so a small subset is still visible at
                  comparable scale to the universe distribution. */}
              {hasHighlight && hl > 0 && (
                <rect
                  x={x + 0.5}
                  y={innerH - hlH}
                  width={Math.max(0, barW - 1)}
                  height={hlH}
                  fill={color}
                  opacity={0.8}
                />
              )}
            </g>
          );
        })}
        {/* Axis ticks: min + max raw values. */}
        <text
          x={padLeft}
          y={height - 2}
          fontSize="9"
          fill="rgba(0,0,0,0.55)"
          fontFamily="ui-monospace, monospace"
        >
          {formatTick(bins.binMin)}
        </text>
        <text
          x={width}
          y={height - 2}
          fontSize="9"
          fill="rgba(0,0,0,0.55)"
          textAnchor="end"
          fontFamily="ui-monospace, monospace"
        >
          {formatTick(bins.binMax)}
        </text>
      </svg>
    </div>
  );
}

interface HistogramData {
  /** Universe distribution density (each value = bin count /
   *  universe total; sums to 1). */
  universeDensity: number[];
  /** Highlight distribution density (each value = bin count /
   *  highlight total; sums to 1 when the highlight is non-empty,
   *  else all zeros). */
  highlightDensity: number[];
  binMin: number;
  binMax: number;
}

function buildHistogram(
  values: Array<number | null>,
  cellIds: string[],
  highlight: Set<string> | null,
  nBins: number,
): HistogramData | null {
  // Pass 1: extent over finite values.
  let mn = Number.POSITIVE_INFINITY;
  let mx = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  if (!Number.isFinite(mn)) return null;

  const binsLen = mx === mn ? 1 : nBins;
  const binCounts = new Array<number>(binsLen).fill(0);
  const highlightCounts = new Array<number>(binsLen).fill(0);
  let universeTotal = 0;
  let highlightTotal = 0;

  if (mx === mn) {
    // Constant column — single bin so the panel renders without a
    // divide-by-zero downstream.
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      binCounts[0] += 1;
      universeTotal += 1;
      if (highlight && highlight.has(cellIds[i])) {
        highlightCounts[0] += 1;
        highlightTotal += 1;
      }
    }
  } else {
    const span = mx - mn;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      let bin = Math.floor(((v - mn) / span) * nBins);
      if (bin >= nBins) bin = nBins - 1; // clamp the max-value point
      binCounts[bin] += 1;
      universeTotal += 1;
      if (highlight && highlight.has(cellIds[i])) {
        highlightCounts[bin] += 1;
        highlightTotal += 1;
      }
    }
  }

  // Normalize to densities (each distribution sums to 1) so a small
  // subset's shape is visually comparable to the full universe's.
  const universeDensity = binCounts.map((c) =>
    universeTotal > 0 ? c / universeTotal : 0,
  );
  const highlightDensity = highlightCounts.map((c) =>
    highlightTotal > 0 ? c / highlightTotal : 0,
  );
  return { universeDensity, highlightDensity, binMin: mn, binMax: mx };
}

function formatTick(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000 || (Math.abs(n) < 0.01 && n !== 0))
    return n.toExponential(1);
  if (Math.abs(n) >= 100) return n.toFixed(0);
  return n.toFixed(2);
}

function SummaryRow({
  cat,
  maxUniverse,
}: {
  cat: CategoryRow;
  maxUniverse: number;
}) {
  const universePct = (cat.universeCount / maxUniverse) * 100;
  const highlightPctOfMax = (cat.highlightCount / maxUniverse) * 100;
  return (
    <div className="summary-row">
      <div className="summary-row-label" title={cat.label}>
        <span
          className="summary-row-swatch"
          style={{ background: cat.hex }}
        />
        <span className="summary-row-name">{cat.label}</span>
      </div>
      <div className="summary-row-bar-wrap">
        <div
          className="summary-row-bar-universe"
          style={{ width: `${universePct}%` }}
        />
        {cat.highlightCount > 0 && (
          <div
            className="summary-row-bar-highlight"
            style={{
              width: `${highlightPctOfMax}%`,
              background: cat.hex,
            }}
          />
        )}
      </div>
      <div className="summary-row-count">
        {cat.highlightCount > 0 ? (
          <>
            {cat.highlightCount.toLocaleString()}
            <span className="summary-row-count-of">/</span>
            {cat.universeCount.toLocaleString()}
          </>
        ) : (
          cat.universeCount.toLocaleString()
        )}
      </div>
    </div>
  );
}

function bareCol(col: string): string {
  const dot = col.indexOf(".");
  return dot >= 0 ? col.slice(dot + 1) : col;
}
