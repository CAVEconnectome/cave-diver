/**
 * Share / Save affordance for /explore. Mirrors the connectivity
 * ShareMenu (Copy query link, Copy recipe link, Save as my recipe)
 * but routes through the explorer adapter and — crucially — captures
 * the Selection bag at save time.
 *
 * Mount this inside FeatureExplorer (not the global Sidebar) because
 * the Selection bag lives in FeatureExplorer's component state and
 * isn't reachable from the Sidebar without lifting it into a global
 * store. The global Sidebar's ShareMenu detects /explore via
 * useApplicableRecipeKinds and renders nothing, so this is the sole
 * share affordance on the route.
 */
import { useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { explorerAdapter } from "../../tours/adapters/explorerAdapter";
import { newPersonalId, save as savePersonal } from "../../tours/personalRecipes";
import { parseRecipesFromYaml } from "../../tours/recipeFromYaml";
import {
  buildQueryLink,
  buildRecipeLink,
  EXPLORER_RECIPE_STRIP_KEYS,
  EXPLORER_RECIPE_STRIP_PREFIXES,
} from "../../tours/shareLinks";

interface Props {
  ds: string;
  /** The current Selection bag (cell_ids). Captured into the saved
   *  recipe verbatim — recipes preserve user intent, NOT the
   *  filter-scope intersection. See [[feature-explorer-scope-vs-selection-model]]. */
  selection: string[];
}

export function ExplorerShareMenu({ ds, selection }: Props) {
  const [searchParams] = useSearchParams();
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [copied, setCopied] = useState<"query" | "recipe" | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [uploadMessage, setUploadMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  const onUploadClick = () => fileInputRef.current?.click();

  const onFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseRecipesFromYaml(text);
    for (const recipe of parsed.recipes) savePersonal(ds, recipe);
    e.target.value = "";

    if (parsed.recipes.length > 0) {
      setUploadMessage({
        kind: "ok",
        text: `Loaded ${parsed.recipes.length} recipe${parsed.recipes.length === 1 ? "" : "s"}.`,
      });
      setSavedFlash(true);
      window.setTimeout(() => setSavedFlash(false), 1500);
    } else {
      const errText = parsed.errors[0] ?? "No recipes found in file.";
      setUploadMessage({ kind: "err", text: errText });
    }
    window.setTimeout(() => setUploadMessage(null), 4000);
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
        <button type="button" onClick={() => onCopy("query")}>
          {copied === "query" ? "Copied!" : "Copy query link"}
        </button>
        <button type="button" onClick={() => onCopy("recipe")}>
          {copied === "recipe" ? "Copied!" : "Copy recipe link"}
        </button>
        <button
          type="button"
          onClick={() => setShowSaveForm((s) => !s)}
          disabled={!hasContent}
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
            <button type="submit" disabled={!title.trim()}>Save</button>
          </form>
        )}
        <button
          type="button"
          onClick={onDownload}
          disabled={!hasContent}
          title={
            hasContent
              ? "Download the current explorer view as YAML"
              : "Configure the view before downloading"
          }
        >
          Download YAML
        </button>
        <button type="button" onClick={onUploadClick}>Upload YAML</button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".yaml,.yml,application/x-yaml,text/yaml"
          onChange={onFileChosen}
          style={{ display: "none" }}
        />
        {uploadMessage && (
          <p
            className={uploadMessage.kind === "err" ? "error" : "muted"}
            style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}
          >
            {uploadMessage.text}
          </p>
        )}
      </div>
    </details>
  );
}
