import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useSearchParams } from "react-router-dom";
import type { ConnectivityBundle } from "../api/types";
import { useUrlParam } from "../hooks/useUrlState";
import { classify, type ColumnProfile } from "../plots/columns";
import { directionalColumnNames, unifyColumnGroups, unifyPartners } from "../plots/unify";
import {
  PANEL_SCOPES,
  encodeUnfilterList,
  encodeVizParam,
  isPanelUnfiltered,
  parseVizParam,
  selKey,
  toggleUnfilter,
  UNFILTER_PARAM_KEY,
  vizParamKey,
  type PanelScope,
  type PlotBindings,
} from "../plots/urlState";
import type { DynamicPlotDescriptor } from "../plots/registry";
import { PlotPanel } from "./PlotPanel";

interface Props {
  descriptor: DynamicPlotDescriptor;
  ds: string;
  rootId: string;
  matVersion: number | "live";
  bundle: ConnectivityBundle;
  decorationTables: string[];
  /** Global cell filter (raw `?cells=` URL value) forwarded to PlotPanel. */
  cells?: string | null;
  /** Optional close handler — when present a "✕" button appears in the
   *  panel header so the user can drop the panel from `?plots=`. */
  onClose?: () => void;
  /** Reorder handlers — when set, ↑/↓ buttons appear in the header.
   *  `undefined` disables the corresponding button (panel at top/bottom
   *  of the rail), so the buttons stay in the layout but visibly grey. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  /** Brush / lasso selection callback (proxied to PlotPanel). Receives the
   *  deduped list of selected partner root_ids — the AnalyticsRail uses this
   *  to write the per-plot URL `?sel_<id>=` key for cross-component filtering. */
  onSelected?: (rootIds: string[]) => void;
}

type Channel = "x" | "y" | "hue" | "size" | "weight";

const CHANNEL_LABEL: Record<Channel, string> = {
  x: "x",
  y: "y",
  hue: "hue",
  size: "size",
  weight: "weight",
};

/**
 * Per-row column option for the channel pickers, with classification info
 * so each picker can grey out columns that aren't suitable for that channel.
 * (e.g. a string column can be x/y but not size; an id-shaped column is
 * always rejected; a high-cardinality non-numeric column can't drive hue.)
 */
interface ColumnOption {
  group: string;
  key: string;
  display: string;
  profile: ColumnProfile;
}

/**
 * Produce picker options spanning *both* directions' columns. Walks the
 * unified column groups (which split the synapse group into _in / _out
 * pairs) and classifies each column against the unified rows.
 *
 * Also injects a synthetic `direction` option in a "synthetic" group —
 * a hue-only channel that the backend computes as a categorical column on
 * the unified frame (presynaptic / postsynaptic / reciprocal).
 */
function listColumnOptions(bundle: ConnectivityBundle): ColumnOption[] {
  const directional = directionalColumnNames(bundle.column_groups);
  const unifiedRows = unifyPartners(
    bundle.partners_out ?? [],
    bundle.partners_in ?? [],
    directional,
  ) as unknown as Record<string, unknown>[];
  const unifiedGroups = unifyColumnGroups(bundle.column_groups, directional);

  const options: ColumnOption[] = [];
  for (const g of unifiedGroups) {
    if (g.kind === "intrinsic") continue;
    for (const col of g.columns) {
      const profile = classify(col, unifiedRows);
      const display = col.includes(".") ? col.slice(col.indexOf(".") + 1) : col;
      options.push({ group: g.name, key: col, display, profile });
    }
  }
  // Synthetic direction-class hue. Backend computes it server-side on the
  // unified frame so we don't materialize the column on the SPA. Hue-only;
  // not useful as x/y (it's a 3-value enum) or size (not numeric).
  options.push({
    group: "synthetic",
    key: "direction",
    display: "direction (pre / post / reciprocal)",
    profile: {
      vocabulary: "categorical-palette",
      cardinality: 3,
      isNumeric: false,
      isIdShaped: false,
      suitableFor: { x: false, y: false, hue: true, size: false, weight: false },
    },
  });
  return options;
}

