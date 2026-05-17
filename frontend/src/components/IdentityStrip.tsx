import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMakeLinkMutation } from "../api/queries";
import type { ConnectivityBundle } from "../api/types";
import { migrateStorageKey } from "../hooks/storageMigration";
import { CellDetails } from "./CellDetails";
import { CopyableId } from "./tableColumns";

const DETAILS_OPEN_KEY = "cdv:v1:identity_details_open";

/**
 * Persistent locator strip for the currently-loaded cell.
 *
 * Lives between the query form and the workbench so the canonical
 * identifiers (root_id, cell_id) and the most common follow-up
 * action (open in Neuroglancer) are one click from every workbench
 * tab — promoted out of the Cell tab where they used to hide.
 *
 * Also absorbs the transient "resolving cell id" and "loading cell"
 * states so the user sees a single element fill in with the answer
 * rather than a separate loading line that flashes and disappears.
 */

type NglKind = "connectivity" | "inputs" | "outputs";

interface Props {
  ds: string;
  rootId: string | null;
  matVersion: number | "live";
  bundle: ConnectivityBundle | null;
  /** Connectivity fetch is in flight and no prior bundle is available. */
  isLoadingBundle: boolean;
  /** Cell-id → root-id lookup is in flight (the user typed a cell id,
   *  we're calling /cell_ids before we can navigate to the root). */
  isResolvingCellId: boolean;
}

export function IdentityStrip({
  ds,
  rootId,
  matVersion,
  bundle,
  isLoadingBundle,
  isResolvingCellId,
}: Props) {
  const cellId = bundle?.root_record?.cell_id ?? null;
  const makeLink = useMakeLinkMutation();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Details disclosure — persistent per user so the preferred density
  // (default-tight vs. always-expanded) survives reload and cross-nav.
  // Mirrors the rail-collapse / sidebar-collapse pattern.
  const [detailsOpen, setDetailsOpen] = useState<boolean>(() => {
    migrateStorageKey("cdv:identity_details_open", DETAILS_OPEN_KEY, localStorage);
    try { return localStorage.getItem(DETAILS_OPEN_KEY) === "1"; } catch { return false; }
  });
  const toggleDetails = useCallback(() => {
    setDetailsOpen((prev) => {
      const next = !prev;
      try { localStorage.setItem(DETAILS_OPEN_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // Count of non-empty annotation columns the details panel will show;
  // surfaced in the toggle label so a user knows whether opening it is
  // worth the screen real estate. Skips intrinsic + synapse + cell_id
  // for consistency with `CellDetails`.
  const detailsCount = useMemo(() => {
    const cell = bundle?.root_record;
    if (!cell) return 0;
    let n = 0;
    for (const g of bundle?.column_groups ?? []) {
      if (g.kind === "synapse" || g.kind === "intrinsic") continue;
      for (const c of g.columns) {
        if (c === "cell_id" || c === "root_id") continue;
        const v = cell[c];
        if (v === null || v === undefined) continue;
        if (typeof v === "string" && v.trim() === "") continue;
        n += 1;
      }
    }
    return n;
  }, [bundle]);

  const open = useCallback(
    async (template: NglKind) => {
      if (!rootId) return;
      setMenuOpen(false);
      const result = await makeLink.mutateAsync({
        ds, rootId, matVersion, template,
      });
      window.open(result.url, "_blank");
    },
    [ds, rootId, matVersion, makeLink],
  );

  // Close the NGL kind menu on outside click / Escape. Cheap to wire
  // up — only attached while the menu is open.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // States, in priority order:
  //   1. cell-id lookup in flight → "Resolving cell id…"
  //   2. no rootId at all          → render nothing (caller shows EmptyWorkbench)
  //   3. bundle loading             → "Loading cell…" + the rootId we requested
  //   4. bundle loaded              → full strip with IDs + NGL button
  if (isResolvingCellId) {
    return (
      <div className="identity-strip loading" role="status">
        <span className="identity-spinner" aria-hidden>↻</span>
        <span className="identity-status-text">Resolving cell id…</span>
      </div>
    );
  }
  if (!rootId) return null;

  const showDetailsToggle = bundle != null && bundle.root_record != null;

  return (
    <div className={`identity-strip-wrapper${detailsOpen ? " open" : ""}`}>
      <div className="identity-strip">
        <div className="identity-ids">
          <span className="identity-id-block">
            <span className="identity-label">Root</span>
            <span className="identity-value"><CopyableId value={rootId} /></span>
          </span>
          {cellId && (
            <span className="identity-id-block">
              <span className="identity-label">Cell</span>
              <span className="identity-value"><CopyableId value={cellId} /></span>
            </span>
          )}
          {isLoadingBundle && (
            <span className="identity-loading">
              <span className="identity-spinner" aria-hidden>↻</span>
              <span className="identity-status-text">Loading cell…</span>
            </span>
          )}
        </div>
        {showDetailsToggle && (
          <button
            type="button"
            className={`identity-details-toggle${detailsOpen ? " open" : ""}`}
            onClick={toggleDetails}
            aria-expanded={detailsOpen}
            aria-controls="identity-details-panel"
            title={detailsOpen ? "Hide cell details" : "Show cell details"}
          >
            <span className="identity-details-label">
              Details{detailsCount > 0 && <span className="identity-details-count">{` (${detailsCount})`}</span>}
            </span>
            <span className="chevron" aria-hidden>{detailsOpen ? "▾" : "▸"}</span>
          </button>
        )}
        <div className="identity-actions" ref={menuRef}>
          <button
            type="button"
            className="identity-ngl-primary"
            onClick={() => open("connectivity")}
            disabled={makeLink.isPending}
            title="Open this cell in Neuroglancer (both input and output layers)"
          >
            Open in Neuroglancer
          </button>
          <button
            type="button"
            className="identity-ngl-toggle"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Other Neuroglancer link options"
            title="Other link variants"
          >
            ▾
          </button>
          {menuOpen && (
            <ul className="identity-ngl-menu" role="menu">
              <li role="menuitem" tabIndex={0} onClick={() => open("connectivity")}>
                <span className="menu-title">Connectivity</span>
                <span className="menu-hint">both input + output synapse layers</span>
              </li>
              <li role="menuitem" tabIndex={0} onClick={() => open("inputs")}>
                <span className="menu-title">Inputs only</span>
                <span className="menu-hint">presynaptic partners</span>
              </li>
              <li role="menuitem" tabIndex={0} onClick={() => open("outputs")}>
                <span className="menu-title">Outputs only</span>
                <span className="menu-hint">postsynaptic partners</span>
              </li>
            </ul>
          )}
          {makeLink.isError && (
            <span className="identity-ngl-error">{makeLink.error.message}</span>
          )}
        </div>
      </div>
      {showDetailsToggle && detailsOpen && (
        <div id="identity-details-panel">
          <CellDetails bundle={bundle!} />
        </div>
      )}
    </div>
  );
}
