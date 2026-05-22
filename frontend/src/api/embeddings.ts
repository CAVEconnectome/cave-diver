// Feature Explorer TanStack Query hooks.
//
// Slim foundation surface — only what the refactored explorer will need:
// the catalog list, the distance-to-set similarity primitive, and the
// cell_id->root_id resolver. The bulk data-fetching hooks
// (useEmbeddingPoints, useEmbeddingColumn, useDecorationCategoricalColumns)
// were removed when the UI flipped onto the shared toolkit — `/plots`
// covers plotting and a new `/feature_tables/<ft>/rows` endpoint will
// cover the table.

import {
  keepPreviousData,
  useMutation,
  useQuery,
  type QueryKey,
} from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  ColumnHistogramResponse,
  DistanceToSetArgs,
  DistanceToSetResponse,
  EmbeddingColumnResponse,
  EmbeddingListResponse,
  EmbeddingScatterResponse,
  FeatureTableCellsResponse,
  FindCellsResponse,
  ResolveRootsResponse,
} from "./types";

const PATHS = {
  list: (ds: string) => `/api/v1/datastacks/${ds}/feature_tables`,
  scatter: (ds: string, ftId: string, embId: string) =>
    `/api/v1/datastacks/${ds}/feature_tables/${ftId}/embeddings/${embId}/scatter`,
  cells: (ds: string, ftId: string) =>
    `/api/v1/datastacks/${ds}/feature_tables/${ftId}/cells`,
  column: (ds: string, ftId: string, column: string) =>
    // Path-segment column name (server uses <path:column> so dotted
    // names like `<table>.<col>` survive without escaping the dot).
    // We still encodeURIComponent the segment so slashes or unusual
    // characters in a column name don't break the URL.
    `/api/v1/datastacks/${ds}/feature_tables/${ftId}/column/${encodeURIComponent(column)}`,
  columnHistogram: (ds: string, ftId: string, column: string) =>
    `/api/v1/datastacks/${ds}/feature_tables/${ftId}/column/${encodeURIComponent(column)}/histogram`,
  distanceToSet: (ds: string, ftId: string) =>
    `/api/v1/datastacks/${ds}/feature_tables/${ftId}/distance_to_set`,
  resolveRoots: (ds: string, ftId: string) =>
    `/api/v1/datastacks/${ds}/feature_tables/${ftId}/resolve_roots`,
  findCells: (ds: string, ftId: string) =>
    `/api/v1/datastacks/${ds}/feature_tables/${ftId}/find_cells`,
  seedSummary: (ds: string, ftId: string) =>
    `/api/v1/datastacks/${ds}/feature_tables/${ftId}/seed_summary`,
};

// ---- /embeddings (catalog) -------------------------------------------------

/** Catalog of embeddings for one datastack. Always 200; check `enabled`. */
export function useEmbeddingList(ds: string | null) {
  return useQuery<EmbeddingListResponse>({
    queryKey: ["embedding_list", ds],
    queryFn: () => apiFetch<EmbeddingListResponse>(PATHS.list(ds!)),
    enabled: !!ds,
    // Catalog comes from a SWR-cached manifest server-side (~5 min refresh).
    // 5 min stale matches that cadence so the SPA doesn't poll the catalog
    // more aggressively than the backend refreshes it.
    staleTime: 5 * 60 * 1000,
  });
}

// ---- /scatter (universe layer) ---------------------------------------------

export interface EmbeddingScatterArgs {
  ds: string;
  featureTableId: string;
  embeddingId: string;
  /** Optional column override for the x axis (parquet col or
   *  `<dec_table>.<col>`). Defaults to the embedding's first axis. */
  x?: string | null;
  /** Optional column override for the y axis. */
  y?: string | null;
  /** Optional color channel column. */
  colorBy?: string | null;
  /** Optional size channel column (numeric only). The server ships
   *  raw values; the client rank-scales to px in UniverseScatter so
   *  the size-range slider is a free client-side transform. */
  sizeBy?: string | null;
  /** Attached decoration tables — required when any channel references
   *  a `<table>.<col>` not on the feature_table itself. */
  decorationTables?: string[];
  /** mat_version — required when any channel references a decoration
   *  column (drives the cell_id → root_id resolver). */
  matVersion?: number | "live" | null;
  /** Connectivity seed root_id (string; int64-safe). When set and any
   *  channel references a `seed_*` column, the server joins per-cell
   *  seed-derived columns onto the universe frame. */
  seedRootId?: string | null;
}

