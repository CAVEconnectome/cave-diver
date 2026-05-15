import { useMemo } from "react";
import type { ColumnGroup, FeatureTableListItem } from "../../api/types";
import { SizeRangeSlider } from "./SizeRangeSlider";

interface ChannelOption {
  /** URL/query value — `<table>.<col>` (always dotted, since parquet
   *  columns are prefixed with the feature_table id and decoration
   *  columns are `<dec_table>.<col>`). */
  value: string;
  /** Display label — the bare column name. */
  label: string;
  /** Source group, for the optgroup header. */
  source: "features" | "categoricals" | string;
  /** Whether the option supports the size channel (numeric only). */
  isNumeric?: boolean;
}

interface Props {
  /** The currently-selected feature table — used to enumerate parquet
   *  columns. */
  featureTable: FeatureTableListItem | null;
  /** Column_groups from the /cells response — used to surface
   *  decoration-table columns once a decoration table is attached.
   *  Pass undefined if /cells hasn't loaded yet; the picker degrades
   *  to parquet-only options. */
  cellsColumnGroups?: ColumnGroup[];
  x: string | null;
  y: string | null;
  colorBy: string | null;
  sizeBy: string | null;
  /** Current px range for the size channel (defaults applied by the
   *  parent — typically 2/18). */
  sizeMinPx: number;
  sizeMaxPx: number;
  defaultXLabel?: string; // shown when x is null (the embedding's declared axis)
  defaultYLabel?: string;
  defaultColorLabel?: string | null; // embedding's default_color_by
  onChange: (next: {
    x?: string | null;
    y?: string | null;
    colorBy?: string | null;
    sizeBy?: string | null;
    sizeMinPx?: number;
    sizeMaxPx?: number;
  }) => void;
}

/**
 * Seaborn-style x/y/color/size channel pickers.
 *
 * Four selectors that bind to the universe scatter. Each option carries
 * its provenance (feature-table parquet column or decoration table
 * column) and a numeric-vs-categorical hint so the size picker shows
 * only numeric options.
 *
 * The bindings travel in URL state (`?x`, `?y`, `?color`, `?size`)
 * which is parsed by `FeatureExplorer` and threaded into the
 * `useEmbeddingScatter` hook. The backend's /scatter endpoint
 * substitutes the bound columns into its parallel-array payload and
 * (for categorical color) attaches a `color_map` derived from the
 * project's shared categorical-palette resolver.
 */
export function ChannelPicker({
  featureTable,
  cellsColumnGroups,
  x,
  y,
  colorBy,
  sizeBy,
  sizeMinPx,
  sizeMaxPx,
  defaultXLabel,
  defaultYLabel,
  defaultColorLabel,
  onChange,
}: Props) {
  const { axisOptions, colorOptions, sizeOptions } = useMemo(() => {
    const parquetNumeric: ChannelOption[] = (featureTable?.feature_columns ?? []).map(
      (c) => ({
        value: `${featureTable!.id}.${c}`,
        label: c,
        source: "features",
        isNumeric: true,
      }),
    );
    const parquetCategorical: ChannelOption[] = featureTable
      ? featureTable.categorical_columns.map((c) => ({
          value: `${featureTable.id}.${c}`,
          label: c,
          source: "categoricals",
          isNumeric: false,
        }))
      : [];
    // Decoration tables show up in the /cells response's column_groups
    // as `kind: "table"` entries with the table name. We surface all
    // columns from those groups — we don't know which are numeric until
    // a row sample arrives, so the size channel treats them all as
    // candidates and the backend 422s on non-numeric (caught + shown).
    const decorationOptions: ChannelOption[] = [];
    for (const g of cellsColumnGroups ?? []) {
      if (g.kind !== "table") continue;
      if (g.name === featureTable?.id) continue; // already covered above
      for (const fullCol of g.columns) {
        const bare = fullCol.includes(".") ? fullCol.slice(fullCol.indexOf(".") + 1) : fullCol;
        decorationOptions.push({
          value: fullCol,
          label: bare,
          source: g.name,
          // Unknown without a sample; the size channel falls back to a
          // type check on the backend.
        });
      }
    }
    const all = [...parquetNumeric, ...parquetCategorical, ...decorationOptions];
    return {
      axisOptions: all, // any column can be on an axis
      colorOptions: all,
      sizeOptions: all.filter((o) => o.isNumeric !== false), // numerics + decoration (unknown)
    };
  }, [featureTable, cellsColumnGroups]);

  return (
    <div className="explore-channels">
      <div className="explore-picker-label">Channels</div>
      <ChannelSelect
        label="x"
        value={x}
        defaultLabel={defaultXLabel}
        options={axisOptions}
        onChange={(v) => onChange({ x: v })}
      />
      <ChannelSelect
        label="y"
        value={y}
        defaultLabel={defaultYLabel}
        options={axisOptions}
        onChange={(v) => onChange({ y: v })}
      />
      <ChannelSelect
        label="color"
        value={colorBy}
        defaultLabel={defaultColorLabel ?? "—"}
        options={colorOptions}
        allowNone
        onChange={(v) => onChange({ colorBy: v })}
      />
      <ChannelSelect
        label="size"
        value={sizeBy}
        defaultLabel="—"
        options={sizeOptions}
        allowNone
        onChange={(v) => onChange({ sizeBy: v })}
      />
      {sizeBy && (
        <SizeRangeSlider
          minPx={sizeMinPx}
          maxPx={sizeMaxPx}
          onChange={(next) =>
            onChange({
              ...(next.minPx !== undefined ? { sizeMinPx: next.minPx } : {}),
              ...(next.maxPx !== undefined ? { sizeMaxPx: next.maxPx } : {}),
            })
          }
        />
      )}
    </div>
  );
}

function ChannelSelect({
  label,
  value,
  defaultLabel,
  options,
  allowNone,
  onChange,
}: {
  label: string;
  value: string | null;
  defaultLabel?: string;
  options: ChannelOption[];
  allowNone?: boolean;
  onChange: (next: string | null) => void;
}) {
  // Group options by source for an optgroup-style render.
  const grouped: Record<string, ChannelOption[]> = {};
  for (const o of options) {
    (grouped[o.source] ??= []).push(o);
  }
  return (
    <label className="explore-channel">
      <span className="explore-channel-label">{label}</span>
      <select
        className="explore-channel-select"
        value={value ?? ""}
        onChange={(ev) => {
          const v = ev.target.value;
          onChange(v === "" ? null : v);
        }}
      >
        <option value="">
          {allowNone
            ? defaultLabel && defaultLabel !== "—"
              ? `default (${defaultLabel})`
              : "none"
            : defaultLabel
              ? `default (${defaultLabel})`
              : "—"}
        </option>
        {Object.entries(grouped).map(([source, opts]) => (
          <optgroup key={source} label={source}>
            {opts.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
