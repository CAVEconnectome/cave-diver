import { useCallback } from "react";

interface Props {
  /** Lower handle value. */
  min: number;
  /** Upper handle value. */
  max: number;
  /** Slider bounds — outer envelope the user can drag within. */
  bound: { lo: number; hi: number };
  /** Step. Defaults to 1% of the bound span — fine enough for typical
   *  px ranges and raw numeric domains alike. */
  step?: number;
  /** Channel label shown to the left of the track. */
  label: string;
  /** Formatter for the readout under the slider. Receives a single
   *  numeric value; returns the user-facing string. */
  formatValue?: (n: number) => string;
  onChange: (next: { min?: number; max?: number }) => void;
}

/**
 * Dual-thumb range slider, used for both size (px range) and color
 * (colorscale-domain range) channel clipping.
 *
 * Built from two stacked ``<input type="range">`` elements over a
 * shared track. Pointer events flow through to whichever thumb is
 * closer; the active segment of the track between the two values
 * fills in the project's accent color so the active range is visible
 * at a glance.
 *
 * Each handle is clamped against the other so dragging the min past
 * the max (or vice versa) is impossible — the moving handle stops one
 * step short of the static one.
 */
export function RangeSlider({
  min,
  max,
  bound,
  step,
  label,
  formatValue = (n) => n.toFixed(2),
  onChange,
}: Props) {
  // Compute a step from the bound span when one isn't supplied. ~1%
  // resolution is usually enough; finer slows the read-out flicker
  // without adding obvious precision.
  const effStep = step ?? Math.max(0.01, (bound.hi - bound.lo) / 100);

  const handleMin = useCallback(
    (v: number) => {
      const clamped = Math.min(v, max - effStep);
      onChange({ min: clamped });
    },
    [max, effStep, onChange],
  );
  const handleMax = useCallback(
    (v: number) => {
      const clamped = Math.max(v, min + effStep);
      onChange({ max: clamped });
    },
    [min, effStep, onChange],
  );

  // Percent positions for the colored "active" segment of the track.
  const range = bound.hi - bound.lo;
  const leftPct = range > 0 ? ((min - bound.lo) / range) * 100 : 0;
  const rightPct = range > 0 ? ((max - bound.lo) / range) * 100 : 100;

  return (
    <div className="size-range-slider">
      <div className="size-range-slider-row">
        <span className="size-range-slider-label">{label}</span>
        <div className="size-range-slider-track-wrap">
          <div className="size-range-slider-track" />
          <div
            className="size-range-slider-track-active"
            style={{ left: `${leftPct}%`, right: `${100 - rightPct}%` }}
          />
          <input
            type="range"
            min={bound.lo}
            max={bound.hi}
            step={effStep}
            value={min}
            onChange={(e) => handleMin(parseFloat(e.target.value))}
            className="size-range-thumb size-range-thumb-min"
            aria-label={`${label} min`}
          />
          <input
            type="range"
            min={bound.lo}
            max={bound.hi}
            step={effStep}
            value={max}
            onChange={(e) => handleMax(parseFloat(e.target.value))}
            className="size-range-thumb size-range-thumb-max"
            aria-label={`${label} max`}
          />
        </div>
      </div>
      <div className="size-range-slider-readout">
        <span>{formatValue(min)}</span>
        <span>{formatValue(max)}</span>
      </div>
    </div>
  );
}
