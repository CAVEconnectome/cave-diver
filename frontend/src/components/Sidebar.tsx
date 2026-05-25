import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  useDatastackInfo,
  useDatastacks,
  useTours,
  useVersions,
} from "../api/queries";
import type { Recipe, RecipeKind } from "../api/types";
import { useNglLink } from "../hooks/useNglLink";
import { parseMatVersion, useSetUrlParams, useSwitchDatastack, useUrlParam } from "../hooks/useUrlState";
import type { ViewFamily } from "../hooks/useViewSnapshot";
import { applyTourConfigToParams } from "../tours/urlMint";
import { useApplyRecipe } from "../tours/useApplyRecipe";
import {
  listForDsAndKind,
  subscribe as subscribePersonalRecipes,
} from "../tours/personalRecipes";
import { urlHasRecipeContent } from "../tours/recipeFromUrl";
import { adapterForRecipe } from "../tours/adapters/registry";
import { useApplicableRecipeKinds } from "../tours/useApplicableRecipeKinds";
import { saveSessionRecipe } from "../tours/sessionRecipe";
import { ExplorerShareMenu } from "./explore/ExplorerShareMenu";
import { ShareMenu } from "./ShareMenu";

interface SidebarProps {
  navigateToView: (family: ViewFamily) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

/**
 * Left rail: brand, datastack/version pickers, datastack info, nav buttons,
 * Share menu, and operator/personal recipes.
 *
 * Sidebar-collapsed state is owned by the parent (Workspace) because the
 * `.workspace.sidebar-collapsed` class drives the outer grid layout in CSS.
 * We accept `collapsed` + `onToggleCollapsed` as props and let the parent
 * persist it.
 *
 * Reads `ds` / `mv` from the URL directly (rather than as props) because
 * the picker mutations write back to the URL via `useSetUrlParams` — a
 * single source of truth for which datastack/version is selected. The
 * Workspace shell reads the same params for its default-version effect.
 */
export function Sidebar({ navigateToView, collapsed, onToggleCollapsed }: SidebarProps) {
  const [ds] = useUrlParam("ds");
  const [mv] = useUrlParam("mv");
  const setUrl = useSetUrlParams();
  const switchDatastack = useSwitchDatastack();
  const navigate = useNavigate();

  const datastacks = useDatastacks();
  const versions = useVersions(ds);
  const info = useDatastackInfo(ds);

  // "live" is always offered in the picker. Datastacks with `live_mode: false`
  // (public release datastacks) still gate the connectivity / plots / links
  // endpoints — picking "live" for those falls back to "browse the latest
  // version" in the table view but errors out on the neuron view. This keeps
  // the table-browsing affordance available everywhere without giving a
  // misleading impression that connectivity queries can run live on a
  // release datastack.

  // Show whatever's in `?ds=` even if it's not in the allowlist response yet
  // (race on first paint, or operator forgot to add it). The select still
  // renders the URL value so the picker reads as "in sync" with the URL.
  const allowed = datastacks.data?.datastacks ?? [];
  const dsOptions = ds && !allowed.includes(ds) ? [ds, ...allowed] : allowed;

  return (
    <aside className="sidebar">
      {collapsed ? (
        // Vertical "CAVE Diver ›" label — uses the otherwise-
        // wasted collapsed-strip space to brand the app and signal
        // that the strip is interactive. Click anywhere on the
        // button expands the sidebar.
        <button
          className="sidebar-toggle vertical"
          onClick={onToggleCollapsed}
          title="Expand sidebar"
          aria-label="Expand sidebar"
        >
          <span className="vertical-label">CAVE Diver</span>
          <span className="vertical-chevron">›</span>
        </button>
      ) : (
        <>
          <div className="sidebar-header">
            <div className="sidebar-brand">
              <img src="/cave-diver.svg" alt="" className="brand-mark" width="28" height="28" />
              <h1>CAVE Diver</h1>
            </div>
            <button
              className="sidebar-toggle"
              onClick={onToggleCollapsed}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              ‹
            </button>
          </div>
          <label>
            Datastack
            <select
              value={ds ?? ""}
              onChange={(e) => switchDatastack(e.target.value || null)}
              disabled={datastacks.isError}
            >
              <option value="">
                {datastacks.isFetching && !datastacks.data ? "loading…" : "— select —"}
              </option>
              {dsOptions.map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            {datastacks.isError && (
              <div className="error-row">
                <span>datastack list failed: {datastacks.error instanceof Error ? datastacks.error.message : "unknown"}</span>
                <button
                  onClick={() => datastacks.refetch()}
                  disabled={datastacks.isFetching}
                  title="Retry fetching the datastack list"
                >
                  {datastacks.isFetching ? "retrying…" : "retry"}
                </button>
              </div>
            )}
          </label>

          <label>
            Materialization
            <select
              value={mv ?? "live"}
              // Write "live" as an explicit URL value rather than clearing
              // `?mv=` — that way the auto-default-to-latest effect in
              // Workspace (which keys off `!mv`) doesn't immediately
              // overwrite the user's choice the moment they pick "live".
              onChange={(e) => setUrl({ mv: e.target.value })}
              disabled={!ds || versions.isError}
            >
              {/* "live" only when the datastack permits it. Public-release
                  datastacks set `live_mode: false` in YAML; surfacing live
                  for those is misleading (the connectivity / plot / link
                  endpoints reject it) and confusing in the picker. */}
              {info.data?.live_mode !== false && <option value="live">live</option>}
              {/* Show the URL's current mv immediately so the select isn't empty
                  while versions.data is in flight (cold CAVE call can be slow). */}
              {mv && !versions.data && (
                <option value={mv}>v{mv}{versions.isFetching ? " (loading…)" : ""}</option>
              )}
              {versions.data?.versions.filter((v) => v.valid).map((v) => (
                <option key={v.version} value={String(v.version)}>v{v.version}</option>
              ))}
            </select>
            {versions.isError && (
              <div className="error-row">
                <span>versions failed: {versions.error instanceof Error ? versions.error.message : "unknown"}</span>
                <button
                  onClick={() => versions.refetch()}
                  disabled={versions.isFetching}
                  title="Retry fetching the materialization versions"
                >
                  {versions.isFetching ? "retrying…" : "retry"}
                </button>
              </div>
            )}
          </label>

          {info.data && (
            <details className="info">
              <summary>Datastack info</summary>
              <p><strong>Synapse table:</strong> {info.data.synapse_table}</p>
              <p><strong>Soma table:</strong> {info.data.soma_table}</p>
              <p><strong>Voxel:</strong> {info.data.voxel_resolution?.join(" × ")}</p>
            </details>
          )}
          {info.data && <NeutralNeuroglancerLink ds={ds!} mv={mv} />}

          <ExamplesLink />

          <nav className="nav">
            <button
              onClick={() => navigate(`/${ds ? `?ds=${ds}${mv ? `&mv=${mv}` : ""}` : ""}`)}
              title="Curated recipes for this datastack"
            >
              Recipes
            </button>
            <button
              onClick={() => navigateToView("neuron")}
              disabled={!ds}
              title="Resumes your last neuron view if you've been here before"
            >
              Neuron View
            </button>
            <button
              onClick={() => navigateToView("tables")}
              disabled={!ds}
              title="Resumes your last table browser view if you've been here before"
            >
              Table Browser
            </button>
            <button
              onClick={() => navigateToView("explore")}
              disabled={!ds}
              title="Resumes your last feature-explorer view if you've been here before"
            >
              Feature Explorer
            </button>
          </nav>
          {ds && <ShareMenu ds={ds} />}
          {ds && <ExplorerShareMenu ds={ds} />}
          {ds && <SidebarResetView ds={ds} />}
          {ds && <SidebarRecipes ds={ds} mv={mv} />}
        </>
      )}
    </aside>
  );
}

function ExamplesLink() {
  const [params] = useSearchParams();
  const ds = params.get("ds");
  const to = ds ? `/examples?ds=${encodeURIComponent(ds)}` : "/examples";
  return (
    <div className="sidebar-examples-link">
      <Link to={to}>Quickstart Examples →</Link>
    </div>
  );
}

interface NeutralNeuroglancerLinkProps {
  ds: string;
  mv: string | null;
}

/**
 * "Open in Neuroglancer" affordance for the sidebar's Datastack-info block.
 * Empty `root_ids` means the segments-link endpoint composes a viewer with
 * just the datastack's default image + segmentation layers, no segments
 * pinned and no point annotations — a neutral landing for "I want to look
 * around this dataset before I have a specific cell in mind."
 *
 * In live mode the connectivity flow is gated on release datastacks but the
 * neutral viewer is fine — there's no live-vs-materialized data being read,
 * we're just composing a default Neuroglancer state. The mutation forwards
 * the URL's mat_version verbatim; backend endpoint accepts both.
 */
function NeutralNeuroglancerLink({ ds, mv }: NeutralNeuroglancerLinkProps) {
  const matVersion = parseMatVersion(mv);
  const ngl = useNglLink();
  return (
    <p className="ngl-link-row">
      <button
        type="button"
        className="link-button"
        onClick={() =>
          ngl.open({ kind: "segments", ds, matVersion, rootIds: [] })
        }
        disabled={ngl.isPending}
        title="Open Neuroglancer with this datastack's default image and segmentation layers (no cells pinned)"
      >
        {ngl.isPending ? "opening…" : "Open Datastack in Neuroglancer ↗"}
      </button>
      {ngl.isError && ngl.error && (
        <span className="error">{ngl.error.message}</span>
      )}
    </p>
  );
}

/**
 * "Reset view" — clears the current overlay (decorations, plots, cell
 * filter, column visibility) and persists the cleared state as the new
 * per-datastack baseline so it survives cross-navigation.
 *
 * Renders only when there's overlay to reset; otherwise the sidebar stays
 * uncluttered. The escape hatch for the auto-restore behavior in
 * `useSessionRecipe` — pure auto-restore without a visible reset would
 * leave users with no way to opt out short of clearing localStorage.
 *
 * Confirms before clearing — mirrors `useApplyRecipe`'s window.confirm
 * pattern. The summary surfaces what'll be lost so the user can intercept
 * an accidental click.
 */
function SidebarResetView({ ds }: { ds: string }) {
  const [params, setParams] = useSearchParams();
  if (!urlHasRecipeContent(params)) return null;
  const onReset = () => {
    const summary = formatResetSummary(params);
    if (!window.confirm(`Reset view?\n\nThis will clear:\n${summary}`)) return;
    setParams(
      (prev) =>
        applyTourConfigToParams(prev, {
          decoration_tables: [],
          plots: [],
          cells: null,
          hide: [],
          show: [],
          coll: [],
        }),
      { replace: true },
    );
    // SidebarResetView is only mounted on /neuron — connectivity is
    // the only kind whose URL state it knows how to clear.
    saveSessionRecipe(ds, "connectivity", null);
  };
  return (
    <div className="sidebar-reset-view">
      <button
        type="button"
        onClick={onReset}
        title="Clear decorations, plots, filters, and column visibility for this cell"
      >
        Reset view
      </button>
    </div>
  );
}

/** Build the bullet-list body for the Reset view confirm prompt. Counts
 *  what's currently set in the URL so the user sees exactly what will be
 *  discarded — n decoration tables, n plots, the cell filter (if any),
 *  hidden / shown / collapsed columns. Returns a string ready to drop
 *  into `window.confirm`. */
function formatResetSummary(params: URLSearchParams): string {
  const csv = (k: string) => (params.get(k) ?? "").split(",").filter(Boolean);
  const lines: string[] = [];
  const plural = (n: number, one: string, many: string = `${one}s`) =>
    `${n} ${n === 1 ? one : many}`;
  const dec = csv("dec");
  if (dec.length > 0) lines.push(`  • ${plural(dec.length, "decoration table")}`);
  const plots = csv("plots");
  if (plots.length > 0) lines.push(`  • ${plural(plots.length, "plot")}`);
  if (params.get("cells")) lines.push(`  • cell filter`);
  const hide = csv("hide");
  if (hide.length > 0) lines.push(`  • ${plural(hide.length, "hidden column")}`);
  const show = csv("show");
  if (show.length > 0) lines.push(`  • ${plural(show.length, "shown override")}`);
  const coll = csv("coll");
  if (coll.length > 0) lines.push(`  • ${plural(coll.length, "collapsed group")}`);
  return lines.length > 0 ? lines.join("\n") : "  (overlay state)";
}

/**
 * Sidebar widget surfacing operator-curated Recipes scoped to the current
 * datastack. Examples don't appear here — they're navigation-style and
 * belong on the landing page (`/`); the sidebar is for "I'm already in the
 * workspace, overlay this configuration onto my cell" gestures.
 *
 * The Apply CTA is disabled when no `?root=` is set, with a tooltip
 * explaining why. Same hook (`useApplyRecipe`) the landing page uses, so
 * the confirmation flow and URL-state semantics stay identical regardless
 * of where the user triggers an Apply from.
 *
 * Defaults to closed (`<details>` without `open`) — tours are a tour-of-
 * capabilities feature, not a primary workflow, so the widget shouldn't
 * dominate the sidebar's vertical space. Per-session collapse state is
 * native browser behavior; we don't persist it.
 */
// Label the recipes section by the kind(s) applicable on this route:
// "Neuron Recipes" on /neuron, "Feature Recipes" on /explore. The
// landing page is the only place that legitimately mixes both, and
// there we fall back to the unqualified "Recipes" since the cards
// already render a per-kind chip. Returns "" when there are no
// applicable kinds — caller bails before rendering anyway.
function recipesSectionLabel(kinds: Set<RecipeKind>): string {
  if (kinds.size === 0) return "";
  if (kinds.size === 1) {
    if (kinds.has("connectivity")) return "Neuron Recipes";
    if (kinds.has("explorer")) return "Feature Recipes";
  }
  return "Recipes";
}

function SidebarRecipes({ ds, mv }: { ds: string; mv: string | null }) {
  const applicableKinds = useApplicableRecipeKinds();
  // Routes with no recipe concept (Table Browser, Examples, 404) return
  // an empty kind set from the hook. Bail before firing the tours
  // query — there's nothing to show and no need to warm the cache for
  // a section the user can't act on from here.
  const sectionLabel = recipesSectionLabel(applicableKinds);
  if (applicableKinds.size === 0) return null;
  return (
    <SidebarRecipesBody ds={ds} mv={mv} applicableKinds={applicableKinds} sectionLabel={sectionLabel} />
  );
}

function SidebarRecipesBody({
  ds,
  mv,
  applicableKinds,
  sectionLabel,
}: {
  ds: string;
  mv: string | null;
  applicableKinds: Set<RecipeKind>;
  sectionLabel: string;
}) {
  const tours = useTours(ds);
  const [root] = useUrlParam("root");
  const applyRecipe = useApplyRecipe();
  // Personal recipes live in localStorage. Subscribe to mutation events
  // emitted by `personalRecipes.save/remove` so the list re-renders when
  // ShareMenu (a sibling, not a parent) writes a new entry.
  const [, setPersonalTick] = useState(0);
  useEffect(() => subscribePersonalRecipes(() => setPersonalTick((n) => n + 1)), []);
  // Filter to kinds applicable to the current route. /neuron shows only
  // connectivity recipes; /explore shows only explorer recipes. Hiding
  // the inapplicable ones keeps the rail focused on actions the user
  // can take from where they are.
  const personalRecipes: Recipe[] = listForDsAndKind(ds, applicableKinds);
  const builtinRecipes: Recipe[] = (tours.data?.recipes ?? []).filter((r) =>
    applicableKinds.has(r.kind),
  );

  const toursLoading = tours.isLoading;
  // useApplyRecipe handles both apply-onto-loaded-cell and open-without-cell
  // internally (via the adapter's hasNavContext + buildOpenParams). The
  // sidebar just renders the right CTA label so the user knows what's
  // about to happen.
  const canApply = !!root;
  const onClick = (r: Recipe) => {
    applyRecipe(r);
  };
  // `mv` is kept in the prop signature for future kind-specific routing
  // decisions but isn't read here directly — silence the lint.
  void mv;
  const total = personalRecipes.length + builtinRecipes.length;
  // Show `(N+…)` while built-in tours are still in flight so the count
  // visibly grows — avoids a misleading `(0)` that flips to `(N)` once
  // the cache warms.
  const summaryText = toursLoading
    ? `${sectionLabel} (${total}+…)`
    : `${sectionLabel} (${total})`;

  // The Built-in section is omitted entirely when this datastack ships
  // no built-in recipes — a missing header reads as "nothing here" more
  // cleanly than an empty subsection with a "no built-ins" hint. The
  // My Recipes section stays mounted even when empty so the
  // Save-from-Share-menu workflow is discoverable.
  const showBuiltin = builtinRecipes.length > 0 || toursLoading;

  return (
    <details className="sidebar-recipes" open>
      <summary>{summaryText}</summary>
      <div className="recipes-group">
        <h4 className="sidebar-recipes-group">My recipes</h4>
        {personalRecipes.length > 0 ? (
          <ul>
            {personalRecipes.map((r) => (
              <PersonalRecipeRow
                key={r.id}
                recipe={r}
                root={root}
                canApply={canApply}
                onApply={() => onClick(r)}
              />
            ))}
          </ul>
        ) : (
          <p className="muted sidebar-recipes-empty">
            No saved recipes yet — use <strong>Share / Save</strong> above
            to save the current view.
          </p>
        )}
      </div>
      {showBuiltin && (
        <div className="recipes-group">
          <h4 className="sidebar-recipes-group">Built-in recipes</h4>
          {toursLoading && builtinRecipes.length === 0 ? (
            <p className="muted">Loading…</p>
          ) : (
            <ul>
              {builtinRecipes.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onClick(r)}
                    title={
                      canApply
                        ? `Apply: overlay onto cell ${root!.slice(0, 6)}…${root!.slice(-4)}` +
                          (r.description ? `\n\n${r.description}` : "")
                        : "Open: preconfigure the workspace, then pick a cell" +
                          (r.description ? `\n\n${r.description}` : "")
                    }
                  >
                    {r.title}
                    <span className="sidebar-recipes-cta">{canApply ? "Apply" : "Open"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </details>
  );
}

function PersonalRecipeRow({
  recipe,
  root,
  canApply,
  onApply,
}: {
  recipe: Recipe;
  root: string | null;
  canApply: boolean;
  onApply: () => void;
}) {
  const onDownload = () => {
    const yaml = adapterForRecipe(recipe).toYaml(recipe);
    const blob = new Blob([yaml], { type: "application/x-yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    // Slugify title for filename; fall back to the id if the title is
    // entirely non-alphanumeric.
    const slug = recipe.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    a.download = `${slug || recipe.id}.recipe.yaml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  return (
    <li className="sidebar-recipes-personal">
      <button
        type="button"
        onClick={onApply}
        title={
          canApply
            ? `Apply: overlay onto cell ${root!.slice(0, 6)}…${root!.slice(-4)}` +
              (recipe.description ? `\n\n${recipe.description}` : "")
            : "Open: preconfigure the workspace, then pick a cell" +
              (recipe.description ? `\n\n${recipe.description}` : "")
        }
      >
        {recipe.title}
        <span className="sidebar-recipes-cta">{canApply ? "Apply" : "Open"}</span>
      </button>
      <div className="sidebar-recipes-row-actions">
        <button type="button" onClick={onDownload} title="Download as YAML">YAML</button>
      </div>
    </li>
  );
}
