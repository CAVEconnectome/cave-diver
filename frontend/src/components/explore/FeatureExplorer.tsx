import { useEffect, useMemo } from "react";
import { useEmbeddingList, useEmbeddingPoints } from "../../api/embeddings";
import { parseMatVersion, useSetUrlParams, useUrlParam } from "../../hooks/useUrlState";
import { ColorByPicker } from "./ColorByPicker";
import { EmbeddingPicker } from "./EmbeddingPicker";
import { EmbeddingScatter } from "./EmbeddingScatter";

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
  const [color, setColor] = useUrlParamSafe("color");
  const [, setCell] = useUrlParamSafe("cell");
  const [decRaw] = useUrlParam("dec");
  const setUrl = useSetUrlParams();

  const matVersion = parseMatVersion(mvRaw);
  const decorationTables = useMemo(
    () => (decRaw ? decRaw.split(",").map((s) => s.trim()).filter(Boolean) : []),
    [decRaw],
  );

  const catalog = useEmbeddingList(ds);
  const enabled = catalog.data?.enabled === true;
  const embeddings = catalog.data?.embeddings ?? [];

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

  const points = useEmbeddingPoints(
    ds && selected
      ? {
          ds,
          embeddingId: selected.id,
          colorBy: effectiveColor,
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
        <ColorByPicker embedding={selected} value={color} onChange={setColor} />
        {points.data?.color?.resolution_stats && (
          <ResolutionStatsBanner stats={points.data.color.resolution_stats} />
        )}
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
            xLabel={selected.axes[0]}
            yLabel={selected.axes[1]}
            onCellClick={(cellId) => setCell(cellId)}
          />
        )}
      </section>
    </div>
  );
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
