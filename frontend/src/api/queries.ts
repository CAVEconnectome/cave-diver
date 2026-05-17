import { useEffect, useMemo } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  CellIdLookupResponse,
  ConnectivityBundle,
  DatastackInfo,
  DatastacksListResponse,
  LinkResponse,
  PlotResponse,
  PlotSpecCatalogResponse,
  TableRowsResponse,
  TableUniqueValuesResponse,
  TablesResponse,
  ToursResponse,
  VersionsResponse,
} from "./types";

// Metadata calls hit CAVE on cache miss and occasionally flake (cold connection,
// upstream blip). The global retry default is 0 because expensive queries like
// /connectivity shouldn't auto-retry, but cheap metadata reads should — bump
// retry locally so a transient 502 doesn't strand the dropdown.
const META_RETRY = 2;
const META_RETRY_DELAY = (attempt: number) => Math.min(500 * 2 ** attempt, 4000);

export function useDatastacks() {
  // Allowlist served by the backend (`CDV_DATASTACKS_ALLOWED`). Drives the
  // sidebar's datastack picker. Cached aggressively — this list only changes
  // with a deployment-config change, so a short staleTime would just create
  // unnecessary refetches every time the sidebar mounts.
  return useQuery<DatastacksListResponse>({
    queryKey: ["datastacks"],
    queryFn: () => apiFetch<DatastacksListResponse>(`/api/v1/datastacks`),
    staleTime: 60 * 60 * 1000,
    retry: META_RETRY,
    retryDelay: META_RETRY_DELAY,
  });
}

export function useDatastackInfo(ds: string | null) {
  return useQuery<DatastackInfo>({
    queryKey: ["info", ds],
    queryFn: () => apiFetch<DatastackInfo>(`/api/v1/datastacks/${ds}/info`),
    enabled: !!ds,
    staleTime: 60 * 60 * 1000, // 1h — info_cache is server-side too
    retry: META_RETRY,
    retryDelay: META_RETRY_DELAY,
  });
}

/**
 * Catalog of plot specs the backend has loaded from
 * `api/templates/plots/*.yaml`. Drives the SPA's plot picker so a new
 * template appears without editing `plots/registry.ts`. Cached aggressively
 * — specs only change on deploy, just like the datastack list.
 */
export function usePlotSpecs() {
  return useQuery<PlotSpecCatalogResponse>({
    queryKey: ["plot_specs"],
    queryFn: () => apiFetch<PlotSpecCatalogResponse>(`/api/v1/plots/specs`),
    staleTime: 60 * 60 * 1000,
    retry: META_RETRY,
    retryDelay: META_RETRY_DELAY,
  });
}

/**
 * Operator-curated landing-page recipes for one datastack.
 *
 * Note: examples are served separately by /api/v1/examples (Task 3.x);
 * they are NOT included in this response despite the legacy hook name.
 *
 * The YAML changes only with a deployment-config change, so cache aggressively
 * — same staleTime as the datastack list. Backend serves a fresh dump on
 * every request (cheap; no upstream calls).
 */
export function useTours(ds: string | null) {
  return useQuery<ToursResponse>({
    queryKey: ["tours", ds],
    queryFn: () => apiFetch<ToursResponse>(`/api/v1/datastacks/${ds}/tours`),
    enabled: !!ds,
    staleTime: 60 * 60 * 1000,
    retry: META_RETRY,
    retryDelay: META_RETRY_DELAY,
  });
}

export function useVersions(ds: string | null) {
  return useQuery<VersionsResponse>({
    queryKey: ["versions", ds],
    queryFn: () => apiFetch<VersionsResponse>(`/api/v1/datastacks/${ds}/versions`),
    enabled: !!ds,
    staleTime: 60 * 60 * 1000,
    retry: META_RETRY,
    retryDelay: META_RETRY_DELAY,
  });
}

/**
 * Full distinct-value universe for a table's string columns, used to
 * populate category filter dropdowns with *every* selectable value rather
 * than just the values present in the loaded slice. Backend caches the
 * call effectively forever (the universe is mat-version-stable), so this
 * is essentially free on warm requests.
 *
 * Disabled while `ds` / `table` are null and for views (which CAVE doesn't
 * expose `get_unique_string_values` for); callers degrade silently to
 * row-walking when `data` is undefined.
 */
