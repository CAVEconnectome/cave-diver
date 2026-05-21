import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  type ColumnDef,
  type ColumnFiltersState,
  type RowSelectionState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import {
  useDatastackInfo,
  useTableRows,
  useTableUniqueValues,
  useTables,
} from "../api/queries";
import { migrateStorageKey } from "../hooks/storageMigration";
import { useCrossNavHref } from "../hooks/useCrossNavHref";
import { useNglLink } from "../hooks/useNglLink";
import { parseMatVersion, useUrlParam } from "../hooks/useUrlState";
import {
  CopyableId,
  FilterInput,
  filterValueFromParams,
  filterValueToParams,
  formatCell,
  inferKind,
  isServerEligibleColumn,
  type ColumnKind,
} from "./tableColumns";
import { TableMetadataBanner } from "./TableMetadata";
import {
  type Bucket,
  DEFAULT_COLLAPSED_BUCKETS,
  orderColumnsGrouped,
} from "./columnOrder";

const PAGE_SIZE = 50;
// Most CAVE tables (10–100k rows) fit comfortably in 20k; the few that
// exceed it (synapse tables: 300M+ rows) trip the `limit_hit` flag and the
// SPA flips into server-side filter dispatch. Backend caps at 200k, which
// is also the ceiling for the manual "Load all" override (`?limit=200000`).
const ROW_LIMIT = 20_000;
const ROW_LIMIT_MAX = 200_000;

// Persistence key for the collapsed-bucket set. Per-bucket (not per-table) so
// a user who always wants the bookkeeping group hidden gets that everywhere.
const COLLAPSED_BUCKETS_STORAGE_KEY = "cdv:v1:tablerows_collapsed_buckets";

// URL prefix for filter params, distinguishing them from the workspace's
// many other URL keys (`ds`, `mv`, `from`, `dec`, plot keys). Frontend writes
// `?f_<col>=val` / `?f_<col>__gte=N` etc.; the prefix is stripped before
// the dict reaches the backend's `parse_filters`.
const FILTER_PREFIX = "f_";

/** Read URL filter params (anything `f_*`) into the dict the backend rows
 *  endpoint expects. The keys come back de-prefixed and ready to ride along
 *  on the request as `?col=val` / `?col__gte=N`. */
function readFilterParamsForApi(searchParams: URLSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of searchParams.entries()) {
    if (k.startsWith(FILTER_PREFIX)) {
      const stripped = k.slice(FILTER_PREFIX.length);
      if (stripped) out[stripped] = v;
    }
  }
  return out;
}

/** Hydrate TanStack `ColumnFiltersState` from `f_*` URL params, decoding
 *  per-column based on the column's inferred kind. Skips substring kinds
 *  (those never round-trip via URL) and unknown columns (defensive — a
 *  shared link with stale column names should fail silent rather than
 *  throw). Returns the array of filter records to set in TanStack state. */
function hydrateColumnFiltersFromUrl(
  searchParams: URLSearchParams,
  columnNames: string[],
  columnKinds: Record<string, ColumnKind>,
): ColumnFiltersState {
  // Build a stripped URLSearchParams scoped to f_-prefixed keys so
  // `filterValueFromParams` (which expects unprefixed keys) can consume it.
  const stripped = new URLSearchParams();
  for (const [k, v] of searchParams.entries()) {
    if (k.startsWith(FILTER_PREFIX)) {
      const u = k.slice(FILTER_PREFIX.length);
      if (u) stripped.append(u, v);
    }
  }
  const next: ColumnFiltersState = [];
  for (const c of columnNames) {
    const kind = columnKinds[c];
    if (!kind || !isServerEligibleColumn(c, kind)) continue;
    const value = filterValueFromParams(c, kind, stripped);
    if (value !== undefined) next.push({ id: c, value });
  }
  return next;
}

// Per-row label cap for the rotated collapsed-group header. Same value the
// PartnersTable uses for visual parity.
const COLLAPSED_LABEL_MAX_CHARS = 5;