// Mirror of `services/plots.py::_axis_target_value` — classifies an axis
// binding as one of the cell-position-marker families so the toggle is
// only offered when the marker would actually render. Drives off
// `bundle.spatial_meta.column_roles`: a column whose role is `depth` or
// `tangential` is a valid cell-marker axis. `radial` and `distance` are
// excluded — the target's value for those is trivially 0, which isn't a
// useful reference glyph.
function isCellPositionColumn(
  name: string | null | undefined,
  columnRoles: Record<string, string>,
): boolean {
  if (!name) return false;
  const bare = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  const role = columnRoles[bare];
  return role === "depth" || role === "tangential";
}

// Predict the chart-kind the backend will pick from the bindings, mirroring
// the dispatch in `services/plots.py::resolve_plot`. The chip uses this as
// its label so the user reads "scatter" / "bar" / "stripplot" / "histogram"
// at a glance — the actual column names live on the chart's axis titles
// (set by the backend's `_apply_auto_titles`), so the chip stays compact
// instead of cramming the bindings into a long pill that overflows the
// panel frame.
function predictChartKind(
  bindings: PlotBindings,
  xIsNumeric: boolean,
  yIsNumeric: boolean,
): "scatter" | "stripplot" | "bar" | "histogram" | null {
  const hasX = !!bindings.x;
  const hasY = !!bindings.y;
  const hasWeight = !!bindings.weight;
  if (hasX && hasY) {
    return !xIsNumeric && yIsNumeric ? "stripplot" : "scatter";
  }
  if (hasX && !hasY) {
    return !xIsNumeric || hasWeight ? "bar" : "histogram";
  }
  if (hasY && !hasX) return "histogram";
  return null;
}

/**
 * Runtime-configurable plot panel.
 *
 * Reads/writes its bindings to a JSON-encoded URL key (`?viz_<id>={...}`).
 * The header carries four channel pickers (x / y / hue / size); only
 * options whose `suitableFor[channel]` is true are selectable. Hue/size
 * pickers are visually disabled when the binding combo doesn't render
 * them (e.g. size on a histogram).
 *
 * Backend dispatch: 1-of-(x,y) bound → histogram. Both bound → scatter.
 * The `<PlotPanel>` is reused to do the actual fetch + theme + render.
 */