export function useTableUniqueValues(
  ds: string | null,
  table: string | null,
  matVersion: number | "live" | null,
  enabled: boolean = true,
) {
  return useQuery<TableUniqueValuesResponse>({
    queryKey: ["table_unique_values", ds, table, matVersion],
    queryFn: () =>
      apiFetch<TableUniqueValuesResponse>(
        `/api/v1/datastacks/${ds}/tables/${table}/values`,
        { query: { mat_version: matVersion === "live" ? undefined : matVersion ?? undefined } },
      ),
    enabled: enabled && !!ds && !!table,
    // Distinct-value universe is immutable per (datastack, mat_version,
    // table) — backend caches it in `unique_values_cache` for 7 days and
    // we trust that, so the SPA tier can match. Effectively "session-stable."
    staleTime: 24 * 60 * 60 * 1000,
    retry: META_RETRY,
    retryDelay: META_RETRY_DELAY,
  });
}

/**
 * Fetch the distinct-value universe for several tables in parallel and
 * merge into a single map keyed by qualified column (`${table}.${col}`).
 *
 * Designed for surfaces that need a categorical dropdown across an
 * arbitrary set of attached decoration tables (the Filter Scope
 * predicate builder is the primary caller). Each underlying query reuses
 * the same TanStack Query cache entry as `useTableUniqueValues`, so
 * pages that already loaded a table's values pay nothing on entry.
 *
 * `live` mat_version is treated as "no version" by the backend; the
 * unique-values cache is materialization-stable so a live caller falls
 * back to whatever's currently cached server-side without forcing a fetch.
 *
 * Returns the merged map along with a coarse readiness flag — useful
 * for branching UI between "loading…" and "render with whatever's here."
 */
