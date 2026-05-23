import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDatastacks, useTours } from "../api/queries";
import { useSwitchDatastack, useUrlParam } from "../hooks/useUrlState";
import type { ConnectivityRecipe, Recipe } from "../api/types";
import { useApplyRecipe } from "../tours/useApplyRecipe";
import {
  getInvalidCount,
  getPendingDeletion,
  listForDs as listPersonalRecipes,
  restorePending,
  softRemove as softRemovePersonalRecipe,
  save as savePersonalRecipe,
  subscribe as subscribePersonalRecipes,
  subscribePendingDeletions,
  type PendingDeletion,
} from "../tours/personalRecipes";
import { adapterForRecipe } from "../tours/adapters/registry";
import { parseRecipesFromYaml } from "../tours/recipeFromYaml";

// Persisted across sessions so a returning user lands on whichever datastack
// they last engaged with — the operator-controlled API order is irrelevant
// once a user has expressed a preference by clicking a tab.
const LAST_DS_KEY = "cdv:last_ds";

function readStoredDs(): string | null {
  try {
    return localStorage.getItem(LAST_DS_KEY);
  } catch {
    return null;
  }
}
function writeStoredDs(ds: string): void {
  try {
    localStorage.setItem(LAST_DS_KEY, ds);
  } catch {
    // localStorage may throw under quota / private-mode; non-fatal.
  }
}

