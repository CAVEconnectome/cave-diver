import { useEffect, useMemo, useRef, useState } from "react";
import { useUrlParam } from "../hooks/useUrlState";
import type { ColumnGroup, FeatureCategory, PartnerRecord } from "../api/types";
import { CellFilterPanel } from "./CellFilterPanel";

export type ScopeMode = "ghost" | "hide";

interface Props {
  /** Forwarded to the inner CellFilterPanel — same data the panel needs
   *  when mounted in a rail. */
  columnGroups?: ColumnGroup[];
  sampleRows?: PartnerRecord[];
  /** Optional extra className on the trigger button so the host can size
   *  it to match its neighbors (drawer-header pills, tab-bar tools). */
  className?: string;
  /** Which direction the popover should extend from the trigger.
   *  Defaults to "down" (the NeuronView placement — header pill with
   *  the rail beneath). The explorer mounts at the bottom of the
   *  viewport (drawer header), so it passes "up" to avoid the popover
   *  rendering below the fold. */
  placement?: "down" | "up";
  /** Forwarded to CellFilterPanel — manifest-declared category
   *  structure keyed by table name. When the user picks a table that
   *  has categories, the column dropdown renders as optgroups. */
  categoriesByTable?: Record<string, FeatureCategory[]>;
  /** Distinct-value universe per qualified column (`${table}.${col}`),
   *  forwarded to the inner CellFilterPanel. Hosts compute this via
   *  `useTablesUniqueValues` over their attached decoration tables;
   *  the predicate builder uses it to render dropdowns / checkbox
   *  lists for categorical string columns. */
  availableValues?: Record<string, string[]>;
  /** Trigger button label + the prefix used in tooltip strings. Defaults
   *  to "Scope". The connectivity rail passes "Plot Scope" to clarify
   *  that the filter scopes which cells appear in *plots* (and is
   *  toggleable per-plot) — distinct from the explorer's workspace-wide
   *  scope semantics. */
  label?: string;
  /** Out-of-scope cell rendering mode. "ghost" = render desaturated
   *  in the background; "hide" = omit entirely. Affects the universe
   *  scatter. Only meaningful when a scope is active. Optional —
   *  hosts that don't render a scatter (e.g. NeuronView) can omit. */
  scopeMode?: ScopeMode;
  onScopeModeChange?: (next: ScopeMode) => void;
  /** When the host supports "Filter to selection" — pass the current
   *  selection bag size and a callback that snapshots it into scope.
   *  When undefined, the action is hidden. */
  selectionBagCount?: number;
  onFilterToSelection?: () => void;
  /** Size of the active direct-scope snapshot (cells pinned via
   *  "Filter to selection"). Drives the header line that distinguishes
   *  a predicate scope from a snapshot scope. Zero = no snapshot. */
  directScopeCount?: number;
  /** Clears both the predicate (`?cells=`) and the direct-scope
   *  snapshot in one click. Hosts without snapshot support can wire
   *  this to clear just the predicate. */
  onClearScope?: () => void;
}

/**
 * Drawer-header / toolbar wrapper around `CellFilterPanel`.
 *
 * Renders a small button labeled `Filter Scope (N)` where N is the active
 * predicate count (or the snapshot size when "Filter to selection" is in
 * effect). The popover wraps the predicate editor with chrome:
 *
 * - A header that names the active scope source (predicate vs snapshot vs
 *   none) and exposes the Ghost/Hide toggle for out-of-scope rendering.
 * - The predicate editor (CellFilterPanel) for predicate-based scoping.
 * - A footer with "Filter to selection" (snapshot the current selection
 *   bag as scope) and "Clear scope" actions.
 *
 * Scope is *not* the same as Selection:
 *   - Scope defines the active set; out-of-scope cells are inactive
 *     (ghosted or hidden) and can't be selected.
 *   - Selection is a stable bag of cells the user has pinned via row
 *     checkboxes, lasso, or Cell ID Search. Filter Scope changes never
 *     mutate the bag; the visible "selected" set is the bag ∩ scope.
 */
