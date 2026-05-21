/**
 * Browser-local personal recipes with optional server-side persistence.
 *
 * localStorage is the source of truth for "what the user sees right now"
 * — the synchronous `listForDs` API renders the sidebar and landing page
 * during the same React tick as the rest of the UI, with no loading
 * state. When `/api/v1/me/recipes/config` reports the server-side store
 * is enabled, this module also write-throughs to GCS via the
 * `/api/v1/me/recipes/...` endpoints, so recipes follow the user across
 * browsers and machines.
 *
 * Storage shape (single key `cdv:v1:recipes`):
 *
 *     { version: 1, byDs: { "<datastack>": [Recipe, ...] } }
 *
 * Server sync state machine:
 *
 *     pending   → on module load. save/remove queue server ops.
 *     enabled   → /me/recipes/config returned enabled:true. save/remove
 *                 fire server ops directly; failures requeue.
 *     disabled  → config returned enabled:false (dev_bypass / no_bucket)
 *                 or the probe failed. save/remove are localStorage-only.
 *
 * Mutations dispatch a `cdv:personal-recipes-changed` window event so
 * sibling components (the SidebarRecipes widget, LandingPage) re-read
 * without a shared state store. The `storage` event from other tabs
 * also re-dispatches this event so cross-tab updates are immediate.
 *
 * Migration safety: the `cdv:v1:userdata_migrated:<ds>` flag prevents
 * "I deleted everything on another machine, then came back here where
 * local still has them, and they got re-uploaded." Once set (after a
 * successful first reconcile), an empty server list NEVER triggers an
 * upload of stale local state — the server is authoritative.
 */
import { dump as yamlDump, JSON_SCHEMA, load as yamlLoad } from "js-yaml";
import type { Recipe, RecipeKind } from "../api/types";
import { migrateStorageKey } from "../hooks/storageMigration";
import { ALL_KINDS, adapterForRecipe } from "./adapters/registry";

const STORAGE_KEY = "cdv:v1:recipes";
const CHANGE_EVENT = "cdv:personal-recipes-changed";
const MIG_KEY_PREFIX = "cdv:v1:userdata_migrated:";

// One-shot forward-migration from the unversioned legacy key. Runs at
// module load (idempotent) so the `readAll` call below sees v1 data even
// on a user's first session after the version bump.
migrateStorageKey("cdv:recipes", STORAGE_KEY, localStorage);

interface StoredRecipes {
  version: 1;
  byDs: Record<string, Recipe[]>;
}

const EMPTY: StoredRecipes = { version: 1, byDs: {} };

function readAll(): StoredRecipes {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, byDs: {} };
    const obj = JSON.parse(raw) as Partial<StoredRecipes>;
    if (obj && typeof obj === "object" && obj.version === 1 && obj.byDs && typeof obj.byDs === "object") {
      return { version: 1, byDs: obj.byDs as Record<string, Recipe[]> };
    }
    return { version: 1, byDs: {} };
  } catch {
    // Quota exceeded, private mode, malformed JSON — treat as empty.
    return { version: 1, byDs: {} };
  }
}

function writeAll(data: StoredRecipes): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  } catch {
    // Silently degrade — we don't have a UX-affordance for storage
    // failures and they're rare. Caller's optimistic UI update will
    // simply not be reflected on next mount.
  }
}

export function listForDs(ds: string): Recipe[] {
  // Drop anything in localStorage that doesn't carry a kind the
  // client knows about. Defensive against a stale browser bundle
  // reading newer-server data with a future kind, AND against legacy
  // pre-discriminator items that may still be sitting in localStorage
  // from before the migration.
  const known = new Set<string>(ALL_KINDS);
  return (readAll().byDs[ds] ?? []).filter((r) =>
    typeof r.kind === "string" && known.has(r.kind),
  );
}

/** Like `listForDs` but filtered to a specific set of kinds — used by
 *  the route-aware sidebar (which only wants kinds the current view
 *  knows how to apply). Pass `null` or omit to get every known kind
 *  (same as `listForDs`). */
export function listForDsAndKind(
  ds: string,
  kinds: Set<RecipeKind> | null = null,
): Recipe[] {
  const all = listForDs(ds);
  if (!kinds || kinds.size === 0) return all;
  return all.filter((r) => kinds.has(r.kind));
}

// Server-reported count of stored-but-unreadable recipes per ds. The
// server skip-logs items without a recognized `kind` and returns the
// count; the SPA renders a banner so the user understands why some
// previously-saved items aren't visible. Keyed by ds; updated by the
// reconcile path and exposed via `getInvalidCount`.
const _invalidCountByDs: Map<string, number> = new Map();

