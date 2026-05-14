import type { EmbeddingListItem } from "../../api/types";

/** Generic column-picker used for x, y, color, and size channels. The
 *  column universe is identical across channels (parquet feature columns
 *  + parquet categorical columns + decoration columns); what varies is
 *  the label, the "leave at default" placeholder, and whether categorical
 *  columns are usable (size only takes numeric). */

export interface ChannelDecorationColumn {
  /** Display label, typically `table.column`. */
  label: string;
  /** The URL/wire value, typically `table.column`. */
  value: string;
  kind: "categorical" | "numeric";
}

interface Props {
  /** Rendered above the select, e.g. "X axis", "Color", "Size by". */
  label: string;
  embedding: EmbeddingListItem;
  decorationColumns?: ChannelDecorationColumn[];
  /** Currently-selected column from the URL. `null` means the channel
   *  is left at default; the select shows the default placeholder option. */
  value: string | null;
  onChange: (column: string | null) => void;
  /** Optional default-column name shown in the placeholder so the user
   *  sees what the manifest is falling back to. */
  defaultColumn?: string | null;
  /** Filter to numeric columns only. Used by the size channel — sizing
   *  by a categorical column would have to either dictionary-encode or
   *  pick a discrete size per category, both of which are unusual; the
   *  backend rejects categorical with a 422 anyway. */
  numericOnly?: boolean;
  /** When true, the "(none)" placeholder explicitly disables the
   *  channel (vs falling through to a default). Used for size (and any
   *  other strictly-optional channel) where there's no manifest default. */
  noneEnabled?: boolean;
  /** Display text for the default/empty option. Defaults to
   *  ``"(default: <col>)"`` when ``defaultColumn`` is set, else
   *  ``"(none)"``. */
  placeholderLabel?: string;
}

export function ChannelPicker({
  label,
  embedding,
  decorationColumns = [],
  value,
  onChange,
  defaultColumn,
  numericOnly = false,
  noneEnabled = false,
  placeholderLabel,
}: Props) {
  const feature = embedding.feature_columns ?? [];
  const categorical = numericOnly ? [] : (embedding.categorical_columns ?? []);
  const decorations = numericOnly
    ? decorationColumns.filter((c) => c.kind === "numeric")
    : decorationColumns;

  const placeholder =
    placeholderLabel ??
    (defaultColumn ? `(default: ${defaultColumn})` : noneEnabled ? "(none)" : "(default)");

  return (
    <div className="explore-picker">
      <label className="explore-picker-label">
        {label}
      </label>
      <select
        className="explore-picker-select"
        value={value ?? ""}
        onChange={(ev) => {
          const v = ev.target.value;
          // Empty string → "use the default" / "no channel". Stored as
          // null in URL state (param absent) so reading the URL doesn't
          // have to distinguish "explicitly defaulted" from "first
          // visit".
          onChange(v === "" ? null : v);
        }}
      >
        <option value="">{placeholder}</option>
        {feature.length > 0 && (
          <optgroup label="Numeric (parquet)">
            {feature.map((col) => (
              <option key={`num:${col}`} value={col}>{col}</option>
            ))}
          </optgroup>
        )}
        {categorical.length > 0 && (
          <optgroup label="Categorical (parquet)">
            {categorical.map((col) => (
              <option key={`cat:${col}`} value={col}>{col}</option>
            ))}
          </optgroup>
        )}
        {decorations.length > 0 && (
          <optgroup label="Decoration tables">
            {decorations.map((c) => (
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