/** Universe payload for the scatter component. Parquet-pinned + cached
 *  immutably; channel bindings cut a new cache entry per binding set. */
export function useEmbeddingScatter(args: EmbeddingScatterArgs | null) {
  // The seed only changes the /scatter response when a channel actually
  // references a `seed_*` column — the backend joins seed data only in
  // that case. So fold the seed into the cache key (and send the param)
  // ONLY when it matters. Otherwise setting / clearing the seed would
  // pointlessly invalidate the cache and force a "Loading universe
  // scatter…" reload of an identical picture.
  const seedAffectsScatter =
    !!args &&
    !!args.seedRootId &&
    [args.x, args.y, args.colorBy, args.sizeBy].some(
      (c) => typeof c === "string" && c.startsWith("seed_"),
    );
  const effectiveSeed = seedAffectsScatter ? args!.seedRootId! : "";
  return useQuery<EmbeddingScatterResponse>({
    queryKey: args
      ? [
          "embedding_scatter",
          args.ds,
          args.featureTableId,
          args.embeddingId,
          args.x ?? "",
          args.y ?? "",
          args.colorBy ?? "",
          args.sizeBy ?? "",
          (args.decorationTables ?? []).join(","),
          args.matVersion ?? "",
          effectiveSeed,
        ]
      : ["embedding_scatter", "disabled"],
    queryFn: () =>
      apiFetch<EmbeddingScatterResponse>(
        PATHS.scatter(args!.ds, args!.featureTableId, args!.embeddingId),
        {
          query: {
            x: args!.x || undefined,
            y: args!.y || undefined,
            color: args!.colorBy || undefined,
            size: args!.sizeBy || undefined,
            dec: args!.decorationTables?.length
              ? args!.decorationTables.join(",")
              : undefined,
            mat_version:
              args!.matVersion === "live"
                ? "live"
                : args!.matVersion === null || args!.matVersion === undefined
                  ? undefined
                  : String(args!.matVersion),
            seed: effectiveSeed || undefined,
          },
        },
      ),
    enabled: !!args && !!args.ds && !!args.featureTableId && !!args.embeddingId,
    // Parquet content is pinned by URI; channel projections derived
    // from it are pinned by params; once fetched, no need to refetch.
    staleTime: Infinity,
    // Keep the previous scatter on screen while a new channel / axis /
    // seed binding fetches, instead of flashing to the "Loading…"
    // placeholder. The stale colors show briefly until the new data
    // lands — a smoother channel-switch than a hard reload.
    placeholderData: keepPreviousData,
  });
}

// ---- /cells (cell list rows) -----------------------------------------------

export interface CellListArgs {
  ds: string;
  featureTableId: string;
  matVersion: number | "live" | null;
  decorationTables?: string[];
  cells?: string | null;
  /** Explicit cell_id subset (e.g. from a universe-scatter lasso).
   *  ANDs with the `cells` filter expression server-side. Null or
   *  empty means no lasso constraint. */
  cellIds?: string[] | null;
  limit?: number;
  /** Connectivity seed root_id — when set, the response includes a
   *  ``seed`` column group (`seed_is_partner`, `seed_partner_dir`,
   *  `seed_n_syn_in/out`, etc.) projected from the seed's cached
   *  partners bundle. Drives the "Seed view" filter toggle on the
   *  explorer's PartnersTable. */
  seedRootId?: string | null;
}

/** Rows + column_groups for the explorer's cell-list table. Filter
 *  expression is server-side; client just renders + paginates. */