export function getInvalidCount(ds: string): number {
  return _invalidCountByDs.get(ds) ?? 0;
}

export function save(ds: string, recipe: Recipe): void {
  const all = readAll();
  const list = all.byDs[ds] ?? [];
  // De-dupe by id — `save` doubles as upsert. Personal recipe ids are
  // generated to be unique, but defensive against an odd retry flow.
  const next = [...list.filter((r) => r.id !== recipe.id), recipe];
  writeAll({ version: 1, byDs: { ...all.byDs, [ds]: next } });
  scheduleServerPut(ds, recipe);
}

export function remove(ds: string, id: string): void {
  const all = readAll();
  const list = all.byDs[ds] ?? [];
  const next = list.filter((r) => r.id !== id);
  if (next.length === list.length) {
    // Nothing to remove locally — also skip the server call. Avoids a
    // spurious DELETE for ids the user never had.
    return;
  }
  writeAll({ version: 1, byDs: { ...all.byDs, [ds]: next } });
  scheduleServerDelete(ds, id);
}

export function exists(ds: string, id: string): boolean {
  return listForDs(ds).some((r) => r.id === id);
}

/** Generate a fresh personal-recipe id. The `personal-` prefix lets the
 *  merged sidebar list discriminate operator vs personal recipes without a
 *  separate flag, and guarantees no collision with operator ids (which
 *  come from YAML keys and never start with `personal-`). The shape also
 *  matches the backend's `_RECIPE_ID_PATTERN` regex (`^personal-[a-z0-9-]{4,64}$`). */
export function newPersonalId(): string {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 6);
  return `personal-${ts}-${rnd}`;
}

export function isPersonalId(id: string): boolean {
  return id.startsWith("personal-");
}

/** Subscribe to mutation events. Returns an unsubscribe function. */
export function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

// Re-export the empty constant for callers that want a stable reference.
export const EMPTY_STORE: Readonly<StoredRecipes> = EMPTY;

// ---------- Soft-delete with undo window ----------------------------------

/**
 * Soft-delete model: `softRemove` marks a recipe as pending-deletion in
 * an in-memory map and starts a `UNDO_WINDOW_MS` timer. The recipe STAYS
 * in localStorage during the window — consumers (LandingPage) join the
 * recipe list with `isPendingDeletion(ds, id)` so the card slot renders
 * as an inline "Deleted - Undo" placeholder without losing grid
 * position. The real `remove()` (localStorage + server DELETE) fires
 * only when the timer expires.
 *
 * `restorePending` cancels the timer + clears the marker. The recipe
 * keeps its existing place in storage.
 *
 * Tab close during the undo window abandons the deletion (the recipe
 * survives) — different from a Gmail-style "deleted then undo" but
 * safer for users who walk away mid-confirmation.
 */

/** Duration of the undo window. ~6s is the Material/Gmail convention —
 *  long enough to read + react, short enough that the toast doesn't
 *  linger uncomfortably. */
export const UNDO_WINDOW_MS = 6000;

export interface PendingDeletion {
  ds: string;
  recipe: Recipe;
  /** ms-since-epoch when the timer fires and the toast self-dismisses.
   *  Consumers use this to render a countdown bar. */
  expiresAt: number;
}

const PENDING_EVENT = "cdv:pending-deletions-changed";

interface PendingEntry extends PendingDeletion {
  timer: ReturnType<typeof setTimeout>;
}

const _pending: Map<string, PendingEntry> = new Map();

function pendingKey(ds: string, id: string): string {
  // U+0000 as separator — neither valid in a datastack name nor in a
  // recipe id, so collision-free.
  return `${ds} ${id}`;
}

function notifyPending(): void {
  window.dispatchEvent(new CustomEvent(PENDING_EVENT));
}

/** Mark a recipe for deletion; commit on timer expiry. The recipe
 *  remains in storage so consumers can render an inline "Undo"
 *  placeholder in the card's existing grid slot. No-op if the recipe
 *  doesn't exist locally. */
