import { useMemo, useState, type ReactNode } from "react";
import { useUrlParam } from "../hooks/useUrlState";
import type { ColumnGroup, FeatureCategory, PartnerRecord } from "../api/types";

const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "notin", "nonnull", "null"] as const;
type Op = (typeof OPS)[number];

// "between" exists only in the UI: in the builder as a pseudo-op for
// numeric columns, and in the chip rendering as a merged display of an
// adjacent (gte, lte) pair. On the wire it remains two clauses, so the
// backend parser doesn't need to learn anything new.
type BuilderOp = Op | "between";

// Ops the picker exposes per inferred column kind. Numeric gets the full
// comparator set plus "between"; strings get equality + membership only
// (range filters on strings are rarely useful and trip users up);
// booleans collapse to four pseudo-ops in the UI (handled separately).
type ColumnKind = "boolean" | "numeric" | "string" | "unknown";

const OPS_FOR_KIND: Record<Exclude<ColumnKind, "boolean">, readonly BuilderOp[]> = {
  numeric: ["eq", "ne", "gt", "gte", "lt", "lte", "between", "in", "notin", "null", "nonnull"],
  string: ["eq", "ne", "in", "notin", "null", "nonnull"],
  // No type evidence — show everything so the user can still build a
  // predicate. We include "between" too, since the user may know more
  // about the column kind than our sampler can infer.
  unknown: [...OPS, "between"],
};

// Symbols + plain-language for display. Wire format stays as the keys.
// The wordy suffix in the builder dropdown lets non-programmers read
// the math symbols ("≥" with "(at least)") without first decoding them.
const OP_SYMBOL: Record<BuilderOp, string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  in: "in",
  notin: "not in",
  nonnull: "is not null",
  null: "is null",
  between: "between",
};

// Builder dropdown uses plain-language labels so users don't have to
// decode math symbols at edit time — the chip is where compactness
// matters and the symbols pay off.
const OP_DROPDOWN_LABEL: Record<BuilderOp, string> = {
  eq: "equals",
  ne: "not equal",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  in: "is one of",
  notin: "is none of",
  nonnull: "is not null",
  null: "is null",
  between: "between",
};

// Boolean columns get a single "predicate" select with four mutually-exclusive
// options that map to backend op+value pairs. Avoids the awkward "eq + true"
// flow when the answer space is so small.
const BOOL_PREDICATES = [
  { label: "is true", op: "eq" as Op, value: "true" },
  { label: "is false", op: "eq" as Op, value: "false" },
  { label: "is null", op: "null" as Op, value: "" },
  { label: "is not null", op: "nonnull" as Op, value: "" },
];

/**
 * Sniff a column's type from a small sample of partner rows. Cheap because
 * partners arrays are bounded and we only inspect non-null cells until we
 * have enough evidence to decide. Falls back to "unknown" when the sample is
 * empty (e.g. column was just added to decoration_tables and no rows have
 * a value yet).
 */
function inferColumnKind(rows: PartnerRecord[], qualifiedKey: string): ColumnKind {
  let nNumeric = 0;
  let nBool = 0;
  let nString = 0;
  let nNonNull = 0;
  const SAMPLE_LIMIT = 200;
  for (let i = 0; i < rows.length && nNonNull < SAMPLE_LIMIT; i += 1) {
    const v = rows[i][qualifiedKey];
    if (v === null || v === undefined) continue;
    nNonNull += 1;
    if (typeof v === "boolean") nBool += 1;
    else if (typeof v === "number") nNumeric += 1;
    else nString += 1;
  }
  if (nNonNull === 0) return "unknown";
  if (nBool === nNonNull) return "boolean";
  if (nNumeric === nNonNull) return "numeric";
  if (nString === nNonNull) return "string";
  return "unknown";
}

interface Predicate {
  table: string;
  column: string;
  op: Op;
  value: string;
  /** When false, the predicate is encoded with a leading `~` so the backend
   *  parser drops it. Lets users build a filter, toggle it off to compare,
   *  then toggle it back on without retyping. */
  enabled: boolean;
}

