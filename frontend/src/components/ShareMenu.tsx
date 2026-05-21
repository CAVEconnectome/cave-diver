import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { connectivityAdapter } from "../tours/adapters/connectivityAdapter";
import { parseRecipeFromUrl, urlHasRecipeContent } from "../tours/recipeFromUrl";
import { newPersonalId, save as savePersonal } from "../tours/personalRecipes";
import {
  buildQueryLink,
  buildRecipeLink,
  CONNECTIVITY_RECIPE_STRIP_KEYS,
  CONNECTIVITY_RECIPE_STRIP_PREFIXES,
} from "../tours/shareLinks";
import { useApplicableRecipeKinds } from "../tours/useApplicableRecipeKinds";
import { YamlActionsRow } from "./YamlActionsRow";

/**
 * Sidebar disclosure for sharing the current view (as a query link or a
 * recipe link) and saving it to localStorage as a personal recipe.
 *
 * - "Copy query link" — exact current URL; reproduces the view including
 *   pinned mv + root.
 * - "Copy recipe link" — current URL stripped of mv/root/from/sel_*. When
 *   opened, the recipe-Open path takes over: mv auto-defaults to latest,
 *   user picks a cell.
 * - "Save as my recipe" — expands an inline form. On Save, mints a Recipe
 *   from URL state and persists in localStorage. Disabled when the URL
 *   has no decoration/plot/filter state to capture.
 *
 * The disclosure starts collapsed — it's a tertiary affordance, not a
 * primary workflow — but it sits above the existing Recipes widget so
 * related actions cluster.
 */
export function ShareMenu({ ds }: { ds: string }) {
  const [searchParams] = useSearchParams();
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [copied, setCopied] = useState<"query" | "recipe" | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const applicableKinds = useApplicableRecipeKinds();

  // Connectivity-only. /explore mounts ExplorerShareMenu inside the
  // explorer rail because the Selection bag (which an explorer save
  // needs to capture) only lives in FeatureExplorer's component
  // state. Landing (`/`) shows neither — there's no "current view"
  // to share from the picker.
  if (!applicableKinds.has("connectivity") || applicableKinds.size !== 1) {
    return null;
  }

  const hasContent = urlHasRecipeContent(searchParams);

  const onCopy = async (kind: "query" | "recipe") => {
    const link =
      kind === "query"
        ? buildQueryLink()
        : buildRecipeLink(
            searchParams,
            CONNECTIVITY_RECIPE_STRIP_KEYS,
            CONNECTIVITY_RECIPE_STRIP_PREFIXES,
          );
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      // Fall back to a prompt the user can manually copy from. Old browsers
      // and HTTP origins don't have async clipboard access.
      window.prompt("Copy link:", link);
      return;
    }
    setCopied(kind);
    window.setTimeout(() => setCopied((c) => (c === kind ? null : c)), 1500);
  };

  const onSave = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    const recipe = parseRecipeFromUrl(searchParams, {
      id: newPersonalId(),
      title: trimmed,
      description: description.trim() || undefined,
    });
    savePersonal(ds, recipe);
    setTitle("");
    setDescription("");
    setShowSaveForm(false);
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1500);
  };

  const onDownload = () => {
    if (!hasContent) return;
    const recipe = parseRecipeFromUrl(searchParams, {
      id: newPersonalId(),
      title: title.trim() || "Untitled connectivity view",
      description: description.trim() || undefined,
    });
    const yaml = connectivityAdapter.toYaml(recipe);
    const blob = new Blob([yaml], { type: "application/x-yaml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
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
    <details className="sidebar-share" open>
      <summary>Share / Save</summary>
      <div className="sidebar-share-actions">
        <button
          type="button"
          onClick={() => onCopy("query")}
          title="Copy a URL that reproduces the current cell, decorations, and filters"
        >
          {copied === "query" ? "Copied!" : "Copy query link"}
        </button>
        <button
          type="button"
          onClick={() => onCopy("recipe")}
          title="Copy a URL that applies this view's recipe to a cell of the recipient's choice"
        >
          {copied === "recipe" ? "Copied!" : "Copy recipe link"}
        </button>
        <button
          type="button"
          onClick={() => setShowSaveForm((s) => !s)}
          disabled={!hasContent}
          className={savedFlash ? "is-saved-flash" : undefined}
          title={
            hasContent
              ? "Save the current decorations, plots, and filters as a personal recipe"
              : "Configure decorations or plots before saving"
          }
        >
          {savedFlash ? "Saved!" : showSaveForm ? "Cancel" : "Save as my recipe"}
        </button>
        {showSaveForm && (
          <form className="sidebar-share-form" onSubmit={onSave}>
            <label>
              Title
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="My favorite view"
                autoFocus
                required
              />
            </label>
            <label>
              Description (optional)
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="What this view is good for"
              />
            </label>
            <button
              type="submit"
              disabled={!title.trim()}
              title="Save this view to your personal recipes for this datastack"
            >
              Save
            </button>
          </form>
        )}
        <YamlActionsRow
          ds={ds}
          onDownload={onDownload}
          downloadDisabled={!hasContent}
          downloadTitle={
            hasContent
              ? "Download the current connectivity view as YAML"
              : "Configure decorations or plots before downloading"
          }
          onUploaded={() => {
            setSavedFlash(true);
            window.setTimeout(() => setSavedFlash(false), 1500);
          }}
        />
      </div>
    </details>
  );
}
