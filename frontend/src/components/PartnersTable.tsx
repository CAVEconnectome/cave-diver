import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useCrossNavHref } from "../hooks/useCrossNavHref";
import { useSetUrlParams } from "../hooks/useUrlState";
import {
  type ColumnDef,
  type ColumnFiltersState,
  type RowSelectionState,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useNglLink } from "../hooks/useNglLink";
import type { ColumnGroup, PartnerRecord } from "../api/types";
import { CopyableId, FilterInput, columnDisplayName, displayName, formatCell, inferKind, type ColumnKind } from "./tableColumns";

interface Props {
  ds: string;
  rootId: string;
  matVersion: number | "live";
  direction: "in" | "out" | "both";
  rows: PartnerRecord[];
  columnGroups: ColumnGroup[];
  decorationTables?: string[];
  // Columns to hide unless the user has explicitly opted them back in via the
  // Columns dropdown. The Both tab uses this for directional aggregation
  // columns (e.g. `net_size_out`, `net_size_in`) — useful but verbose, so
  // they're off by default and discoverable through the standard menu.
  defaultHiddenColumns?: string[];
  /** Plot-brush filter: rows whose primary-key value isn't in this set are
   *  hidden, ANDed with column filters. `null` / empty disables. */
  externalSelection?: string[] | null;
  /** Called when the user clicks the "clear" affordance on the brush pill. */
  onClearSelection?: () => void;
  /** Provider-emitted column label overrides from `bundle.spatial_meta`.
   *  Layered on top of the SPA's anatomy-independent renames. */
  labelOverrides?: Record<string, string>;
  /** Primary-key column on each row. Drives `getRowId`, the plot-brush
   *  comparison, and the per-row cross-nav arrow. Defaults to "root_id"
   *  so /neuron callers are unchanged; /explore passes "cell_id". */
  keyColumn?: "root_id" | "cell_id";
  /** Builds the cross-nav href for a clicked row. Defaults to the
   *  partner→/neuron builder; explorer passes a builder that resolves
   *  cell_id → root_id at the current mv before constructing /neuron URL. */
  crossNavHref?: (rowId: string) => string;
  /** Whether to render the per-row "open in Neuroglancer" action column
   *  AND the bulk "Open in NGL" action bar above the table. Defaults
   *  true (the partners path always wants both); explorer disables it
   *  until a generic ids-as-segments /links template lands. */
  enableNglAction?: boolean;
  /** Noun used in the row counter ("X of Y partners" / "X partners")
   *  and the CSV filename. Defaults to "partners" so /neuron callers
   *  are unchanged; explorer passes "cells". */
  rowsLabel?: string;
  /** Controlled row-selection ids (lifted to URL state on the caller
   *  side). When provided together with `onSelectedIdsChange`, the
   *  table's internal selection state is replaced by these props —
   *  row clicks fire the callback, and the table renders whichever
   *  rows the callback's owner sets. /neuron leaves these unset and
   *  keeps the in-memory selection it always had. */
  selectedIds?: string[];
  onSelectedIdsChange?: (ids: string[]) => void;
  /** Per-row NGL handler. When supplied, the per-row "↗" action
   *  column renders (whether or not `enableNglAction` is true) and
   *  this callback fires on click instead of the default focal-cell
   *  template flow. Used by /explore so its rows can route through
   *  `/links/segments` with a resolved root_id, distinct from
   *  /neuron's `/links?template=...` partner-frame path. */
  onRowNglClick?: (rowId: string) => void;
  /** Optional slot rendered inside the action bar (the row above the
   *  table that holds the count, CSV, pagination, Columns menu).
   *  Used by /explore to mount its "Limit visible to selection" and
   *  "Reset visible" actions in the same bar as the count and CSV
   *  controls, instead of in a separate toolbar above the table. */
  extraActions?: ReactNode;
}

// Column key may be `<table>.<col>` (decoration table) or just `<col>` (intrinsic /
// synapse / soma / cell_type). The bare name shown in the column header is the
// segment after the first dot, or the whole key if there is no dot.
function bareColumnName(key: string): string {
  const i = key.indexOf(".");
  const stripped = i >= 0 ? key.slice(i + 1) : key;
  return columnDisplayName(stripped);
}

// Column visibility persistence — URL-state-first.
//
// Three URL params hold the user's column-visibility preferences:
//   ?hide=col1,col2  — columns the user has explicitly unchecked.
//   ?show=col1,col2  — columns the user has explicitly re-shown after they
//                      started default-hidden. Only meaningful when the
//                      calling view passes a `defaultHiddenColumns` list.
//   ?coll=group1,…   — collapsed column groups in the table header.
//
// URL state was the right move (over localStorage) because:
// 1. Recipes / Examples (operator-curated tour configurations) need to set
//    the user's view atomically — `apply view → URL state updates`. With
//    localStorage, applying a recipe would have to navigate to a URL AND
//    write three localStorage keys, and the ordering matters.
// 2. Sharing a Slack link reproduces the colleague's view exactly,
//    including which columns they hid.
// 3. The legacy localStorage approach put state on the BROWSER, which
//    meant a single user with two tabs open at different neurons saw
//    their hidden-list snap-sync between them — surprising behavior.
//
// Format: comma-separated column keys. Column keys can contain dots
// (e.g. `proofreading_status_and_strategy.valid_id`); commas don't appear
// in CAVE column names so they're a safe separator without escaping.
const HIDE_URL_KEY = "hide";
const SHOW_URL_KEY = "show";
const COLLAPSED_URL_KEY = "coll";