export function softRemove(ds: string, id: string): void {
  const all = readAll();
  const list = all.byDs[ds] ?? [];
  const target = list.find((r) => r.id === id);
  if (!target) return;

  // Replace any prior pending for the same key — clear the old timer
  // so its commit doesn't fire after a restore.
  const key = pendingKey(ds, id);
  const prev = _pending.get(key);
  if (prev) clearTimeout(prev.timer);

  const expiresAt = Date.now() + UNDO_WINDOW_MS;
  const timer = setTimeout(() => {
    _pending.delete(key);
    // Commit the deletion now — localStorage + server DELETE via the
    // existing path. writeAll's CHANGE_EVENT fires, then we fire
    // PENDING_EVENT so consumers re-render once with both signals.
    remove(ds, id);
    notifyPending();
  }, UNDO_WINDOW_MS);
  _pending.set(key, { ds, recipe: target, expiresAt, timer });
  notifyPending();
}

/** Cancel a pending deletion. The recipe stays in storage with its
 *  existing position; the inline placeholder reverts to a normal card. */
export function restorePending(ds: string, id: string): void {
  const key = pendingKey(ds, id);
  const entry = _pending.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  _pending.delete(key);
  notifyPending();
}

/** Read-only check for "is this id currently in the undo window?". */
export function isPendingDeletion(ds: string, id: string): boolean {
  return _pending.has(pendingKey(ds, id));
}

/** Snapshot of a specific pending deletion (for the inline placeholder
 *  to read expiresAt + the recipe title). Null when not pending. */
export function getPendingDeletion(
  ds: string,
  id: string,
): PendingDeletion | null {
  const entry = _pending.get(pendingKey(ds, id));
  if (!entry) return null;
  return { ds: entry.ds, recipe: entry.recipe, expiresAt: entry.expiresAt };
}

/** Subscribe to pending-deletion add/restore/expire events. */
export function subscribePendingDeletions(listener: () => void): () => void {
  window.addEventListener(PENDING_EVENT, listener);
  return () => window.removeEventListener(PENDING_EVENT, listener);
}

// ---------- Server sync ---------------------------------------------------

type ServerMode = "pending" | "enabled" | "disabled";
let _serverMode: ServerMode = "pending";

interface ServerConfig {
  enabled: boolean;
  reason?: "dev_bypass" | "no_bucket";
  /** Server's preferred body-schema version. Today always 1. The SPA
   *  reads this so a future v2 server can advertise its preferred shape
   *  to a v1 client without an endpoint-version bump. */
  schema_version?: number;
  /** Versions the server can read AND write on PUT. The SPA may refuse
   *  to send a body version not in this set (today: just [1]). */
  supported_schema_versions?: number[];
}

/** Body-schema version this client emits on PUT. Server stamps it if we
 *  forget; we stamp it explicitly so every PUT carries an unambiguous
 *  version and a future server can honor it without inferring. Bump only
 *  when the SPA's Recipe shape actually changes. */
const CLIENT_SCHEMA_VERSION = 1;

type RetryOp =
  | { type: "put"; ds: string; recipeId: string; body: string }
  | { type: "delete"; ds: string; recipeId: string };

// Server ops queued during "pending" or after a transient failure.
// Drained on bootstrap-completion and on window focus.
const _retryQueue: RetryOp[] = [];

/** Internal status read for tests / future "synced" indicator. */
export function _serverSyncMode(): ServerMode {
  return _serverMode;
}

function recipeToYamlBody(recipe: Recipe): string {
  // Per-kind adapters control the on-the-wire YAML shape:
  // connectivity uses the hand-rolled emitter for operator-YAML
  // paste fidelity; explorer uses js-yaml because its nested shape
  // is deeper than the emitter handles. The adapter wraps the
  // recipe under a top-level `recipes:` list to match operator
  // config; for a PUT we want just the inner object, so we parse
  // the adapter's output and re-dump the first item.
  //
  // Stamp `version` if missing so the wire payload is unambiguous.
  const versioned: Recipe =
    recipe.version === undefined
      ? { ...recipe, version: CLIENT_SCHEMA_VERSION }
      : recipe;
  const adapter = adapterForRecipe(versioned);
  // Both adapters emit `recipes:\n  - <item>\n…` — unwrap to send
  // just the item, since the PUT endpoint takes a single recipe
  // body, not a list.
  const wrapped = adapter.toYaml(versioned);
  const parsed = yamlLoad(wrapped, { schema: JSON_SCHEMA }) as
    | { recipes?: unknown[] }
    | undefined;
  const item = parsed?.recipes?.[0];
  if (!item) {
    // Adapter contract violation — fall back to a flat dump rather
    // than throwing. Server will validate either way.
    return wrapped;
  }
  // Re-emit just the item using js-yaml so the on-the-wire format
  // is canonical regardless of which adapter produced it.
  return yamlDump(item, { schema: JSON_SCHEMA, sortKeys: false });
}

