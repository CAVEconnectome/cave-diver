import { useCallback, useEffect, useMemo, useState } from "react";
import {
  useDecorationCategoricalColumns,
  useEmbeddingList,
  useEmbeddingPoints,
} from "../../api/embeddings";
import { parseMatVersion, useSetUrlParams, useUrlParam } from "../../hooks/useUrlState";
import { ChannelPicker, type ChannelDecorationColumn } from "./ChannelPicker";
import { DecorationPicker } from "./DecorationPicker";
import { EmbeddingPicker } from "./EmbeddingPicker";
import { EmbeddingScatter } from "./EmbeddingScatter";
import { FeatureFilters, type FilterMask } from "./FeatureFilters";
import { KnnControls } from "./KnnControls";
import { SelectionPane } from "./SelectionPane";

/**
 * Top-level route component for `/explore`.
 *
 * URL state (every meaningful selection lives here so a refreshed / shared
 * link reproduces the view):
 *
 * - `?ds`   — datastack (inherited from Workspace)
 * - `?mv`   — mat version (inherited; threaded into the points fetch's
 *             queryKey so flipping mv re-fetches)
 * - `?emb`  — embedding id
 * - `?color`— color-by column (bare = parquet; `table.column` = decoration
 *             once #10 lands)
 * - `?cell` — focus cell_id (single id; lasso/neighbors land in #9)
 * - `?dec`  — attached decoration tables (CSV; threaded but unused in #8)
 *
 * v1 scope (task #8): render the scatter, allow parquet-native coloring,
 * click selects a cell into `?cell=`. Selection / kNN / decorations come
 * in #9-#11. The component is built so each follow-up task only adds
 * children — the URL-state and layout shell are stable.
 */