export function useTablesUniqueValues(
  ds: string | null,
  tables: string[],
  matVersion: number | "live" | null,
): { values: Record<string, string[]>; isLoading: boolean } {
  const queries = useQueries({
    queries: tables.map((table) => ({
      queryKey: ["table_unique_values", ds, table, matVersion] as QueryKey,
      queryFn: () =>
        apiFetch<TableUniqueValuesResponse>(
          `/api/v1/datastacks/${ds}/tables/${table}/values`,
          {
            query: {
              mat_version: matVersion === "live" ? undefined : matVersion ?? undefined,
            },
          },
        ),
      enabled: !!ds && !!table,
      staleTime: 24 * 60 * 60 * 1000,
      retry: META_RETRY,
      retryDelay: META_RETRY_DELAY,
    })),
  });
  // Merge as a `${table}.${column}` map so the predicate builder can do
  // a single lookup on the qualified column key it already has.
  const values = useMemo(() => {
    const out: Record<string, string[]> = {};
    queries.forEach((q, i) => {
      const table = tables[i];
      const data = q.data;
      if (!data) return;
      for (const [col, vals] of Object.entries(data.values ?? {})) {
        out[`${table}.${col}`] = vals;
      }
    });
    return out;
    // The queries array identity is new every render; keying memo on
    // table identifiers + per-query data is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.join("|"), ...queries.map((q) => q.data)]);
  const isLoading = queries.some((q) => q.isLoading);
  return { values, isLoading };
}

export function useTables(ds: string | null, matVersion: number | "live" | null) {
  return useQuery<TablesResponse>({
    queryKey: ["tables", ds, matVersion],
    queryFn: () =>
      apiFetch<TablesResponse>(`/api/v1/datastacks/${ds}/tables`, {
        query: { mat_version: matVersion === "live" ? undefined : matVersion ?? undefined },
      }),
    enabled: !!ds,
    staleTime: 60 * 60 * 1000,
    retry: META_RETRY,
    retryDelay: META_RETRY_DELAY,
  });
}

export interface TableRowsArgs {
  ds: string;
  table: string;
  matVersion: number | "live" | null;
  limit?: number;
  offset?: number;
  isView?: boolean;
  // Reserved column-filters: anything else here is forwarded as ?col=val.
  filters?: Record<string, string>;
}

export function useTableRows(args: TableRowsArgs | null) {
  return useQuery<TableRowsResponse>({
    queryKey: args
      ? ["table_rows", args.ds, args.table, args.matVersion, args.limit, args.offset, args.isView, args.filters]
      : ["table_rows", "disabled"],
    queryFn: () =>
      apiFetch<TableRowsResponse>(
        `/api/v1/datastacks/${args!.ds}/tables/${args!.table}/rows`,
        {
          query: {
            mat_version: args!.matVersion === "live" ? undefined : args!.matVersion ?? undefined,
            limit: args!.limit ?? 1000,
            offset: args!.offset ?? 0,
            is_view: args!.isView === undefined ? undefined : args!.isView ? "true" : "false",
            ...(args!.filters ?? {}),
          },
        },
      ),
    enabled: !!args && !!args.table,
    staleTime: 5 * 60 * 1000,
  });
}

export interface ConnectivityArgs {
  ds: string;
  rootId: string;  // string to preserve int64 precision (see types.ts)
  matVersion: number | "live" | null;
  include?: ("partners_in" | "partners_out" | "summary")[];
  decorationTables?: string[];
}

export function useConnectivity(args: ConnectivityArgs | null) {
  const queryKey: QueryKey = args
    ? ["connectivity", args.ds, args.rootId, args.matVersion,
       (args.decorationTables ?? []).join(","), args.include]
    : ["connectivity", "disabled"];

  const query = useQuery<ConnectivityBundle>({
    queryKey,
    queryFn: () =>
      apiFetch<ConnectivityBundle>(
        `/api/v1/datastacks/${args!.ds}/neuron/${args!.rootId}/connectivity`,
        {
          method: "POST",
          query: { mat_version: args!.matVersion === "live" ? undefined : args!.matVersion ?? undefined },
          body: {
            include: args!.include ?? ["partners_in", "partners_out", "summary"],
            decoration_tables: args!.decorationTables ?? [],
          },
        },
      ),
    enabled: !!args && !!args.rootId,
    staleTime: 5 * 60 * 1000, // matches server query_cache TTL roughly
  });

  useDecorationRevalidationPoll(query.data, queryKey);
  return query;
}

interface DecorationPollResponse {
  status: "ready" | "in_flight" | "expired";
  retry_after?: number;
  deltas?: Record<string, { num_soma?: number; cell_id?: string | null }>;
}

/**
 * When the connectivity bundle response carries `decoration_revalidation`, the
 * server has served stale cell_type/num_soma values and queued a background
 * refresh. This effect schedules a single delayed poll, then on `ready` merges
 * the deltas into the cached bundle so any displayed cell_type / num_soma
 * column updates without a full refetch. Self-healing: a failed poll falls
 * through silently — the next /connectivity request will reflect the truth.
 */
function useDecorationRevalidationPoll(
  bundle: ConnectivityBundle | undefined,
  queryKey: QueryKey,
): void {
  const qc = useQueryClient();
  const ticketId = bundle?.decoration_revalidation?.ticket_id ?? null;
  const pollUrl = bundle?.decoration_revalidation?.poll_url ?? null;

  useEffect(() => {
    if (!ticketId || !pollUrl) return;
    let cancelled = false;
    let timer: number | null = null;

    const tick = (delayMs: number) => {
      timer = window.setTimeout(async () => {
        if (cancelled) return;
        try {
          const resp = await apiFetch<DecorationPollResponse>(pollUrl);
          if (cancelled) return;
          if (resp.status === "ready" && resp.deltas) {
            qc.setQueryData<ConnectivityBundle>(queryKey, (prev) =>
              prev ? mergeDecorationDeltas(prev, resp.deltas!) : prev,
            );
          } else if (resp.status === "in_flight") {
            tick((resp.retry_after ?? 2) * 1000);
          } else if (resp.status === "expired") {
            // Ticket aged out before the background refresh landed. The cached
            // bundle's decoration values are stale-of-unknown-age — readiness
            // is `fetched_at >= minted_at`, not `freshness == "fresh"`. Clear
            // the consumed ticket so we don't re-poll, then invalidate so the
            // next render fetches a fresh bundle.
            qc.setQueryData<ConnectivityBundle>(queryKey, (prev) =>
              prev ? { ...prev, decoration_revalidation: null } : prev,
            );
            qc.invalidateQueries({ queryKey });
          }
        } catch {
          // Swallow: best-effort. Next /connectivity will reflect the latest.
        }
      }, delayMs);
    };

    tick(3000); // first poll after 3s — gives the background revalidation time to land
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [ticketId, pollUrl, queryKey, qc]);
}

function mergeDecorationDeltas(
  bundle: ConnectivityBundle,
  deltas: Record<string, { num_soma?: number; cell_id?: string | null }>,
): ConnectivityBundle {
  const apply = (rows: ConnectivityBundle["partners_in"]) => {
    if (!rows) return rows;
    return rows.map((r) => {
      const d = deltas[r.root_id];
      return d ? { ...r, ...d } : r;
    });
  };
  return {
    ...bundle,
    partners_in: apply(bundle.partners_in),
    partners_out: apply(bundle.partners_out),
    decoration_revalidation: null, // ticket consumed; clear so we don't re-poll
  };
}

export interface MakeLinkArgs {
  ds: string;
  template: string;
  rootId: string;
  selectedPartnerIds?: string[];
  matVersion: number | "live" | null;
}

export interface PlotBindings {
  x?: string | null;
  y?: string | null;
  hue?: string | null;
  size?: string | null;
  /** Numeric column to sum on bar plots; replaces implicit row-count. */
  weight?: string | null;
  /** Panel-level direction scope on the unified `partners_both` frame.
   *  Applied to every channel uniformly (replaces the legacy per-axis
   *  x_scope / y_scope pair). `reciprocal` = strict intersection; `both`
   *  = no filter (use `hue=direction` to color by direction class). */
  scope?: "input" | "output" | "both" | "reciprocal" | null;
  /** Draw the target neuron's soma depth on depth-axis plots. Default ON
   *  on the backend; the SPA only sets this when the user toggled it off. */
  show_cell_depth?: boolean | null;
}

export interface PlotArgs {
  ds: string;
  spec: string;          // plot spec name, matches templates/plots/<name>.yaml
  rootId: string;
  matVersion: number | "live" | null;
  decorationTables?: string[];
  /** Legacy single-column override (column-bound plots). Maps to `bindings.x`
   *  on the backend. New code should use `bindings` directly. */
  column?: string | null;
  /** Multi-channel binding: backend auto-picks chart kind for `dynamic` specs
   *  (1 axis → histogram, 2 axes → scatter). Wins over `column` when set. */
  bindings?: PlotBindings | null;
  /** Cell filter to apply to *this* fetch — the *effective* value the
   *  backend sees. When the panel is in `?unfilter=`, the dynamic-panel
   *  layer null's this even when a global filter is set; for static and
   *  column-bound panels it equals the global filter. */
  cells?: string | null;
  /** Whether *this* panel is opted out of the global cell filter (i.e.
   *  the panel id appears in `?unfilter=`). Distinct from `cells` being
   *  null/empty: the global filter may be unset (cells absent for both
   *  filtered and unfiltered panels) but the *intent* differs. Pinning
   *  this in the queryKey makes the cache distinguish "no filter
   *  configured" from "filter explicitly opted out for this panel" so
   *  toggling the per-panel filter pill always invalidates correctly,
   *  even in edge cases where `cells` happens to compare equal across
   *  the toggle. */
  unfiltered?: boolean;
}

function bindingsCacheKey(b: PlotBindings | null | undefined): string {
  if (!b) return "";
  // `show_cell_depth` only contributes when explicitly off — the backend
  // default is ON, so undefined and true produce the same fetch key.
  const scd = b.show_cell_depth === false ? "0" : "";
  return `${b.x ?? ""}|${b.y ?? ""}|${b.hue ?? ""}|${b.size ?? ""}|${b.weight ?? ""}|${b.scope ?? ""}|${scd}`;
}

function hasAnyBinding(b: PlotBindings | null | undefined): boolean {
  if (!b) return false;
  return !!(b.x || b.y || b.hue || b.size || b.weight);
}

export function usePlot(args: PlotArgs | null) {
  return useQuery<PlotResponse>({
    queryKey: args
      ? ["plot", args.ds, args.spec, args.rootId, args.matVersion,
         (args.decorationTables ?? []).join(","), args.column ?? "", bindingsCacheKey(args.bindings),
         args.cells ?? "", args.unfiltered ? "unfiltered" : "filtered"]
      : ["plot", "disabled"],
    queryFn: () =>
      apiFetch<PlotResponse>(
        `/api/v1/datastacks/${args!.ds}/plots/${args!.spec}`,
        {
          method: "POST",
          query: {
            mat_version: args!.matVersion === "live" ? undefined : args!.matVersion ?? undefined,
            cells: args!.cells || undefined,
          },
          body: {
            root_id: args!.rootId,
            decoration_tables: args!.decorationTables ?? [],
            column: args!.column ?? null,
            bindings: args!.bindings ?? undefined,
          },
        },
      ),
    // Disabled when nothing is bound — the backend would 422 on a dynamic spec
    // with no axes; legacy column-bound plots gate on `column`.
    enabled: !!args && !!args.rootId && (!!args.column || hasAnyBinding(args.bindings)),
    staleTime: 5 * 60 * 1000,
  });
}

export interface CellIdLookupArgs {
  ds: string;
  matVersion: number | "live" | null;
  cellIds?: string[];
  rootIds?: string[];
}

export function useCellIdLookupMutation() {
  return useMutation<CellIdLookupResponse, Error, CellIdLookupArgs>({
    mutationFn: (args) =>
      apiFetch<CellIdLookupResponse>(
        `/api/v1/datastacks/${args.ds}/cell-ids/lookup`,
        {
          method: "POST",
          query: { mat_version: args.matVersion === "live" ? undefined : args.matVersion ?? undefined },
          body: {
            cell_ids: args.cellIds ?? [],
            root_ids: args.rootIds ?? [],
          },
        },
      ),
  });
}

export function useMakeLinkMutation() {
  return useMutation<LinkResponse, Error, MakeLinkArgs>({
    mutationFn: (args) =>
      apiFetch<LinkResponse>(`/api/v1/datastacks/${args.ds}/links`, {
        method: "POST",
        query: { mat_version: args.matVersion === "live" ? undefined : args.matVersion ?? undefined },
        body: {
          template: args.template,
          query: {
            root_id: args.rootId,
            selected_partner_ids: args.selectedPartnerIds,
          },
        },
      }),
  });
}

export interface MakeSegmentsLinkArgs {
  ds: string;
  matVersion: number | "live";
  rootIds: string[];
  /** Optional view position to open the viewer at, in raw voxel coordinates
   *  (typically pulled from a row's `<prefix>_pt_position_x/y/z` triple). */
  position?: [number, number, number];
  /** Optional voxel resolution (nm/voxel) for the table the position came
   *  from. Used as the data dimension so `position` reads as voxel coords;
   *  omit to fall back to nglui's inferred coordinates. */
  voxelResolution?: [number, number, number];
}

/**
 * Open Neuroglancer with a flat list of segments pinned. Used when
 * there's no focal neuron — just a set of root_ids the user is
 * interested in (table-rows view, cell-list lasso, neutral sidebar
 * link).
 *
 * Prefer the unified `useNglLink` (hooks/useNglLink.ts) at call sites
 * rather than importing this directly — the unified hook aggregates
 * pending/error state across both template-based and segment-based
 * NGL flows and centralises the `window.open` step. Direct use is
 * reserved for code that needs the raw mutation handle.
 */
export function useMakeSegmentsLinkMutation() {
  return useMutation<LinkResponse, Error, MakeSegmentsLinkArgs>({
    mutationFn: (args) =>
      apiFetch<LinkResponse>(`/api/v1/datastacks/${args.ds}/links/segments`, {
        method: "POST",
        query: { mat_version: args.matVersion === "live" ? undefined : args.matVersion ?? undefined },
        body: {
          root_ids: args.rootIds,
          position: args.position,
          voxel_resolution: args.voxelResolution,
        },
      }),
  });
}
