import type { EmbeddingListItem } from "../../api/types";

interface Props {
  embedding: EmbeddingListItem;
  /** Current selection. `null` shows the default-marker option; the
   *  effective color column in that state is `embedding.default_color_by`. */
  value: string | null;
  onChange: (column: string | null) => void;
  /** Hook for task #10: decoration table columns merged into the picker
   *  when the user attaches a table via `?dec=`. v1 leaves this empty. */
  decorationColumns?: Array<{ label: string; value: string; source: string }>;
}

/**
 * Color-by picker. v1 surfaces the embedding's parquet columns
 * (feature_columns + categorical_columns); task #10 extends this same
 * picker with `table.column` entries from attached decoration tables.
 *
 * Categorical columns appear in a separate optgroup so the user can scan
 * the kind quickly — most cell-type-style coloring goes through
 * categorical, most distribution-style coloring through numeric.
 */
export function ColorByPicker({ embedding, value, onChange, decorationColumns = [] }: Props) {
  const feature = embedding.feature_columns ?? [];
  const categorical = embedding.categorical_columns ?? [];

  return (
    <div className="explore-picker">
      <label className="explore-picker-label" htmlFor="explore-color-select">
        Color by
      </label>
      <select
        id="explore-color-select"
        className="explore-picker-select"
        value={value ?? ""}
        onChange={(ev) => {
          const v = ev.target.value;
          // Empty string → "use the manifest default". Stored as null in the
          // URL state (param absent) so reading the URL doesn't have to
          // distinguish "explicitly defaulted" from "first visit".
          onChange(v === "" ? null : v);
        }}
      >
        <option value="">
          {embedding.default_color_by ? `(default: ${embedding.default_color_by})` : "(no color)"}
        </option>
        {categorical.length > 0 && (
          <optgroup label="Categorical (parquet)">
            {categorical.map((col) => (
              <option key={`cat:${col}`} value={col}>{col}</option>
            ))}
          </optgroup>
        )}
        {feature.length > 0 && (
          <optgroup label="Numeric (parquet)">
            {feature.map((col) => (
              <option key={`num:${col}`} value={col}>{col}</option>
            ))}
          </optgroup>
        )}
        {decorationColumns.length > 0 && (
          <optgroup label="Decoration tables">
            {decorationColumns.map((c) => (
              <option key={`dec:${c.value}`} value={c.value}>
                {c.label}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
