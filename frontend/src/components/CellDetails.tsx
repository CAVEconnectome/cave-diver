import type { ConnectivityBundle } from "../api/types";
import { displayName, formatCell } from "./tableColumns";

/**
 * Collapsible details panel rendered beneath `<IdentityStrip>`. Promotes
 * the metadata that used to live exclusively inside the "Cell" tab —
 * cell-type annotations, decoration tables, soma position, any spatial
 * provider columns — so a user doesn't have to dig into the partner
 * tabs to learn what CAVE knows about the loaded neuron.
 *
 * Renders one section per `ColumnGroup`, skipping:
 *   - "intrinsic" (just root_id; already shown in the strip)
 *   - "synapse"   (per-edge stats; don't apply to a single cell)
 *   - the soma group's `cell_id` column (already in the strip)
 *   - columns whose value is null / undefined / empty string — empty
 *     rows are visual noise on what's already a metadata dump.
 */
interface Props {
  bundle: ConnectivityBundle;
}

function bareColumnName(key: string): string {
  const i = key.indexOf(".");
  return i >= 0 ? key.slice(i + 1) : key;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

export function CellDetails({ bundle }: Props) {
  const cell = bundle.root_record;
  if (!cell) return null;

  const labelOverrides = bundle.spatial_meta.label_overrides;
  const groups = bundle.column_groups.filter(
    (g) => g.kind !== "synapse" && g.kind !== "intrinsic",
  );

  const sections = groups
    .map((g) => {
      const cols =
        g.kind === "soma"
          ? g.columns.filter((c) => c !== "cell_id" && c !== "root_id")
          : g.columns.filter((c) => c !== "root_id");
      const items = cols
        .map((col) => ({ col, value: cell[col] }))
        .filter((item) => !isEmpty(item.value));
      return { group: g, items };
    })
    .filter((s) => s.items.length > 0);

  if (sections.length === 0) {
    return (
      <div className="cell-details empty">
        <span className="cell-details-empty">No annotations available for this cell.</span>
      </div>
    );
  }

  return (
    <div className="cell-details">
      {sections.map(({ group, items }) => (
        <section className="cell-details-group" key={group.name}>
          <h4 className="cell-details-group-name" title={group.name}>
            {group.name}
          </h4>
          <dl className="cell-details-list">
            {items.map(({ col, value }) => (
              <div className="cell-details-row" key={col}>
                <dt>{displayName(bareColumnName(col), labelOverrides)}</dt>
                <dd>{formatCell(value)}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}