function scheduleServerPut(ds: string, recipe: Recipe): void {
  if (_serverMode === "disabled") return;
  const body = recipeToYamlBody(recipe);
  if (_serverMode === "pending") {
    _retryQueue.push({ type: "put", ds, recipeId: recipe.id, body });
    return;
  }
  // enabled — fire and re-queue on failure.
  void putRecipeToServer(ds, recipe.id, body);
}

function scheduleServerDelete(ds: string, id: string): void {
  if (_serverMode === "disabled") return;
  if (_serverMode === "pending") {
    _retryQueue.push({ type: "delete", ds, recipeId: id });
    return;
  }
  void deleteRecipeOnServer(ds, id);
}

async function putRecipeToServer(ds: string, id: string, body: string): Promise<void> {
  try {
    const resp = await fetch(`/api/v1/me/recipes/${encodeURIComponent(ds)}/${encodeURIComponent(id)}`, {
      method: "PUT",
      credentials: "include",
      headers: { "Content-Type": "application/yaml" },
      body,
    });
    if (!resp.ok) {
      // 4xx errors (e.g., 413 size cap, 400 invalid) are not retryable —
      // requeueing would loop forever. Log loudly and drop.
      if (resp.status >= 400 && resp.status < 500) {
        console.warn(`[recipes] server PUT rejected (${resp.status}); not retrying`);
        return;
      }
      throw new Error(`PUT ${resp.status}`);
    }
  } catch (err) {
    console.warn("[recipes] server PUT failed; queued for retry", err);
    _retryQueue.push({ type: "put", ds, recipeId: id, body });
  }
}