export function useCellList(args: CellListArgs | null) {
  return useQuery<FeatureTableCellsResponse>({
    queryKey: args
      ? [
          "feature_cells",
          args.ds,
          args.featureTableId,
          args.matVersion,
          (args.decorationTables ?? []).join(","),
          args.cells ?? "",
          (args.cellIds ?? []).join(","),
          args.limit ?? null,
          args.seedRootId ?? "",
        ]
      : ["feature_cells", "disabled"],
    queryFn: () =>
      // POST rather than GET — cell_ids can run into the tens of
      // thousands of ids on a large lasso, which overflows Node's
      // default 8KB request-header limit when it rides in a query
      // string. Body has no such limit.
      apiFetch<FeatureTableCellsResponse>(PATHS.cells(args!.ds, args!.featureTableId), {
        method: "POST",
        body: {
          mat_version:
            args!.matVersion === "live"
              ? "live"
              : args!.matVersion === null || args!.matVersion === undefined
                ? undefined
                : args!.matVersion,
          dec: args!.decorationTables?.length ? args!.decorationTables : undefined,
          cells: args!.cells || undefined,
          cell_ids: args!.cellIds?.length ? args!.cellIds : undefined,
          limit: args!.limit,
          seed: args!.seedRootId || undefined,
        },
      }),
    enabled: !!args && !!args.ds && !!args.featureTableId,
    // Parquet is immutable + decoration values are stable within a
    // mat_version; 5 min keeps the SPA responsive across explorer
    // navigation while still reflecting a manifest swap reasonably fast.
    staleTime: 5 * 60 * 1000,
  });
}

// ---- /column (single-column universe values) -------------------------------

export interface EmbeddingColumnArgs {
  ds: string;
  featureTableId: string;
  /** Resolved column name. Bare for feature-table parquet columns
   *  (server prefixes with `<ft>.` after `FeatureTableQuery.frame()`);
   *  dotted `<table>.<col>` for decoration columns and synthetic
   *  `nucleus.x/y/z`. */
  column: string;
  /** Decoration tables to attach. The server auto-extends this to
   *  include the column's table when the column is a decoration
   *  reference, so callers don't have to pre-compute it. */
  decorationTables?: string[];
  /** Required when the column lives in a decoration table or in
   *  synthetic nucleus space (those go through the resolver). */
  matVersion?: number | "live" | null;
  /** Connectivity seed root_id. Required when `column` is a `seed_*`
   *  column — the server joins the seed projection only when this is
   *  set. Ignored for non-seed columns. */
  seedRootId?: string | null;
}

/** Universe-aligned values for one column. Cached with `staleTime:
 *  Infinity` because the parquet content is pinned by URI and
 *  decoration snapshots are immutable at a mat_version — the response
 *  cannot change for a fixed (ft, column, decTables, mat_version)
 *  tuple. */
export function useEmbeddingColumn(args: EmbeddingColumnArgs | null) {
  return useQuery<EmbeddingColumnResponse>({
    queryKey: args
      ? [
          "embedding_column",
          args.ds,
          args.featureTableId,
          args.column,
          (args.decorationTables ?? []).join(","),
          args.matVersion ?? "",
          args.seedRootId ?? "",
        ]
      : ["embedding_column", "disabled"],
    queryFn: () =>
      apiFetch<EmbeddingColumnResponse>(
        PATHS.column(args!.ds, args!.featureTableId, args!.column),
        {
          query: {
            dec: args!.decorationTables?.length
              ? args!.decorationTables.join(",")
              : undefined,
            mat_version:
              args!.matVersion === "live"
                ? "live"
                : args!.matVersion === null || args!.matVersion === undefined
                  ? undefined
                  : String(args!.matVersion),
            seed: args!.seedRootId || undefined,
          },
        },
      ),
    enabled:
      !!args && !!args.ds && !!args.featureTableId && !!args.column,
    staleTime: Infinity,
  });
}

// ---- /column/<col>/histogram ----------------------------------------------

