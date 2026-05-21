import { useState } from "react";
import { useTables } from "../../api/queries";
import { Combobox } from "../Combobox";

interface Props {
  ds: string;
  matVersion: number | "live";
  /** Currently-attached tables (from `?dec=` parsed). */
  attached: string[];
  /** Apply a new attached list — caller writes `?dec=` to the URL. */
  onChange: (next: string[]) => void;
}

/**
 * Compact decoration-table attach/detach UI for the explorer rail.
 *
 * Differs from the equivalent block on NeuronView in two ways:
 *
 *   1. Changes are applied immediately (each pick rewrites `?dec=`) —
 *      no "Load" button is needed because the explorer's /points fetch
 *      doesn't depend on `?dec=` at all for the base scatter; the dec
 *      list only widens the column menus for color/filter.
 *   2. No draft state. The URL is the single source of truth — picking
 *      and removing tables roundtrips through the URL on every action.
 *
 * Tables that don't appear in CAVE for the current ds/mv get filtered
 * out of the picker silently — they'd 4xx anyway when the user tried
 * to color/filter by one.
 */
export function DecorationPicker({ ds, matVersion, attached, onChange }: Props) {
  const tables = useTables(ds, matVersion);
  const [draftPick, setDraftPick] = useState<string>("");

  const options = (tables.data?.tables ?? [])
    .filter((t) => !attached.includes(t.name))
    .map((t) => ({
      value: t.name,
      label: t.name,
      hint: t.kind === "view" ? "view" : undefined,
    }));

  return (
    <div className="explore-dec">
      <div className="explore-picker-label">Decoration tables</div>
      {attached.length > 0 && (
        <ul className="explore-dec-chips">
          {attached.map((name) => (
            <li key={name} className="explore-dec-chip" title={name}>
              <span className="explore-dec-chip-name">{name}</span>
              <button
                type="button"
                className="explore-dec-chip-remove"
                aria-label={`Detach ${name}`}
                title={`Detach ${name}`}
                onClick={() => onChange(attached.filter((t) => t !== name))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <Combobox
        className="explore-dec-add"
        value={draftPick}
        options={options}
        onChange={(v) => {
          if (v && !attached.includes(v)) {
            onChange([...attached, v]);
          }
          // Reset the combobox after a successful pick so subsequent
          // attaches are clean (the chip list is the source of truth).
          setDraftPick("");
        }}
        disabled={!tables.data}
        placeholder={attached.length === 0 ? "add table…" : "+ add another…"}
        emptyText="No tables match"
      />
    </div>
  );
}