async function deleteRecipeOnServer(ds: string, id: string): Promise<void> {
  try {
    const resp = await fetch(`/api/v1/me/recipes/${encodeURIComponent(ds)}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!resp.ok) {
      if (resp.status >= 400 && resp.status < 500) {
        console.warn(`[recipes] server DELETE rejected (${resp.status}); not retrying`);
        return;
      }
      throw new Error(`DELETE ${resp.status}`);
    }
  } catch (err) {
    console.warn("[recipes] server DELETE failed; queued for retry", err);
    _retryQueue.push({ type: "delete", ds, recipeId: id });
  }
}

async function fetchServerConfig(): Promise<ServerConfig> {
  const resp = await fetch("/api/v1/me/recipes/config", { credentials: "include" });
  if (!resp.ok) throw new Error(`config ${resp.status}`);
  return (await resp.json()) as ServerConfig;
}

interface ServerListResult {
  recipes: Recipe[];
  invalidCount: number;
}

async function fetchServerList(ds: string): Promise<ServerListResult> {
  const resp = await fetch(`/api/v1/me/recipes/${encodeURIComponent(ds)}`, {
    credentials: "include",
    headers: { Accept: "application/yaml" },
  });
  if (!resp.ok) throw new Error(`list ${resp.status}`);
  const text = await resp.text();
  if (!text) return { recipes: [], invalidCount: 0 };
  let parsed: unknown;
  try {
    parsed = yamlLoad(text, { schema: JSON_SCHEMA });
  } catch (err) {
    console.warn("[recipes] failed to parse server list YAML", err);
    return { recipes: [], invalidCount: 0 };
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { recipes?: unknown }).recipes)
  ) {
    const raw = (parsed as { recipes: unknown[]; invalid_count?: number }).recipes;
    const invalidCount = Number((parsed as { invalid_count?: number }).invalid_count) || 0;
    // Drop items with unknown kinds — defensive against a newer
    // server shipping a kind this SPA hasn't been built for. The
    // server already filtered no-kind items (and counted them in
    // invalid_count); this is a second pass for kinds the SPA itself
    // doesn't know.
    const known = new Set<string>(ALL_KINDS);
    const recipes = raw.filter(
      (r): r is Recipe =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as Recipe).kind === "string" &&
        known.has((r as Recipe).kind),
    );
    return { recipes, invalidCount };
  }
  return { recipes: [], invalidCount: 0 };
}

async function flushRetryQueue(): Promise<void> {
  if (_serverMode !== "enabled" || _retryQueue.length === 0) return;
  // Drain to a local snapshot so concurrent enqueues during the flush
  // don't make this loop forever; the next focus event picks them up.
  const ops = _retryQueue.splice(0, _retryQueue.length);
  for (const op of ops) {
    if (op.type === "put") {
      await putRecipeToServer(op.ds, op.recipeId, op.body);
    } else {
      await deleteRecipeOnServer(op.ds, op.recipeId);
    }
  }
}

// Server is the migration boundary. SPA sends what it has (stamped with
// CLIENT_SCHEMA_VERSION); server validates against SUPPORTED_SCHEMA_VERSIONS
// and stores. On read, the SPA receives whatever shape the server returned
// — js-yaml load preserves all fields, so a newer server's extra fields
// survive the round-trip through localStorage and back to GCS as long as
// no UI path constructs a fresh Recipe object from individual fields and
// re-saves it (today, recipes are created from current-overlay state, not
// edited; an "edit existing recipe" UI would need to preserve unknowns
// explicitly).
async function reconcileDs(ds: string): Promise<void> {
  let serverResult: ServerListResult;
  try {
    serverResult = await fetchServerList(ds);
  } catch (err) {
    console.warn(`[recipes] reconcile ${ds} failed`, err);
    return;
  }

  const all = readAll();
  // localList feeds first-server-visit migration. Only the items
  // with a known kind are eligible to upload — legacy unkinded
  // items in localStorage stay there but never get pushed.
  const localList = (all.byDs[ds] ?? []).filter(
    (r) => typeof r.kind === "string" && (ALL_KINDS as readonly string[]).includes(r.kind),
  );
  const migKey = `${MIG_KEY_PREFIX}${ds}`;
  const migrated = localStorage.getItem(migKey) === "1";

  if (serverResult.recipes.length === 0 && localList.length > 0 && !migrated) {
    // First-server-visit migration: push local up. Once any server
    // recipe exists OR the migrated flag is set, an empty server list
    // means "user deleted everything on another machine" — never
    // re-upload from local.
    await Promise.allSettled(
      localList.map((r) => putRecipeToServer(ds, r.id, recipeToYamlBody(r))),
    );
    localStorage.setItem(migKey, "1");
    try {
      serverResult = await fetchServerList(ds);
    } catch {
      // Stale serverResult; the next reconcile will catch up.
    }
  } else if (!migrated) {
    // Server has data already — mark migrated so subsequent reconciles
    // don't re-upload after a server-side delete-everything.
    localStorage.setItem(migKey, "1");
  }

  // Capture invalid-count so the banner can render. Stored separately
  // from the recipe list so subscribers don't have to thread it through
  // every consumer.
  _invalidCountByDs.set(ds, serverResult.invalidCount);

  // Server is authoritative. Replace local with server contents.
  writeAll({ version: 1, byDs: { ...readAll().byDs, [ds]: serverResult.recipes } });
}

async function bootstrapServerSync(): Promise<void> {
  let cfg: ServerConfig;
  try {
    cfg = await fetchServerConfig();
  } catch (err) {
    console.warn("[recipes] config probe failed; localStorage-only mode", err);
    _serverMode = "disabled";
    return;
  }
  if (!cfg.enabled) {
    _serverMode = "disabled";
    return;
  }
  _serverMode = "enabled";

  // Flush any saves that landed during "pending" BEFORE reconcile so
  // the subsequent GET sees the post-flush server state and doesn't
  // overwrite freshly-saved-but-unsynced recipes in the user's local
  // view.
  await flushRetryQueue();

  // Reconcile every known datastack + the active one from the URL.
  const all = readAll();
  const known = new Set(Object.keys(all.byDs));
  for (const ds of known) {
    await reconcileDs(ds);
  }
  try {
    const url = new URL(window.location.href);
    const activeDs = url.searchParams.get("ds");
    if (activeDs && !known.has(activeDs)) {
      await reconcileDs(activeDs);
    }
  } catch {
    // window.location parsing failure is ignorable here.
  }
}

// ---------- Cross-tab + retry triggers ------------------------------------

if (typeof window !== "undefined") {
  // Cross-tab: when another tab writes recipes to localStorage, this tab's
  // sidebar/landing should re-render. The `storage` event only fires in
  // OTHER tabs (not the one that wrote), so this is a free way to keep
  // multi-tab in sync without polling.
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) {
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
    }
  });
  // Retry queue flush on tab focus — cheap recovery from transient
  // network failures during a save/remove. Also covers the case where
  // the server was down at module load and came back later.
  window.addEventListener("focus", () => {
    void flushRetryQueue();
  });
  // Kick off async server sync. Don't await — module exports must stay
  // synchronous so consumers can render from localStorage immediately.
  void bootstrapServerSync();
}