export function DynamicPlotPanel({
  descriptor,
  ds,
  rootId,
  matVersion,
  bundle,
  decorationTables,
  cells,
  onClose,
  onMoveUp,
  onMoveDown,
  onSelected,
}: Props) {
  const [raw] = useUrlParam(vizParamKey(descriptor.id));
  const [, setSearchParams] = useSearchParams();
  const bindings: PlotBindings = useMemo(() => parseVizParam(raw), [raw]);

  // Write the panel's bindings AND clear its brush selection in a single
  // navigation. Bindings changes invalidate any brush — the selected
  // partner ids may not appear on the new chart at all (e.g. swapping
  // `y=median_syn_depth_out` for `y=net_size_in` reshuffles which
  // points are visible) — and a stale `?sel_<id>` would leave the
  // partner table filtered on ids that no longer correspond to anything
  // the user can see. Clearing in the same `setSearchParams` call
  // avoids a brief flicker where the filter hangs around for one render.
  const writeBindings = useCallback(
    (next: PlotBindings) => {
      const encoded = encodeVizParam(next);
      const vizKey = vizParamKey(descriptor.id);
      const sKey = selKey(descriptor.id);
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        if (encoded === "{}") params.delete(vizKey);
        else params.set(vizKey, encoded);
        params.delete(sKey);
        return params;
      });
    },
    [descriptor.id, setSearchParams],
  );

  const setChannel = (ch: Channel, value: string | null) => {
    writeBindings({ ...bindings, [ch]: value || undefined });
  };
  const setScope = (value: PanelScope) => {
    writeBindings({ ...bindings, scope: value });
  };
  // Default ON — only persist `false` to keep URL state minimal. Encoder
  // already drops `true`/`undefined` from the JSON for the same reason.
  const showCellDepth = bindings.show_cell_depth !== false;
  const toggleCellDepth = () => {
    const next = { ...bindings };
    if (showCellDepth) next.show_cell_depth = false;
    else delete next.show_cell_depth;
    writeBindings(next);
  };

  // Per-panel cell-filter override. The global `?cells=` filter applies
  // to every plot by default; when the panel id is in `?unfilter=` the
  // backend gets `cells=undefined` for this panel only. Lets the user
  // see "what would the plot look like *without* the filter" without
  // having to globally remove the filter and re-apply it.
  const [searchParamsRead] = useSearchParams();
  const unfiltered = useMemo(
    () => isPanelUnfiltered(searchParamsRead, descriptor.id),
    [searchParamsRead, descriptor.id],
  );
  // `effectiveCells` is what the backend sees — null when the panel
  // opts out of the global filter via `?unfilter=`. The `unfiltered`
  // boolean rides separately into PlotPanel's queryKey so toggling
  // the filter pill always invalidates the cache, even if `cells`
  // happens to compare equal across the toggle.
  const effectiveCells = unfiltered ? null : cells;
  const onToggleFilter = useMemo(
    // The toggle is meaningful only when the global filter is actually
    // active. When `cells` is null/empty there's nothing to override —
    // we'd just be flipping a no-op flag — so the badge stays inert.
    () => {
      if (!cells) return undefined;
      return () => {
        setSearchParams((prev) => {
          const params = new URLSearchParams(prev);
          const next = toggleUnfilter(params, descriptor.id);
          if (next.length === 0) params.delete(UNFILTER_PARAM_KEY);
          else params.set(UNFILTER_PARAM_KEY, encodeUnfilterList(next));
          return params;
        });
      };
    },
    [cells, descriptor.id, setSearchParams],
  );

  // Pickers default-open on a fresh "+ Add plot" panel (no bindings yet)
  // and default-closed on a panel rehydrated from a URL with bindings —
  // the reader of a shared link mostly wants to *see the chart*, not
  // re-edit it. After the initial mount the user controls the state via
  // the summary chip.
  //
  // The init reads bindings once via the lazy initializer. Re-running this
  // on every render would close the pickers the moment a binding is set,
  // which is the wrong behavior — once the user clicks "expand" they
  // should stay expanded until they click "collapse".
  const [pickersOpen, setPickersOpen] = useState(
    () =>
      !bindings.x &&
      !bindings.y &&
      !bindings.hue &&
      !bindings.size &&
      !bindings.weight,
  );

  const options = useMemo(() => listColumnOptions(bundle), [bundle]);

  // Synapse-group columns that come in `_in` / `_out` directional pairs.
  // Used to filter options based on the panel scope: when scope is Input
  // or Output, the opposite-direction variants are redundant (the scope
  // filter already removed those rows; the variant would only contain
  // nulls). On Both / Reciprocal, both variants stay visible — the
  // per-direction split is the whole point of those scopes.
  const directionalKeys = useMemo(() => {
    const directional = directionalColumnNames(bundle.column_groups);
    const set = new Set<string>(["n_syn_in", "n_syn_out"]);
    for (const name of directional) {
      set.add(`${name}_in`);
      set.add(`${name}_out`);
    }
    return set;
  }, [bundle.column_groups]);

  // Visual hints for disabled channels. Mirrors the backend's dispatch:
  //   - scatter (x AND y) → all four channels meaningful; weight is ignored.
  //   - histogram (numeric x, no y, no weight) → hue / size / weight ignored.
  //   - bar (non-numeric x OR weight bound; no y) → weight + hue meaningful;
  //     size has no place on a bar.
  // We can't perfectly predict backend dispatch (it inspects dtypes on the
  // resolved frame) but the column profile's `isNumeric` is a faithful proxy.
  const haveAxis = !!(bindings.x || bindings.y);
  const haveScatter = !!(bindings.x && bindings.y);
  const xOption = options.find((o) => o.key === bindings.x);
  const yOption = options.find((o) => o.key === bindings.y);
  const xIsNumeric = !!xOption?.profile.isNumeric;
  const yIsNumeric = !!yOption?.profile.isNumeric;
  // Predicted chart kind, used as the chip label so the user can read at a
  // glance what they're getting (the column names live on the chart axes).
  const chartKind = predictChartKind(bindings, xIsNumeric, yIsNumeric);
  // Bar dispatch: x bound, no y, AND (x is non-numeric OR weight is bound).
  // The `|| !!bindings.weight` clause prevents weight from greying itself out
  // the moment it's chosen on a numeric-x case.
  const haveBar = !!bindings.x && !bindings.y && (!xIsNumeric || !!bindings.weight);

  const scope: PanelScope = (bindings.scope ?? "both") as PanelScope;

  // Cell-position toggle visibility. The backend only draws the marker when
  // at least one bound axis maps to a cell-position family (depth-shaped,
  // soma_x, or soma_z), so hide the toggle in the other case to avoid a
  // control that does nothing visible. Two-axis case gets a tooltip noting
  // the marker semantics: for a soma_x × soma_z scatter the circle sits at
  // the cell's actual cortical-flat location; for a depth × depth scatter
  // it sits on the diagonal at (target_depth, target_depth) — geometrically
  // meaningful as a reference, but worth calling out so the user reads it
  // as a guide rather than data.
  const columnRoles = bundle.spatial_meta.column_roles;
  const xIsSpatial = isCellPositionColumn(bindings.x, columnRoles);
  const yIsSpatial = isCellPositionColumn(bindings.y, columnRoles);
  const cellDepthAvailable = xIsSpatial || yIsSpatial;
  const cellDepthTooltip = !cellDepthAvailable
    ? "Bind a spatial column (depth or tangential axis) to enable"
    : xIsSpatial && yIsSpatial
      ? showCellDepth
        ? "Hide cell soma marker — open black circle at the queried cell's position"
        : "Show queried cell's soma as an open black circle"
      : showCellDepth
        ? "Hide cell soma reference (dashed black line at the queried cell's position)"
        : "Show queried cell's soma as a dashed black line on the spatial axis";

  // Hide `_in` / `_out` directional options that don't match the panel
  // scope. Non-directional columns (decoration, soma, cell-type, intrinsic,
  // synthetic) are always shown. `both` and `reciprocal` keep both variants
  // visible: under `both` the user is exploring the full population (often
  // with `direction` bound to hue), under `reciprocal` every row has values
  // for both directions so the `_in` / `_out` split remains meaningful.
  const scopedOptions = useMemo(() => {
    if (scope === "both" || scope === "reciprocal") return options;
    return options.filter((o) => {
      if (!directionalKeys.has(o.key)) return true;
      if (scope === "input") return o.key.endsWith("_in");
      return o.key.endsWith("_out");
    });
  }, [options, scope, directionalKeys]);

  // Header layout: chart-kind chip (left, click to toggle pickers), then
  // the expand and close buttons, then the picker grid wrapping below
  // when open.
  // Modal state — clicking the expand button (⤢) opens an overlay with
  // the same chart at viewport-scale dimensions. ESC closes; the inline
  // copy stays mounted behind the backdrop so closing returns the user
  // to exactly where they were in the rail (no scroll jump, no refetch).
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  // Predicted chart kind drives the chip label so the user reads "scatter"
  // / "bar" / "stripplot" / "histogram" at a glance. Column names live on
  // the chart's axis titles (set by the backend's `_apply_auto_titles`),
  // so the chip stays narrow rather than overflowing the panel frame.
  const chipLabel = chartKind ?? "Pick a column…";
  // Hover tooltip: full bindings summary so the user can see what hue /
  // size are bound to without expanding the pickers. Axis bindings are
  // already visible on the chart axes themselves; hue and size aren't —
  // they live on color & marker scale, which the user has to mentally
  // decode. Listing every channel keeps the tooltip uniform and the
  // mental model simple ("everything bound is here"). Newlines render
  // as line breaks in native browser tooltips.
  const summaryTooltip = useMemo(() => {
    const lines: string[] = [chartKind ? `${chartKind} plot` : "no axis bound"];
    const channels: { ch: Channel; label: string }[] = [
      { ch: "x", label: "x" },
      { ch: "y", label: "y" },
      { ch: "hue", label: "hue (color)" },
      { ch: "size", label: "size (marker)" },
      { ch: "weight", label: "weight (sum)" },
    ];
    for (const { ch, label } of channels) {
      const v = bindings[ch];
      if (v) lines.push(`${label}: ${v}`);
    }
    lines.push("");  // visual gap before the click hint
    lines.push(pickersOpen ? "Click to collapse pickers" : "Click to edit bindings");
    return lines.join("\n");
  }, [bindings, chartKind, pickersOpen]);
  const header = (
    <div className="plot-panel-header dynamic">
      <button
        type="button"
        className={`dynamic-summary${pickersOpen ? " open" : ""}`}
        onClick={() => setPickersOpen((v) => !v)}
        title={summaryTooltip}
        aria-expanded={pickersOpen}
      >
        <span className="dynamic-summary-text">{chipLabel}</span>
        <span className="chevron">{pickersOpen ? "▾" : "▸"}</span>
      </button>
      <button
        type="button"
        className="dynamic-move"
        onClick={onMoveUp}
        disabled={!onMoveUp}
        title="Move panel up"
        aria-label="Move panel up"
      >
        ↑
      </button>
      <button
        type="button"
        className="dynamic-move"
        onClick={onMoveDown}
        disabled={!onMoveDown}
        title="Move panel down"
        aria-label="Move panel down"
      >
        ↓
      </button>
      {cellDepthAvailable && (
        <button
          type="button"
          className={`dynamic-cell-depth${showCellDepth ? " active" : ""}`}
          onClick={toggleCellDepth}
          title={cellDepthTooltip}
          aria-label={cellDepthTooltip}
          aria-pressed={showCellDepth}
        >
          ⊙
        </button>
      )}
      <button
        type="button"
        className="dynamic-expand"
        onClick={() => setExpanded(true)}
        title="View larger (Esc to close)"
        aria-label="View larger"
      >
        ⤢
      </button>
      {onClose && (
        <button
          type="button"
          className="dynamic-close"
          onClick={onClose}
          title="Remove this plot"
          aria-label="Remove this plot"
        >
          ✕
        </button>
      )}
      {pickersOpen && (
        <div className="dynamic-pickers">
          <span className="dynamic-picker-group scope">
            <ScopeSelect value={scope} onChange={setScope} />
          </span>
          {(Object.keys(CHANNEL_LABEL) as Channel[]).map((ch) => {
            const disabledReason =
              (ch === "hue" || ch === "size") && !haveScatter
                ? "needs both x and y"
                : ch === "weight" && !haveBar
                  ? "needs categorical x with no y"
                  : null;
            const isAxis = ch === "x" || ch === "y";
            return (
              <span key={ch} className={`dynamic-picker-group${isAxis ? " axis" : ""}`}>
                <ChannelPicker
                  channel={ch}
                  value={bindings[ch] ?? null}
                  options={scopedOptions}
                  disabledReason={disabledReason}
                  onChange={(v) => setChannel(ch, v)}
                />
              </span>
            );
          })}
        </div>
      )}
    </div>
  );

  // Modal renders the chart at viewport-scale via React portal so it
  // escapes the rail's column clipping. We omit `header` inside the modal
  // — the modal has its own close button — and skip `onSelected` so brush
  // events only fire from the rail copy (avoids two listeners writing the
  // same `?sel_<id>` URL key concurrently).
  const modal = expanded
    ? createPortal(
        <div
          className="plot-modal-backdrop"
          onClick={() => setExpanded(false)}
          role="presentation"
        >
          <div
            className="plot-modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <button
              type="button"
              className="plot-modal-close"
              onClick={() => setExpanded(false)}
              title="Close (Esc)"
              aria-label="Close"
            >
              ✕
            </button>
            <PlotPanel
              ds={ds}
              spec={descriptor.spec}
              rootId={rootId}
              matVersion={matVersion}
              decorationTables={decorationTables}
              cells={effectiveCells}
              cellsContext={cells}
              onToggleFilter={onToggleFilter}
              filterOverridden={unfiltered}
              bindings={bindings}
              height={Math.floor(window.innerHeight * 0.78)}
            />
          </div>
        </div>,
        document.body,
      )
    : null;

  if (!haveAxis) {
    return (
      <>
        <div className="plot-panel">
          {header}
          <div className="loading">Pick at least one axis to plot.</div>
        </div>
        {modal}
      </>
    );
  }

  return (
    <>
      <PlotPanel
        ds={ds}
        spec={descriptor.spec}
        rootId={rootId}
        matVersion={matVersion}
        decorationTables={decorationTables}
        cells={effectiveCells}
        cellsContext={cells}
        onToggleFilter={onToggleFilter}
        filterOverridden={unfiltered}
        bindings={bindings}
        height={300}
        header={header}
        onSelected={onSelected}
      />
      {modal}
    </>
  );
}

