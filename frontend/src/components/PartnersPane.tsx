import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { ConnectivityBundle } from "../api/types";
import { directionalColumnNames, unifyColumnGroups, unifyPartners } from "../plots/unify";
import { gatherSelections, isSelKey } from "../plots/urlState";
import { PartnersTable } from "./PartnersTable";

type Tab = "out" | "in" | "both";

interface Props {
  ds: string;
  rootId: string;
  matVersion: number | "live";
  bundle: ConnectivityBundle;
  decorationTables?: string[];
}

/**
 * Tabbed wrapper around `<PartnersTable>` exposing Output / Input / Both
 * views over the same connectivity bundle.
 *
 * Both-tab synthesis (client-side, from `partners_in` + `partners_out`):
 *   - one row per unique partner root_id
 *   - synapse counts split into `n_syn_out` and `n_syn_in` (0 when the
 *     partner only appears in the other direction)
 *   - any `synapse_aggregation_rules` columns from the bundle (e.g. `net_size`,
 *     `mean_size`) are split into `<rule>_out` / `<rule>_in` (null when the
 *     partner only appears in the other direction — null is honest where
 *     0 would be misleading for averages)
 *   - decoration / cell_type / soma columns merge per root_id (out wins on
 *     conflict; values are deterministic per root_id so this is moot)
 *
 * Aggregation columns start hidden by default — they're useful but verbose,
 * and the Columns dropdown surfaces them on demand without cluttering the
 * default reciprocal-analysis view.
 *
 * Tab state is component-local. Selection / sort / filter state per direction
 * is preserved by mounting only the active table; switching tabs unmounts and
 * remounts, which resets these — acceptable since users typically pick one
 * direction and work it through to action.
 */
export function PartnersPane({ ds, rootId, matVersion, bundle, decorationTables }: Props) {
  const [tab, setTab] = useState<Tab>("out");
  const [searchParams, setSearchParams] = useSearchParams();

  // Brush selections: every `?sel_<plot_id>=` key contributes ids into one
  // of two source buckets. Per-tab the table receives the relevant bucket
  // as `externalSelection`, which AND-s with column filters. Multi-plot
  // selections on the same source are unioned (most permissive).
  const selectionBySource = useMemo(
    () => gatherSelections(searchParams),
    [searchParams],
  );

  const externalSelection = useMemo(() => {
    if (tab === "out") {
      return selectionBySource.partners_out.size > 0
        ? [...selectionBySource.partners_out]
        : null;
    }
    if (tab === "in") {
      return selectionBySource.partners_in.size > 0
        ? [...selectionBySource.partners_in]
        : null;
    }
    // Both tab: union across sources so a row showing in either side's
    // selection stays visible.
    const total = selectionBySource.partners_out.size + selectionBySource.partners_in.size;
    if (total === 0) return null;
    return [...new Set([
      ...selectionBySource.partners_out,
      ...selectionBySource.partners_in,
    ])];
  }, [tab, selectionBySource]);

  /**
   * Drop every `sel_*` URL key — clears all plot brushes. The plot panels
   * never write empty selections (PlotPanel gates that path), so this button
   * on the brush pill is the only way to clear.
   */
  const clearAllSelections = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const key of [...next.keys()]) {
          if (isSelKey(key)) next.delete(key);
        }
        return next;
      },
      { replace: false },
    );
  }, [setSearchParams]);

  const partnersOut = bundle.partners_out ?? [];
  const partnersIn = bundle.partners_in ?? [];
  const directional = useMemo(
    () => directionalColumnNames(bundle.column_groups),
    [bundle.column_groups],
  );

  const unified = useMemo(
    () => unifyPartners(partnersOut, partnersIn, directional),
    [partnersOut, partnersIn, directional],
  );

  const unifiedColumnGroups = useMemo(
    () => unifyColumnGroups(bundle.column_groups, directional),
    [bundle.column_groups, directional],
  );

  // Default-hide directional pairs in the Both view. `n_syn_out` / `n_syn_in`
  // are the headline columns and stay visible.
  const bothDefaultHidden = useMemo(() => {
    const out: string[] = [];
    for (const name of directional) {
      out.push(`${name}_out`);
      out.push(`${name}_in`);
    }
    return out;
  }, [directional]);

  const counts = {
    out: partnersOut.length,
    in: partnersIn.length,
    both: unified.length,
  };

  return (
    <div className="partners-pane">
      <div className="partners-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "out"}
          className={tab === "out" ? "active" : ""}
          onClick={() => setTab("out")}
          title="Downstream partners — cells this neuron synapses onto"
        >
          Output ({counts.out})
        </button>
        <button
          role="tab"
          aria-selected={tab === "in"}
          className={tab === "in" ? "active" : ""}
          onClick={() => setTab("in")}
          title="Upstream partners — cells that synapse onto this neuron"
        >
          Input ({counts.in})
        </button>
        <button
          role="tab"
          aria-selected={tab === "both"}
          className={tab === "both" ? "active" : ""}
          onClick={() => setTab("both")}
          title="Unified view — find reciprocal partners by filtering n_syn_in > 0 and n_syn_out > 0"
        >
          Both ({counts.both})
        </button>
      </div>

      {tab === "out" && (
        <PartnersTable
          ds={ds}
          rootId={rootId}
          matVersion={matVersion}
          direction="out"
          rows={partnersOut}
          columnGroups={bundle.column_groups}
          decorationTables={decorationTables}
          externalSelection={externalSelection}
          onClearSelection={clearAllSelections}
          labelOverrides={bundle.spatial_meta.label_overrides}
        />
      )}
      {tab === "in" && (
        <PartnersTable
          ds={ds}
          rootId={rootId}
          matVersion={matVersion}
          direction="in"
          rows={partnersIn}
          columnGroups={bundle.column_groups}
          decorationTables={decorationTables}
          externalSelection={externalSelection}
          onClearSelection={clearAllSelections}
          labelOverrides={bundle.spatial_meta.label_overrides}
        />
      )}
      {tab === "both" && (
        <PartnersTable
          ds={ds}
          rootId={rootId}
          matVersion={matVersion}
          direction="both"
          rows={unified}
          columnGroups={unifiedColumnGroups}
          decorationTables={decorationTables}
          defaultHiddenColumns={bothDefaultHidden}
          externalSelection={externalSelection}
          onClearSelection={clearAllSelections}
          labelOverrides={bundle.spatial_meta.label_overrides}
        />
      )}
    </div>
  );
}

