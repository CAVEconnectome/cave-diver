/**
 * Share / Save affordance for /explore. Mirrors the connectivity
 * ShareMenu (Copy query link, Copy recipe link, Save as my recipe)
 * but routes through the explorer adapter and — crucially — captures
 * the Selection bag at save time.
 *
 * Mounted in the global Sidebar (not the explorer rail) for layout
 * parity with /neuron's ShareMenu. The Selection bag is read from the
 * `explorerSelection` module-level singleton, which FeatureExplorer
 * writes to via `useExplorerSelection`. Gated by route via
 * `useApplicableRecipeKinds` — renders nothing outside /explore.
 */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { explorerAdapter } from "../../tours/adapters/explorerAdapter";
import { useExplorerSelection } from "../../tours/explorerSelection";
import { newPersonalId, save as savePersonal } from "../../tours/personalRecipes";
import {
  buildQueryLink,
  buildRecipeLink,
  EXPLORER_RECIPE_STRIP_KEYS,
  EXPLORER_RECIPE_STRIP_PREFIXES,
} from "../../tours/shareLinks";
import { useApplicableRecipeKinds } from "../../tours/useApplicableRecipeKinds";
import { YamlActionsRow } from "../YamlActionsRow";

interface Props {
  ds: string;
}

export function ExplorerShareMenu({ ds }: Props) {
  const [searchParams] = useSearchParams();
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [copied, setCopied] = useState<"query" | "recipe" | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const applicableKinds = useApplicableRecipeKinds();
  const [selection] = useExplorerSelection();

  // Explorer-only. Mirrors ShareMenu's route gate: ShareMenu shows on
  // /neuron, ExplorerShareMenu shows on /explore, neither shows on /.
  if (!applicableKinds.has("explorer") || applicableKinds.size !== 1) {
    return null;
  }

  // "Has content" considers both URL-shape state (scatter bindings,
  // growth params, decorations, cells filter) and the Selection bag.
  // A user with nothing but a hand-curated lasso should still be able
  // to save — the bag IS the recipe payload in that case.
  const hasContent = explorerAdapter.urlHasContent(searchParams, {
    id: "tmp",
    title: "tmp",
    extras: { selection },
  });

  const onCopy = async (kind: "query" | "recipe") => {
    const link =
      kind === "query"
        ? buildQueryLink()
        : buildRecipeLink(
            searchParams,
            EXPLORER_RECIPE_STRIP_KEYS,
            EXPLORER_RECIPE_STRIP_PREFIXES,
          );
    try {
      await navigator.clipboard.writeText(link);
    } catch {
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
    const recipe = explorerAdapter.parseFromUrl(searchParams, {
      id: newPersonalId(),
      title: trimmed,
      description: description.trim() || undefined,
      extras: { selection },
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
    const recipe = explorerAdapter.parseFromUrl(searchParams, {
      id: newPersonalId(),
      title: title.trim() || "Untitled explorer view",
      description: description.trim() || undefined,
      extras: { selection },
    });
    const yaml = explorerAdapter.toYaml(recipe);
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

  const selectionHint =
    selection.length > 0
      ? ` (incl. ${selection.length.toLocaleString()} selected cell${
          selection.length === 1 ? "" : "s"
        })`
      : "";

  return (
    <details className="sidebar-share explorer-share" open>
      <summary>Share / Save</summary>
      <div className="sidebar-share-actions">
        <button
          type="button"
          onClick={() => onCopy("query")}
          title="Copy a URL that reproduces this explorer view, including the current selection"
        >
          {copied === "query" ? "Copied!" : "Copy query link"}
        </button>
        <button
          type="button"
          onClick={() => onCopy("recipe")}
          title="Copy a URL that applies this explorer view as a recipe (without the current selection)"
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
              ? `Save the current explorer view${selectionHint}`
              : "Configure scatter bindings or build a selection before saving"
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
                placeholder="My explorer view"
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
            {selection.length > 0 && (
              <p className="muted small">
                Will include {selection.length.toLocaleString()} selected
                cell{selection.length === 1 ? "" : "s"}.
              </p>
            )}
            <button
              type="submit"
              disabled={!title.trim()}
              title="Save this explorer view to your personal recipes for this datastack"
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
              ? "Download the current explorer view as YAML"
              : "Configure the view before downloading"
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