interface ScopeSelectProps {
  value: PanelScope;
  onChange: (v: PanelScope) => void;
}

// Labels match the partners-pane tabs ("Output" / "Input" / "Both") so the
// same direction has the same name everywhere. `Reciprocal` is the
// strict-intersection subset; under `Both` the user can recover the
// direction split by binding `hue=direction` instead of filtering rows.
const SCOPE_LABEL: Record<PanelScope, string> = {
  both: "Both",
  input: "Input",
  output: "Output",
  reciprocal: "Reciprocal",
};

const SCOPE_TOOLTIP: Record<PanelScope, string> = {
  both: "all partners (no direction filter; bind hue=direction to color the split)",
  input: "input partners (n_syn_in > 0; includes reciprocal)",
  output: "output partners (n_syn_out > 0; includes reciprocal)",
  reciprocal: "reciprocal partners only (both directions present)",
};

/**
 * Panel-level direction scope selector. One per dynamic panel; applies
 * uniformly to every channel. Sits at the head of the picker row so the
 * user reads it as "what population is this whole plot about" before
 * picking columns.
 */
function ScopeSelect({ value, onChange }: ScopeSelectProps) {
  return (
    <label className="dynamic-picker" title={`scope: ${SCOPE_TOOLTIP[value]}`}>
      <span className="dynamic-picker-label">scope</span>
      <select
        className={`dynamic-scope${value !== "both" ? " active" : ""}`}
        value={value}
        onChange={(e) => onChange(e.target.value as PanelScope)}
      >
        {PANEL_SCOPES.map((s) => (
          <option key={s} value={s}>{SCOPE_LABEL[s]}</option>
        ))}
      </select>
    </label>
  );
}