// Legacy localStorage keys — read once on first mount per session and
// migrated into URL state if the URL is empty. Existing users get their
// saved hidden-list carried forward without losing it; the legacy keys
// are not written to anymore.
const LEGACY_HIDDEN_LS_KEY = "cdv:hidden_cols";
const LEGACY_SHOWN_LS_KEY = "cdv:shown_cols";
const LEGACY_COLLAPSED_LS_KEY = "cdv:collapsed_groups";

function parseColumnList(raw: string | null): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function encodeColumnList(cols: Iterable<string>): string {
  return [...cols].join(",");
}

// One-shot localStorage → URL migration. Returns the legacy values if
// any existed; the caller decides whether to apply them (only on first
// mount and only when URL params for the same keys are absent).
function readLegacyLocalStorage(): {
  hidden: string[];
  shown: string[];
  collapsed: string[];
} {
  const read = (key: string): string[] => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  };
  return {
    hidden: read(LEGACY_HIDDEN_LS_KEY),
    shown: read(LEGACY_SHOWN_LS_KEY),
    collapsed: read(LEGACY_COLLAPSED_LS_KEY),
  };
}

function visibilityState(hidden: Iterable<string>): VisibilityState {
  return Object.fromEntries([...hidden].map((k) => [k, false]));
}

const PAGE_SIZE = 50;

// Cap the rotated label of a collapsed group at this many chars; longer names
// get a trailing ellipsis. The full name stays in the tooltip. Tied to the
// CSS `max-height: 65px` of the collapsed cell — at ~11px per rotated
// character with the current font + letter-spacing, 5 chars fits in ~55px
// of vertical row height with a few px of padding to spare.
const COLLAPSED_LABEL_MAX_CHARS = 5;

