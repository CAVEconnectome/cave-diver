import { useEffect, useMemo } from "react";
import {
  useCellList,
  useEmbeddingList,
  useEmbeddingScatter,
  useResolveRoots,
} from "../../api/embeddings";
import {
  parseMatVersion,
  useSetUrlParams,
  useUrlParam,
} from "../../hooks/useUrlState";
import { useMakeSegmentsLinkMutation } from "../../api/queries";
import type { PartnerRecord } from "../../api/types";

/** Hard cap on the cells handed to /links/segments at once. The server
 *  allows up to 1000; the explorer caps lower (500) because Neuroglancer
 *  itself starts feeling sluggish past a few hundred segments and the
 *  user rarely needs more for a "look at this group" workflow. Sets
 *  above the cap get randomly sub-sampled — `Open in NGL` on a 50k
 *  filter result is meaningful as a sample, not as a full enumeration. */
const NGL_LINK_CAP = 500;

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
      title={active ? `Clear the active ${label}` : `No active ${label} to clear`}
      onClick={(e) => {
        e.stopPropagation();
        if (!active) return;
        onClear();
      }}
    >
      × clear {label}
    </span>
  );
}

interface NglActionPillProps {
  label: string;
  count: number;
  disabled: boolean;
  liveDisabled: boolean;
  onOpen: () => void;
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
  disabled,
  liveDisabled,
  onOpen,
}: NglActionPillProps) {
  const sampled = Math.min(count, NGL_LINK_CAP);
  const title = liveDisabled
    ? "Switch to a materialized version to open in Neuroglancer"
    : count === 0
      ? `No ${label} cells to open`
      : count > NGL_LINK_CAP
        ? `Open a random sample of ${NGL_LINK_CAP} cells from the ${count.toLocaleString()} ${label}`
        : `Open ${count.toLocaleString()} ${label} cells in Neuroglancer`;
  return (
    <span
      role="button"
      className={`explore-ngl-pill${disabled ? " disabled" : ""}`}
      aria-disabled={disabled}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        if (disabled) return;
        onOpen();
      }}
    >
      ↗ {label} ({sampled.toLocaleString()}
      {count > NGL_LINK_CAP && (
        <>/{count.toLocaleString()}</>
      )}
      )
    </span>
  );
}

/** Random sub-sample of `arr` of size `cap`, preserving original order.
 *  Reservoir sampling: O(n) single-pass, uniform without replacement.
 *  Returns the full array unchanged when it's already at-or-below cap. */
