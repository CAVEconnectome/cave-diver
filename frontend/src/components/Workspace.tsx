import { useEffect, useState } from "react";
import { Link, Outlet, useSearchParams } from "react-router-dom";
import { useDatastackInfo, useVersions } from "../api/queries";
import { migrateStorageKey } from "../hooks/storageMigration";
import { useSetUrlParams, useUrlParam } from "../hooks/useUrlState";
import { readViewSnapshot, useViewSnapshot } from "../hooks/useViewSnapshot";
import { Sidebar } from "./Sidebar";

const SIDEBAR_COLLAPSED_KEY = "cdv:v1:sidebar_collapsed";

function loadSidebarCollapsed(): boolean {
  // One-shot forward-migration from the unversioned legacy key. The
  // helper is idempotent — after the first call the legacy entry is
  // gone and this is a no-op on subsequent loads.
  migrateStorageKey("cdv:sidebar_collapsed", SIDEBAR_COLLAPSED_KEY, localStorage);
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * App-shell layout: sidebar + main content. Owns three things:
 *
 *   1. Sidebar-collapsed state (the `.workspace.sidebar-collapsed` class
 *      drives the outer grid in styles.css, so the class lives on the
 *      shell, not the sidebar itself).
 *   2. The default-version effect — picking the latest valid materialization
 *      on first load if the URL doesn't pin one. Runs at the shell level so
 *      it fires on any sub-route, not just the sidebar.
 *   3. Mounting the breadcrumb header above `<Outlet>`.
 *
 * Everything else — pickers, recipes, view-snapshot navigation — lives in
 * `Sidebar` and `useViewSnapshot`.
 */
export function Workspace() {
  const [ds] = useUrlParam("ds");
  const [mv] = useUrlParam("mv");
  const setUrl = useSetUrlParams();
  const [from] = useUrlParam("from");

  const { navigateToView } = useViewSnapshot(ds, mv);

  const versions = useVersions(ds);
  const info = useDatastackInfo(ds);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(loadSidebarCollapsed);
  const toggleSidebar = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  // Default the version picker to the latest valid materialization on first
  // load. Even when live mode is allowed, "latest valid" is the better default
  // — live drifts as proofreading lands, materialization is a stable reference
  // point. User can flip to "live" explicitly when they want it.
  useEffect(() => {
    if (!info.data || !versions.data) return;
    if (!mv) {
      const latest = versions.data.versions.find((v) => v.valid);
      if (latest) setUrl({ mv: String(latest.version) });
    }
  }, [info.data, versions.data, mv, setUrl]);

  return (
    <div className={`workspace${sidebarCollapsed ? " sidebar-collapsed" : ""}`}>
      <Sidebar
        navigateToView={navigateToView}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={toggleSidebar}
      />
      <main className="main">
        {from && <Breadcrumb from={from} ds={ds} mv={mv} />}
        <Outlet />
      </main>
    </div>
  );
}

interface BreadcrumbProps {
  from: string;
  ds: string | null;
  mv: string | null;
}

/**
 * Renders a tiny "← from <neuron 864...>" / "← from table <ct_name>" link
 * driven by the `from=` URL param that cross-nav handlers set when they jump
 * between views.
 *
 * The destination URL preserves the user's current lens — decorations,
 * plots, filters, hidden columns. Two paths:
 *
 * - **Back to a previous neuron**: copy the current searchParams (which
 *   carry the lens since the partner cross-nav at PartnersTable.tsx
 *   preserves it forward), swap `root` to the breadcrumb target, drop
 *   `from` and any per-panel `sel_*` keys (those reference the current
 *   root's partners and would nonsense-filter the previous root).
 *
 * - **Back to a previous table**: read the `cdv:view:tables` snapshot. If
 *   it matches the breadcrumb's target table name, restore in full
 *   (preserves filters / sort / column state). Otherwise fall back to the
 *   correct `/tables/<name>` URL with just ds/mv — the user lands on the
 *   table they came from rather than the table list.
 */
function Breadcrumb({ from, ds, mv }: BreadcrumbProps) {
  const [searchParams] = useSearchParams();
  const [kind, value] = from.split(":", 2);

  let label: string;
  let to: string;
  if (kind === "neuron" && value) {
    // Carry the lens forward by cloning the current params; only the
    // root and breadcrumb-related keys change.
    const next = new URLSearchParams(searchParams);
    next.set("root", value);
    if (ds) next.set("ds", ds);
    if (mv) next.set("mv", mv);
    next.delete("from");  // we're navigating TO the source view
    for (const key of [...next.keys()]) {
      // sel_<id> is per-plot brush state keyed on the current cell's
      // partners — the previous root has different partners and the ids
      // would dangle.
      if (key.startsWith("sel_")) next.delete(key);
    }
    label = `neuron ${value.slice(0, 6)}…${value.slice(-4)}`;
    to = `/neuron?${next.toString()}`;
  } else if (kind === "table" && value) {
    const snapshot = readViewSnapshot("tables");
    let next: URLSearchParams;
    let pathname: string;
    if (snapshot && snapshot.pathname === `/tables/${value}`) {
      // Snapshot matches the breadcrumb's target table — restore filters,
      // sort, column visibility, and any other table-view state.
      next = new URLSearchParams(snapshot.search);
      pathname = snapshot.pathname;
    } else {
      // No matching snapshot (different table or first visit) — bare
      // landing on the right table.
      next = new URLSearchParams();
      pathname = `/tables/${value}`;
    }
    if (ds) next.set("ds", ds);
    if (mv) next.set("mv", mv);
    next.delete("from");
    label = `table ${value}`;
    to = `${pathname}?${next.toString()}`;
  } else if (kind === "explore" && value) {
    // `value` is `<ft>/<emb>` — what the explorer was looking at when the
    // user cross-navigated out. Two restoration paths, parallel to the
    // table-breadcrumb logic:
    //   - sessionStorage snapshot if the user left a richer view behind
    //     (channel bindings, manual histograms, filter, …) on this tab,
    //     restore in full so they land back where they were.
    //   - bare /explore with just ?ds, ?mv, ?ft, ?emb when no snapshot
    //     matches — gets the user on the right embedding view even on
    //     a fresh tab.
    const [breadcrumbFt, breadcrumbEmb] = value.split("/");
    const snapshot = readViewSnapshot("explore");
    const snapshotDs = snapshot
      ? new URLSearchParams(snapshot.search).get("ds")
      : null;
    let next: URLSearchParams;
    if (snapshot && snapshotDs === ds) {
      next = new URLSearchParams(snapshot.search);
    } else {
      next = new URLSearchParams();
      if (breadcrumbFt) next.set("ft", breadcrumbFt);
      if (breadcrumbEmb) next.set("emb", breadcrumbEmb);
    }
    if (ds) next.set("ds", ds);
    if (mv) next.set("mv", mv);
    next.delete("from");
    label = breadcrumbFt
      ? `feature explorer (${breadcrumbFt})`
      : "feature explorer";
    to = `/explore?${next.toString()}`;
  } else {
    return null;
  }

  return (
    <div className="breadcrumb">
      <Link to={to}>← back to {label}</Link>
    </div>
  );
}
