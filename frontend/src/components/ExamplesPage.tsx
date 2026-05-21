import { useSearchParams } from "react-router-dom";

import { useExamples } from "../api/examples";
import { ExampleCard } from "./ExampleCard";

/**
 * /examples — top-level browsable card grid. URL parameters:
 *  - `?ds=<datastack>` filters to one datastack (set by Sidebar's
 *    Examples link in Task 3.5). Without it, the page shows a hint.
 *  - `?kind=connectivity|explorer` filters by kind.
 */
export function ExamplesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const ds = searchParams.get("ds");
  const kindParam = searchParams.get("kind");
  const kind =
    kindParam === "connectivity" || kindParam === "explorer" ? kindParam : undefined;

  const { data, isLoading, error } = useExamples(ds, kind);

  const setKindFilter = (next: "connectivity" | "explorer" | null) => {
    const params = new URLSearchParams(searchParams);
    if (next) params.set("kind", next);
    else params.delete("kind");
    setSearchParams(params, { replace: true });
  };

  if (!ds) {
    return (
      <section className="examples-page">
        <h2>Quickstart Examples</h2>
        <p className="muted">Pick a datastack from the sidebar to see examples.</p>
      </section>
    );
  }

  return (
    <section className="examples-page">
      <h2>Quickstart Examples</h2>
      <div className="examples-filters">
        <button
          type="button"
          onClick={() => setKindFilter(null)}
          className={kind ? "" : "active"}
          title="Show examples of every kind"
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setKindFilter("connectivity")}
          className={kind === "connectivity" ? "active" : ""}
          title="Show only Neuron View / connectivity examples"
        >
          Connectivity
        </button>
        <button
          type="button"
          onClick={() => setKindFilter("explorer")}
          className={kind === "explorer" ? "active" : ""}
          title="Show only Feature Explorer examples"
        >
          Explorer
        </button>
      </div>
      {isLoading && <p className="muted">Loading examples…</p>}
      {error && (
        <p className="error">Failed to load examples: {(error as Error).message}</p>
      )}
      {data && data.items.length === 0 && (
        <p className="muted">
          {data.hidden_count > 0
            ? `All ${data.hidden_count} example${data.hidden_count === 1 ? "" : "s"} for this datastack are pinned to retired versions; operator can republish.`
            : `No examples published for ${ds} yet.`}
        </p>
      )}
      {data && data.hidden_count > 0 && data.items.length > 0 && (
        <p className="muted small">
          {data.hidden_count} example{data.hidden_count === 1 ? " is" : "s are"} hidden —
          pinned to retired materialization version
          {data.hidden_count === 1 ? "" : "s"}.
        </p>
      )}
      <div className="examples-grid">
        {data?.items.map((ex) => (
          <ExampleCard key={ex.id} ds={ds} example={ex} />
        ))}
      </div>
    </section>
  );
}
