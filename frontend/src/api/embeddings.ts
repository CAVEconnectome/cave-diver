// Feature Explorer TanStack Query hooks.
//
// Mirrors the convention in `queries.ts` — keyed queries with explicit args
// objects, `enabled` gated on required keys, retries off (the global default;
// we don't want a 500 to thrash CAVE through an automatic retry storm).
//
// Hooks split by endpoint so cache invalidation is granular: changing
// `?color_by=` only re-fetches `/points`, not the catalog list.

import { useMutation, useQueries, useQuery, type QueryKey } from "@tanstack/react-query";
import { apiFetch } from "./client";
import type {
  EmbeddingColumnResponse,
  EmbeddingKnnResponse,
  EmbeddingListResponse,
  EmbeddingPointsResponse,
  ResolveRootsResponse,
  TableUniqueValuesResponse,
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
  /** Override the manifest's axis defaults. Bare name = parquet column,
   *  `table.column` = decoration. Null/undefined → backend uses the
   *  manifest's `spec.axes[0]` / `spec.axes[1]`. */
  xColumn?: string | null;
  yColumn?: string | null;
  /** Color (hue) channel. Same shape; null → manifest default_color_by;
   *  empty string → explicitly no color (the URL state distinguishes via
   *  param presence). */
  colorBy?: string | null;
  /** Size channel. Server enforces numeric-only. Null = uniform size. */
  sizeBy?: string | null;
  /** Attached decoration tables. Required when any channel references a
   *  `table.column` column. */
  decorationTables?: string[];
  /** Materialization version. Required when any channel is decoration-
   *  sourced; threaded through the queryKey unconditionally so a mv flip
   *  always invalidates. */
  matVersion?: number | "live" | null;
}

export function useEmbeddingPoints(args: EmbeddingPointsArgs | null) {
  const queryKey: QueryKey = args
    ? [
        "embedding_points",
        args.ds,
        args.embeddingId,
        args.xColumn ?? "",
        args.yColumn ?? "",
        args.colorBy ?? "",
        args.sizeBy ?? "",
        (args.decorationTables ?? []).join(","),
        args.matVersion ?? "",
      ]
    : ["embedding_points", "disabled"];
  return useQuery<EmbeddingPointsResponse>({
    queryKey,
    queryFn: () =>
      apiFetch<EmbeddingPointsResponse>(PATHS.points(args!.ds, args!.embeddingId), {
        query: {
          x: args!.xColumn ?? undefined,
          y: args!.yColumn ?? undefined,
          color_by: args!.colorBy ?? undefined,
          size: args!.sizeBy ?? undefined,
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

// ---- Decoration column discovery ------------------------------------------

export interface DecorationColumnEntry {
  table: string;
  column: string;
  /** v1 only surfaces categorical columns (cell types, statuses) because the
   *  table-values endpoint exposes distinct values per categorical column;
   *  numeric decoration columns would need a separate schema endpoint. */
  kind: "categorical";
}

/**
 * Discover categorical column names across a set of attached decoration
 * tables. Drives the explorer's ColorByPicker and FeatureFilters menus.
 *
 * Implemented via `useQueries` so each table's
 * `/tables/<name>/values` call runs in parallel and re-renders the parent
 * once all settle. Failed/pending tables contribute no entries — silent
 * because a fresh-from-CAVE table can take a second or two to populate and
 * the user shouldn't see a flapping error state in the meantime.
 */
export function useDecorationCategoricalColumns(
  ds: string | null,
  matVersion: number | "live" | null,
  tables: string[],
): { columns: DecorationColumnEntry[]; isPending: boolean } {
  const results = useQueries({
    queries: tables.map((table) => ({
      queryKey: ["table_unique_values", ds, table, matVersion],
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
    })),
  });

  const columns: DecorationColumnEntry[] = [];
  let isPending = false;
  results.forEach((r, i) => {
    if (r.isPending) isPending = true;
    if (!r.data) return;
    for (const col of Object.keys(r.data.values)) {
      columns.push({ table: tables[i], column: col, kind: "categorical" });
    }
  });
  return { columns, isPending };
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