// Parse `?cells=table.col:op:val[,table.col:op:val...]` into structured
// predicates. Mirrors the backend parser in services/plots.py — keeping the
// two in sync is the cost of a URL-driven design, but the gain is that the
// URL is the single source of truth and shareable. A leading `~` on a clause
// marks it disabled (parsed but ignored by the backend).
function parseCells(raw: string | null): Predicate[] {
  if (!raw) return [];
  const out: Predicate[] = [];
  for (const clause of raw.split(",")) {
    let trimmed = clause.trim();
    if (!trimmed) continue;
    let enabled = true;
    if (trimmed.startsWith("~")) {
      enabled = false;
      trimmed = trimmed.slice(1).trim();
      if (!trimmed) continue;
    }
    const firstColon = trimmed.indexOf(":");
    if (firstColon < 0) continue;
    const head = trimmed.slice(0, firstColon);
    const rest = trimmed.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    const opStr = secondColon < 0 ? rest : rest.slice(0, secondColon);
    const value = secondColon < 0 ? "" : rest.slice(secondColon + 1);
    const dot = head.indexOf(".");
    if (dot < 0) continue;
    const table = head.slice(0, dot);
    const column = head.slice(dot + 1);
    if (!table || !column || !OPS.includes(opStr as Op)) continue;
    out.push({ table, column, op: opStr as Op, value, enabled });
  }
  return out;
}

function encodeCells(preds: Predicate[]): string | null {
  if (preds.length === 0) return null;
  return preds
    .map((p) => `${p.enabled ? "" : "~"}${p.table}.${p.column}:${p.op}:${p.value}`)
    .join(",");
}

// Display items: either a single predicate, or a merged "between" pair.
// The merge is purely cosmetic — under the hood there are still two
// predicates in URL state, and removing/toggling a "between" affects
// both. Detected for adjacent same-column (gte, lte) pairs in either
// order so the user-facing chip stays compact regardless of which side
// they entered first.
type DisplayItem =
  | { kind: "single"; indices: [number]; pred: Predicate }
  | {
      kind: "between";
      indices: [number, number];
      table: string;
      column: string;
      lo: string;
      hi: string;
      enabled: boolean;
    };

