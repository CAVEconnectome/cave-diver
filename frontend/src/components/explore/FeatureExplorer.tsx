import { useEffect, useMemo } from "react";
import {
  useCellList,
  useEmbeddingList,
  useEmbeddingScatter,
} from "../../api/embeddings";
import {
  parseMatVersion,
  useSetUrlParams,
  useUrlParam,
} from "../../hooks/useUrlState";
import { CellFilterPanel } from "../CellFilterPanel";
import { PartnersTable } from "../PartnersTable";
import { ChannelPicker } from "./ChannelPicker";
import { DecorationPicker } from "./DecorationPicker";
import { EmbeddingPicker } from "./EmbeddingPicker";
import { FeatureTablePicker } from "./FeatureTablePicker";
import { SummaryPanel } from "./SummaryPanel";
import { UniverseScatter } from "./UniverseScatter";

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
  const [cells] = useUrlParam("cells");
  const [selUniverseRaw, setSelUniverse] = useUrlParam("sel_universe");
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
  const [colorMinRaw] = useUrlParam("color_min");
  const [colorMaxRaw] = useUrlParam("color_max");
  // Drawer state for the cell-list table. Closed by default so the
  // scatter owns the full canvas on first arrival; user clicks the
  // drawer handle to pull up the table.
  const [tableRaw, setTable] = useUrlParam("table");
  const tableOpen = tableRaw === "open";
  // Size range falls back to client defaults when URL is silent.
  const sizeMinPx = sizeMinRaw ? parseFloat(sizeMinRaw) : 2.0;
  const sizeMaxPx = sizeMaxRaw ? parseFloat(sizeMaxRaw) : 18.0;
  // Color clipping is null-default — the slider's bounds come from
  // the data extent at render time, and null means "use the full
  // extent." Explicit URL values clamp the colorscale endpoints.
  const colorMin = colorMinRaw ? parseFloat(colorMinRaw) : null;
  const colorMax = colorMaxRaw ? parseFloat(colorMaxRaw) : null;
  const setUrl = useSetUrlParams();

  const matVersion = parseMatVersion(mv);
  const decorationTables = decRaw ? decRaw.split(",").filter(Boolean) : [];

  // Catalog — drives both pickers + tells us if the explorer is even
  // configured for this datastack.
  const catalog = useEmbeddingList(ds);
  const featureTables = catalog.data?.feature_tables ?? [];

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

  // Lasso selection: cell_ids in URL state. Parsed once here so both
  // the highlight computation and the cell-list fetch reuse it.
  const lassoCellIds = useMemo(
    () => (selUniverseRaw ? selUniverseRaw.split(",").filter(Boolean) : []),
    [selUniverseRaw],
  );

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
          colorBy: colorBinding,
          sizeBy: sizeBinding,
          decorationTables,
          matVersion,
        }
      : null,
  );

  // Color slider bounds: data extent of the bound numeric column.
  // Recomputed on each response so the slider always reflects the
  // current column's range, not a stale one from a previous binding.
  const colorBound = useMemo(() => {
    const c = scatter.data?.color;
    if (!c || c.kind !== "numeric") return null;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (const v of c.values) {
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!Number.isFinite(lo)) return null;
    return { lo, hi };
  }, [scatter.data?.color]);

  // /cells fetch — the cell-list table reads from this. When a lasso
  // is active, the request includes the cell_id subset so the table
  // shows only lasso'd rows (ANDed with any active filter expression
  // on the server). matched_count then reflects "filter ∩ lasso".
  const cellList = useCellList(
    ds && ft
      ? {
          ds,
          featureTableId: ft,
          matVersion,
          decorationTables,
          cells,
          selCellIds: lassoCellIds.length > 0 ? lassoCellIds : null,
        }
      : null,
  );

  // Highlight set on the scatter: the cell_id set that matters right
  // now. With the /cells endpoint already applying the lasso ∧ filter
  // intersection server-side, the response's `cell_ids` IS the
  // intersection — we just consume it. Returns null when nothing is
  // active so the scatter renders without an overlay.
  const highlightedCellIds = useMemo(() => {
    const filterActive = !!cells;
    const lassoActive = lassoCellIds.length > 0;
    if (!filterActive && !lassoActive) return null;
    if (!cellList.data) return null;
    return new Set(cellList.data.cell_ids);
  }, [cells, lassoCellIds, cellList.data]);

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

  const currentFt = featureTables.find((t) => t.id === ft) ?? null;
  const currentEmbeddings = currentFt?.embeddings ?? [];
  const currentEmb = currentEmbeddings.find((e) => e.id === emb) ?? null;

  return (
    <div className="explore">
      <aside className="explore-rail">
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
        <ChannelPicker
          featureTable={currentFt}
          cellsColumnGroups={cellList.data?.column_groups}
          x={xBinding}
          y={yBinding}
          colorBy={colorBinding}
          sizeBy={sizeBinding}
          sizeMinPx={sizeMinPx}
          sizeMaxPx={sizeMaxPx}
          colorBound={colorBound}
          colorMin={colorMin}
          colorMax={colorMax}
          colorIsNumeric={scatter.data?.color?.kind === "numeric"}
          defaultXLabel={currentEmb?.axes?.[0]}
          defaultYLabel={currentEmb?.axes?.[1]}
          defaultColorLabel={currentEmb?.default_color_by ?? null}
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
              ...(next.colorMin !== undefined
                ? { color_min: next.colorMin === null ? null : String(next.colorMin) }
                : {}),
              ...(next.colorMax !== undefined
                ? { color_max: next.colorMax === null ? null : String(next.colorMax) }
                : {}),
            })
          }
        />
        <CellFilterPanel
          columnGroups={cellList.data?.column_groups}
          sampleRows={cellList.data?.rows}
        />
        <SummaryPanel
          scatter={scatter.data}
          highlightedCellIds={highlightedCellIds}
        />
      </aside>
      <section className={`explore-center${tableOpen ? " table-open" : ""}`}>
        <div className="explore-scatter-wrap">
          <UniverseScatter
            ds={ds}
            featureTableId={ft}
            embeddingId={emb}
            x={xBinding}
            y={yBinding}
            colorBy={colorBinding}
            sizeBy={sizeBinding}
            sizeMinPx={sizeMinPx}
            sizeMaxPx={sizeMaxPx}
            colorMin={colorMin}
            colorMax={colorMax}
            decorationTables={decorationTables}
            matVersion={matVersion}
            highlightedCellIds={highlightedCellIds}
            onLassoSelect={(ids) =>
              setSelUniverse(ids.length > 0 ? ids.join(",") : null)
            }
          />
        </div>
        {/* Drawer: handle always visible; body only when open. */}
        <div className={`explore-drawer${tableOpen ? " open" : ""}`}>
          <button
            type="button"
            className="explore-drawer-handle"
            onClick={() => setTable(tableOpen ? null : "open")}
            aria-expanded={tableOpen}
          >
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
            {selUniverseRaw && (
              <span
                role="button"
                className="explore-clear-lasso"
                onClick={(e) => {
                  // Stop propagation so clicking "clear" doesn't also
                  // toggle the drawer.
                  e.stopPropagation();
                  setSelUniverse(null);
                }}
              >
                clear lasso
              </span>
            )}
          </button>
          {tableOpen && cellList.data && cellList.data.rows.length > 0 && (
            <div className="explore-drawer-body">
              <PartnersTable
                ds={ds}
                rootId={ft}
                matVersion={matVersion}
                direction="both"
                rows={cellList.data.rows}
                columnGroups={cellList.data.column_groups}
                decorationTables={decorationTables}
                keyColumn="cell_id"
                crossNavHref={() => "#"}
                enableNglAction={false}
                rowsLabel="cells"
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
