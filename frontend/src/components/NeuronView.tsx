import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { useCellIdLookupMutation, useConnectivity, useDatastackInfo, useTables } from "../api/queries";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { migrateStorageKey } from "../hooks/storageMigration";
import { parseMatVersion, useSetUrlParams, useUrlParam } from "../hooks/useUrlState";
import { isSelKey } from "../plots/urlState";
import { useSessionRecipe } from "../tours/sessionRecipe";
import { AnalyticsRail } from "./AnalyticsRail";
import { Combobox } from "./Combobox";
import { IdentityStrip } from "./IdentityStrip";
import { PartnersPane } from "./PartnersPane";

export function NeuronView() {
  const [ds] = useUrlParam("ds");
  const [mv] = useUrlParam("mv");
  const [root] = useUrlParam("root");
  const [decRaw] = useUrlParam("dec"); // comma-separated decoration table names
  const [cells] = useUrlParam("cells"); // global plot cell filter (see services/plots.py)
  const setUrl = useSetUrlParams();
  // Form-submit handler below uses raw setSearchParams in a single
  // mutation that deletes keys by predicate (sel_*) — the conditional
  // key-iteration doesn't fit `useSetUrlParams`'s flat-record API, and
  // a single in-handler call doesn't suffer the chained-setSearchParams
  // race that `useSetUrlParams` guards against.
  const [, setSearchParams] = useSearchParams();
  // Per-datastack overlay persistence: save the current overlay on every
  // URL change, and restore the saved baseline when a fresh entry lands
  // here without overlay (e.g., from a table-row click). Owns its own
  // URL observation; placement here is just for thematic grouping.
  useSessionRecipe("connectivity");
  const decorationTables = decRaw ? decRaw.split(",").filter(Boolean) : [];

  const [draftRoot, setDraftRoot] = useState(root ?? "");
  const [draftCellId, setDraftCellId] = useState("");
  const [draftDecorations, setDraftDecorations] = useState<string[]>(decorationTables);
  // At narrow viewport widths the workbench stops side-by-siding the
  // analytics rail and the partners table — they squeeze each other out.
  // Below the breakpoint we render them as a tabbed pair so the user
  // sees one at full width at a time. Default tab is "partners" (the
  // table is the more common primary action). State is component-local;
  // resizing wide → narrow → wide preserves the last selected tab.
  const isNarrow = useMediaQuery("(max-width: 960px)");
  const [workbenchTab, setWorkbenchTab] = useState<"plots" | "partners">("partners");

  // Rail collapse — at wide widths the user can shrink the analytics rail
  // to a thin strip so the partners table claims most of the horizontal
  // space. State persists in localStorage so a user's preference (e.g.
  // "I always want a wide table") survives reload / cross-nav. Mirrors
  // the sidebar-collapse pattern in `Workspace`.
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => {
    migrateStorageKey("cdv:rail_collapsed", "cdv:v1:rail_collapsed", localStorage);
    try { return localStorage.getItem("cdv:v1:rail_collapsed") === "1"; } catch { return false; }
  });

  // Stale-root translation banner. When the backend swaps root_id via
  // chunkedgraph.suggest_latest_root (because synapse queries on the
  // requested root came back empty), it surfaces `root_id_updated` on
  // the bundle. We capture it in component state so it persists past
  // the URL update + refetch — by the time the SPA re-fetches with the
  // new root, the next bundle won't carry the marker, but the user
  // still needs to see the banner.
  const [rootSwap, setRootSwap] = useState<{ original: string; current: string } | null>(null);
  const toggleRail = () => {
    setRailCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem("cdv:v1:rail_collapsed", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };
  // Decoration picker collapses to a chip showing the active count; opens on
  // click for editing. Form's id fields stay editable at all times — typical
  // workflow is "punch in a new id, hit Load" and re-expanding the form via
  // a separate Edit click was friction. Persists per-session in component state.
  const [decorationsOpen, setDecorationsOpen] = useState(false);

  // Datastack info tells us whether the cell-id lookup is wired for this
  // dataset. Some operators omit the config keys and the lookup endpoint will
  // 422; in that case we hide the input.
  const info = useDatastackInfo(ds);
  const cellLookup = useCellIdLookupMutation();

  // Keep the form drafts in sync with URL state — cross-nav (table → neuron,
  // partner → partner) and back/forward updates the URL params, and the
  // visible inputs should reflect that without the user having to retype.
  useEffect(() => { setDraftRoot(root ?? ""); }, [root]);
  useEffect(() => { setDraftDecorations(decorationTables); }, [decRaw]);  // eslint-disable-line

  // Collapse the decorations picker whenever navigation lands on a new root.
  // Without this, the picker stays sticky across `→` cross-nav and Load
  // submissions, making the form visually grow on every partner navigation
  // until the user thinks to manually click the chip closed.
  useEffect(() => { setDecorationsOpen(false); }, [root]);

  const matVersion = parseMatVersion(mv);
  // Don't Number(root) — int64 root ids overflow JS Number precision (2^53);
  // keep them as strings end-to-end. Backend accepts strings on every entry point.
  const rootId = root || null;

  // Tables/views list for the cell-type picker. Backend returns:
  //   live mode  → tables only
  //   materialized → tables + views
  // …so we just hand the response straight through to the dropdown.
  const tables = useTables(ds, matVersion);
  const queryClient = useQueryClient();

  // Gate the connectivity hook on `mv` being explicitly set in the URL
  // (not just non-null after `parseMatVersion` defaults). When the user
  // switches datastacks the picker clears `mv` momentarily before the
  // default-version effect picks the latest valid materialization;
  // without this gate the SPA fires a request with `matVersion: "live"`
  // (parseMatVersion's null fallback), then a second request with the
  // real version a render later. The default-version effect runs within
  // a render, so users see no perceptible delay.
  const connectivity = useConnectivity(
    ds && rootId && mv
      ? { ds, rootId, matVersion, decorationTables }
      : null,
  );

  // React to a stale-root translation: capture the swap into component
  // state (so the banner persists past the URL update) and rewrite
  // ?root= to the suggested current id. Replace the history entry —
  // back-button shouldn't return to the broken root.
  useEffect(() => {
    const u = connectivity.data?.root_id_updated;
    if (!u) return;
    setRootSwap({ original: u.original, current: u.current });
    setUrl({ root: u.current }, { replace: true });
  }, [
    connectivity.data?.root_id_updated?.original,
    connectivity.data?.root_id_updated?.current,
    setUrl,
  ]);

  // Clear the swap notification when the user navigates to a third
  // root (one that's neither the original nor the current). Keeps the
  // banner visible while they explore the swapped cell, hides it when
  // they move on.
  useEffect(() => {
    if (rootSwap && root && root !== rootSwap.current && root !== rootSwap.original) {
      setRootSwap(null);
    }
  }, [root, rootSwap]);

  if (!ds) return <p>Pick a datastack from the sidebar to begin.</p>;

  const decorationsCount = draftDecorations.filter(Boolean).length;
  const decorationsLabel =
    decorationsCount === 0
      ? "no decorations"
      : decorationsCount === 1
        ? "1 decoration"
        : `${decorationsCount} decorations`;

  return (
    <div className="neuron-view">
      <form
        className="root-form"
        onSubmit={async (e) => {
          e.preventDefault();
          let resolvedRoot = draftRoot.trim() || null;
          const cid = draftCellId.trim();
          if (cid) {
            const result = await cellLookup.mutateAsync({
              ds, matVersion, cellIds: [cid],
            });
            const mapped = result.cell_to_root[cid];
            if (mapped) {
              resolvedRoot = mapped;
              setDraftRoot(mapped);
              setDraftCellId("");
            } else {
              return; // leave the URL alone; the error renders below
            }
          }
          // Preserve view configuration (analytics rail layout `?plots`,
          // per-panel bindings `?viz_*`, the global cell filter `?cells`,
          // datastack/version `?ds`/`?mv`) across the root change so the
          // user's setup follows them. Strip per-plot brush selections
          // (`?sel_*`) — those reference the previous root's partner ids
          // and would mis-filter the new neuron's tables.
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            for (const key of [...next.keys()]) {
              if (isSelKey(key)) next.delete(key);
            }
            if (resolvedRoot) next.set("root", resolvedRoot);
            else next.delete("root");
            if (draftDecorations.length > 0) {
              next.set("dec", draftDecorations.join(","));
            } else {
              next.delete("dec");
            }
            return next;
          });
          // Live mode only: Load is also a "force refetch" — partners
          // may have been edited since the previous fetch even when the
          // form inputs (root + decorations) are unchanged. In
          // materialized mode the URL identifies an immutable snapshot,
          // so the cache hit is correct and we don't invalidate.
          if (matVersion === "live") {
            queryClient.invalidateQueries({ queryKey: ["connectivity"] });
          }
        }}
      >
        <div className="root-form-row">
          <label>
            Root ID
            <input
              type="text"
              inputMode="numeric"
              placeholder="e.g. 864691135855914798"
              value={draftRoot}
              onChange={(e) => setDraftRoot(e.target.value)}
              size={22}
            />
          </label>
          {info.data && info.data.soma_table && (
            <label>
              Cell ID
              <input
                type="text"
                inputMode="numeric"
                placeholder="e.g. 271700"
                value={draftCellId}
                onChange={(e) => setDraftCellId(e.target.value)}
                size={10}
                title="Persistent nucleus id; resolves to a current root id on submit"
              />
            </label>
          )}
          <button
            type="button"
            className={`decorations-chip${decorationsOpen ? " open" : ""}`}
            onClick={() => setDecorationsOpen((v) => !v)}
            title={decorationsOpen ? "Hide decoration picker" : "Show decoration picker"}
          >
            {decorationsLabel} <span className="chevron">{decorationsOpen ? "▾" : "▸"}</span>
          </button>
          <button
            type="submit"
            className="neuron-load-btn"
            title="Load connectivity for the entered root or cell id"
          >
            Load Cell
          </button>
          {connectivity.data && (
            <SummaryInline bundle={connectivity.data} decorationTables={decorationTables} />
          )}
        </div>
        {decorationsOpen && (
          <fieldset className="decorations-picker">
            <legend>Decoration tables</legend>
            {draftDecorations.map((tbl, i) => (
              <span key={i} className="decoration-row">
                <Combobox
                  className="decoration-combobox"
                  value={tbl}
                  options={(tables.data?.tables ?? []).map((t) => ({
                    value: t.name,
                    label: t.name,
                    hint: t.kind === "view" ? "view" : undefined,
                  }))}
                  onChange={(v) => {
                    const next = [...draftDecorations];
                    next[i] = v;
                    setDraftDecorations(next.filter(Boolean));
                  }}
                  disabled={!tables.data}
                  placeholder="search tables…"
                  emptyText="No tables match"
                />
                <button
                  type="button"
                  className="decoration-remove"
                  onClick={() => setDraftDecorations(draftDecorations.filter((_, j) => j !== i))}
                  title="Remove"
                  aria-label="Remove decoration"
                >×</button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => setDraftDecorations([...draftDecorations, ""])}
              disabled={!tables.data}
              title="Add another decoration table to join onto partner rows"
            >+ add decoration</button>
          </fieldset>
        )}
      </form>

      {ds && (
        <IdentityStrip
          ds={ds}
          rootId={rootId}
          matVersion={matVersion}
          bundle={connectivity.data ?? null}
          isLoadingBundle={connectivity.isFetching && !connectivity.data}
          isResolvingCellId={cellLookup.isPending}
        />
      )}
      {cellLookup.error && (
        <p className="error">cell-id lookup failed: {cellLookup.error.message}</p>
      )}
      {cellLookup.data && draftCellId === "" && Object.values(cellLookup.data.cell_to_root).every((v) => v === null) && (
        <p className="error">No cell with that id was found.</p>
      )}
      {/* Stale-root translation notice. Persistent until dismissed —
          the user should know the URL was rewritten, but the banner
          shouldn't flash and disappear on the URL update. The dismiss
          button just clears local state; the URL stays at `current`. */}
      {rootSwap && (
        <div className="root-swap-notice" role="status">
          <div className="root-swap-text">
            Root id <code>{rootSwap.original}</code> is no longer current —
            showing the equivalent cell at the requested timepoint:{" "}
            <code>{rootSwap.current}</code>.
          </div>
          <button
            type="button"
            className="root-swap-dismiss"
            onClick={() => setRootSwap(null)}
            title="Dismiss this notice"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      {connectivity.error && (
        <p className="error">{(connectivity.error as Error).message}</p>
      )}

      {!rootId && !cellLookup.isPending && <EmptyWorkbench ds={ds} mv={mv} />}

      {connectivity.data && ds && rootId && (
        <>
          <div
            className={`workbench${isNarrow ? " narrow" : ""}${
              !isNarrow && railCollapsed ? " rail-collapsed" : ""
            }`}
          >
            {isNarrow && (
              <div className="workbench-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  className={workbenchTab === "plots" ? "active" : ""}
                  aria-selected={workbenchTab === "plots"}
                  onClick={() => setWorkbenchTab("plots")}
                  title="Show the analytics plot rail"
                >
                  Plots
                </button>
                <button
                  type="button"
                  role="tab"
                  className={workbenchTab === "partners" ? "active" : ""}
                  aria-selected={workbenchTab === "partners"}
                  onClick={() => setWorkbenchTab("partners")}
                  title="Show the partner table"
                >
                  Partners
                </button>
              </div>
            )}
            {(!isNarrow || workbenchTab === "plots") && (
              <div className={`analytics-rail${!isNarrow && railCollapsed ? " collapsed" : ""}`}>
                {!isNarrow && railCollapsed ? (
                  // Vertical "Plots ›" label — same pattern as the
                  // sidebar's collapsed branding. Fills the strip so
                  // the user can scan the rail edge and immediately
                  // see what hides behind it.
                  <button
                    type="button"
                    className="rail-toggle vertical"
                    onClick={toggleRail}
                    title="Expand plots"
                    aria-label="Expand plots"
                  >
                    <span className="vertical-label">Plots</span>
                    <span className="vertical-chevron">›</span>
                  </button>
                ) : (
                  <>
                    {!isNarrow && (
                      <div className="rail-toggle-row">
                        <button
                          type="button"
                          className="rail-toggle"
                          onClick={toggleRail}
                          title="Collapse plots"
                          aria-label="Collapse plots"
                        >
                          ‹
                        </button>
                      </div>
                    )}
                    <AnalyticsRail
                      ds={ds}
                      rootId={rootId}
                      matVersion={matVersion}
                      bundle={connectivity.data}
                      decorationTables={decorationTables}
                      cells={cells}
                    />
                  </>
                )}
              </div>
            )}
            {(!isNarrow || workbenchTab === "partners") && (
              <div className="tables-pane">
                <PartnersPane
                  ds={ds}
                  rootId={rootId!}
                  matVersion={matVersion}
                  bundle={connectivity.data}
                  decorationTables={decorationTables}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Placeholder rendered when no cell is loaded. Mirrors the workbench's
 * rail-plus-tables shape so users can see where the cell filter, plots,
 * and partner-connectivity table will land — and gives them a clear
 * "what to do next" instruction. Uses dashed borders + muted colors so
 * the page feels populated but not cluttered, and the live workbench's
 * arrival doesn't visually reflow the layout.
 */
function EmptyWorkbench({ ds, mv }: { ds: string | null; mv: string | null }) {
  // Carry the current datastack + materialization version into the table-
  // browser link so the user lands on the right slice of CAVE rather than
  // the empty datastack picker.
  const params = new URLSearchParams();
  if (ds) params.set("ds", ds);
  if (mv) params.set("mv", mv);
  const tablesHref = `/tables${params.toString() ? `?${params.toString()}` : ""}`;
  return (
    <div className="empty-workbench">
      <div className="empty-message">
        <h3>No cell loaded</h3>
        <p>
          Enter a Root ID or Cell ID above and press <strong>Load</strong> to
          see this neuron's connectivity, or{" "}
          <Link to={tablesHref}>browse cells in the table browser</Link> to
          find one. The workbench below will fill with a cell-population
          filter, configurable plots, and the partner tables.
        </p>
      </div>
      <div className="empty-shape">
        <div className="empty-shape-rail">
          <div className="empty-card">
            <span className="empty-card-label">Cell filter</span>
            <span className="empty-card-hint">
              Restrict plots and tables to a subset of partners
            </span>
          </div>
          <div className="empty-card">
            <span className="empty-card-label">Plots</span>
            <span className="empty-card-hint">
              Synapse-depth profile and configurable scatter / bar / histogram panels
            </span>
          </div>
        </div>
        <div className="empty-shape-tables">
          <div className="empty-card empty-card-tables">
            <span className="empty-card-label">Partner connectivity</span>
            <span className="empty-card-hint">
              Inputs, outputs, and the unified Both view with optional
              decoration columns
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Compact one-line summary that lives inside `.root-form-row` rather than
 * as its own block. Same content as the previous `Summary` component
 * (version, partner counts, synapse counts, soma count, revalidation
 * badge) but visually folded into the query bar to free up vertical
 * space for the workbench.
 */
function SummaryInline({
  bundle,
  decorationTables,
}: {
  bundle: import("../api/types").ConnectivityBundle;
  decorationTables: string[];
}) {
  const s = bundle.summary;
  return (
    <span className="summary-inline">
      {decorationTables.length > 0 && (
        <span
          className="summary-decorations"
          title={`Decoration tables joined into the partners view: ${decorationTables.join(", ")}`}
        >
          decorations: {decorationTables.join(", ")}
        </span>
      )}
      <span className="summary-line">
        <strong>v{bundle.version_used}</strong>
        {s && (
          <span className="summary-counts">
            {s.num_partners_in} in / {s.num_partners_out} out · {s.num_syn_in} / {s.num_syn_out} syns · {s.num_soma} soma
          </span>
        )}
        <RevalidationBadge bundle={bundle} />
      </span>
    </span>
  );
}

/**
 * Status pill that surfaces the SWR revalidation state of decoration columns.
 *
 * The connectivity bundle ships served records sourced from cache; if any
 * cache entry was past its soft TTL, the backend kicked off a background
 * refetch and tagged the bundle with `decoration_revalidation` (a polling
 * ticket). The SPA polls until the refresh lands, then `mergeDecorationDeltas`
 * clears the field — meaning the displayed cell_type / num_soma values are
 * authoritative as of the request timestamp.
 *
 *   pending → amber chip with spinning glyph; some decoration cells may
 *             still flip in-place when the poll resolves
 *   done    → muted green check; the values you see are final
 *
 * The fresh-on-first-load case (no ticket ever issued) shows "done"
 * immediately, which is correct — no revalidation was needed.
 */
function RevalidationBadge({ bundle }: { bundle: import("../api/types").ConnectivityBundle }) {
  const pending = bundle.decoration_revalidation != null;
  const nPending = bundle.decoration_revalidation?.pending_root_ids.length ?? 0;
  if (pending) {
    return (
      <span
        className="reval-badge pending"
        title={`Background refresh in flight for ${nPending} partners — values may flip in place when it lands.`}
      >
        <span className="spin" aria-hidden>↻</span>{" "}refreshing decorations
      </span>
    );
  }
  return (
    <span className="reval-badge done" title="Decoration values are current.">
      ✓ up to date
    </span>
  );
}
