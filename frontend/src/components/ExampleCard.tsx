import { useState } from "react";
import { useNavigate } from "react-router-dom";

import type { ConnectivityRecipe, Example, ExplorerRecipe } from "../api/types";
import { fetchExample, thumbnailUrl } from "../api/examples";
import { adapterFor } from "../tours/adapters/registry";

/**
 * One example card in the /examples grid. Two click affordances:
 *  - Anywhere on the card body → fetch full payload, navigate to the
 *    target viewer (kind-derived) with pinned.mv applied silently.
 *  - The chevron in the corner → toggle inline full_text expansion
 *    without navigating.
 */
export function ExampleCard({ ds, example }: { ds: string; example: Example }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onOpen = async () => {
    if (opening) return;   // guard against double-clicks while a fetch is in flight
    setOpening(true);
    setError(null);
    try {
      const full = await fetchExample(ds, example.id);
      const mv = String(full.pinned.mv);
      if (full.kind === "connectivity") {
        const adapter = adapterFor("connectivity");
        // Strip example-specific card-metadata; supply defaults for
        // required ConnectivityRecipe fields that are optional on the
        // Example wire shape (decoration_tables / plots / hide / show / coll).
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { title, summary, full_text, thumbnail, pinned, ...rest } = full;
        const recipe: ConnectivityRecipe = {
          id: rest.id,
          kind: "connectivity",
          title: full.title,
          description: rest.description,
          decoration_tables: rest.decoration_tables ?? [],
          plots: rest.plots ?? [],
          cells: rest.cells,
          hide: rest.hide ?? [],
          show: rest.show ?? [],
          coll: rest.coll ?? [],
          ...(rest.scope !== undefined ? { scope: rest.scope } : {}),
        };
        const params = adapter.buildOpenParams(ds, recipe, mv);
        if (full.pinned.root) {
          params.set("root", full.pinned.root);
        }
        navigate(`${adapter.openRoute}?${params.toString()}`);
      } else {
        const adapter = adapterFor("explorer");
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { title, summary, full_text, thumbnail, pinned, ...rest } = full;
        const recipe: ExplorerRecipe = {
          id: rest.id,
          kind: "explorer",
          title: full.title,
          explorer: rest.explorer,
          ...(rest.scope !== undefined ? { scope: rest.scope } : {}),
        };
        const params = adapter.buildOpenParams(ds, recipe, mv);
        const navState =
          full.explorer.selection
            ? { selection: full.explorer.selection }
            : undefined;
        navigate(`${adapter.openRoute}?${params.toString()}`, { state: navState });
      }
    } catch (e) {
      setError((e as Error).message);
      setOpening(false);
    }
  };

  const thumb = thumbnailUrl(ds, example.thumbnail);

  return (
    <article
      className="example-card"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      role="button"
      tabIndex={0}
      aria-busy={opening}
    >
      <div className="example-card-thumb">
        {thumb ? <img src={thumb} alt="" /> : <div className="example-card-thumb-placeholder" />}
      </div>
      <div className="example-card-body">
        <header>
          <h4>{example.title}</h4>
          {example.full_text && (
            <button
              type="button"
              className="example-card-chevron"
              aria-label={expanded ? "Collapse description" : "Expand description"}
              aria-expanded={expanded}
              onClick={(e) => { e.stopPropagation(); setExpanded((s) => !s); }}
            >
              {expanded ? "▴" : "▾"}
            </button>
          )}
        </header>
        <p className="example-card-summary">{example.summary}</p>
        {expanded && example.full_text && (
          <p className="example-card-full-text">{example.full_text}</p>
        )}
        <footer className="example-card-footer">
          <span>{example.kind}</span>
          <span>·</span>
          <span>{ds}</span>
          <span>·</span>
          <span>mv {example.pinned.mv}</span>
        </footer>
        {opening && <p className="example-card-status">Opening…</p>}
        {error && <p className="example-card-error">{error}</p>}
      </div>
    </article>
  );
}
