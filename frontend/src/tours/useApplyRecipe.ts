import { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Recipe, RecipeKind } from "../api/types";
import { adapterForRecipe } from "./adapters/registry";

/**
 * Cross-route handoff for adapter-supplied "extras" — non-URL recipe
 * state (e.g. the explorer's Selection bag) that needs to land in a
 * different view's component state. useApplyRecipe writes the
 * extras to a transient localStorage key keyed by (ds, kind); the
 * target view reads + removes it on mount.
 *
 * One-shot semantics: any read consumes the value. This avoids the
 * extras getting re-applied on a later /explore mount that wasn't
 * triggered by this apply.
 */
const PENDING_EXTRAS_PREFIX = "cdv:v1:pending_apply_extras:";

function pendingExtrasKey(ds: string, kind: RecipeKind): string {
  return `${PENDING_EXTRAS_PREFIX}${ds}:${kind}`;
}

export function consumePendingApplyExtras(
  ds: string,
  kind: RecipeKind,
): Record<string, unknown> | null {
  if (!ds) return null;
  try {
    const key = pendingExtrasKey(ds, kind);
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    localStorage.removeItem(key);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export function writePendingApplyExtras(
  ds: string,
  kind: RecipeKind,
  extras: Record<string, unknown>,
): void {
  if (!ds) return;
  try {
    localStorage.setItem(pendingExtrasKey(ds, kind), JSON.stringify(extras));
  } catch {
    // Quota exceeded etc. — non-fatal; URL state still lands, just
    // without the extras.
  }
}

/**
 * Shared apply-recipe flow used by every recipe consumer (LandingPage
 * RecipeCard, Sidebar Recipes widget, future kinds). Dispatches via
 * the kind-specific adapter: parses the diff summary, confirms with
 * the user, applies via the adapter's applyToParams, and navigates
 * to the adapter's openRoute.
 *
 * Confirmation uses `window.confirm` for v1 (the plan accepted
 * "replace with confirmation" without specifying a component
 * flavor). Substitute a richer dialog later without changing the
 * caller surface.
 *
 * When the current URL lacks navigation context for the recipe's
 * kind (e.g. applying a connectivity recipe with no `?root=`
 * loaded), the function navigates to the adapter's openRoute with
 * the recipe pre-applied — same UX as clicking "Open" on the
 * landing page. This way the user always gets the configured view,
 * never a silent no-op.
 */
export function useApplyRecipe(): (recipe: Recipe) => void {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  return useCallback(
    (recipe: Recipe) => {
      const prev = new URLSearchParams(searchParams);
      const adapter = adapterForRecipe(recipe);

      // Without nav context for this kind, fall through to Open
      // (build a fresh URL with the recipe applied, navigate to the
      // kind's home route). Avoids the v1-only silent no-op when a
      // user clicked Apply from a context that lacked the right
      // anchors.
      const ds = prev.get("ds") ?? "";
      const mv = prev.get("mv");
      const onExtras = (extras: Record<string, unknown>) => {
        writePendingApplyExtras(ds, recipe.kind, extras);
      };

      if (!adapter.hasNavContext(prev)) {
        if (!ds) return;
        // buildOpenParams calls applyToParams internally — pass the
        // extras-writer so a recipe with a Selection bag still
        // restores it on the destination route.
        const fresh = new URLSearchParams();
        fresh.set("ds", ds);
        if (mv) fresh.set("mv", mv);
        const openParams = adapter.applyToParams(fresh, recipe, onExtras);
        navigate(`${adapter.openRoute}?${openParams.toString()}`);
        return;
      }

      const next = adapter.applyToParams(prev, recipe, onExtras);
      const diff = adapter.diff(prev, recipe);
      const summary = diff.lines.length > 0 ? diff.lines.join("\n") : "";
      if (summary && !window.confirm(`Apply recipe "${recipe.title}"?\n\n${summary}`)) {
        return;
      }
      navigate(`${adapter.openRoute}?${next.toString()}`);
    },
    [navigate, searchParams],
  );
}
