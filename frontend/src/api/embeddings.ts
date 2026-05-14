// Feature Explorer TanStack Query hooks.
//
// Mirrors the convention in `queries.ts` — keyed queries with explicit args
// objects, `enabled` gated on required keys, retries off (the global default;
// we don't want a 500 to thrash CAVE through an automatic retry storm).
//
// Hooks split by endpoint so cache invalidation is granular: changing
// `?color_by=` only re-fetches `/points`, not the catalog list.

import { useMutation, useQuery, type QueryKey } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  EmbeddingColumnResponse,
  EmbeddingKnnResponse,
  EmbeddingListResponse,
  EmbeddingPointsResponse,
  ResolveRootsResponse,
} from "./types";

const PATHS = {
  list: (ds: string) => `/api/v1/datastacks/${ds}/embeddings`,
  points: (ds: string, id: string) =>
    `/api/v1/datastacks/${ds}/embeddings/${id}/points`,
  column: (ds: string, id: string, column: string) =>
    `/api/v1/datastacks/${ds}/embeddings/${id}/column/${encodeURI(column)}`,
  knn: (ds: string, id: string) =>
    `/api/v1/datastacks/${ds}/embeddings/${id}/knn`,
  resolveRoots: (ds: string, id: string) =>
    `/api/v1/datastacks/${ds}/embeddings/${id}/resolve_roots`,
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

// ---- /points ---------------------------------------------------------------

export interface EmbeddingPointsArgs {
  ds: string;
  embeddingId: string;
  /** Color-by column. Bare name = parquet; `table.column` = decoration. */
  colorBy?: string | null;
  /** Attached decoration tables. Required when `colorBy` is `table.column`. */
  decorationTables?: string[];
  /** Materialization version. Required for decoration colors; ignored for
   *  parquet-native colors but threaded through the queryKey so a `mv`
   *  flip still re-fetches (cleaner than branching the key shape on
   *  whether the color is decoration-sourced). */
  matVersion?: number | "live" | null;
}

export function useEmbeddingPoints(args: EmbeddingPointsArgs | null) {
  const queryKey: QueryKey = args
    ? [
        "embedding_points",
        args.ds,
        args.embeddingId,
        args.colorBy ?? "",
        (args.decorationTables ?? []).join(","),
        args.matVersion ?? "",
      ]
    : ["embedding_points", "disabled"];
  return useQuery<EmbeddingPointsResponse>({
    queryKey,
    queryFn: () =>
      apiFetch<EmbeddingPointsResponse>(PATHS.points(args!.ds, args!.embeddingId), {
        query: {
          color_by: args!.colorBy ?? undefined,
          dec: args!.decorationTables?.length
            ? args!.decorationTables.join(",")
            : undefined,
          mv: args!.matVersion ?? undefined,
        },
      }),
    enabled: !!args && !!args.ds && !!args.embeddingId,
    staleTime: 5 * 60 * 1000,
  });
}

// ---- /column ---------------------------------------------------------------

export interface EmbeddingColumnArgs {
  ds: string;
  embeddingId: string;
  /** Column name. Bare = parquet; `table.column` = decoration. */
  column: string;
  decorationTables?: string[];
  matVersion?: number | "live" | null;
}

export function useEmbeddingColumn(args: EmbeddingColumnArgs | null) {
  const queryKey: QueryKey = args
    ? [
        "embedding_column",
        args.ds,
        args.embeddingId,
        args.column,
        (args.decorationTables ?? []).join(","),
        args.matVersion ?? "",
      ]
    : ["embedding_column", "disabled"];
  return useQuery<EmbeddingColumnResponse>({
    queryKey,
    queryFn: () =>
      apiFetch<EmbeddingColumnResponse>(
        PATHS.column(args!.ds, args!.embeddingId, args!.column),
        {
          query: {
            dec: args!.decorationTables?.length
              ? args!.decorationTables.join(",")
              : undefined,
            mv: args!.matVersion ?? undefined,
          },
        },
      ),
    enabled: !!args && !!args.ds && !!args.embeddingId && !!args.column,
    staleTime: 5 * 60 * 1000,
  });
}

// ---- /knn ------------------------------------------------------------------

export interface EmbeddingKnnArgs {
  ds: string;
  embeddingId: string;
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
      apiFetch<EmbeddingKnnResponse>(PATHS.knn(args.ds, args.embeddingId), {
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
  embeddingId: string;
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
        args.embeddingId,
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
        PATHS.resolveRoots(args!.ds, args!.embeddingId),
        {
          method: "POST",
          body: {
            cell_ids: args!.cellIds,
            mat_version: args!.matVersion,
          },
        },
      ),
    enabled: !!args && !!args.ds && !!args.embeddingId && args.cellIds.length > 0,
    // Resolutions are stable within a mat_version (cell_id -> root_id is
    // frozen at a materialization); cache for an hour.
    staleTime: 60 * 60 * 1000,
  });
}