// Recipe-section open/closed state — keyed by (ds, kind) so a user's
// "collapse Connectivity, keep Explorer open" choice survives reloads
// and cross-datastack navigation. Default is open (the first-view
// affordance is "see what's here"); we only persist deviations.
const SECTION_STATE_PREFIX = "cdv:recipes_section_open:";
function sectionKey(ds: string, kind: "connectivity" | "explorer"): string {
  return `${SECTION_STATE_PREFIX}${ds}:${kind}`;
}
function readSectionOpen(ds: string, kind: "connectivity" | "explorer"): boolean {
  try {
    const v = localStorage.getItem(sectionKey(ds, kind));
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}
function writeSectionOpen(
  ds: string,
  kind: "connectivity" | "explorer",
  open: boolean,
): void {
  try {
    localStorage.setItem(sectionKey(ds, kind), open ? "1" : "0");
  } catch {
    // ignore — quota / private-mode degrade silently.
  }
}

/**
 * Resolve which datastack the landing page should display. Priority:
 *   1. URL `?ds=` if it's in the allowed list.
 *   2. localStorage `cdv:last_ds` if it's in the allowed list.
 *   3. First allowed datastack.
 *
 * When the resolved value differs from the URL (cold load, stale `?ds=`,
 * etc.), the URL is rewritten via `replace: true` so the reconciliation
 * doesn't push a history entry. Tab clicks also use replace — switching
 * tabs shouldn't pollute the back stack.
 *
 * Returns `null` while the allowed list is empty (datastacks query in
 * flight or errored). Mirrors the sidebar's behavior of clearing `mv`
 * when ds changes — the prior version doesn't apply across datastacks.
 */
function useActiveDatastack(allowed: string[]): [string | null, (ds: string) => void] {
  const [urlDs] = useUrlParam("ds");
  const switchDatastack = useSwitchDatastack();

  const active = useMemo(() => {
    if (allowed.length === 0) return null;
    if (urlDs && allowed.includes(urlDs)) return urlDs;
    const stored = readStoredDs();
    if (stored && allowed.includes(stored)) return stored;
    return allowed[0];
  }, [urlDs, allowed]);

  useEffect(() => {
    if (!active) return;
    if (active !== urlDs) {
      switchDatastack(active, { replace: true });
    }
    writeStoredDs(active);
  }, [active, urlDs, switchDatastack]);

  const setActive = useCallback(
    (next: string) => {
      switchDatastack(next, { replace: true });
      writeStoredDs(next);
    },
    [switchDatastack],
  );

  return [active, setActive];
}

/**
 * Operator-curated landing page. Renders one datastack's recipes at a
 * time, picked from a tab strip. Recipes overlay configuration onto the
 * user's currently-loaded cell.
 *
 * The active datastack is URL-driven (`?ds=`), with a localStorage
 * fallback so a returning user doesn't have to scroll past datastacks
 * they don't care about. The sidebar's datastack picker writes the same
 * URL param, so the two stay in sync.
 */
export function LandingPage() {
  const datastacks = useDatastacks();
  const list = datastacks.data?.datastacks ?? [];
  const [activeDs, setActiveDs] = useActiveDatastack(list);

  return (
    <div className="landing">
      <header className="landing-header">
        <h2>CAVE Data Viewer</h2>
        <p>
          Browse curated views of CAVE connectome data.{" "}
          <strong>Recipes</strong> configure decoration tables and plots onto your current cell query.
        </p>
      </header>
      {datastacks.isLoading && <p className="muted">Loading datastacks…</p>}
      {datastacks.isError && (
        <p className="error">
          Failed to load datastacks:{" "}
          {datastacks.error instanceof Error ? datastacks.error.message : "unknown"}
        </p>
      )}
      {list.length > 0 && activeDs && (
        <>
          <nav className="landing-tabs" role="tablist" aria-label="Datastack">
            {list.map((ds) => (
              <button
                key={ds}
                type="button"
                role="tab"
                aria-selected={ds === activeDs}
                className={`landing-tab${ds === activeDs ? " is-active" : ""}`}
                onClick={() => setActiveDs(ds)}
                title={`Show recipes for ${ds}`}
              >
                {ds}
              </button>
            ))}
          </nav>
          <DatastackTours ds={activeDs} />
        </>
      )}
    </div>
  );
}

function DatastackTours({ ds }: { ds: string }) {
  const tours = useTours(ds);
  const data = tours.data;
  // Subscribe to personal-recipe mutations so the section re-renders when
  // a YAML upload finishes or the user deletes one.
  const [, setPersonalTick] = useState(0);
  useEffect(() => subscribePersonalRecipes(() => setPersonalTick((n) => n + 1)), []);
  // Subscribe to pending-deletion changes so the slot wrappers (which
  // synchronously read getPendingDeletion) re-render when softRemove
  // marks a recipe or restorePending clears it.
  const [, setPendingTick] = useState(0);
  useEffect(
    () => subscribePendingDeletions(() => setPendingTick((n) => n + 1)),
    [],
  );
  const personalRecipes = listPersonalRecipes(ds);
  // Server-reported count of saved recipes the user has on disk that
  // were skipped because they lack a recognized `kind` (legacy
  // pre-discriminator items, or items with a kind this SPA doesn't
  // know). Surface as a banner so the user understands why some
  // previously-saved items aren't visible.
  const invalidCount = getInvalidCount(ds);

  const builtinRecipes = data?.recipes ?? [];
  const empty =
    data && builtinRecipes.length === 0 && personalRecipes.length === 0;

  return (
    <section className="landing-datastack">
      {invalidCount > 0 && (
        <p className="warning recipe-invalid-banner">
          {invalidCount} recipe{invalidCount === 1 ? " is" : "s are"} from a
          previous schema and {invalidCount === 1 ? "is" : "are"} hidden. Re-create
          {invalidCount === 1 ? " it" : " them"} to restore.
        </p>
      )}
      {tours.isLoading && <p className="muted">Loading recipes…</p>}
      {tours.isError && (
        <p className="error">
          Failed to load recipes:{" "}
          {tours.error instanceof Error ? tours.error.message : "unknown"}
        </p>
      )}
      {empty && (
        <p className="muted">
          No recipes configured for this datastack — load one from a
          YAML file below, or pick this datastack in the sidebar to start fresh.
        </p>
      )}
      {(builtinRecipes.length > 0 || personalRecipes.length > 0) && (
        <>
          {(["connectivity", "explorer"] as const).map((kind) => {
            const personalForKind = personalRecipes.filter((r) => r.kind === kind);
            const builtinForKind = builtinRecipes.filter((r) => r.kind === kind);
            const total = personalForKind.length + builtinForKind.length;
            if (total === 0) return null;
            const sectionTitle =
              kind === "connectivity" ? "Connectivity recipes" : "Explorer recipes";
            return (
              <details
                key={kind}
                className="tour-section"
                open={readSectionOpen(ds, kind)}
                onToggle={(e) =>
                  writeSectionOpen(ds, kind, (e.currentTarget as HTMLDetailsElement).open)
                }
              >
                <summary>
                  <h4>
                    {sectionTitle}{" "}
                    <span className="tour-section-count">({total})</span>
                  </h4>
                </summary>
                {personalForKind.length > 0 && (
                  <>
                    <h5 className="tour-subgroup">My recipes</h5>
                    <div className="tour-grid">
                      {personalForKind.map((r) => (
                        <PersonalRecipeSlot key={r.id} ds={ds} recipe={r} />
                      ))}
                    </div>
                  </>
                )}
                {builtinForKind.length > 0 && (
                  <>
                    {personalForKind.length > 0 && (
                      <h5 className="tour-subgroup">Built-in recipes</h5>
                    )}
                    <div className="tour-grid">
                      {builtinForKind.map((r) => (
                        <RecipeCard key={r.id} ds={ds} recipe={r} />
                      ))}
                    </div>
                  </>
                )}
              </details>
            );
          })}
        </>
      )}
      <RecipeYamlUploader ds={ds} />
    </section>
  );
}

/**
 * "Load recipe from YAML" affordance scoped to one datastack. Accepts
 * either a file picker or text paste; the parsed recipes are stored as
 * personal recipes for THIS datastack only (recipes are inherently
 * datastack-specific because their decoration tables and column names
 * reference datastack-bound CAVE state).
 *
 * Errors from `parseRecipesFromYaml` are surfaced inline; warnings (per-
 * field salvage notes) appear collapsed under a "Show details" toggle so
 * a successful-but-noisy upload doesn't drown the success message.
 */
function RecipeYamlUploader({ ds }: { ds: string }) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [result, setResult] = useState<{
    ok: number;
    warnings: string[];
    errors: string[];
  } | null>(null);

  const handleYaml = (yamlText: string, source: string) => {
    const parsed = parseRecipesFromYaml(yamlText);
    for (const recipe of parsed.recipes) savePersonalRecipe(ds, recipe);
    setResult({
      ok: parsed.recipes.length,
      warnings: parsed.warnings,
      errors: parsed.errors.length > 0 ? parsed.errors : parsed.recipes.length === 0 ? [`No recipes loaded from ${source}.`] : [],
    });
  };

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    handleYaml(text, file.name);
    // Reset so re-uploading the same file re-triggers the change event.
    e.target.value = "";
  };

  const onPasteSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!pasteText.trim()) return;
    handleYaml(pasteText, "pasted YAML");
    setPasteText("");
    setPasteOpen(false);
  };

  return (
    <div className="recipe-uploader">
      <h4>Load recipe from YAML</h4>
      <p className="muted">
        Paste a recipe YAML or upload a file (e.g. one downloaded from the
        sidebar). Loaded recipes go into <em>your personal recipes</em> for
        this datastack only.
      </p>
      <div className="recipe-uploader-actions">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="Pick a recipe YAML file from your computer"
        >
          Choose file…
        </button>
        <button
          type="button"
          onClick={() => setPasteOpen((s) => !s)}
          title={pasteOpen ? "Close the paste box" : "Paste recipe YAML text directly"}
        >
          {pasteOpen ? "Cancel paste" : "Paste YAML"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml,.txt,application/x-yaml,text/yaml,text/plain"
          onChange={onFileChosen}
          style={{ display: "none" }}
        />
      </div>
      {pasteOpen && (
        <form className="recipe-uploader-paste" onSubmit={onPasteSubmit}>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            rows={10}
            placeholder={`recipes:\n  - id: my-recipe\n    title: ...`}
            autoFocus
          />
          <button
            type="submit"
            disabled={!pasteText.trim()}
            title="Parse the pasted YAML and add the recipes to your personal list"
          >
            Load
          </button>
        </form>
      )}
      {result && <RecipeUploadResult result={result} onDismiss={() => setResult(null)} />}
    </div>
  );
}