export interface ColumnHistogramArgs extends EmbeddingColumnArgs {
  /** Numeric bin count. Default 60. Ignored for categorical. */
  bins?: number;
  /** Bin edge spacing. ``linear`` (default) gives equal-width bins
   *  between min and max; ``log`` gives exponentially-spaced edges
   *  for heavy-tailed distributions. Server silently falls back to
   *  linear when the column contains non-positive values (response
   *  carries ``log_fallback: true``). Ignored for categorical. */
  binning?: "linear" | "log";
}

/** Tiny histogram summary of one column. Backed by the L2-cached
 *  ``dcv_column_histogram_cache`` on the server — warm hits round-trip
 *  in tens of milliseconds with a hundreds-of-bytes payload, so this
 *  is the right primitive for first-paint of any per-column
 *  distribution display.
 *
 *  The full ``useEmbeddingColumn`` is still needed when the consumer
 *  requires per-cell-id masks (e.g. the SelectionBuilder's cross-
 *  column AND intersection). They can be requested in parallel; the
 *  histogram lands first and paints the chart while the heavier
 *  column data streams in for the matching pass. */
export function useColumnHistogram(args: ColumnHistogramArgs | null) {
  return useQuery<ColumnHistogramResponse>({
    queryKey: args
      ? [
          "column_histogram",
          args.ds,
          args.featureTableId,
          args.column,
          (args.decorationTables ?? []).join(","),
          args.matVersion ?? "",
          args.bins ?? 60,
          args.binning ?? "linear",
          args.seedRootId ?? "",
        ]
      : ["column_histogram", "disabled"],
    queryFn: () =>
      apiFetch<ColumnHistogramResponse>(
        PATHS.columnHistogram(args!.ds, args!.featureTableId, args!.column),
        {
          query: {
            bins: String(args!.bins ?? 60),
            binning: args!.binning ?? "linear",
            dec: args!.decorationTables?.length
              ? args!.decorationTables.join(",")
              : undefined,
            mat_version:
              args!.matVersion === "live"
                ? "live"
                : args!.matVersion === null || args!.matVersion === undefined
                  ? undefined
                  : String(args!.matVersion),
            seed: args!.seedRootId || undefined,
          },
        },
      ),
    enabled:
      !!args && !!args.ds && !!args.featureTableId && !!args.column,
    staleTime: Infinity,
  });
}

// ---- /distance_to_set ------------------------------------------------------

/** Distance-to-set is a one-shot user action ("Compute distances" click)
 *  so this is a mutation rather than a query. Caching of identical
 *  inputs is left to the panel — it holds a small probe state and only
 *  re-fires when seed-bag / space / k_pca / reduction / features change. */
export function useDistanceToSetMutation() {
  return useMutation<DistanceToSetResponse, Error, DistanceToSetArgs>({
    mutationFn: (args) =>
      apiFetch<DistanceToSetResponse>(
        PATHS.distanceToSet(args.ds, args.featureTableId),
        {
          method: "POST",
          body: {
            cell_ids: args.cellIds,
            space: args.space,
            reduction: args.reduction,
            ...(args.embeddingId !== undefined
              ? { embedding_id: args.embeddingId }
              : {}),
            ...(args.variance !== undefined ? { variance: args.variance } : {}),
            ...(args.limit !== undefined ? { limit: args.limit } : {}),
            ...(args.featureColumns !== undefined
              ? { feature_columns: args.featureColumns }
              : {}),
          },
        },
      ),
  });
}

// ---- /resolve_roots --------------------------------------------------------

export interface ResolveRootsArgs {
  ds: string;
  featureTableId: string;
  cellIds: string[];
  matVersion: number | "live";
}

/** Batched cell_id -> root_id resolution. Used by the SelectionPane to
 *  prefetch resolutions for visible cells so cross-nav links land
 *  immediately rather than after a click-time round-trip. */