export function FeatureExplorer() {
  const [ds] = useUrlParam("ds");
  const [mvRaw] = useUrlParam("mv");
  const [emb, setEmb] = useUrlParamSafe("emb");
  // Channel pickers: each writes the user's override or null when the
  // manifest default should stand. URL params are short to keep shared
  // links readable: x / y / color / size.
  const [xColumn, setXColumn] = useUrlParamSafe("x");
  const [yColumn, setYColumn] = useUrlParamSafe("y");
  const [color, setColor] = useUrlParamSafe("color");
  const [sizeColumn, setSizeColumn] = useUrlParamSafe("size");
  const [cell, setCell] = useUrlParamSafe("cell");
  const [neighborsRaw] = useUrlParam("neighbors");
  const [selRaw] = useUrlParam("sel");
  const [kRaw] = useUrlParam("k");
  const [decRaw] = useUrlParam("dec");
  const [cellsExpression, setCellsExpression] = useUrlParamSafe("cells");
  const setUrl = useSetUrlParams();

  // Filter mask comes back from FeatureFilters; threaded into the scatter
  // as a boolean[] per cell. Lives in component state because the mask is
  // derived from column fetches that don't belong in the URL.
  const [filterMask, setFilterMask] = useState<FilterMask | null>(null);

  const neighborCellIds = useMemo(() => parseIdList(neighborsRaw), [neighborsRaw]);
  const brushCellIds = useMemo(() => parseIdList(selRaw), [selRaw]);
  const currentK = useMemo(() => {
    if (!kRaw) return null;
    const n = Number(kRaw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }, [kRaw]);

  const matVersion = parseMatVersion(mvRaw);
  const decorationTables = useMemo(
    () => (decRaw ? decRaw.split(",").map((s) => s.trim()).filter(Boolean) : []),
    [decRaw],
  );

  const catalog = useEmbeddingList(ds);
  const enabled = catalog.data?.enabled === true;
  const embeddings = catalog.data?.embeddings ?? [];

  // Discover categorical decoration columns for whatever tables are
  // currently attached via ?dec=. Runs in parallel as a useQueries
  // batch; results merge into one flat list for the menus.
  const { columns: decorationColumns } = useDecorationCategoricalColumns(
    ds,
    matVersion,
    decorationTables,
  );

  // ChannelPicker takes the discovered columns as {label, value, kind}.
  // Memo to avoid re-deriving on every render — the four pickers all
  // read the same list.
  const channelDecorationColumns: ChannelDecorationColumn[] = useMemo(
    () => decorationColumns.map((dc) => ({
      label: `${dc.table}.${dc.column}`,
      value: `${dc.table}.${dc.column}`,
      kind: dc.kind,
    })),
    [decorationColumns],
  );

  // First-mount: pick the first embedding if none in the URL. Avoids a
  // blank screen on a bare `/explore` link.
  useEffect(() => {
    if (!enabled) return;
    if (!emb && embeddings.length > 0) {
      setUrl({ emb: embeddings[0].id });
    }
  }, [enabled, emb, embeddings, setUrl]);

  const selected = embeddings.find((e) => e.id === emb) ?? null;

  // Color-by: explicit URL value wins; else fall back to the manifest's
  // `default_color_by`. Pass the effective value (not the raw URL one) to
  // the fetch so a default-colored view actually renders colored.
  const effectiveColor = color ?? selected?.default_color_by ?? null;

  // Callbacks declared above the early returns so the hook count is
  // stable across renders regardless of which return branch fires.
  // (Previously these sat between the `!selected` return and the main
  // render, so the first paint -- where ?emb wasn't yet auto-picked --
  // had zero useCallbacks and the second paint had two. React caught
  // that as "rendered more hooks than during the previous render" and
  // unmounted the tree.)
  const handleNeighbors = useCallback(
    (queryCellId: string, neighborIds: string[]) => {
      setUrl({
        cell: queryCellId,
        neighbors: neighborIds.join(",") || null,
      });
    },
    [setUrl],
  );

  const handleLasso = useCallback(
    (cellIds: string[]) => {
      setUrl({ sel: cellIds.join(",") });
    },
    [setUrl],
  );

  const points = useEmbeddingPoints(
    ds && selected
      ? {
          ds,
          embeddingId: selected.id,
          xColumn,
          yColumn,
          colorBy: effectiveColor,
          sizeBy: sizeColumn,
          decorationTables,
          matVersion,
        }
      : null,
  );

  if (!ds) {
    return <div className="explore-empty">Pick a datastack to begin.</div>;
  }

  if (catalog.isPending) {
    return <div className="explore-empty">Loading embeddings…</div>;
  }

  if (catalog.isError) {
    return (
      <div className="explore-empty explore-error">
        Failed to load embedding catalog for <code>{ds}</code>: {(catalog.error as Error).message}
      </div>
    );
  }

  if (!enabled) {
    return (
      <div className="explore-empty">
        The Feature Explorer is not configured for <code>{ds}</code>. Ask the
        deployment operator to wire a <code>feature_explorer:</code> block
        in this datastack's YAML.
      </div>
    );
  }

  if (!selected) {
    return (
      <div className="explore-empty">
        <p>{embeddings.length} embedding{embeddings.length === 1 ? "" : "s"} available; pick one to render.</p>
        <EmbeddingPicker embeddings={embeddings} value={emb} onChange={(id) => setEmb(id)} />
      </div>
    );
  }

  return (
    <div className="explore">
      <aside className="explore-rail">
        <EmbeddingPicker embeddings={embeddings} value={emb} onChange={(id) => setEmb(id)} />
        <DecorationPicker
          ds={ds}
          matVersion={matVersion}
          attached={decorationTables}
          onChange={(next) => setUrl({ dec: next.length ? next.join(",") : null })}
        />
        <ChannelPicker
          label="X axis"
          embedding={selected}
          decorationColumns={channelDecorationColumns}
          value={xColumn}
          onChange={setXColumn}
          defaultColumn={selected.axes[0]}
        />
        <ChannelPicker
          label="Y axis"
          embedding={selected}
          decorationColumns={channelDecorationColumns}
          value={yColumn}
          onChange={setYColumn}
          defaultColumn={selected.axes[1]}
        />
        <ChannelPicker
          label="Color"
          embedding={selected}
          decorationColumns={channelDecorationColumns}
          value={color}
          onChange={setColor}
          defaultColumn={selected.default_color_by}
        />
        <ChannelPicker
          label="Size"
          embedding={selected}
          decorationColumns={channelDecorationColumns}
          value={sizeColumn}
          onChange={setSizeColumn}
          numericOnly
          noneEnabled
          placeholderLabel="(uniform)"
        />
        {points.data?.color?.resolution_stats && (
          <ResolutionStatsBanner stats={points.data.color.resolution_stats} />
        )}
        <FeatureFilters
          embedding={selected}
          ds={ds}
          matVersion={matVersion}
          attachedDecorations={decorationTables}
          decorationColumns={decorationColumns}
          totalCellCount={points.data?.cell_ids.length ?? 0}
          cellsExpression={cellsExpression}
          onCellsChange={setCellsExpression}
          onMaskChange={setFilterMask}
        />
        <KnnControls
          ds={ds}
          embeddingId={selected.id}
          matVersion={matVersion}
          knnDefaults={catalog.data?.knn}
          currentCellId={cell}
          currentK={currentK}
          onFocusCell={(cellId) => setCell(cellId)}
          onNeighbors={handleNeighbors}
          onKChange={(k) => setUrl({ k: String(k) })}
        />
      </aside>
      <section className="explore-canvas">
        {points.isPending && <div className="explore-loading">Loading points…</div>}
        {points.isError && (
          <div className="explore-error">
            Failed to load points: {(points.error as Error).message}
          </div>
        )}
        {points.data && (
          <EmbeddingScatter
            data={points.data}
            focusCellId={cell}
            neighborCellIds={neighborCellIds}
            brushCellIds={brushCellIds}
            filterMask={filterMask?.passing ?? null}
            onCellClick={(cellId) => setCell(cellId)}
            onSelected={handleLasso}
          />
        )}
      </section>
      <SelectionPane
        ds={ds}
        matVersion={matVersion}
        embeddingId={selected.id}
        focusCellId={cell}
        neighborCellIds={neighborCellIds}
        brushCellIds={brushCellIds}
        onCellClick={(cellId) => setCell(cellId)}
        onClearNeighbors={() => setUrl({ neighbors: null })}
        onClearBrush={() => setUrl({ sel: null })}
      />
    </div>
  );
}

/** Parse a CSV URL param like `?neighbors=12345,12346` into an array
 *  of trimmed ids. Empty/missing → empty array. */
function parseIdList(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * `useUrlParam` returns a setter typed `(value: string | null) => void`; for
 * convenience we want callers to call `setEmb("foo")` without the null
 * union noise. This thin wrapper preserves the underlying semantics
 * (passing null clears the param).
 */
function useUrlParamSafe(key: string): [string | null, (v: string | null) => void] {
  return useUrlParam(key);
}

interface ResolutionStatsProps {
  stats: NonNullable<NonNullable<ReturnType<typeof useEmbeddingPoints>["data"]>["color"]>["resolution_stats"];
}

function ResolutionStatsBanner({ stats }: ResolutionStatsProps) {
  if (!stats) return null;
  const total = stats.ok + stats.missing + stats.ambiguous + (stats.no_decoration ?? 0);
  if (total === 0) return null;
  const okPct = Math.round((100 * stats.ok) / total);
  // Compact one-liner. Full breakdown lives in the tooltip; the banner is
  // mostly there so a user who switches to a decoration column and sees a
  // sea of gray points understands why.
  return (
    <div className="explore-resolution-stats" title={JSON.stringify(stats)}>
      {okPct}% colored ({stats.ok}/{total}). Hover for breakdown.
    </div>
  );
}