function RecipeUploadResult({
  result,
  onDismiss,
}: {
  result: { ok: number; warnings: string[]; errors: string[] };
  onDismiss: () => void;
}) {
  const hasError = result.errors.length > 0;
  const hasWarn = result.warnings.length > 0;
  return (
    <div className={`recipe-uploader-result ${hasError ? "is-error" : "is-success"}`}>
      <div className="recipe-uploader-result-header">
        {result.ok > 0 && (
          <span>
            ✓ Loaded {result.ok} recipe{result.ok === 1 ? "" : "s"}.
          </span>
        )}
        {hasError && <span>✗ {result.errors.length} error{result.errors.length === 1 ? "" : "s"}.</span>}
        <button
          type="button"
          className="link-button"
          onClick={onDismiss}
          title="Dismiss this upload result"
        >
          dismiss
        </button>
      </div>
      {hasError && (
        <ul>
          {result.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {hasWarn && (
        <details>
          <summary>{result.warnings.length} warning{result.warnings.length === 1 ? "" : "s"}</summary>
          <ul>
            {result.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function summarizeTour(t: Recipe): string {
  if (t.kind === "connectivity") {
    return summarizeConnectivity(t as ConnectivityRecipe);
  }
  return summarizeExplorer(t);
}

function summarizeConnectivity(t: ConnectivityRecipe): string {
  const parts: string[] = [];
  const dt = t.decoration_tables ?? [];
  const plots = t.plots ?? [];
  if (dt.length > 0) {
    parts.push(`${dt.length} decoration${dt.length === 1 ? "" : "s"}`);
  }
  if (plots.length > 0) {
    parts.push(`${plots.length} plot${plots.length === 1 ? "" : "s"}`);
  }
  if (t.cells) parts.push("cell filter");
  return parts.join(" · ");
}

function summarizeExplorer(t: Extract<Recipe, { kind: "explorer" }>): string {
  const parts: string[] = [];
  const s = t.explorer;
  if (s.ft) parts.push(`ft: ${s.ft}`);
  if (s.emb) parts.push(`emb: ${s.emb}`);
  const bound = ["x", "y", "color", "size"].filter(
    (k) => Boolean((s as Record<string, unknown>)[k]),
  ).length;
  if (bound > 0) parts.push(`${bound} scatter binding${bound === 1 ? "" : "s"}`);
  if (s.decoration_tables && s.decoration_tables.length > 0) {
    parts.push(
      `${s.decoration_tables.length} decoration${s.decoration_tables.length === 1 ? "" : "s"}`,
    );
  }
  if (s.cells) parts.push("cell filter");
  if (s.selection && s.selection.length > 0) {
    parts.push(`${s.selection.length} selected`);
  }
  return parts.join(" · ");
}

/** Wrapper that decides what to render in a personal recipe's grid
 *  slot. While the recipe is pending deletion, shows an inline Undo
 *  placeholder that occupies the same slot — keeps the grid layout
 *  stable so the user's eye doesn't have to jump. Otherwise renders a
 *  normal RecipeCard. */
function PersonalRecipeSlot({ ds, recipe }: { ds: string; recipe: Recipe }) {
  const pending = getPendingDeletion(ds, recipe.id);
  if (pending) {
    return <PendingDeletionCard pending={pending} />;
  }
  return <RecipeCard ds={ds} recipe={recipe} personal />;
}

/** Inline Undo-delete placeholder. Matches a normal personal RecipeCard's
 *  dimensions (same .tour-card chrome + .is-personal dashed border) so
 *  the grid stays put while the user decides. Countdown bar at the
 *  bottom shrinks over the remaining window; the bar's animation
 *  duration is pinned to (expiresAt - now) at mount so the visual
 *  matches the actual commit time. */
function PendingDeletionCard({ pending }: { pending: PendingDeletion }) {
  const remainingMs = Math.max(0, pending.expiresAt - Date.now());
  return (
    <div className="tour-card is-personal tour-card-pending">
      <div className="tour-card-header">
        <h5>Deleted</h5>
      </div>
      <p className="tour-desc">
        <em>{pending.recipe.title}</em>
      </p>
      <div className="tour-card-actions">
        <button
          type="button"
          className="tour-cta"
          onClick={() => restorePending(pending.ds, pending.recipe.id)}
          title="Restore this recipe before the deletion is committed"
        >
          Undo
        </button>
      </div>
      <div
        className="tour-card-countdown"
        style={{ animationDuration: `${remainingMs}ms` }}
      />
    </div>
  );
}

function RecipeCard({ ds, recipe, personal }: { ds: string; recipe: Recipe; personal?: boolean }) {
  const navigate = useNavigate();
  const [currentDs] = useUrlParam("ds");
  const [currentMv] = useUrlParam("mv");
  const [currentRoot] = useUrlParam("root");
  const applyRecipe = useApplyRecipe();
  const adapter = adapterForRecipe(recipe);
  // Apply overlays the recipe onto a loaded view — connectivity
  // requires same ds + a root, explorer just requires same ds. The
  // adapter's hasNavContext does the kind-aware check.
  const sameDs = currentDs === ds;
  // canApply is shown via the CTA label ("Apply" vs "Open"); the
  // actual fallback to Open when nav context is missing happens
  // inside useApplyRecipe via the adapter.
  const dummyParams = new URLSearchParams(window.location.search);
  const canApply = sameDs && adapter.hasNavContext(dummyParams);
  const open = () => {
    // mv preserved from the sidebar only when the user is already on
    // this datastack — switching to a different datastack's recipe
    // should land the user without a stale mat_version that doesn't
    // apply to the new ds.
    const mvToCarry = sameDs ? currentMv : null;
    const params = adapter.buildOpenParams(ds, recipe, mvToCarry);
    navigate(`${adapter.openRoute}?${params.toString()}`);
  };
  const onDownload = () => {
    const yaml = adapter.toYaml(recipe);
    const blob = new Blob([yaml], { type: "application/x-yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const slug = recipe.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    a.download = `${slug || recipe.id}.recipe.yaml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const onCopy = async (): Promise<boolean> => {
    const yaml = adapter.toYaml(recipe);
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      try {
        await navigator.clipboard.writeText(yaml);
        return true;
      } catch {
        // Fall through to prompt fallback.
      }
    }
    if (typeof window !== "undefined" && "prompt" in window) {
      window.prompt("Copy recipe YAML:", yaml);
    }
    return false;
  };
  const onDelete = () => {
    softRemovePersonalRecipe(ds, recipe.id);
  };
  return (
    <div className={`tour-card${personal ? " is-personal" : ""}`}>
      <div className="tour-card-header">
        <h5>{recipe.title}</h5>
      </div>
      {recipe.description && <p className="tour-desc">{recipe.description}</p>}
      {summarizeTour(recipe) && <p className="tour-meta">{summarizeTour(recipe)}</p>}
      <div className="tour-card-actions">
        {canApply ? (
          <button
            type="button"
            className="tour-cta"
            onClick={() => applyRecipe(recipe)}
            title={
              recipe.kind === "connectivity" && currentRoot
                ? `Overlay onto cell ${currentRoot.slice(0, 6)}…${currentRoot.slice(-4)}`
                : "Apply this recipe to the current view"
            }
          >
            Apply
          </button>
        ) : (
          <button
            type="button"
            className="tour-cta"
            onClick={open}
            title="Open the workspace preconfigured with this recipe — pick a cell once you're there"
          >
            Open
          </button>
        )}
        {personal && (
          <>
            <RecipeYamlMenu onDownload={onDownload} onCopy={onCopy} />
            <button type="button" className="tour-secondary" onClick={onDelete} title="Delete this personal recipe">
              Delete
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Split YAML export affordance: Download writes a .recipe.yaml file
 *  for archival; Copy writes the YAML text to the clipboard so it can
 *  be pasted into another datastack's "Paste YAML" loader. */
function RecipeYamlMenu({
  onDownload,
  onCopy,
}: {
  onDownload: () => void;
  onCopy: () => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const handleDownload = () => {
    onDownload();
    setOpen(false);
  };
  const handleCopy = async () => {
    const ok = await onCopy();
    setOpen(false);
    if (ok) {
      setFlash("copied");
      window.setTimeout(() => setFlash(null), 1500);
    }
  };

  return (
    <div className="recipe-yaml-menu" ref={popoverRef}>
      <button
        type="button"
        className="tour-secondary"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Export this recipe as YAML"
      >
        {flash ?? "YAML ▾"}
      </button>
      {open && (
        <div className="recipe-yaml-popover" role="menu">
          <button
            type="button"
            role="menuitem"
            className="recipe-yaml-option"
            onClick={handleDownload}
            title="Save this recipe to a .yaml file"
          >
            <div className="recipe-yaml-option-label">Download</div>
            <div className="recipe-yaml-option-hint">Archive to a file</div>
          </button>
          <button
            type="button"
            role="menuitem"
            className="recipe-yaml-option"
            onClick={handleCopy}
            title="Copy YAML to the clipboard"
          >
            <div className="recipe-yaml-option-label">Copy</div>
            <div className="recipe-yaml-option-hint">Move to another datastack</div>
          </button>
        </div>
      )}
    </div>
  );
}