function truncateLabel(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** RFC-4180-ish CSV cell encoder. Quotes any value containing a comma,
 *  newline, or quote; doubles internal quotes. Null/undefined → empty.
 *  Numbers + booleans stringify directly; complex values JSON-stringify. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function PartnersTable({ ds, rootId, matVersion, direction, rows, columnGroups, decorationTables, defaultHiddenColumns, externalSelection, onClearSelection, labelOverrides, keyColumn = "root_id", crossNavHref, enableNglAction = true, rowsLabel = "partners", selectedIds, onSelectedIdsChange, onRowNglClick, extraActions }: Props) {
  const [searchParams] = useSearchParams();
  const setUrlParams = useSetUrlParams();
  const ngl = useNglLink();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  // Row selection is *controlled* when both `selectedIds` and
  // `onSelectedIdsChange` are passed (explorer path). Otherwise the
  // table owns its own selection state (the legacy /neuron path).
  const isSelectionControlled =
    selectedIds !== undefined && onSelectedIdsChange !== undefined;
  const [internalRowSelection, setInternalRowSelection] = useState<RowSelectionState>({});
  const controlledRowSelection = useMemo<RowSelectionState>(() => {
    if (!isSelectionControlled || !selectedIds) return {};
    const out: RowSelectionState = {};
    for (const id of selectedIds) out[id] = true;
    return out;
  }, [isSelectionControlled, selectedIds]);
  const rowSelection = isSelectionControlled
    ? controlledRowSelection
    : internalRowSelection;
  const handleRowSelectionChange = useCallback(
    (updater: RowSelectionState | ((prev: RowSelectionState) => RowSelectionState)) => {
      const prev = isSelectionControlled ? controlledRowSelection : internalRowSelection;
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (isSelectionControlled) {
        // Emit the ids in insertion order; TanStack uses an object, so
        // we project to keys-with-truthy-value. Falsy entries (which
        // TanStack writes on deselection) are skipped.
        const ids: string[] = [];
        for (const [k, v] of Object.entries(next)) {
          if (v) ids.push(k);
        }
        onSelectedIdsChange!(ids);
      } else {
        setInternalRowSelection(next);
      }
    },
    [isSelectionControlled, controlledRowSelection, internalRowSelection, onSelectedIdsChange],
  );

  // Hidden / shown / collapsed are derived from URL params on every render
  // — the URL is the source of truth for column visibility.
  const hidden = useMemo(
    () => parseColumnList(searchParams.get(HIDE_URL_KEY)),
    [searchParams],
  );
  const shown = useMemo(
    () => parseColumnList(searchParams.get(SHOW_URL_KEY)),
    [searchParams],
  );
  const collapsedGroups = useMemo(
    () => parseColumnList(searchParams.get(COLLAPSED_URL_KEY)),
    [searchParams],
  );

  // One-shot legacy-localStorage migration. On first mount of a session,
  // if the URL doesn't carry hidden/shown/collapsed params but the user
  // has values stashed in the legacy localStorage keys, transfer them
  // into the URL once so existing users don't lose their preferences.
  // Subsequent mounts skip this — the `migratedRef` blocks re-runs even
  // if the user's URL clears the params via tour application.
  const migratedRef = useRef(false);
  useEffect(() => {
    if (migratedRef.current) return;
    migratedRef.current = true;
    const legacy = readLegacyLocalStorage();
    const updates: Record<string, string | null> = {};
    if (legacy.hidden.length > 0 && !searchParams.get(HIDE_URL_KEY)) {
      updates[HIDE_URL_KEY] = encodeColumnList(legacy.hidden);
    }
    if (legacy.shown.length > 0 && !searchParams.get(SHOW_URL_KEY)) {
      updates[SHOW_URL_KEY] = encodeColumnList(legacy.shown);
    }
    if (legacy.collapsed.length > 0 && !searchParams.get(COLLAPSED_URL_KEY)) {
      updates[COLLAPSED_URL_KEY] = encodeColumnList(legacy.collapsed);
    }
    if (Object.keys(updates).length > 0) {
      setUrlParams(updates);
    }
    // Clear legacy keys regardless of whether URL params existed — once
    // a session has migrated (or chosen not to), we don't want the
    // legacy keys masquerading as the source of truth on a future
    // session that's been operating purely on URL state.
    try {
      localStorage.removeItem(LEGACY_HIDDEN_LS_KEY);
      localStorage.removeItem(LEGACY_SHOWN_LS_KEY);
      localStorage.removeItem(LEGACY_COLLAPSED_LS_KEY);
    } catch {
      // localStorage may be unavailable (private browsing, denied
      // permissions, etc.). Migration is best-effort.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // empty deps — one-shot

  // Helpers that update a column-list URL param atomically. The setter
  // is single-key here (rather than the batch helper) because each
  // toggle action only changes one of hide/show/coll at a time —
  // multi-key updates only happen during legacy migration above.
  const setHiddenUrl = useCallback(
    (next: Set<string>) => {
      setUrlParams({ [HIDE_URL_KEY]: next.size > 0 ? encodeColumnList(next) : null });
    },
    [setUrlParams],
  );
  const setShownUrl = useCallback(
    (next: Set<string>) => {
      setUrlParams({ [SHOW_URL_KEY]: next.size > 0 ? encodeColumnList(next) : null });
    },
    [setUrlParams],
  );
  const setCollapsedUrl = useCallback(
    (next: Set<string>) => {
      setUrlParams({ [COLLAPSED_URL_KEY]: next.size > 0 ? encodeColumnList(next) : null });
    },
    [setUrlParams],
  );

  const toggleGroupCollapsed = (groupName: string) => {
    const next = new Set(collapsedGroups);
    if (next.has(groupName)) next.delete(groupName);
    else next.add(groupName);
    setCollapsedUrl(next);
  };
  const defaultHiddenSet = useMemo(
    () => new Set(defaultHiddenColumns ?? []),
    [defaultHiddenColumns],
  );

  // A column is hidden iff the user explicitly hid it, OR it's in the default-
  // hidden list and the user hasn't explicitly shown it. This split lets a
  // column start hidden by default but become visible after the user toggles
  // it on — that "shown" decision then persists across sessions.
  const effectiveHidden = useMemo(() => {
    const h = new Set(hidden);
    for (const col of defaultHiddenSet) {
      if (!shown.has(col)) h.add(col);
    }
    return h;
  }, [hidden, shown, defaultHiddenSet]);
  const columnVisibility = useMemo(() => visibilityState(effectiveHidden), [effectiveHidden]);

  const toggleColumnVisible = (columnKey: string) => {
    const isDefaultHidden = defaultHiddenSet.has(columnKey);
    const wasVisible = !effectiveHidden.has(columnKey);
    if (wasVisible) {
      // User wants to hide. Add to explicit-hidden; clear any explicit-shown.
      const nextHidden = new Set(hidden);
      nextHidden.add(columnKey);
      setHiddenUrl(nextHidden);
      if (isDefaultHidden && shown.has(columnKey)) {
        const nextShown = new Set(shown);
        nextShown.delete(columnKey);
        setShownUrl(nextShown);
      }
    } else {
      // User wants to show. Remove from explicit-hidden; if the column is
      // default-hidden, mark it as explicitly shown so the override survives
      // a reload.
      const nextHidden = new Set(hidden);
      nextHidden.delete(columnKey);
      setHiddenUrl(nextHidden);
      if (isDefaultHidden) {
        const nextShown = new Set(shown);
        nextShown.add(columnKey);
        setShownUrl(nextShown);
      }
    }
  };

  const showAllColumns = () => {
    // "Show all" → clear hidden, AND record explicit-shown overrides for
    // every default-hidden column so they actually appear. Two-key URL
    // update so the navigation is atomic (no flash where hidden is
    // cleared but shown hasn't caught up).
    const nextShown = new Set(shown);
    for (const col of defaultHiddenSet) nextShown.add(col);
    setUrlParams({
      [HIDE_URL_KEY]: null,
      [SHOW_URL_KEY]: nextShown.size > 0 ? encodeColumnList(nextShown) : null,
    });
  };

  // Flat ordered list of column keys (preserving the group order from the
  // backend; left-to-right is intrinsic → synapse → cell_type → soma → tables).
  const columnNames = useMemo(
    () => columnGroups.flatMap((g) => g.columns),
    [columnGroups],
  );

  // Per-column kind drives which filter widget renders.
  const columnKinds = useMemo(() => {
    const kinds: Record<string, ColumnKind> = {};
    for (const c of columnNames) kinds[c] = inferKind(c, rows);
    return kinds;
  }, [columnNames, rows]);

  // For category columns, build the unique-value list once.
  const categoryOptions = useMemo(() => {
    const options: Record<string, string[]> = {};
    for (const c of columnNames) {
      if (columnKinds[c] !== "category") continue;
      const values = new Set<string>();
      for (const r of rows) {
        const v = r[c];
        if (v === null || v === undefined) values.add("(none)");
        else values.add(String(v));
      }
      options[c] = [...values].sort();
    }
    return options;
  }, [columnNames, columnKinds, rows]);

  // Row-select column. Sits in its own synthetic group at the front
  // so it's the leftmost cell in every row. Promoted from a hard-
  // coded `<th>` / `<td>` into a real TanStack column so the user
  // can sort by selection state — descending lifts every selected
  // row to the top, which is the natural way to verify a lasso
  // against the bottom data table when the result spans multiple
  // pages. ``sortingFn`` compares `row.getIsSelected()` directly
  // (TanStack already keeps that in sync with our controlled
  // `rowSelection`). ``meta.rowSelectColumn`` is the discriminant
  // the header / filter / body renderers use to special-case this
  // column (empty filter, header is the select-all checkbox).
  const selectColumnDef = useMemo<ColumnDef<PartnerRecord>>(
    () => ({
      id: "__select__",
      // Header is rendered by the leaf-row mapper directly off the
      // meta flag, so this is just a fallback for any flexRender call
      // we don't intercept.
      header: "",
      cell: ({ row }) => (
        <input
          type="checkbox"
          checked={row.getIsSelected()}
          onChange={row.getToggleSelectedHandler()}
          aria-label="Toggle row selection"
        />
      ),
      accessorFn: () => null,
      enableSorting: true,
      enableColumnFilter: false,
      sortingFn: (a, b) =>
        Number(b.getIsSelected()) - Number(a.getIsSelected()),
      meta: { rowSelectColumn: true },
    }),
    [],
  );

  // Build per-leaf column definitions, one per key.
  const leafColumnDefs = useMemo(() => {
    const map: Record<string, ColumnDef<PartnerRecord>> = {};
    for (const c of columnNames) {
      const kind = columnKinds[c];
      const display = bareColumnName(c);
      const def: ColumnDef<PartnerRecord> = {
        id: c,
        accessorFn: (row) => row[c],
        header: displayName(display, labelOverrides),
        cell:
          c === "num_soma"
            ? (ctx) => <SomaIndicator count={ctx.getValue() as number | undefined | null} />
            : c === "root_id" || c === "cell_id"
              ? (ctx) => <CopyableId value={ctx.getValue()} />
              : (ctx) => formatCell(ctx.getValue()),
        sortingFn: kind === "number" ? "basic" : "alphanumeric",
        // Sparse numeric columns — e.g. the synthetic `__distance`
        // populated only for cells the Grow-Selection probe returned
        // — would otherwise sort their many missing entries to the
        // top in ascending order (TanStack's "basic" treats null as
        // less than every number), burying the populated cells. With
        // missing values coerced to `undefined` in the row
        // enrichment, this option sends them to the end regardless
        // of direction so "sort by distance ascending" actually puts
        // the closest cells at the top.
        sortUndefined: "last",
      };
      if (kind === "category") {
        def.filterFn = (row, _id, filterValue) => {
          if (!filterValue) return true;
          const v = row.getValue<unknown>(c);
          const display = v === null || v === undefined ? "(none)" : String(v);
          return display === filterValue;
        };
      } else if (kind === "number") {
        def.filterFn = (row, _id, filterValue) => {
          const range = filterValue as { min?: number; max?: number } | undefined;
          if (!range) return true;
          const v = row.getValue<number>(c);
          if (typeof v !== "number") return false;
          if (range.min !== undefined && v < range.min) return false;
          if (range.max !== undefined && v > range.max) return false;
          return true;
        };
      } else {
        def.filterFn = (row, _id, filterValue) => {
          if (!filterValue) return true;
          const v = row.getValue<unknown>(c);
          const haystack = v === null || v === undefined ? "" : String(v).toLowerCase();
          return haystack.includes(String(filterValue).toLowerCase());
        };
      }
      map[c] = def;
    }
    return map;
  }, [columnNames, columnKinds, labelOverrides]);

  // Per-row action handlers, stable for the columns memo's dep list.
  // `open` is shared with the action-bar buttons below — single source of truth
  // for "go to Neuroglancer" navigation.
  const open = useCallback(
    (template: string, partnerIds?: string[]) =>
      ngl.open({
        kind: "template",
        ds,
        rootId,
        matVersion,
        template,
        selectedPartnerIds:
          partnerIds && partnerIds.length > 0 ? partnerIds : undefined,
      }),
    [ds, matVersion, ngl, rootId],
  );

  // URL builder for the per-row "view this partner" Link. Carries the active
  // view config forward — analytics-rail layout (`?plots`, `?viz_*`), the
  // global cell filter (`?cells`), the decoration set (`?dec`), and the
  // datastack/version (`?ds`, `?mv`) — so navigating to a partner doesn't
  // wipe the user's setup. Per-plot brush selections (`?sel_*`) are stripped
  // because they reference the previous root's partner ids and would
  // nonsense-filter the new neuron's tables. `?from` powers the breadcrumb.
  //
  // Returns a `to=` value (not an imperative `navigate()` call) so the
  // `<Link>` renders a real `<a href>` — that lets cmd-click / middle-click
  // open the partner in a new tab natively without any extra event plumbing.
  // Default neuron → neuron cross-nav. Intra-view so view state (plot
  // bindings, column hide/show) carries via `inheritParams`. Callers
  // (the explorer's cell list) supply their own builder for routes
  // that need surface-key → root resolution.
  const defaultPartnerHref = useCrossNavHref({
    ds,
    matVersion,
    from: `neuron:${rootId}`,
    decorationTables: decorationTables ?? [],
  });
  const hrefFor = crossNavHref ?? defaultPartnerHref;

  // Direction → link-template resolution lifted up here so the per-row NGL
  // action button can use it; the action bar below uses the same lookup.
  // For the unified Both view, single-row NGL opens both pre and post layers.
  const linkTemplate =
    direction === "out" ? "outputs" : direction === "in" ? "inputs" : "connectivity";
  const directionLabel =
    direction === "out" ? "output" : direction === "in" ? "input" : "all";

  // Wrap leaf defs into group-defs so TanStack Table renders a two-row header
  // (top = group name, bottom = bare column name). The intrinsic group has a
  // single column (`root_id`) — keep its top header empty for visual quiet.
  //
  // Two narrow per-row action columns are appended to the intrinsic group:
  // a "view this partner" arrow (cross-nav) and an "open in Neuroglancer"
  // shortcut equivalent to selecting just that row and clicking
  // "Open N selected in NGL" on the action bar. Putting them inside the
  // intrinsic group means they sit immediately after `root_id` and never
  // get caught up in column-collapse machinery.
  //
  // Collapsed groups: replace the group's leaf list with a single placeholder
  // leaf so the group header still renders, but as a thin column. The group
  // header is clickable to toggle; the placeholder leaf has no sort handle, no
  // filter widget, and an empty body cell. Long group names are truncated in
  // the rotated label so a 30-character table name doesn't blow the header
  // row up to 400px tall — the full name still appears in the tooltip.
  const columns = useMemo<ColumnDef<PartnerRecord>[]>(() => {
    // Synthetic group that wraps the row-select column. Empty header
    // (like `intrinsic`) and `meta.kind === "intrinsic"` so the group
    // row treats it as non-collapsible — there's nothing to collapse
    // anyway.
    const selectGroup: ColumnDef<PartnerRecord> = {
      id: "group:__select__",
      header: "",
      meta: { kind: "intrinsic", groupName: "__select__", collapsed: false },
      columns: [selectColumnDef],
    };
    const groups = columnGroups.map((g) => {
      const collapsed = collapsedGroups.has(g.name);
      let leafs: ColumnDef<PartnerRecord>[] = collapsed
        ? [{
            id: `__collapsed__:${g.name}`,
            header: "",
            cell: () => null,
            accessorFn: () => null,
            enableSorting: false,
            enableColumnFilter: false,
            meta: { collapsedPlaceholder: true },
          }]
        : g.columns
            .map((c) => leafColumnDefs[c])
            .filter((d): d is ColumnDef<PartnerRecord> => Boolean(d));
      // Per-row action buttons attach to the intrinsic group, sitting between
      // root_id and the synapse columns. Skipped when the (theoretical)
      // intrinsic group is collapsed — same as any other group.
      if (g.kind === "intrinsic" && !collapsed) {
        leafs = [
          ...leafs,
          {
            id: "__action_view__",
            header: "",
            cell: (ctx) => (
              // `<Link>` (not a button) so the browser sees a real `<a href>`
              // — cmd-click / middle-click open the partner in a new tab via
              // the platform's native handling without any extra wiring.
              <Link
                className="row-action"
                to={hrefFor(ctx.row.id)}
                title="View this row (⌘-click for a new tab)"
                aria-label="View this row"
              >→</Link>
            ),
            accessorFn: () => null,
            enableSorting: false,
            enableColumnFilter: false,
            meta: { actionPlaceholder: true },
          },
        ];
        // Per-row NGL action renders when EITHER (a) the legacy
        // focal-cell template path is enabled, OR (b) a custom
        // onRowNglClick callback is provided. The explorer takes
        // path (b); /neuron takes path (a). Both result in the same
        // ↗ icon in the same column slot.
        const showRowNgl = !!onRowNglClick || enableNglAction;
        if (showRowNgl) {
          const handleRowNgl = onRowNglClick
            ? (rowId: string) => onRowNglClick(rowId)
            : (rowId: string) => open(linkTemplate, [rowId]);
          leafs.push({
            id: "__action_ngl__",
            header: "",
            cell: (ctx) => (
              <button
                className="row-action"
                onClick={() => handleRowNgl(ctx.row.id)}
                title="Open this row in Neuroglancer"
                aria-label="Open this row in Neuroglancer"
              >↗</button>
            ),
            accessorFn: () => null,
            enableSorting: false,
            enableColumnFilter: false,
            meta: { actionPlaceholder: true },
          });
        }
      }
      // Two header forms by mode:
      //   - Intrinsic group has no visible label.
      //   - Collapsed group: rotated 5-char ellipsis (existing behavior).
      //   - Expanded group: full name wrapped in `.group-label` so CSS
      //     can cap it at a reasonable width with ellipsis. Long table
      //     names like `proofreading_status_and_strategy` would otherwise
      //     widen their columns far past what their data needs; the cap
      //     + tooltip preserves discoverability without the whitespace.
      // TanStack accepts strings or render functions for `header`. The
      // expanded case wants a JSX wrapper for CSS truncation, so we go
      // through a function. Intrinsic / collapsed cases stay as plain
      // strings — same as before.
      const collapsedLabel = collapsed ? truncateLabel(g.name, COLLAPSED_LABEL_MAX_CHARS) : null;
      // The wrapping `<span>` deliberately omits `title` — the parent
      // `<th>` already sets "<name> — click to collapse/expand" via the
      // header-row mapper below, and the browser picks the *nearest*
      // ancestor's title. A span title would shadow the click hint and
      // give the user a less informative tooltip.
      const headerRender =
        g.kind === "intrinsic"
          ? ""
          : collapsed
            ? collapsedLabel ?? ""
            : () => <span className="group-label">{g.name}</span>;
      return {
        id: `group:${g.name}`,
        header: headerRender,
        meta: { kind: g.kind, groupName: g.name, collapsed },
        columns: leafs,
      };
    });
    return [selectGroup, ...groups];
  }, [columnGroups, leafColumnDefs, selectColumnDef, collapsedGroups, hrefFor, open, linkTemplate, enableNglAction, onRowNglClick]);

  // External selection (from a plot brush) ANDs with column filters via
  // TanStack's globalFilter. Empty / null disables; otherwise rows whose
  // root_id isn't in the set are hidden, and pagination updates naturally.
  const globalFilterValue = useMemo(
    () => (externalSelection && externalSelection.length > 0 ? new Set(externalSelection) : null),
    [externalSelection],
  );

  const table = useReactTable({
    data: rows,
    columns,
    state: {
      sorting,
      columnFilters,
      rowSelection,
      columnVisibility,
      globalFilter: globalFilterValue,
    },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: handleRowSelectionChange,
    getRowId: (row) => String((row as Record<string, unknown>)[keyColumn] ?? ""),
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: (row, _id, filterValue) => {
      const set = filterValue as Set<string> | null;
      if (!set) return true;
      return set.has(row.id);
    },
    initialState: { pagination: { pageSize: PAGE_SIZE } },
  });

  const filteredRows = table.getFilteredRowModel().rows;
  // Effective row-selection ids (always derived from `rowSelection`,
  // whether that came from controlled props or internal state).
  // Renamed from the bare `selectedIds` to avoid shadowing the new
  // prop of the same name.
  const effectiveSelectedIds = Object.keys(rowSelection);

  const filterIsActive = columnFilters.length > 0 && filteredRows.length !== rows.length;

  // CSV export — visible columns and post-sort/post-filter rows ACROSS pages
  // (not just the page the user is on, per requirement). Quote any value
  // that contains commas, quotes, or newlines; null/undefined → empty cell.
  // Filename embeds the root id and direction so a workspace with multiple
  // exports doesn't lose track of which is which.
  const handleExportCsv = useCallback(() => {
    // Skip action columns (`__action_view__`, `__action_ngl__`) — those
    // are UI-only buttons, not data the user wants in a CSV.
    const visibleCols = table
      .getVisibleLeafColumns()
      .filter((c) => !c.id.startsWith("__action_"));
    const exportRows = table.getSortedRowModel().rows;
    const lines = [
      visibleCols.map((c) => csvCell(c.id)).join(","),
      ...exportRows.map((row) =>
        visibleCols.map((col) => csvCell(row.getValue(col.id))).join(","),
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    // Filename embeds the row label, focal id, and (when meaningful) the
    // direction so a workspace with multiple exports doesn't lose track
    // of which is which. Explorer rows are direction-agnostic; the
    // direction slug is dropped when NGL isn't enabled (a reasonable
    // proxy for "this isn't a partner table").
    a.download = enableNglAction
      ? `${rowsLabel}-${rootId}-${direction}-${ts}.csv`
      : `${rowsLabel}-${rootId}-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [table, rootId, direction, rowsLabel, enableNglAction]);

  // Both-tab action bar uses a single scope (selection > filter > all) so the
  // three direction buttons can operate on the same set without stacking nine
  // buttons on the page. The strictest non-empty scope wins.
  const bothScope: { ids: string[] | undefined; label: string } = (() => {
    if (direction !== "both") return { ids: undefined, label: "" };
    if (effectiveSelectedIds.length > 0) return { ids: effectiveSelectedIds, label: `${effectiveSelectedIds.length} selected` };
    if (filterIsActive) return { ids: filteredRows.map((r) => r.id), label: `${filteredRows.length} filtered` };
    return { ids: undefined, label: `all ${rows.length}` };
  })();

  const brushSize = externalSelection?.length ?? 0;

  return (
    <div className="partners">
      {brushSize > 0 && (
        <div className="brush-pill" role="status">
          <span>
            <strong>{brushSize}</strong> partner{brushSize === 1 ? "" : "s"} selected from a plot brush
          </span>
          {onClearSelection && (
            <button
              type="button"
              className="brush-pill-clear"
              onClick={onClearSelection}
              title="Clear plot selection"
            >
              clear
            </button>
          )}
        </div>
      )}
      <div className="actions">
        {/* Caller-provided slot — explorer mounts its "Limit visible
            to selection" / "Reset visible" actions here so they sit
            with the rest of the table-view controls (count, CSV,
            pagination, Columns) rather than in a separate toolbar
            above the table. */}
        {extraActions}
        {/* NGL action bar (bulk + per-direction) is partner-frame specific.
            Explorer disables via enableNglAction=false; the counter and
            CSV controls still render so the action bar isn't empty. */}
        {enableNglAction && (direction === "both" ? (
          <>
            <span className="scope">Open in NGL ({bothScope.label}):</span>
            <button
              onClick={() => open("inputs", bothScope.ids)}
              title={`Open Neuroglancer showing input synapses onto the ${bothScope.label}`}
            >
              input syns
            </button>
            <button
              onClick={() => open("outputs", bothScope.ids)}
              title={`Open Neuroglancer showing output synapses from the ${bothScope.label}`}
            >
              output syns
            </button>
            <button
              onClick={() => open("connectivity", bothScope.ids)}
              title={`Open Neuroglancer showing both input and output synapses for the ${bothScope.label}`}
            >
              both directions
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => open(linkTemplate)}
              title={`Open all ${rows.length} ${directionLabel} partner${rows.length === 1 ? "" : "s"} in Neuroglancer`}
            >
              Open all {directionLabel} synapses ({rows.length}) in NGL
            </button>
            {filterIsActive && (
              <button
                onClick={() => open(linkTemplate, filteredRows.map((r) => r.id))}
                title={`Open the ${filteredRows.length} partner${filteredRows.length === 1 ? "" : "s"} matching the current filter in Neuroglancer`}
              >
                Open {filteredRows.length} filtered in NGL
              </button>
            )}
            <button
              onClick={() => open(linkTemplate, effectiveSelectedIds)}
              disabled={effectiveSelectedIds.length === 0}
              title={
                effectiveSelectedIds.length === 0
                  ? "Select partners (row checkboxes or a plot brush) to open them in Neuroglancer"
                  : `Open the ${effectiveSelectedIds.length} selected partner${effectiveSelectedIds.length === 1 ? "" : "s"} in Neuroglancer`
              }
            >
              Open {effectiveSelectedIds.length} selected in NGL
            </button>
          </>
        ))}
        <span className="page">
          {filteredRows.length === rows.length
            ? `${rows.length} ${rowsLabel}`
            : `${filteredRows.length} of ${rows.length} ${rowsLabel}`}
        </span>
        <button
          type="button"
          onClick={handleExportCsv}
          title="Download visible columns × visible rows (post-filter, all pages) as CSV"
        >
          ↓ CSV
        </button>
        <div className="pagination">
          <button
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            title="Previous page"
          >‹</button>
          <span className="page">
            {table.getState().pagination.pageIndex + 1} / {Math.max(1, table.getPageCount())}
          </span>
          <button
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            title="Next page"
          >›</button>
        </div>
        {(columnFilters.length > 0 || sorting.length > 0) && (
          <button
            onClick={() => {
              setColumnFilters([]);
              setSorting([]);
            }}
            title="Clear all column filters and sorting"
          >
            Reset
          </button>
        )}

        <details className="columns-menu">
          <summary>
            Columns{effectiveHidden.size > 0 ? ` (${effectiveHidden.size} hidden)` : ""}
          </summary>
          <div className="columns-menu-popover">
            <div className="columns-menu-actions">
              <button
                type="button"
                onClick={showAllColumns}
                disabled={effectiveHidden.size === 0}
                title="Restore every hidden column"
              >
                show all
              </button>
            </div>
            {columnGroups.map((g) => (
              <div key={g.name} className="columns-menu-group">
                <div className={`columns-menu-group-header group-${g.kind}`}>{g.name}</div>
                {g.columns.map((col) => (
                  <label key={col} className="columns-menu-row">
                    <input
                      type="checkbox"
                      checked={!effectiveHidden.has(col)}
                      onChange={() => toggleColumnVisible(col)}
                    />
                    {bareColumnName(col)}
                  </label>
                ))}
              </div>
            ))}
          </div>
        </details>
      </div>
      <div className="partners-scroll">
      <table>
        <thead>
          {/* Top row: group headers, spanning their leaf columns. Click toggles
              collapse for that group (intrinsic ignored — single empty header).
              The leading row-select column lives in its own empty-header
              group so it gets a natural `<th colSpan=1>` slot here. */}
          <tr className="group-row">
            {table.getHeaderGroups()[0].headers.map((header) => {
              const meta = header.column.columnDef.meta as
                | { kind?: string; groupName?: string; collapsed?: boolean }
                | undefined;
              const collapsible = !!meta?.groupName && meta?.kind !== "intrinsic";
              return (
                <th
                  key={header.id}
                  colSpan={header.colSpan}
                  className={`group-header group-${meta?.kind ?? ""}${meta?.collapsed ? " collapsed" : ""}${collapsible ? " collapsible" : ""}`}
                  onClick={collapsible ? () => toggleGroupCollapsed(meta!.groupName!) : undefined}
                  title={
                    collapsible
                      ? meta?.collapsed
                        ? `${meta.groupName} — click to expand`
                        : `${meta!.groupName} — click to collapse`
                      : undefined
                  }
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                </th>
              );
            })}
          </tr>
          {/* Second row: leaf columns (sortable). The row-select column
              renders the select-all checkbox in this row (paired with a
              sort indicator — clicking the column header sorts by
              selection state, descending lifts selected rows to the
              top). Selects all *filtered* rows across pages, not just
              the current page. */}
          <tr>
            {table.getHeaderGroups()[1].headers.map((header) => {
              const meta = header.column.columnDef.meta as { collapsedPlaceholder?: boolean; actionPlaceholder?: boolean; rowSelectColumn?: boolean } | undefined;
              if (meta?.collapsedPlaceholder) {
                return <th key={header.id} className="collapsed-placeholder" />;
              }
              if (meta?.actionPlaceholder) {
                return <th key={header.id} className="row-action-col" />;
              }
              if (meta?.rowSelectColumn) {
                const sort = header.column.getIsSorted();
                // Always render a sort affordance so the user knows the
                // column is sortable even before they click — `↕` when
                // unsorted, `▲` / `▼` once a direction is active. The
                // checkbox-only header alone read as "not clickable" in
                // testing.
                const indicator =
                  sort === "asc" ? "▲" : sort === "desc" ? "▼" : "↕";
                const indicatorClass =
                  sort === false
                    ? "row-select-indicator inactive"
                    : "row-select-indicator";
                return (
                  <th key={header.id} className="row-select-col">
                    <button
                      type="button"
                      className="sortable row-select-sort"
                      onClick={header.column.getToggleSortingHandler()}
                      title="Click to sort by selection — descending lifts selected rows to the top, ascending puts them at the bottom"
                      aria-label="Sort by selection"
                    >
                      <input
                        type="checkbox"
                        checked={table.getIsAllRowsSelected()}
                        ref={(el) => {
                          if (el) el.indeterminate = table.getIsSomeRowsSelected() && !table.getIsAllRowsSelected();
                        }}
                        onChange={table.getToggleAllRowsSelectedHandler()}
                        // Stop click from also triggering the sort
                        // toggle — the checkbox and the sort handle
                        // share the same `<th>` cell so the user can
                        // hit either independently.
                        onClick={(e) => e.stopPropagation()}
                        aria-label="Select all rows"
                      />
                      <span className={indicatorClass}>{indicator}</span>
                    </button>
                  </th>
                );
              }
              const sort = header.column.getIsSorted();
              const indicator = sort === "asc" ? " ▲" : sort === "desc" ? " ▼" : "";
              return (
                <th key={header.id}>
                  <button
                    className="sortable"
                    onClick={header.column.getToggleSortingHandler()}
                    title="Click to sort"
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {indicator}
                  </button>
                </th>
              );
            })}
          </tr>
          <tr className="filters-row">
            {table.getHeaderGroups()[1].headers.map((header) => {
              const meta = header.column.columnDef.meta as { collapsedPlaceholder?: boolean; actionPlaceholder?: boolean; rowSelectColumn?: boolean } | undefined;
              if (meta?.collapsedPlaceholder) {
                return <th key={`f-${header.id}`} className="collapsed-placeholder" />;
              }
              if (meta?.actionPlaceholder || meta?.rowSelectColumn) {
                return <th key={`f-${header.id}`} className="row-action-col" />;
              }
              return (
              <th key={`f-${header.id}`}>
                <FilterInput
                  kind={columnKinds[header.id]}
                  options={categoryOptions[header.id]}
                  value={header.column.getFilterValue()}
                  onChange={(v) => header.column.setFilterValue(v)}
                />
              </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className={row.getIsSelected() ? "selected" : ""}>
              {row.getVisibleCells().map((cell) => {
                const meta = cell.column.columnDef.meta as { actionPlaceholder?: boolean; rowSelectColumn?: boolean } | undefined;
                const className = meta?.rowSelectColumn
                  ? "row-select-col"
                  : meta?.actionPlaceholder
                    ? "row-action-col"
                    : undefined;
                return (
                  <td key={cell.id} className={className}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {ngl.isError && ngl.error && <p className="error">{ngl.error.message}</p>}
    </div>
  );
}

/**
 * Compact soma-count indicator: a small colored dot whose tooltip carries the
 * underlying count.
 *   0  → gray   ("orphan", likely an unattached fragment)
 *   1  → green  ("single", the well-formed case — has a unique cell_id)
 *   >1 → red    ("multi", proofreading hasn't separated this neuron yet)
 */
function SomaIndicator({ count }: { count: number | undefined | null }) {
  if (count === undefined || count === null) return null;
  let cls = "soma-dot soma-dot-orphan";
  let label = "orphan";
  if (count === 1) {
    cls = "soma-dot soma-dot-single";
    label = "single";
  } else if (count > 1) {
    cls = "soma-dot soma-dot-multi";
    label = `multi (${count})`;
  }
  return <span className={cls} title={`${label} — ${count} soma`} aria-label={label} />;
}