function randomSubsample<T>(arr: T[], cap: number): T[] {
  if (arr.length <= cap) return arr;
  const out = arr.slice(0, cap);
  for (let i = cap; i < arr.length; i++) {
    const j = Math.floor(Math.random() * (i + 1));
    if (j < cap) out[j] = arr[i];
  }
  return out;
}
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
  // Unified selection state: cell_ids the user has chosen, by either
  // mechanism — row checkboxes in the table OR lassoing on the
  // scatter. Lassoing is a *selection action*, not a table filter —
  // a polygon over the scatter behaves the same as ticking each
  // contained cell's checkbox. URL key kept as ?sel_table since it
  // started life as the row-selection state; the name is incidental
  // now that lasso and row-clicks share it.
  const [selTableRaw, setSelTable] = useUrlParam("sel_table");
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
  // "Limit visible to selection" — a *snapshot* of cell_ids the user
  // froze at the moment they clicked the action. The table narrows
  // to these. Distinct from `?sel_table` (the live selection) so the
  // user can modify their selection (check/uncheck rows, lasso more)
  // without the visible-set shifting under their interactions.
  // "Reset visible" clears this state.
  const [limitToRaw, setLimitTo] = useUrlParam("limit_to");
  const limitToCellIds = useMemo(
    () => (limitToRaw ? limitToRaw.split(",").filter(Boolean) : []),
    [limitToRaw],
  );
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

  // The unified selection set: cell_ids from row checkboxes AND
  // lasso. One source of truth — populated by either mechanism,
  // read by the scatter highlight, the table's row-checked state,
  // and the NGL "selected" action.
  const rowSelectedCellIds = useMemo(
    () => (selTableRaw ? selTableRaw.split(",").filter(Boolean) : []),
    [selTableRaw],
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

  // /cells fetch — the cell-list table reads from this. With lasso
  // now a selection mechanism (not a filter), the request is driven
  // purely by the filter expression `?cells=` from CellFilterPanel.
  // matched_count reflects "everything passing the filter."
  const cellList = useCellList(
    ds && ft
      ? {
          ds,
          featureTableId: ft,
          matVersion,
          decorationTables,
          cells,
        }
      : null,
  );

  // Highlight set on the scatter, in priority order:
  //   1. The unified selection (row-sel = lasso ∪ row-clicks). When
  //      non-empty, that's the highlight.
  //   2. Filter result. When the user has narrowed scope with the
  //      CellFilterPanel but hasn't selected anything yet, the
  //      filter result reads as the implicit highlight.
  //   3. Nothing → no overlay.
  const highlightedCellIds = useMemo(() => {
    if (rowSelectedCellIds.length > 0) {
      return new Set(rowSelectedCellIds);
    }
    if (!cells) return null;
    if (!cellList.data) return null;
    return new Set(cellList.data.cell_ids);
  }, [rowSelectedCellIds, cells, cellList.data]);

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

  const segmentsLink = useMakeSegmentsLinkMutation();
  const openInNgl = async (cellIds: string[]) => {
    if (matVersion === "live" || !ds) return;
    const roots = resolveRoots(cellIds);
    if (roots.length === 0) return;
    const sampled = randomSubsample(roots, NGL_LINK_CAP);
    try {
      const result = await segmentsLink.mutateAsync({
        ds,
        matVersion,
        rootIds: sampled,
      });
      window.open(result.url, "_blank");
    } catch {
      // Error surfaces via segmentsLink.isError below the buttons.
    }
  };

  // Enrich cellList rows with the resolved root_id so PartnersTable's
  // existing rendering machinery picks it up like any other column.
  // The augmented column_groups carries a "current root" group so the
  // user can see the resolution alongside cell_id.
  const enrichedCells = useMemo(() => {
    if (!cellList.data) return null;
    // PartnerRecord.root_id is typed as string (non-null) for the
    // /neuron use case. In /explore the field is a *resolution* —
    // null is meaningful ("didn't resolve at this mv"). The cast
    // is safe because the cell-list table renders root_id via the
    // CopyableId path which handles null; nothing else in the
    // explorer reads this field as a non-null string.
    const rows = cellList.data.rows.map((row) => {
      const cid = String(row.cell_id);
      return {
        ...row,
        root_id: rootByCellId.get(cid) ?? null,
      };
    }) as unknown as PartnerRecord[];
    const groups = cellList.data.column_groups.map((g) =>
      g.name === "id" ? { ...g, columns: [...g.columns, "root_id"] } : g,
    );
    return { rows, column_groups: groups };
  }, [cellList.data, rootByCellId]);

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
            onLassoSelect={(polygonIds) => {
              // Lasso writes into the unified selection. Intersect with
              // the in-scope set so the user can't "select" cells that
              // don't pass the current filter — out-of-scope cells
              // wouldn't show in the table or have meaningful NGL
              // resolution there anyway. When no filter is active the
              // in-scope set is the full universe, so the intersection
              // collapses to the polygon hit-test result.
              const scope = cellList.data
                ? new Set(cellList.data.cell_ids)
                : null;
              const inScope =
                scope === null ? polygonIds : polygonIds.filter((id) => scope.has(id));
              setSelTable(inScope.length > 0 ? inScope.join(",") : null);
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
            {/* NGL actions — grouped on the left side with the
                count and selection context (where filtering and
                selection actually happen). Both buttons are always
                rendered; "selected" greys out when nothing is row-
                selected so the user can see the action exists even
                when it's not actionable. Live mode disables both. */}
            <NglActionPill
              label="visible"
              count={cellList.data?.matched_count ?? 0}
              disabled={
                !cellList.data ||
                cellList.data.matched_count === 0 ||
                matVersion === "live" ||
                segmentsLink.isPending
              }
              liveDisabled={matVersion === "live"}
              onOpen={() =>
                cellList.data && openInNgl(cellList.data.cell_ids)
              }
            />
            <NglActionPill
              label="selected"
              count={rowSelectedCellIds.length}
              disabled={
                rowSelectedCellIds.length === 0 ||
                matVersion === "live" ||
                segmentsLink.isPending
              }
              liveDisabled={matVersion === "live"}
              onOpen={() => openInNgl(rowSelectedCellIds)}
            />
            {/* Single clear-selection pill — covers both lasso and
                row-click selections now that they share the same
                URL key. Greyed when there's nothing to clear. */}
            <span className="explore-pill-separator" aria-hidden />
            <ClearPill
              label="selection"
              active={rowSelectedCellIds.length > 0}
              onClear={() => setSelTable(null)}
              variant="rowsel"
            />
          </button>
          {tableOpen && enrichedCells && enrichedCells.rows.length > 0 && (
            <div className="explore-drawer-body">
              <div className="explore-drawer-toolbar">
                <button
                  type="button"
                  className="explore-toolbar-btn"
                  disabled={rowSelectedCellIds.length === 0}
                  title={
                    rowSelectedCellIds.length === 0
                      ? "Select some rows first, then snapshot the selection into the visible set"
                      : `Snapshot ${rowSelectedCellIds.length} selected cells as the visible set — the table narrows to these and stays stable while you modify the selection`
                  }
                  onClick={() => setLimitTo(rowSelectedCellIds.join(","))}
                >
                  Limit visible to selection
                  {rowSelectedCellIds.length > 0 && (
                    <span className="explore-toolbar-btn-count">
                      &nbsp;({rowSelectedCellIds.length})
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="explore-toolbar-btn"
                  disabled={limitToCellIds.length === 0}
                  title={
                    limitToCellIds.length === 0
                      ? "Nothing limiting the visible set right now"
                      : "Drop the snapshot — table returns to the full filter scope"
                  }
                  onClick={() => setLimitTo(null)}
                >
                  Reset visible
                </button>
                {limitToCellIds.length > 0 && (
                  <span className="explore-toolbar-hint">
                    visible limited to {limitToCellIds.length.toLocaleString()} snapshotted cells
                  </span>
                )}
              </div>
              {segmentsLink.isError && (
                <div className="explore-ngl-error">
                  NGL link failed: {String(segmentsLink.error)}
                </div>
              )}
              <PartnersTable
                ds={ds}
                rootId={ft}
                matVersion={matVersion}
                direction="both"
                rows={enrichedCells.rows}
                columnGroups={enrichedCells.column_groups}
                decorationTables={decorationTables}
                keyColumn="cell_id"
                // Resolve cell_id → root_id at the active mv. Cells
                // that didn't resolve (missing / ambiguous / not yet
                // resolved / live mode) get a "#" href so the link is
                // visually present but doesn't navigate; the user can
                // see why in the root_id column (rendered as null).
                crossNavHref={(cellId) => {
                  const root = rootByCellId.get(cellId);
                  if (!root) return "#";
                  const next = new URLSearchParams();
                  next.set("ds", ds);
                  next.set("mv", matVersion === "live" ? "live" : String(matVersion));
                  next.set("root", root);
                  next.set("from", `explore:${ft}/${emb}`);
                  if (decorationTables.length > 0) {
                    next.set("dec", decorationTables.join(","));
                  }
                  if (cells) next.set("cells", cells);
                  return `/neuron?${next.toString()}`;
                }}
                enableNglAction={false}
                rowsLabel="cells"
                selectedIds={rowSelectedCellIds}
                onSelectedIdsChange={(ids) =>
                  setSelTable(ids.length > 0 ? ids.join(",") : null)
                }
                externalSelection={
                  limitToCellIds.length > 0 ? limitToCellIds : null
                }
              />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