function truncateLabel(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Extract the position prefix from the first column in the position bucket.
 *  `ctr_pt_position_x` → `ctr_pt`; `pt_position_x` → `pt`; null when the
 *  table has no point column. The caller uses the prefix to pull the row's
 *  `[x, y, z]` triple via `<prefix>_position_<axis>`. */
function firstPositionPrefix(positionColumns: string[]): string | null {
  if (positionColumns.length === 0) return null;
  const m = /^(.+)_position_[xyz]$/.exec(positionColumns[0]);
  return m ? m[1] : null;
}

/** Pull a `[x, y, z]` voxel-coord triple from `row` for the given position
 *  prefix. Returns null when any axis is missing / null / not numeric — a
 *  partial position (e.g. only x set) would be worse than no position
 *  (the viewer would jump to a meaningless place on the other axes). */
function rowPosition(
  row: Row,
  prefix: string,
): [number, number, number] | null {
  const x = row[`${prefix}_position_x`];
  const y = row[`${prefix}_position_y`];
  const z = row[`${prefix}_position_z`];
  if (typeof x !== "number" || typeof y !== "number" || typeof z !== "number") {
    return null;
  }
  return [x, y, z];
}

/** Pick the first row with a usable position; null if none. Used by the
 *  action-bar buttons to choose what point to center the viewer on for a
 *  multi-row scope. */
function firstRowPosition(
  rows: Row[],
  prefix: string | null,
): [number, number, number] | null {
  if (!prefix) return null;
  for (const row of rows) {
    const p = rowPosition(row, prefix);
    if (p) return p;
  }
  return null;
}

function loadCollapsedBuckets(): Set<Bucket> {
  // Forward-migrate from the unversioned legacy key on first read.
  migrateStorageKey(
    "cdv:tablerows_collapsed_buckets",
    COLLAPSED_BUCKETS_STORAGE_KEY,
    localStorage,
  );
  try {
    const raw = localStorage.getItem(COLLAPSED_BUCKETS_STORAGE_KEY);
    if (raw) return new Set(JSON.parse(raw) as Bucket[]);
  } catch {
    /* fall through to default */
  }
  return new Set(DEFAULT_COLLAPSED_BUCKETS);
}

function saveCollapsedBuckets(buckets: Set<Bucket>): void {
  try {
    localStorage.setItem(COLLAPSED_BUCKETS_STORAGE_KEY, JSON.stringify([...buckets]));
  } catch {
    /* localStorage unavailable in some embeds; lose persistence quietly */
  }
}

type Row = Record<string, unknown>;

export function TableRowsView() {
  const { name } = useParams<{ name: string }>();
  const [ds] = useUrlParam("ds");
  const [mv] = useUrlParam("mv");
  const matVersion = parseMatVersion(mv);
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  // Server-side filter params live on the URL with an `f_` prefix; pluck
  // them straight off the URL for the rows query so the request signature
  // tracks the URL state without needing a separate client-side cache.
  const filtersForApi = useMemo(
    () => readFilterParamsForApi(searchParams),
    [searchParams],
  );

  // Honor a `?limit=` URL param up to the backend ceiling so a user who has
  // hit the cap can opt into the heavier 200k pull. Out-of-range / malformed
  // values fall back to the default — refusing to render would be worse UX
  // than silently clamping. The applied value flows into the query key, so
  // the bigger fetch is a fresh request rather than a cache hit on the
  // 20k slice.
  const rowLimit = useMemo(() => {
    const raw = searchParams.get("limit");
    if (!raw) return ROW_LIMIT;
    const n = Number(raw);
    if (!Number.isFinite(n)) return ROW_LIMIT;
    return Math.max(ROW_LIMIT, Math.min(ROW_LIMIT_MAX, Math.floor(n)));
  }, [searchParams]);

  const data = useTableRows(
    ds && name
      ? { ds, table: name, matVersion, limit: rowLimit, filters: filtersForApi }
      : null,
  );
  // The list query is cached by TanStack Query (1h staleTime), so navigating
  // here from the table browser is an instant hit. Direct-URL navigation
  // triggers a parallel list fetch — the banner fills in when the list
  // resolves; the rows query usually settles later anyway, so the metadata
  // is in place before the user sees data.
  const tableList = useTables(ds, matVersion);
  const metadataItem = useMemo(() => {
    if (!tableList.data || !name) return null;
    return tableList.data.tables.find((t) => t.name === name) ?? null;
  }, [tableList.data, name]);

  const [sorting, setSorting] = useState<SortingState>([]);
  // Two filter states:
  //   - `columnFilters` is the *applied* set: drives TanStack's filter
  //     model and mirrors the URL (the API request signature).
  //   - `filterDraft` is the *draft* set: what the user is currently
  //     editing in the per-column filter row.
  // In client mode the two move together (the same setter writes both),
  // so the existing instant-filter behavior is unchanged. In server mode
  // they diverge: typing updates the draft only; clicking "Run query" or
  // pressing Enter commits draft → applied → URL → refetch.
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [filterDraft, setFilterDraft] = useState<ColumnFiltersState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [collapsedBuckets, setCollapsedBuckets] = useState<Set<Bucket>>(loadCollapsedBuckets);

  // Server-mode flag: starts off, flips on permanently the first time a
  // response comes back capped (`limit_hit: true`) OR the URL arrives with
  // filter params (a shared / refreshed link from a previous server-mode
  // session). Once on, stays on for the lifetime of this view — we don't
  // bounce between modes per keystroke.
  const initialUrlHadFilters = useMemo(() => {
    for (const k of searchParams.keys()) {
      if (k.startsWith(FILTER_PREFIX)) return true;
    }
    return false;
  // Only consult the initial URL on first render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [serverModeEngaged, setServerModeEngaged] = useState(initialUrlHadFilters);

  const toggleBucketCollapsed = (bucket: Bucket) => {
    setCollapsedBuckets((prev) => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      saveCollapsedBuckets(next);
      return next;
    });
  };

  const rows = data.data?.rows ?? [];
  const columnGroups = useMemo(
    () => orderColumnsGrouped(data.data?.columns ?? [], rows),
    [data.data?.columns, rows],
  );
  const columnNames = useMemo(
    () => columnGroups.flatMap((g) => g.columns),
    [columnGroups],
  );

  // Names of every root_id column the table exposes. Drives both the inline
  // per-cell action buttons and the "open all in NGL" union.
  const rootIdColumns = useMemo(
    () => columnGroups.find((g) => g.bucket === "root_id")?.columns ?? [],
    [columnGroups],
  );

  // First *_pt_position prefix in the table's position bucket, e.g. `ctr_pt`
  // (synapse tables) or `pt` (single-point tables). Used to center the
  // Neuroglancer viewer on the first row in scope when generating a link.
  const positionPrefix = useMemo(() => {
    const positionCols = columnGroups.find((g) => g.bucket === "position")?.columns ?? [];
    return firstPositionPrefix(positionCols);
  }, [columnGroups]);

  // Voxel resolution for the NGL data-dimension. The rows endpoint queries
  // CAVE with `desired_resolution=client.info.viewer_resolution()`, so the
  // position columns come back rescaled to the datastack's *viewer*
  // resolution — NOT the table's stored `voxel_resolution`. Use the
  // datastack info's voxel_resolution field (which is set from
  // viewer_resolution_x/y/z) to match. Without this, opening NGL on a
  // table whose stored resolution differs from the viewer's would center
  // the viewer in the wrong place.
  const datastackInfo = useDatastackInfo(ds);
  const voxelResolution = useMemo<[number, number, number] | undefined>(() => {
    const v = datastackInfo.data?.voxel_resolution;
    if (!v || v.length !== 3) return undefined;
    return [v[0], v[1], v[2]];
  }, [datastackInfo.data]);

  const columnKinds = useMemo(() => {
    const kinds: Record<string, ColumnKind> = {};
    for (const c of columnNames) kinds[c] = inferKind(c, rows);
    return kinds;
  }, [columnNames, rows]);

  // Engage server mode the first time a response comes back capped.
  useEffect(() => {
    if (data.data?.limit_hit && !serverModeEngaged) {
      setServerModeEngaged(true);
    }
  }, [data.data?.limit_hit, serverModeEngaged]);

  // Hydrate filter state from `f_*` URL params once the first response's
  // column list lands. Both `columnFilters` (TanStack/applied) and
  // `filterDraft` (the editable working set) seed from the URL — they're
  // in sync at this point and only diverge when the user starts typing.
  // Single-shot per mount; later URL writes flow through `runQuery`.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!serverModeEngaged) return;
    if (columnNames.length === 0) return;
    hydratedRef.current = true;
    const next = hydrateColumnFiltersFromUrl(searchParams, columnNames, columnKinds);
    setColumnFilters(next);
    setFilterDraft(next);
  }, [serverModeEngaged, columnNames, columnKinds, searchParams]);

  // Filter-input plumbing for the per-column filter row. The two modes
  // diverge here:
  //   - Client mode: read/write straight to TanStack via the column header
  //     so filter changes apply instantly to the loaded slice.
  //   - Server mode: read/write the draft state. The draft doesn't filter
  //     the table until `runQuery` commits it.
  // Splitting this here (rather than inside FilterInput) keeps FilterInput
  // unchanged and lets the table render code stay declarative.
  const getFilterValue = useCallback(
    (col: string): unknown => {
      if (serverModeEngaged) {
        return filterDraft.find((f) => f.id === col)?.value;
      }
      return columnFilters.find((f) => f.id === col)?.value;
    },
    [columnFilters, filterDraft, serverModeEngaged],
  );

  const setFilterValue = useCallback(
    (col: string, value: unknown) => {
      const upsert = (prev: ColumnFiltersState): ColumnFiltersState => {
        const next = prev.filter((f) => f.id !== col);
        const empty = value === undefined || value === null || value === "";
        if (!empty) next.push({ id: col, value });
        return next;
      };
      setFilterDraft(upsert);
      if (!serverModeEngaged) setColumnFilters(upsert);
    },
    [serverModeEngaged],
  );

  // Apply the current draft as a server-side query. Writes the URL
  // (which `useTableRows` keys off) and updates `columnFilters` so
  // TanStack's local filtering matches the server's response shape
  // for any further client-only refinement (e.g. substring narrowing
  // within the new server-filtered result set).
  const runQuery = useCallback(() => {
    if (!serverModeEngaged) return;
    setColumnFilters(filterDraft);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const key of [...next.keys()]) {
        if (key.startsWith(FILTER_PREFIX)) next.delete(key);
      }
      for (const f of filterDraft) {
        const kind = columnKinds[f.id];
        if (!kind || !isServerEligibleColumn(f.id, kind)) continue;
        const params = filterValueToParams(f.id, kind, f.value);
        for (const [k, v] of Object.entries(params)) {
          next.set(`${FILTER_PREFIX}${k}`, v);
        }
      }
      return next;
    });
  }, [serverModeEngaged, filterDraft, columnKinds, setSearchParams]);

  // Pending-change detection: in server mode, draft and applied diverge
  // until Run is clicked (or Enter is pressed). The action-bar Run button
  // enables on this signal.
  const hasPendingFilterChanges = useMemo(() => {
    if (!serverModeEngaged) return false;
    if (filterDraft.length !== columnFilters.length) return true;
    const applied = new Map(columnFilters.map((f) => [f.id, f.value]));
    for (const f of filterDraft) {
      if (!applied.has(f.id)) return true;
      // JSON.stringify is overkill for primitives but handles the range
      // dict case (`{min, max}`) without bespoke equality.
      if (JSON.stringify(applied.get(f.id)) !== JSON.stringify(f.value)) return true;
    }
    return false;
  }, [serverModeEngaged, filterDraft, columnFilters]);

  // Full distinct-value universe for the table's string columns. The
  // dedicated /values endpoint surfaces every selectable value across the
  // entire table — without it, capped tables would offer dropdowns with
  // only the categories that happened to land in the loaded slice. Skipped
  // for views (CAVE doesn't expose get_unique_string_values for them).
  const isViewTarget = data.data?.is_view === true;
  const uniqueValues = useTableUniqueValues(
    ds, name ?? null, matVersion, !isViewTarget,
  );

  const categoryOptions = useMemo(() => {
    const options: Record<string, string[]> = {};
    const upstreamValues = uniqueValues.data?.values ?? {};
    for (const c of columnNames) {
      if (columnKinds[c] !== "category") continue;
      const values = new Set<string>();
      // Upstream universe is the authoritative source — covers categories
      // that exist beyond the loaded cap.
      for (const v of upstreamValues[c] ?? []) values.add(v);
      // Augment with what's actually visible in the loaded slice. Picks up
      // the synthetic `(none)` label for null cells (CAVE doesn't return
      // that) and absorbs any values that drifted between the materialization
      // we queried for unique values and the rows we actually rendered.
      for (const r of rows) {
        const v = r[c];
        if (v === null || v === undefined) values.add("(none)");
        else values.add(String(v));
      }
      options[c] = [...values].sort();
    }
    return options;
  }, [columnNames, columnKinds, rows, uniqueValues.data]);

  // Cross-nav builder for the row-action "→" button. Inter-view (table
  // → neuron) so URL state doesn't carry across — the user's table
  // filters / pagination / column visibility don't belong on the
  // destination neuron page.
  const buildNeuronHref = useCrossNavHref({
    ds: ds ?? "",
    matVersion,
    from: `table:${name ?? ""}`,
    inheritParams: false,
  });
  const goToNeuron = useCallback(
    (rid: string) => {
      if (!ds || !name) return;
      navigate(buildNeuronHref(rid));
    },
    [ds, name, navigate, buildNeuronHref],
  );

  const ngl = useNglLink();
  const openSegmentsInNGL = useCallback(
    (rootIds: string[], position?: [number, number, number]) => {
      if (!ds || rootIds.length === 0) return Promise.resolve(false);
      return ngl.open({
        kind: "segments",
        ds,
        matVersion,
        rootIds,
        position,
        voxelResolution: position ? voxelResolution : undefined,
      });
    },
    [ds, matVersion, ngl, voxelResolution],
  );

  // Build the leaf column defs once per bucketing — sort/filter behavior
  // doesn't depend on collapse state, so the inner factory stays stable
  // across collapse toggles.
  const leafColumnDefs = useMemo(() => {
    const map: Record<string, ColumnDef<Row>> = {};
    const rootIdSet = new Set(rootIdColumns);
    for (const c of columnNames) {
      const kind = columnKinds[c];
      const isRootIdCol = rootIdSet.has(c);
      const def: ColumnDef<Row> = {
        id: c,
        accessorFn: (row) => row[c],
        header: c,
        // root_id cells get inline action buttons (→ neuron view, ↗ NGL)
        // alongside the click-to-copy id widget. The cell renderer pulls
        // the row's own pt_position so a single-row NGL link opens centered
        // on that synapse / soma / point.
        cell: isRootIdCol
          ? (ctx) => {
              const pos = positionPrefix
                ? rowPosition(ctx.row.original, positionPrefix) ?? undefined
                : undefined;
              return (
                <RootIdCell
                  value={ctx.getValue()}
                  onView={goToNeuron}
                  onOpenNGL={(rid) => openSegmentsInNGL([rid], pos)}
                />
              );
            }
          : c === "id" || c === "cell_id" || /_id$/.test(c)
            ? (ctx) => <CopyableId value={ctx.getValue()} />
            : (ctx) => formatCell(ctx.getValue()),
        sortingFn: kind === "number" ? "basic" : "alphanumeric",
        filterFn: filterFnFor(kind, c),
      };
      map[c] = def;
    }
    return map;
  }, [columnNames, columnKinds, rootIdColumns, positionPrefix, goToNeuron, openSegmentsInNGL]);

  // Build TanStack column groups. Collapsed buckets render a single
  // placeholder leaf so the rotated header still draws — matches the
  // PartnersTable visual contract.
  const columns = useMemo<ColumnDef<Row>[]>(() => {
    return columnGroups.map((g) => {
      const collapsed = collapsedBuckets.has(g.bucket);
      const leafs: ColumnDef<Row>[] = collapsed
        ? [{
            id: `__collapsed__:${g.bucket}`,
            header: "",
            cell: () => null,
            accessorFn: () => null,
            enableSorting: false,
            enableColumnFilter: false,
            meta: { collapsedPlaceholder: true },
          }]
        : g.columns
            .map((c) => leafColumnDefs[c])
            .filter((d): d is ColumnDef<Row> => Boolean(d));
      const collapsedLabel = collapsed
        ? truncateLabel(g.label, COLLAPSED_LABEL_MAX_CHARS)
        : null;
      const headerRender = collapsed
        ? collapsedLabel ?? ""
        : () => <span className="group-label">{g.label}</span>;
      return {
        id: `group:${g.bucket}`,
        header: headerRender,
        meta: { bucket: g.bucket, label: g.label, collapsed },
        columns: leafs,
      };
    });
  }, [columnGroups, leafColumnDefs, collapsedBuckets]);

  const table = useReactTable<Row>({
    data: rows,
    columns,
    state: { sorting, columnFilters, rowSelection },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    // Many tables have a unique `id` column (the schema primary key).
    // When missing (some views), fall back to row index so selection
    // still works — the trade-off is that re-sorting changes the index
    // and clears selection, but views that lack `id` are rare enough
    // that's acceptable.
    getRowId: (row, index) => {
      const id = row["id"];
      return id !== null && id !== undefined ? String(id) : `__idx_${index}`;
    },
    enableRowSelection: true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: PAGE_SIZE } },
  });

  const filteredRows = table.getFilteredRowModel().rows;
  const filteredCount = filteredRows.length;
  const filterIsActive = columnFilters.length > 0 && filteredCount !== rows.length;
  const selectedRowIds = Object.keys(rowSelection);

  // Completeness pill state. The pill is the load-bearing scientific
  // disclosure: a user looking at this table needs an at-a-glance answer
  // to "is this everything that matches my filter, or just the first
  // chunk?" Three states:
  //
  //   - "complete": every matching row is loaded. Either the table fits
  //     comfortably (`!serverModeEngaged`), or a server filter narrowed
  //     the response below the cap (`serverModeEngaged && !limit_hit`).
  //   - "partial / no filter": server mode engaged, no server filter
  //     active, response was capped — first ROW_LIMIT of an unknown
  //     larger total.
  //   - "partial / filtered": server mode engaged, a server filter is
  //     active, and the filtered response was *still* capped — the
  //     filter has at least ROW_LIMIT matches and an unknown number more.
  //
  // The pill is always rendered when we have data; "complete" is green,
  // partial states are amber. Tooltip on amber explains the cap and the
  // narrow-further remedy.
  const limitHit = !!data.data?.limit_hit;
  const hasServerFilter = Object.keys(filtersForApi).length > 0;
  const completeness:
    | { state: "complete"; label: string; tooltip: string }
    | { state: "partial-unfiltered"; label: string; tooltip: string }
    | { state: "partial-filtered"; label: string; tooltip: string }
    = !limitHit
      ? {
          state: "complete",
          label: hasServerFilter ? "complete (filtered)" : "complete",
          tooltip: hasServerFilter
            ? `Every matching row for the current filter is loaded (${rows.length} rows).`
            : `Every row of this table is loaded (${rows.length} rows).`,
        }
      : hasServerFilter
        ? {
            state: "partial-filtered",
            label: `partial — ${rows.length.toLocaleString()} matches`,
            tooltip:
              `The current filter matches at least ${rows.length.toLocaleString()} rows, ` +
              `but more may exist beyond the ${rowLimit.toLocaleString()}-row cap. ` +
              `Narrow further to see all matches.`,
          }
        : {
            state: "partial-unfiltered",
            label: `partial — ${rows.length.toLocaleString()} of many`,
            tooltip:
              `This table is larger than the ${rowLimit.toLocaleString()}-row cap; ` +
              `you're seeing the first ${rows.length.toLocaleString()}. ` +
              `Apply a column filter to narrow on the server.`,
          };

  // Collect *_root_id values across a row scope. Drives the action-bar
  // "Open N in NGL" buttons. Returns sorted-deduplicated strings — the
  // backend dedupes too, but client-side dedup gives the user an honest
  // count *before* clicking.
  const collectRootIds = useCallback(
    (scopeRows: Row[]): string[] => {
      const out = new Set<string>();
      for (const row of scopeRows) {
        for (const col of rootIdColumns) {
          const v = row[col];
          if (v === null || v === undefined) continue;
          const s = typeof v === "number" ? String(v) : String(v);
          if (s === "0" || s === "") continue;
          out.add(s);
        }
      }
      return [...out];
    },
    [rootIdColumns],
  );

  const allRootIds = useMemo(() => collectRootIds(rows), [collectRootIds, rows]);
  const filteredRootIds = useMemo(
    () => collectRootIds(filteredRows.map((r) => r.original)),
    [collectRootIds, filteredRows],
  );
  const selectedScopeRows = useMemo(
    () => filteredRows.filter((r) => selectedRowIds.includes(r.id)).map((r) => r.original),
    [filteredRows, selectedRowIds],
  );
  const selectedRootIds = useMemo(
    () => collectRootIds(selectedScopeRows),
    [collectRootIds, selectedScopeRows],
  );

  if (!ds || !name) return <p>Pick a datastack and a table.</p>;

  const backCarry = new URLSearchParams();
  if (ds) backCarry.set("ds", ds);
  if (mv) backCarry.set("mv", mv);

  const hasRootIds = rootIdColumns.length > 0 && allRootIds.length > 0;

  return (
    <div className="table-rows-view">
      <div className="table-rows-breadcrumb">
        <Link to={`/tables?${backCarry}`}>← tables</Link>
      </div>
      <TableMetadataBanner item={metadataItem} fallbackName={name} />
      {data.isFetching && !data.data && <p>Loading…</p>}
      {data.error && <p className="error">{(data.error as Error).message}</p>}
      {data.data && (
        <div className="partners">
          <div className="actions">
            {/* Completeness pill — always rendered; the load-bearing
                disclosure that this view is honest about partial results. */}
            <span
              className={`completeness-pill completeness-${completeness.state}`}
              title={completeness.tooltip}
            >
              {completeness.label}
            </span>
            {/* Manual cap-override. Only surfaces when the response was
                truncated AND we're still on the default 20k slice — once the
                user has bumped to 200k the button has nothing more to offer
                and we hide it rather than render a permanent "you're at the
                ceiling" disabled chip. The bigger pull can take several
                seconds and may slow per-keystroke filter / sort, so the
                tooltip is the manual-override caveat. */}
            {limitHit && rowLimit < ROW_LIMIT_MAX && (
              <button
                className="load-more"
                onClick={() => {
                  setSearchParams((prev) => {
                    const next = new URLSearchParams(prev);
                    next.set("limit", String(ROW_LIMIT_MAX));
                    return next;
                  });
                }}
                disabled={data.isFetching}
                title={
                  `Refetch this table with the ${ROW_LIMIT_MAX.toLocaleString()}-row ceiling. ` +
                  `Takes a few seconds and may slow per-keystroke filtering and sorting.`
                }
              >
                {data.isFetching
                  ? "loading…"
                  : `Load up to ${ROW_LIMIT_MAX.toLocaleString()}`}
              </button>
            )}
            {hasRootIds && (
              <>
                <span className="scope">Open in NGL:</span>
                <button
                  onClick={() =>
                    openSegmentsInNGL(allRootIds, firstRowPosition(rows, positionPrefix) ?? undefined)
                  }
                  disabled={ngl.isPending}
                  title={
                    limitHit
                      ? `Open the ${allRootIds.length} segments in this loaded slice — additional matching segments may exist beyond the ${rowLimit.toLocaleString()}-row cap.`
                      : `Open all ${allRootIds.length} segments in Neuroglancer`
                  }
                >
                  {limitHit ? "all loaded" : "all"} ({allRootIds.length})
                  {limitHit && <span className="partial-flag"> · partial</span>}
                </button>
                {filterIsActive && (
                  <button
                    onClick={() =>
                      openSegmentsInNGL(
                        filteredRootIds,
                        firstRowPosition(filteredRows.map((r) => r.original), positionPrefix) ?? undefined,
                      )
                    }
                    disabled={ngl.isPending}
                    title={`Open ${filteredRootIds.length} filtered-row segments`}
                  >
                    filtered ({filteredRootIds.length})
                  </button>
                )}
                <button
                  onClick={() =>
                    openSegmentsInNGL(
                      selectedRootIds,
                      firstRowPosition(selectedScopeRows, positionPrefix) ?? undefined,
                    )
                  }
                  disabled={selectedRootIds.length === 0 || ngl.isPending}
                  title={`Open ${selectedRootIds.length} selected-row segments`}
                >
                  selected ({selectedRootIds.length})
                </button>
              </>
            )}
            {serverModeEngaged && (
              // Run-query button is the explicit commit handle for the
              // server-side filter dispatch. Always visible in server mode
              // (so the user knows the affordance exists) but only enabled
              // when the draft differs from what's been applied — clicking
              // it with no pending changes would just refetch the same
              // request, so we'd rather make that a no-op than confuse.
              <button
                className="run-query"
                onClick={runQuery}
                disabled={!hasPendingFilterChanges || data.isFetching}
                title={
                  hasPendingFilterChanges
                    ? "Apply the current filters as a server query (or press Enter in any filter input)"
                    : "No pending filter changes to apply"
                }
              >
                {data.isFetching && hasPendingFilterChanges ? "running…" : "Run query"}
              </button>
            )}
            <span className="page">
              {filteredCount === rows.length
                ? `${rows.length.toLocaleString()} rows`
                : `${filteredCount.toLocaleString()} of ${rows.length.toLocaleString()} rows`}
            </span>
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
            {(columnFilters.length > 0 || filterDraft.length > 0 || sorting.length > 0 || selectedRowIds.length > 0) && (
              <button
                onClick={() => {
                  setColumnFilters([]);
                  setFilterDraft([]);
                  if (serverModeEngaged) {
                    // Reset clears server filter URL params too — otherwise
                    // the next page-load would re-engage with stale filters.
                    setSearchParams((prev) => {
                      const next = new URLSearchParams(prev);
                      for (const key of [...next.keys()]) {
                        if (key.startsWith(FILTER_PREFIX)) next.delete(key);
                      }
                      return next;
                    });
                  }
                  setSorting([]);
                  setRowSelection({});
                }}
                title="Clear all filters, sorting, and row selection"
              >
                Reset
              </button>
            )}
          </div>

          {ngl.isError && ngl.error && (
            <p className="error">{ngl.error.message}</p>
          )}

          <div className="partners-scroll">
            <table>
              <thead>
                {/* Top row: bucket-group headers, spanning their leaf columns.
                    Click toggles collapse for that bucket. */}
                <tr className="group-row">
                  <th />
                  {table.getHeaderGroups()[0].headers.map((header) => {
                    const meta = header.column.columnDef.meta as
                      | { bucket?: Bucket; label?: string; collapsed?: boolean }
                      | undefined;
                    const bucket = meta?.bucket;
                    return (
                      <th
                        key={header.id}
                        colSpan={header.colSpan}
                        className={`group-header group-${bucket ?? ""}${meta?.collapsed ? " collapsed" : ""} collapsible`}
                        onClick={bucket ? () => toggleBucketCollapsed(bucket) : undefined}
                        title={
                          bucket
                            ? meta?.collapsed
                              ? `${meta.label} — click to expand`
                              : `${meta?.label} — click to collapse`
                            : undefined
                        }
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    );
                  })}
                </tr>
                {/* Second row: leaf columns (sortable). */}
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={table.getIsAllPageRowsSelected()}
                      ref={(el) => {
                        if (el) el.indeterminate = table.getIsSomePageRowsSelected() && !table.getIsAllPageRowsSelected();
                      }}
                      onChange={table.getToggleAllPageRowsSelectedHandler()}
                    />
                  </th>
                  {table.getHeaderGroups()[1].headers.map((header) => {
                    const meta = header.column.columnDef.meta as
                      | { collapsedPlaceholder?: boolean }
                      | undefined;
                    if (meta?.collapsedPlaceholder) {
                      return <th key={header.id} className="collapsed-placeholder" />;
                    }
                    const sort = header.column.getIsSorted();
                    const indicator = sort === "asc" ? " ▲" : sort === "desc" ? " ▼" : "";
                    return (
                      <th key={header.id}>
                        <button
                          className="sortable"
                          onClick={header.column.getToggleSortingHandler()}
                          title={
                            sort === "asc"
                              ? "Sorted ascending — click to sort descending"
                              : sort === "desc"
                                ? "Sorted descending — click to clear sort"
                                : "Click to sort by this column"
                          }
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {indicator}
                        </button>
                      </th>
                    );
                  })}
                </tr>
                <tr
                  className="filters-row"
                  // Pressing Enter anywhere in the filter row commits the
                  // current draft as a server query. Cheaper than a per-input
                  // form wrapper (form-in-tr is invalid HTML) and matches the
                  // search-bar UX the user expects.
                  onKeyDown={
                    serverModeEngaged
                      ? (e) => {
                          if (e.key === "Enter" && hasPendingFilterChanges) {
                            e.preventDefault();
                            runQuery();
                          }
                        }
                      : undefined
                  }
                >
                  <th></th>
                  {table.getHeaderGroups()[1].headers.map((header) => {
                    const meta = header.column.columnDef.meta as
                      | { collapsedPlaceholder?: boolean }
                      | undefined;
                    if (meta?.collapsedPlaceholder) {
                      return <th key={`f-${header.id}`} className="collapsed-placeholder" />;
                    }
                    const kind = columnKinds[header.id];
                    // Substring-in-server-mode is the genuinely-misleading
                    // case (filter only narrows the loaded slice, not the
                    // whole table). One small ⚠ glyph + tooltip is the
                    // entire per-cell disclosure — server-eligible inputs
                    // get nothing extra (the page-level pill already tells
                    // the truth, and badges on every input cluttered the row).
                    const showLocalOnlyWarning =
                      serverModeEngaged
                        && kind
                        && !isServerEligibleColumn(header.id, kind)
                        && !!getFilterValue(header.id);
                    return (
                      <th key={`f-${header.id}`}>
                        <FilterInput
                          kind={kind}
                          options={categoryOptions[header.id]}
                          value={getFilterValue(header.id)}
                          onChange={(v) => setFilterValue(header.id, v)}
                        />
                        {showLocalOnlyWarning && (
                          <span
                            className="filter-local-warning"
                            title={`This filter narrows only the ${rows.length.toLocaleString()} loaded rows; matching rows beyond the cap aren't searched.`}
                            aria-label="filter narrows only the loaded slice"
                          >
                            ⚠
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr key={row.id} className={row.getIsSelected() ? "selected" : ""}>
                    <td>
                      <input
                        type="checkbox"
                        checked={row.getIsSelected()}
                        onChange={row.getToggleSelectedHandler()}
                      />
                    </td>
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

interface RootIdCellProps {
  value: unknown;
  onView: (rid: string) => void;
  /** Single-id NGL handler — the caller is responsible for wrapping this
   *  row's id and position into the multi-id mutation. Accepting a single
   *  id keeps the cell renderer lean and the row-context plumbing in the
   *  factory closure where it belongs. */
  onOpenNGL: (rid: string) => void;
}

/**
 * Cell renderer for `*_root_id` columns. Shows the click-to-copy id followed
 * by two compact action buttons:
 *   - → cross-navigate to the neuron view for this root_id
 *   - ↗ open Neuroglancer with this single segment pinned
 *
 * Empty / null / 0 values render nothing (no actionable id).
 */
function RootIdCell({ value, onView, onOpenNGL }: RootIdCellProps) {
  if (value === null || value === undefined) return null;
  const rid = typeof value === "number" ? String(value) : String(value);
  if (rid === "" || rid === "0") return null;
  return (
    <span className="rootid-cell">
      <CopyableId value={rid} />
      <button
        className="row-action"
        onClick={() => onView(rid)}
        title={`View connectivity for ${rid}`}
        aria-label="View connectivity"
      >→</button>
      <button
        className="row-action"
        onClick={() => onOpenNGL(rid)}
        title={`Open ${rid} in Neuroglancer`}
        aria-label="Open in Neuroglancer"
      >↗</button>
    </span>
  );
}

function filterFnFor(kind: ColumnKind, col: string) {
  if (kind === "category") {
    return (row: { getValue: <T>(id: string) => T }, _id: string, filterValue: unknown) => {
      if (!filterValue) return true;
      const v = row.getValue<unknown>(col);
      const display = v === null || v === undefined ? "(none)" : String(v);
      return display === filterValue;
    };
  }
  if (kind === "number") {
    return (row: { getValue: <T>(id: string) => T }, _id: string, filterValue: unknown) => {
      const range = filterValue as { min?: number; max?: number } | undefined;
      if (!range) return true;
      const v = row.getValue<number>(col);
      if (typeof v !== "number") return false;
      if (range.min !== undefined && v < range.min) return false;
      if (range.max !== undefined && v > range.max) return false;
      return true;
    };
  }
  return (row: { getValue: <T>(id: string) => T }, _id: string, filterValue: unknown) => {
    if (!filterValue) return true;
    const v = row.getValue<unknown>(col);
    const haystack = v === null || v === undefined ? "" : String(v).toLowerCase();
    return haystack.includes(String(filterValue).toLowerCase());
  };
}
