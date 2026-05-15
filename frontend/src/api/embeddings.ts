// Feature Explorer TanStack Query hooks.
//
// Slim foundation surface — only what the refactored explorer will need:
// the catalog list, kNN, and the cell_id->root_id resolver. The bulk
// data-fetching hooks (useEmbeddingPoints, useEmbeddingColumn,
// useDecorationCategoricalColumns) were removed when the UI flipped
// onto the shared toolkit — `/plots` covers plotting and a new
// `/feature_tables/<ft>/rows` endpoint will cover the table.

import { useMutation, useQuery, type QueryKey } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  EmbeddingKnnResponse,
  EmbeddingListResponse,
  EmbeddingScatterResponse,
  FeatureTableCellsResponse,
  ResolveRootsResponse,
} from "./types";

const PATHS = {
  list: (ds: string) => `/api/v1/datastacks/${ds}/feature_tables`,
  scatter: (ds: string, ftId: string, embId: string) =>
    `/api/v1/datastacks/${ds}/feature_tables/${ftId}/embeddings/${embId}/scatter`,
  cells: (ds: string, ftId: string) =>
    `/api/v1/datastacks/${ds}/feature_tables/${ftId}/cells`,
  knn: (ds: string, ftId: string) =>
    `/api/v1/datastacks/${ds}/feature_tables/${ftId}/knn`,
  resolveRoots: (ds: string, ftId: string) =>
    `/api/v1/datastacks/${ds}/feature_tables/${ftId}/resolve_roots`,
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
  /** Optional size channel column (numeric only). */
  sizeBy?: string | null;
  /** Attached decoration tables — required when any channel references
   *  a `<table>.<col>` not on the feature_table itself. */
  decorationTables?: string[];
  /** mat_version — required when any channel references a decoration
   *  column (drives the cell_id → root_id resolver). */
  matVersion?: number | "live" | null;
}

/** Universe payload for the scatter component. Parquet-pinned + cached
 *  immutably; channel bindings cut a new cache entry per binding set. */
export function useEmbeddingScatter(args: EmbeddingScatterArgs | null) {
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
          },
        },
      ),
    enabled: !!args && !!args.ds && !!args.featureTableId && !!args.embeddingId,
    // Parquet content is pinned by URI; channel projections derived
    // from it are pinned by params; once fetched, no need to refetch.
    staleTime: Infinity,
  });
}

// ---- /cells (cell list rows) -----------------------------------------------

export interface CellListArgs {
  ds: string;
  featureTableId: string;
  matVersion: number | "live" | null;
  decorationTables?: string[];
  cells?: string | null;
  limit?: number;
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
          args.limit ?? null,
        ]
      : ["feature_cells", "disabled"],
    queryFn: () =>
      apiFetch<FeatureTableCellsResponse>(PATHS.cells(args!.ds, args!.featureTableId), {
        query: {
          mat_version:
            args!.matVersion === "live"
              ? "live"
              : args!.matVersion === null || args!.matVersion === undefined
                ? undefined
                : String(args!.matVersion),
          dec: args!.decorationTables?.length
            ? args!.decorationTables.join(",")
            : undefined,
          cells: args!.cells || undefined,
          limit: args!.limit ? String(args!.limit) : undefined,
        },
      }),
    enabled: !!args && !!args.ds && !!args.featureTableId,
    // Parquet is immutable + decoration values are stable within a
    // mat_version; 5 min keeps the SPA responsive across explorer
    // navigation while still reflecting a manifest swap reasonably fast.
    staleTime: 5 * 60 * 1000,
  });
}

// ---- /knn ------------------------------------------------------------------

export interface EmbeddingKnnArgs {
  ds: string;
  /** Feature table id — kNN is data-level, not view-level, so it's keyed
   *  on the table rather than any one embedding. Multiple embeddings on
   *  one table share the kNN index. */
  featureTableId: string;
  /** Provide either `cellId` (preferred — stable across edits) or
   *  `rootId` + `matVersion` (server reverse-resolves to cell_id). */
  cellId?: string | number;
  rootId?: string | number;
  matVersion?: number | "live" | null;
  k?: number;
  featureColumns?: string[];
}

/** kNN is a one-shot user action ("Find neighbors" click), so a mutation
 *  rather than a query — fires on demand, no auto-refetch on focus etc. */
export function useEmbeddingKnnMutation() {
  return useMutation<EmbeddingKnnResponse, Error, EmbeddingKnnArgs>({
    mutationFn: (args) =>
      apiFetch<EmbeddingKnnResponse>(PATHS.knn(args.ds, args.featureTableId), {
        method: "POST",
        body: {
          ...(args.cellId !== undefined ? { cell_id: args.cellId } : {}),
          ...(args.rootId !== undefined ? { root_id: args.rootId } : {}),
          ...(args.matVersion !== undefined && args.matVersion !== null
            ? { mat_version: args.matVersion }
            : {}),
          ...(args.k !== undefined ? { k: args.k } : {}),
          ...(args.featureColumns !== undefined
            ? { feature_columns: args.featureColumns }
            : {}),
        },
      }),
  });
}

// ---- /resolve_roots --------------------------------------------------------

export interface ResolveRootsArgs {
  ds: string;
  featureTableId: string;
  cellIds: Array<string | number>;
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
    // Resolutions are stable within a mat_version (cell_id -> root_id is
    // frozen at a materialization); cache for an hour.
    staleTime: 60 * 60 * 1000,
  });
}