export function useResolveRoots(args: ResolveRootsArgs | null) {
  const queryKey: QueryKey = args
    ? [
        "embedding_resolve_roots",
        args.ds,
        args.featureTableId,
        args.matVersion,
        // Order matters — different orderings produce the same resolutions
        // but distinct cache entries; tradeoff is fine for v1 (each
        // SelectionPane section's order is stable per session).
        args.cellIds.join(","),
      ]
    : ["embedding_resolve_roots", "disabled"];
  return useQuery<ResolveRootsResponse>({
    queryKey,
    queryFn: () =>
      apiFetch<ResolveRootsResponse>(
        PATHS.resolveRoots(args!.ds, args!.featureTableId),
        {
          method: "POST",
          body: {
            cell_ids: args!.cellIds,
            mat_version: args!.matVersion,
          },
        },
      ),
    enabled: !!args && !!args.ds && !!args.featureTableId && args.cellIds.length > 0,
    // Resolutions are immutable at a frozen mat_version — cell_id ↔
    // root_id at a materialization can never change. Cache forever
    // client-side; the server's L2 GCS cache makes the cross-user /
    // cross-pod story symmetric. Live mode bypasses this hook via
    // FeatureExplorer skipping the call when mv === "live".
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

// ---- /find_cells -----------------------------------------------------------

export interface FindCellsArgs {
  ds: string;
  featureTableId: string;
  /** Root_ids the user typed into the search box. Strings end-to-end —
   *  chunkedgraph root_ids exceed JS Number precision (2^53). */
  rootIds: string[];
  matVersion: number | "live";
}

/** Two-step lookup behind the explorer's `<CellIdSearch>` component:
 *  chunkedgraph alignment at the request's mat_version timestamp, then
 *  nucleus reverse-resolve on the aligned root.
 *
 *  Mutation rather than query — search is a one-shot user action;
 *  results aren't cached across submissions because the input changes
 *  every time the user clicks the submit button. Partial failure is
 *  expected (paste-many always has a few stale ids past the lineage
 *  walk), so the caller groups results by `status` for the status row.
 */
export function useFindCellsMutation() {
  return useMutation<FindCellsResponse, Error, FindCellsArgs>({
    mutationFn: (args) =>
      apiFetch<FindCellsResponse>(PATHS.findCells(args.ds, args.featureTableId), {
        method: "POST",
        body: {
          root_ids: args.rootIds,
          mat_version: args.matVersion,
        },
      }),
  });
}

// ---- /seed_summary ---------------------------------------------------------

export interface SeedSummaryArgs {
  ds: string;
  featureTableId: string;
  matVersion: number | "live" | null;
  seedRootId: string;
}

/** Connectivity-seed partner counts restricted to the feature table.
 *  `n_in` / `n_out` count feature-table cells with any input / output
 *  contact with the seed (a reciprocal cell is in both); `n_partners`
 *  is the distinct partner count; `n_universe` is the feature table's
 *  total cell count. */
export interface SeedSummaryResponse {
  n_in: number;
  n_out: number;
  n_partners: number;
  n_universe: number;
}

/** Feature-table-scoped seed summary. Drives the Connectivity Seed
 *  widget's "ready" indicator: while it's pending the seed projection
 *  is still computing; on success the seed columns are warm and the
 *  widget shows how many of *this feature table's* cells are partners.
 *  Frozen mat_version → immutable, cached for the session. */
export function useSeedSummary(args: SeedSummaryArgs | null) {
  return useQuery<SeedSummaryResponse>({
    queryKey: args
      ? [
          "seed_summary",
          args.ds,
          args.featureTableId,
          args.matVersion ?? "",
          args.seedRootId,
        ]
      : ["seed_summary", "disabled"],
    queryFn: () =>
      apiFetch<SeedSummaryResponse>(
        PATHS.seedSummary(args!.ds, args!.featureTableId),
        {
          query: {
            seed: args!.seedRootId,
            mat_version:
              args!.matVersion === "live" || args!.matVersion == null
                ? undefined
                : String(args!.matVersion),
          },
        },
      ),
    enabled:
      !!args &&
      !!args.ds &&
      !!args.featureTableId &&
      !!args.seedRootId &&
      args.matVersion !== "live" &&
      args.matVersion != null,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