function mergeBetween(preds: Predicate[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  for (let i = 0; i < preds.length; i++) {
    const a = preds[i];
    const b = preds[i + 1];
    const pair = matchBetweenPair(a, b);
    if (pair) {
      out.push({
        kind: "between",
        indices: [i, i + 1],
        table: a.table,
        column: a.column,
        lo: pair.lo,
        hi: pair.hi,
        enabled: a.enabled,
      });
      i += 1; // skip the partner
    } else {
      out.push({ kind: "single", indices: [i], pred: a });
    }
  }
  return out;
}

/** Match a (gte, lte) or (lte, gte) pair on the same column with the same
 *  enabled state into a between-display. Returns {lo, hi} string values
 *  (the URL representation — kept as strings since we don't need numeric
 *  arithmetic on them for display) or null if the pair doesn't qualify. */
function matchBetweenPair(
  a: Predicate | undefined,
  b: Predicate | undefined,
): { lo: string; hi: string } | null {
  if (!a || !b) return null;
  if (a.table !== b.table || a.column !== b.column) return null;
  if (a.enabled !== b.enabled) return null;
  if (a.op === "gte" && b.op === "lte") return { lo: a.value, hi: b.value };
  if (a.op === "lte" && b.op === "gte") return { lo: b.value, hi: a.value };
  return null;
}

interface Props {
  // The connectivity bundle's column_groups; we surface decoration / cell-type
  // groups as the picker's table choices. Synapse / intrinsic / soma columns
  // aren't exposed here — they aren't `<table>.<col>` qualified, so the
  // backend parser would reject them.
  columnGroups?: ColumnGroup[];
  // Sample rows for column-type inference. Pass partners_in + partners_out
  // (or any subset). Used purely to decide which ops the picker exposes —
  // the actual filter still runs server-side.
  sampleRows?: PartnerRecord[];
  /** Optional manifest-declared categories per table, keyed by the
   *  table name in `columnGroups`. When the active table has
   *  categories declared, the column dropdown renders as optgroups —
   *  matching the channel pickers' optgroup behavior so the user sees
   *  the same organization in both surfaces. Tables not in this map
   *  (decoration tables, partners-frame intrinsic tables) render flat
   *  as before. */
  categoriesByTable?: Record<string, FeatureCategory[]>;
  /** Distinct-value universe per qualified column (`${table}.${col}`).
   *  When a column being filtered has entries here, the predicate
   *  builder swaps free-text input for a dropdown (eq/ne) or checkbox
   *  multi-select (in/notin), mirroring the table view's categorical
   *  filter UX. Missing columns fall back to free-text — works for
   *  parquet feature-table strings (no /values endpoint for those) and
   *  for tables whose unique-values fetch failed. */
  availableValues?: Record<string, string[]>;
}

/**
 * Sidebar panel for the global "cells" plot filter.
 *
 * Predicates are encoded into the `?cells=` URL param so the filter is part
 * of every shared link. Chips show the active predicates with a × to remove;
 * the + button opens a small builder for a new predicate (table → column →
 * op → value). The full predicate text is the chip label so users learn the
 * grammar by reading their own filters.
 */
export function CellFilterPanel({ columnGroups, sampleRows, categoriesByTable, availableValues }: Props) {
  const [raw, setRaw] = useUrlParam("cells");
  const preds = useMemo(() => parseCells(raw), [raw]);
  const items = useMemo(() => mergeBetween(preds), [preds]);
  const [adding, setAdding] = useState(false);

  // Annotation-table groups own the dotted column names that the backend
  // parser expects. Synapse / intrinsic / soma columns are excluded — they
  // aren't qualified by a table prefix.
  const tableGroups = useMemo(
    () => (columnGroups ?? []).filter((g) => g.kind === "table"),
    [columnGroups],
  );

  // Remove a set of indices from preds (so removing a "between" drops
  // both clauses in one URL write).
  const removeIndices = (indices: number[]) => {
    const drop = new Set(indices);
    const next = preds.filter((_, j) => !drop.has(j));
    setRaw(encodeCells(next));
  };
  const toggleIndices = (indices: number[]) => {
    const flip = new Set(indices);
    // Use the first index's current state to compute the new state, so
    // a "between" pair toggles atomically rather than each clause
    // flipping independently if they ever drifted out of sync.
    const newEnabled = !preds[indices[0]].enabled;
    const next = preds.map((p, j) =>
      flip.has(j) ? { ...p, enabled: newEnabled } : p,
    );
    setRaw(encodeCells(next));
  };
  const addPredicates = (toAdd: Omit<Predicate, "enabled">[]) => {
    const enabled = toAdd.map((p) => ({ ...p, enabled: true }));
    setRaw(encodeCells([...preds, ...enabled]));
    setAdding(false);
  };

  // Disable the "add predicate" affordance when there's no table to
  // filter on. The "Load a decoration table first" hint surfaces via
  // the title attribute on the disabled button.
  const noTables = tableGroups.length === 0;

  return (
    <div className="cell-filter-panel">
      {/* No inline "Cell filter" header — the popover title (Filter
          Scope) already labels the surface. Removing the redundant
          subheader gives the chips + builder more breathing room. */}
      {items.length > 0 && (
        <div className="cell-filter-chips">
          {items.map((item, i) => (
            <ChipView
              key={i}
              item={item}
              onToggle={() => toggleIndices(item.indices)}
              onRemove={() => removeIndices(item.indices)}
            />
          ))}
        </div>
      )}
      {/* Add-predicate affordance is shape-shifted by context: a
          single primary "Build a predicate" button when no chips
          exist (empty state), a ghost "+ add predicate" link when
          chips are already there. Both open the builder card. The
          builder hides this trigger while open — only one editor at
          a time. */}
      {!adding &&
        (items.length === 0 ? (
          <button
            type="button"
            className="cell-filter-add-primary"
            onClick={() => setAdding(true)}
            disabled={noTables}
            title={
              noTables
                ? "Load a decoration table first"
                : "Open the filter builder"
            }
          >
            + Build a filter
          </button>
        ) : (
          <button
            type="button"
            className="cell-filter-add-ghost"
            onClick={() => setAdding(true)}
            disabled={noTables}
            title={
              noTables
                ? "Load a decoration table first"
                : "Add another filter"
            }
          >
            + add filter
          </button>
        ))}
      {adding && (
        <PredicateBuilder
          tableGroups={tableGroups}
          sampleRows={sampleRows ?? []}
          categoriesByTable={categoriesByTable}
          availableValues={availableValues}
          onCancel={() => setAdding(false)}
          onAdd={addPredicates}
        />
      )}
    </div>
  );
}

/** Render a single chip — single predicate or merged between. Both share
 *  the same outer structure (text + delete) so they line up visually. */
function ChipView({
  item,
  onToggle,
  onRemove,
}: {
  item: DisplayItem;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const enabled = item.kind === "single" ? item.pred.enabled : item.enabled;
  return (
    <span className={`cell-filter-chip${enabled ? "" : " disabled"}`}>
      <button
        type="button"
        className="chip-text"
        onClick={onToggle}
        title={enabled ? "Click to disable" : "Click to enable"}
      >
        {item.kind === "between" ? (
          <>
            <ColumnPath table={item.table} column={item.column} /> between {item.lo}{" "}
            and {item.hi}
          </>
        ) : (
          renderSinglePredicate(item.pred)
        )}
      </button>
      <button
        type="button"
        onClick={onRemove}
        aria-label="remove"
        title="Remove this filter"
      >×</button>
    </span>
  );
}

/** Render `table/column` as a styled span — slash separator matches the
 *  plot-label convention and reads as a path the user can parse at a
 *  glance, where a dot tends to vanish next to long identifiers. */
function ColumnPath({ table, column }: { table: string; column: string }) {
  return (
    <span className="cell-filter-colpath">
      <span className="cell-filter-colpath-table">{table}</span>
      <span className="cell-filter-colpath-sep">/</span>
      <span className="cell-filter-colpath-col">{column}</span>
    </span>
  );
}

/** Build the body of a single-predicate chip. Boolean-looking values
 *  (eq true / eq false) get the "is true" / "is false" phrasing
 *  instead of the bare comparator since that's how users describe a
 *  flag. Other comparators get the symbol from OP_SYMBOL. Membership
 *  ops translate to "is one of {…}" / "is none of {…}" with the
 *  pipe-separated wire values rendered as a comma list. */
function renderSinglePredicate(p: Predicate): ReactNode {
  const path = <ColumnPath table={p.table} column={p.column} />;
  if (p.op === "nonnull") return <>{path} is not null</>;
  if (p.op === "null") return <>{path} is null</>;
  if (p.op === "eq" && (p.value === "true" || p.value === "false")) {
    return <>{path} is {p.value}</>;
  }
  if (p.op === "ne" && (p.value === "true" || p.value === "false")) {
    return <>{path} is not {p.value}</>;
  }
  if (p.op === "in" || p.op === "notin") {
    const verb = p.op === "in" ? "is one of" : "is none of";
    const display = p.value.split("|").filter(Boolean).join(", ");
    return (
      <>
        {path} {verb} {"{"}
        {display}
        {"}"}
      </>
    );
  }
  const sym = OP_SYMBOL[p.op as BuilderOp] ?? p.op;
  return <>{path} {sym} {p.value}</>;
}

interface BuilderProps {
  tableGroups: ColumnGroup[];
  sampleRows: PartnerRecord[];
  /** Optional category structure per table. When the active table has
   *  categories, the column select renders as optgroups; otherwise
   *  flat (the legacy behavior). */
  categoriesByTable?: Record<string, FeatureCategory[]>;
  /** Distinct-value universe per qualified column. When the active
   *  column has entries, eq/ne render as a `<select>` and in/notin
   *  render as a checkbox list — matching the table view's pattern.
   *  Columns without entries fall back to free-text. */
  availableValues?: Record<string, string[]>;
  onCancel: () => void;
  onAdd: (preds: Omit<Predicate, "enabled">[]) => void;
}

// Bare column name from a possibly-dotted column key. Decoration columns ship
// as `<table>.<col>` in column_groups; cell-type columns sometimes ship bare.
function bareColumn(c: string): string {
  return c.includes(".") ? c.split(".").slice(1).join(".") : c;
}

function PredicateBuilder({ tableGroups, sampleRows, categoriesByTable, availableValues, onCancel, onAdd }: BuilderProps) {
  const [table, setTable] = useState(tableGroups[0]?.name ?? "");
  const tableCols = useMemo(() => {
    const group = tableGroups.find((g) => g.name === table);
    if (!group) return [] as string[];
    return group.columns.map(bareColumn);
  }, [tableGroups, table]);
  const [column, setColumn] = useState(tableCols[0] ?? "");
  const [op, setOp] = useState<BuilderOp>("eq");
  const [value, setValue] = useState("");
  // Between-mode lo/hi inputs. Only consulted when op === "between"; the
  // single `value` state stays untouched so the user's typing in one
  // mode doesn't leak into another.
  const [betweenLo, setBetweenLo] = useState("");
  const [betweenHi, setBetweenHi] = useState("");
  // Boolean-mode pseudo-op index (into BOOL_PREDICATES). Only consulted when
  // the picked column's inferred kind is "boolean".
  const [boolIdx, setBoolIdx] = useState(0);

  const columnKind = useMemo<ColumnKind>(() => {
    if (!table || !column) return "unknown";
    return inferColumnKind(sampleRows, `${table}.${column}`);
  }, [sampleRows, table, column]);

  // Build the column dropdown's optgroup layout. When the active
  // table has manifest-declared categories, group by category title
  // + an implicit "Uncategorized" bucket for parquet columns the
  // manifest didn't file; otherwise render flat (a single anonymous
  // group). Parallels the ChannelPicker grouping so the two surfaces
  // present the column universe identically.
  const columnSections = useMemo<{ title: string | null; columns: string[] }[]>(() => {
    const categories = categoriesByTable?.[table];
    if (!categories || categories.length === 0) {
      return [{ title: null, columns: tableCols }];
    }
    const available = new Set(tableCols);
    const referenced = new Set<string>();
    const sections: { title: string | null; columns: string[] }[] = [];
    for (const cat of categories) {
      const cols = cat.columns.filter((c) => available.has(c));
      // Track referenced columns regardless of section emission so the
      // Uncategorized bucket doesn't double-count an empty section's
      // members. Columns referenced by a category but absent from the
      // table count as "claimed" — they just won't render anywhere
      // since they don't exist on the active frame.
      for (const c of cat.columns) referenced.add(c);
      if (cols.length > 0) {
        sections.push({ title: cat.title, columns: cols });
      }
    }
    const leftovers = tableCols.filter((c) => !referenced.has(c));
    if (leftovers.length > 0) {
      sections.push({ title: "Uncategorized", columns: leftovers });
    }
    return sections;
  }, [categoriesByTable, table, tableCols]);

  const onTableChange = (next: string) => {
    setTable(next);
    const cols = (tableGroups.find((g) => g.name === next)?.columns ?? []).map(bareColumn);
    setColumn(cols[0] ?? "");
    setOp("eq");
    setValue("");
    setBetweenLo("");
    setBetweenHi("");
    setBoolIdx(0);
  };

  const onColumnChange = (next: string) => {
    setColumn(next);
    setOp("eq");
    setValue("");
    setBetweenLo("");
    setBetweenHi("");
    setBoolIdx(0);
  };

  const valueDisabled = op === "nonnull" || op === "null";
  const isBoolean = columnKind === "boolean";
  const isBetween = op === "between";
  const isNumeric = columnKind === "numeric";
  // Categorical-value short-circuit: when the active column has an
  // enumerated value universe (decoration table fed through
  // `useTablesUniqueValues`), the predicate builder swaps the
  // free-text input for a dropdown or checkbox list. Limited to
  // string/unknown columns — numeric/boolean already have specialized
  // widgets that are better than a dropdown over thousands of values.
  // Parquet feature-table strings (no /values endpoint for those) fall
  // through to free-text since their qualified col won't be in the map.
  const qualifiedCol = table && column ? `${table}.${column}` : "";
  const enumValues = availableValues?.[qualifiedCol];
  const isStringish = columnKind === "string" || columnKind === "unknown";
  const hasEnum = isStringish && !!enumValues && enumValues.length > 0;
  const useDropdown = hasEnum && (op === "eq" || op === "ne");
  const useChecklist = hasEnum && (op === "in" || op === "notin");
  // Between needs both endpoints. Comparison ops need a value unless
  // they're nullish. Boolean uses its own widget and is always "ready".
  const betweenOk =
    isBetween &&
    betweenLo.trim() !== "" &&
    betweenHi.trim() !== "" &&
    Number.isFinite(Number(betweenLo)) &&
    Number.isFinite(Number(betweenHi));
  const canSubmit =
    !!table &&
    !!column &&
    (isBoolean ||
      (isBetween
        ? betweenOk
        : op && (valueDisabled || value !== "")));
  const allowedOps: BuilderOp[] = isBoolean
    ? []  // boolean uses the BOOL_PREDICATES select instead of an op + value pair
    : [...OPS_FOR_KIND[columnKind]];

  return (
    <form
      className="cell-filter-builder"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        if (isBoolean) {
          const choice = BOOL_PREDICATES[boolIdx];
          onAdd([{ table, column, op: choice.op, value: choice.value }]);
          return;
        }
        if (isBetween) {
          // Canonicalise so lo ≤ hi on the wire regardless of input
          // order — the merged "between" display reads correctly either
          // way, but ordered wire values are easier to reason about.
          const lo = Number(betweenLo);
          const hi = Number(betweenHi);
          const [a, b] = lo <= hi ? [betweenLo, betweenHi] : [betweenHi, betweenLo];
          onAdd([
            { table, column, op: "gte", value: a },
            { table, column, op: "lte", value: b },
          ]);
          return;
        }
        onAdd([{ table, column, op: op as Op, value: valueDisabled ? "" : value }]);
      }}
    >
      {/* Where: table + column.  Selects are stacked full-width inside
          the card so long names ("aibs_metamodel_mtypes_v661_v2") don't
          force the form to squash everything else. */}
      <div className="cell-filter-builder-section">
        <div className="cell-filter-builder-section-label">Where</div>
        <div className="cell-filter-builder-section-body">
          <select
            className="cell-filter-builder-select"
            value={table}
            onChange={(e) => onTableChange(e.target.value)}
            aria-label="table"
          >
            {tableGroups.map((g) => (
              <option key={g.name} value={g.name}>{g.name}</option>
            ))}
          </select>
          <select
            className="cell-filter-builder-select"
            value={column}
            onChange={(e) => onColumnChange(e.target.value)}
            aria-label="column"
          >
            {columnSections.length === 1 && columnSections[0].title === null
              ? // Flat layout — no optgroups so a one-table partners-frame
                // filter doesn't get a single anonymous-group wrapper.
                columnSections[0].columns.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))
              : columnSections.map((s) => (
                  <optgroup key={s.title ?? "_flat"} label={s.title ?? ""}>
                    {s.columns.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </optgroup>
                ))}
          </select>
        </div>
      </div>
      {/* Match: op + value (or a specialized value widget). The op
          select sits inline with the value control for simple cases;
          between / checklist break onto the row below since they're
          tall. */}
      <div className="cell-filter-builder-section">
        <div className="cell-filter-builder-section-label">Match</div>
        <div className="cell-filter-builder-section-body">
          {isBoolean ? (
            // Boolean: a single 4-option select replaces the op+value pair. Reads
            // naturally as "field <choice>" which is what the user asked for.
            <select
              className="cell-filter-builder-select"
              value={boolIdx}
              onChange={(e) => setBoolIdx(Number(e.target.value))}
              aria-label="filter"
            >
              {BOOL_PREDICATES.map((p, i) => (
                <option key={i} value={i}>{p.label}</option>
              ))}
            </select>
          ) : (
            <>
              <div className="cell-filter-builder-row">
                <select
                  className="cell-filter-builder-select"
                  value={op}
                  onChange={(e) => setOp(e.target.value as BuilderOp)}
                  aria-label="operator"
                >
                  {allowedOps.map((o) => (
                    <option key={o} value={o}>{OP_DROPDOWN_LABEL[o]}</option>
                  ))}
                </select>
                {/* Inline value widget for the simple cases (text,
                    numeric, single-value dropdown). between/checklist
                    render full-width below this row instead.
                    Null/nonnull ops take no value at all — the op
                    name is the predicate ("column is null"), so we
                    omit the widget entirely rather than show a
                    disabled placeholder. */}
                {!isBetween && !useChecklist && !valueDisabled && (
                  useDropdown ? (
                    <select
                      className="cell-filter-builder-select"
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      aria-label="value"
                    >
                      <option value="">— pick value —</option>
                      {enumValues!.map((v) => (
                        <option key={v} value={v}>{v}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="cell-filter-builder-input"
                      type={isNumeric && op !== "in" && op !== "notin" ? "number" : "text"}
                      value={value}
                      onChange={(e) => setValue(e.target.value)}
                      placeholder={op === "in" || op === "notin" ? "a|b|c" : "value"}
                      // Numeric inputs accept any precision; don't force step.
                      step={isNumeric && op !== "in" && op !== "notin" ? "any" : undefined}
                    />
                  )
                )}
              </div>
              {/* Wide value widgets break to the row below the op
                  picker so they have room to breathe at popover width. */}
              {isBetween && (
                <span className="cell-filter-between">
                  <input
                    type="number"
                    step="any"
                    className="cell-filter-between-input"
                    value={betweenLo}
                    onChange={(e) => setBetweenLo(e.target.value)}
                    placeholder="low"
                    aria-label="lower bound"
                  />
                  <span className="cell-filter-between-sep">and</span>
                  <input
                    type="number"
                    step="any"
                    className="cell-filter-between-input"
                    value={betweenHi}
                    onChange={(e) => setBetweenHi(e.target.value)}
                    placeholder="high"
                    aria-label="upper bound"
                  />
                </span>
              )}
              {useChecklist && (
                // Multi-value membership — checkbox list backed by the
                // same pipe-separated wire format the in/notin predicate
                // grammar already uses.
                <ValueChecklist
                  options={enumValues!}
                  value={value}
                  onChange={setValue}
                />
              )}
            </>
          )}
        </div>
      </div>
      {/* Footer: cancel + add, right-aligned and separated from the
          data controls by a divider. Mirrors the .cell-filter-menu-
          footer pattern in the surrounding popover so the user reads
          "decide / commit" in the same spot every time. */}
      <div className="cell-filter-builder-footer">
        <button
          type="button"
          className="cell-filter-builder-btn"
          onClick={onCancel}
          title="Discard this draft filter"
        >
          cancel
        </button>
        <button
          type="submit"
          className="cell-filter-builder-btn primary"
          disabled={!canSubmit}
          title="Add this filter to the active set"
        >
          add
        </button>
      </div>
    </form>
  );
}

/** Checkbox-list multi-select backed by the pipe-separated wire format
 *  in/notin already uses. Surfaces a search box once the option count
 *  passes a threshold — cell_type columns can have 30+ values and a
 *  flat list becomes tedious to scan. Selecting/deselecting any
 *  option re-serializes the pipe-joined string into the parent's
 *  `value` state, so canSubmit (which checks `value !== ""`) stays
 *  honest without the checklist needing its own readiness signal. */
function ValueChecklist({
  options,
  value,
  onChange,
}: {
  options: string[];
  value: string;
  onChange: (next: string) => void;
}) {
  const [search, setSearch] = useState("");
  const selected = useMemo(
    () => new Set(value.split("|").filter(Boolean)),
    [value],
  );
  // Search becomes worth the chrome around ~12 entries — below that
  // the user can eyeball the list faster than typing.
  const SEARCH_THRESHOLD = 12;
  const showSearch = options.length >= SEARCH_THRESHOLD;
  const filtered = useMemo(() => {
    if (!search) return options;
    const needle = search.toLowerCase();
    return options.filter((o) => o.toLowerCase().includes(needle));
  }, [options, search]);
  const toggle = (v: string) => {
    const next = new Set(selected);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    onChange([...next].join("|"));
  };
  const selectAllVisible = () => {
    const next = new Set(selected);
    for (const v of filtered) next.add(v);
    onChange([...next].join("|"));
  };
  const clearAll = () => onChange("");
  return (
    <div className="cell-filter-checklist">
      {showSearch && (
        <input
          type="text"
          className="cell-filter-checklist-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={`search ${options.length} values…`}
          aria-label="filter value list"
        />
      )}
      <div className="cell-filter-checklist-actions">
        <button
          type="button"
          className="cell-filter-checklist-link"
          onClick={selectAllVisible}
          disabled={filtered.length === 0}
          title={
            search
              ? `Select all ${filtered.length} matching values`
              : `Select all ${options.length} values`
          }
        >
          select all{search ? ` (${filtered.length})` : ""}
        </button>
        <button
          type="button"
          className="cell-filter-checklist-link"
          onClick={clearAll}
          disabled={selected.size === 0}
          title="Uncheck every value"
        >
          clear ({selected.size})
        </button>
      </div>
      <div className="cell-filter-checklist-items">
        {filtered.length === 0 ? (
          <div className="cell-filter-checklist-empty">no matches</div>
        ) : (
          filtered.map((v) => (
            <label key={v} className="cell-filter-checklist-item">
              <input
                type="checkbox"
                checked={selected.has(v)}
                onChange={() => toggle(v)}
              />
              <span>{v}</span>
            </label>
          ))
        )}
      </div>
    </div>
  );
}
