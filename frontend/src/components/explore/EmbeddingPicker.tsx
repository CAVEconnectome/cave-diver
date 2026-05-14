import type { EmbeddingListItem } from "../../api/types";

interface Props {
  embeddings: EmbeddingListItem[];
  /** Currently-selected embedding id, or null when none picked yet. */
  value: string | null;
  onChange: (id: string) => void;
}

/**
 * Dropdown for picking among the embeddings declared in the manifest.
 *
 * Single-entry datastacks render the title as a plain label rather than a
 * disabled select — looks tidier and removes a click target that has no
 * effect. Multi-entry datastacks render a real `<select>`.
 */
export function EmbeddingPicker({ embeddings, value, onChange }: Props) {
  if (embeddings.length === 0) {
    return <div className="explore-picker explore-picker-empty">No embeddings configured.</div>;
  }
  if (embeddings.length === 1) {
    const e = embeddings[0];
    return (
      <div className="explore-picker">
        <label className="explore-picker-label">Embedding</label>
        <div className="explore-picker-static" title={e.description ?? undefined}>
          {e.title}
        </div>
      </div>
    );
  }
  return (
    <div className="explore-picker">
      <label className="explore-picker-label" htmlFor="explore-embedding-select">
        Embedding
      </label>
      <select
        id="explore-embedding-select"
        className="explore-picker-select"
        value={value ?? ""}
        onChange={(ev) => onChange(ev.target.value)}
      >
        {value == null && <option value="">— pick one —</option>}
        {embeddings.map((e) => (
          <option key={e.id} value={e.id} title={e.description ?? undefined}>
            {e.title}
          </option>
        ))}
      </select>
    </div>
  );
}