export function CellFilterMenu({
  columnGroups,
  sampleRows,
  className,
  placement = "down",
  categoriesByTable,
  availableValues,
  scopeMode,
  onScopeModeChange,
  selectionBagCount,
  onFilterToSelection,
  directScopeCount = 0,
  onClearScope,
  label = "Scope",
}: Props) {
  const [raw, setRaw] = useUrlParam("cells");
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Active-predicate count for the button label. We split-and-trim
  // here rather than reach into the panel's parser to avoid a circular
  // import; the grammar is comma-separated clauses so a naive split is
  // accurate enough for a count badge.
  const predicateCount = useMemo(() => {
    if (!raw) return 0;
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0).length;
  }, [raw]);

  // Active scope source — direct snapshot wins over predicate so the
  // user can't get a confusing "predicate AND snapshot" state. The
  // trigger and header reflect the active source.
  const scopeSource: "snapshot" | "predicate" | "none" =
    directScopeCount > 0 ? "snapshot" : predicateCount > 0 ? "predicate" : "none";

  // Badge text on the trigger: predicate count, snapshot count, or
  // nothing. The button reads "Filter Scope" with no count when no
  // scope is active.
  const triggerBadge =
    scopeSource === "snapshot"
      ? ` (${directScopeCount.toLocaleString()})`
      : scopeSource === "predicate"
        ? ` (${predicateCount})`
        : "";

  const triggerTitle =
    scopeSource === "snapshot"
      ? `${label} — ${directScopeCount.toLocaleString()} cells from selection snapshot`
      : scopeSource === "predicate"
        ? `${label} — ${predicateCount} active filter${predicateCount === 1 ? "" : "s"}`
        : `${label} — which cells are active (build with the Selection Builder)`;

  // Close on outside click + Escape. Same pattern as the colormap picker
  // so behavior is consistent across the app's popovers.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // "Clear scope" should clear whatever's active. When the host wired
  // an onClearScope handler, defer to that (it can clear both the
  // predicate and the snapshot). Otherwise fall back to clearing only
  // the predicate via the URL setter we already have.
  const clearScope = () => {
    if (onClearScope) {
      onClearScope();
    } else {
      setRaw(null);
    }
  };

  return (
    <div ref={containerRef} className="cell-filter-menu">
      <button
        type="button"
        className={`cell-filter-menu-trigger${scopeSource !== "none" ? " has-filter" : ""}${
          className ? ` ${className}` : ""
        }`}
        onClick={(e) => {
          // Stop propagation so clicks inside a parent that's also a
          // button (e.g. the drawer handle) don't toggle the drawer.
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        title={triggerTitle}
      >
        ⏚ {label}{triggerBadge}
      </button>
      {open && (
        <div
          className={`cell-filter-menu-popover cell-filter-menu-popover-${placement}`}
          onClick={(e) => e.stopPropagation()}
        >
          <ScopeHeader
            scopeSource={scopeSource}
            predicateCount={predicateCount}
            directScopeCount={directScopeCount}
            scopeMode={scopeMode}
            onScopeModeChange={onScopeModeChange}
          />
          {/* The predicate editor is greyed out (but still readable) when
              a snapshot is active — predicates are inert while the
              snapshot owns scope. Clicking "Clear scope" or removing the
              snapshot re-activates the predicate path. */}
          <div
            className={
              scopeSource === "snapshot"
                ? "cell-filter-panel-wrap disabled"
                : "cell-filter-panel-wrap"
            }
            aria-disabled={scopeSource === "snapshot"}
          >
            <CellFilterPanel
              columnGroups={columnGroups}
              sampleRows={sampleRows}
              categoriesByTable={categoriesByTable}
              availableValues={availableValues}
            />
          </div>
          <ScopeFooter
            selectionBagCount={selectionBagCount}
            onFilterToSelection={onFilterToSelection}
            onClearScope={clearScope}
            canClear={scopeSource !== "none"}
          />
        </div>
      )}
    </div>
  );
}

interface ScopeHeaderProps {
  scopeSource: "snapshot" | "predicate" | "none";
  predicateCount: number;
  directScopeCount: number;
  scopeMode?: ScopeMode;
  onScopeModeChange?: (next: ScopeMode) => void;
}

/** Top strip of the popover. Tells the user which scope source is
 *  active (so the predicate editor's "inert when snapshot wins" state
 *  reads as intentional, not broken) and hosts the Ghost/Hide toggle. */
function ScopeHeader({
  scopeSource,
  predicateCount,
  directScopeCount,
  scopeMode,
  onScopeModeChange,
}: ScopeHeaderProps) {
  const sourceLabel =
    scopeSource === "snapshot"
      ? `Scoped to ${directScopeCount.toLocaleString()} cells (snapshot)`
      : scopeSource === "predicate"
        ? `Filtered (${predicateCount} clause${predicateCount === 1 ? "" : "s"})`
        : "No scope — full universe";
  return (
    <div className="cell-filter-menu-header">
      <div className="cell-filter-menu-header-title">Scope</div>
      <div className="cell-filter-menu-header-source">{sourceLabel}</div>
      {onScopeModeChange && (
        <div className="cell-filter-menu-mode-toggle" role="group" aria-label="Out-of-scope cells">
          <span className="cell-filter-menu-mode-label">Out of scope:</span>
          <button
            type="button"
            className={`cell-filter-menu-mode-btn${scopeMode === "ghost" ? " active" : ""}`}
            onClick={() => onScopeModeChange("ghost")}
            title="Render out-of-scope cells faintly in the background"
          >
            ghost
          </button>
          <button
            type="button"
            className={`cell-filter-menu-mode-btn${scopeMode === "hide" ? " active" : ""}`}
            onClick={() => onScopeModeChange("hide")}
            title="Don't render out-of-scope cells at all"
          >
            hide
          </button>
        </div>
      )}
    </div>
  );
}

interface ScopeFooterProps {
  selectionBagCount?: number;
  onFilterToSelection?: () => void;
  onClearScope: () => void;
  canClear: boolean;
}

/** Bottom strip of the popover. Holds the snapshot action ("Filter to
 *  selection") and a clear-scope shortcut so the user can return to the
 *  full universe in one click without first removing each predicate. */
function ScopeFooter({
  selectionBagCount,
  onFilterToSelection,
  onClearScope,
  canClear,
}: ScopeFooterProps) {
  const hasFilterToSelection = onFilterToSelection !== undefined;
  const canFilterToSelection =
    hasFilterToSelection && (selectionBagCount ?? 0) > 0;
  return (
    <div className="cell-filter-menu-footer">
      {hasFilterToSelection && (
        <button
          type="button"
          className="cell-filter-menu-footer-btn"
          disabled={!canFilterToSelection}
          title={
            canFilterToSelection
              ? `Snapshot the ${selectionBagCount!.toLocaleString()} selected cells as the active scope`
              : "Make a selection first"
          }
          onClick={onFilterToSelection}
        >
          ⤓ Filter to selection
          {canFilterToSelection && (
            <span className="cell-filter-menu-footer-btn-count">
              &nbsp;({selectionBagCount!.toLocaleString()})
            </span>
          )}
        </button>
      )}
      <button
        type="button"
        className="cell-filter-menu-footer-btn"
        disabled={!canClear}
        title={
          canClear
            ? "Reset to the full universe — clears filters and snapshot, leaves selection intact"
            : "Already on the full universe"
        }
        onClick={onClearScope}
      >
        ↺ Reset scope
      </button>
    </div>
  );
}
