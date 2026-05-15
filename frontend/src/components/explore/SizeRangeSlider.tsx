import { useCallback } from "react";

interface Props {
  /** Min px (lower end of the size encoding's visual range). */
  minPx: number;
  /** Max px (upper end). */
  maxPx: number;
  /** Slider bounds — outer envelope the user can drag within. */
  bound?: { lo: number; hi: number };
  /** Step in px. */
  step?: number;
  onChange: (next: { minPx?: number; maxPx?: number }) => void;
}

/**
 * Dual-thumb slider for the size channel's px range.
 *
 * Built from two stacked `<input type="range">` elements with CSS that
 * lets the thumbs sit on top of a shared track. Each thumb's value is
 * constrained against the other's — drag the min thumb past the max
 * and it clamps to max-1, and vice versa.
 *
 * Mounts in `ChannelPicker` only when a size channel is bound; the
 * panel is meaningless without one.
 */
export function SizeRangeSlider({
  minPx,
  maxPx,
  bound = { lo: 1, hi: 24 },
  step = 0.5,
  onChange,
}: Props) {
  const handleMin = useCallback(
    (v: number) => {
      const clamped = Math.min(v, maxPx - step);
      onChange({ minPx: clamped });
    },
    [maxPx, step, onChange],
  );
  const handleMax = useCallback(
    (v: number) => {
      const clamped = Math.max(v, minPx + step);
      onChange({ maxPx: clamped });
    },
    [minPx, step, onChange],
  );

  // Percent positions for the colored "active" segment of the track.
  const range = bound.hi - bound.lo;
  const leftPct = ((minPx - bound.lo) / range) * 100;
  const rightPct = ((maxPx - bound.lo) / range) * 100;

  return (
    <div className="size-range-slider">
      <div className="size-range-slider-row">
        <span className="size-range-slider-label">size</span>
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
            step={step}
            value={minPx}
            onChange={(e) => handleMin(parseFloat(e.target.value))}
            className="size-range-thumb size-range-thumb-min"
            aria-label="size min"
          />
          <input
            type="range"
            min={bound.lo}
            max={bound.hi}
            step={step}
            value={maxPx}
            onChange={(e) => handleMax(parseFloat(e.target.value))}
            className="size-range-thumb size-range-thumb-max"
            aria-label="size max"
          />
        </div>
      </div>
      <div className="size-range-slider-readout">
        <span>{minPx.toFixed(1)} px</span>
        <span>{maxPx.toFixed(1)} px</span>
      </div>
    </div>
  );
}