interface ChannelPickerProps {
  channel: Channel;
  value: string | null;
  options: ColumnOption[];
  disabledReason: string | null;
  onChange: (v: string | null) => void;
}

function ChannelPicker({ channel, value, options, disabledReason, onChange }: ChannelPickerProps) {
  // Group options for the dropdown via <optgroup>. Greyed entries (not
  // suitable for this channel) stay visible but disabled, so users see
  // what columns *exist* and why they're unavailable.
  const grouped = useMemo(() => {
    const byGroup = new Map<string, ColumnOption[]>();
    for (const opt of options) {
      if (!byGroup.has(opt.group)) byGroup.set(opt.group, []);
      byGroup.get(opt.group)!.push(opt);
    }
    return [...byGroup.entries()];
  }, [options]);

  return (
    <label className={`dynamic-picker${disabledReason ? " disabled" : ""}`} title={disabledReason ?? ""}>
      <span className="dynamic-picker-label">{CHANNEL_LABEL[channel]}</span>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
        disabled={!!disabledReason}
      >
        <option value="">—</option>
        {grouped.map(([groupName, opts]) => (
          <optgroup key={groupName} label={groupName}>
            {opts.map((o) => (
              <option
                key={o.key}
                value={o.key}
                disabled={!o.profile.suitableFor[channel]}
              >
                {o.display}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}
