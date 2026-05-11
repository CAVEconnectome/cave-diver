"""Categorical color policy + cell-type universe lookup.

Plots in this app render colors in two ways:

1. **Default categorical** — Plotly's `colorway` cycles through CSS `--cat-*`
   tokens injected by `frontend/src/plots/theme.ts`. Used for hues whose
   provenance we don't (or can't) trace back to a cell-type table — synthetic
   columns like `direction`, low-cardinality numerics, etc.
2. **Universe-pinned** — when the hue column comes from a cell-type table or
   a decoration table, we look up the FULL set of distinct values via
   `client.materialize.get_unique_string_values(table)` and assign colors
   over that sorted universe. The same value lands on the same slot whether
   one plot or twelve are observing it, whether the user reloaded, and
   whether a `cells=` filter trimmed the visible subset. Backend writes
   `marker.color` explicitly in this branch.

The palette below is matplotlib's `tab10 + tab20-light-pair-companions`:
twenty visually-distinct slots that scale past the SPA's 10-token colorway.
For ≤10 distinct values the `--cat-*` tokens (which mirror TAB10 in the SPA)
and our explicit colors produce identical hexes; from 11 onward only the
backend's explicit-color path runs (the SPA never sees a colorway with more
than 10 entries). Past 20 distinct values we fall through to HSL rotation
in `_categorical_palette`.

Null is always neutral gray. The two grays embedded in TAB10 / TAB20 are
near-but-distinct from `NULL_COLOR` so a value happening to land on that
slot is visibly different from "missing".
"""

import colorsys

from flask import current_app

from .cache_lifecycle import cache_datastack


# tab10 — the canonical categorical palette. Slots 0–9.
TAB10 = [
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
    "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
]

# tab20 light-pair companions — paler version of each tab10 hue, taken from
# the odd indices of matplotlib's tab20. Slots 10–19. Visually similar to
# their tab10 counterpart so a related-but-distinct cell type is easy to
# spot on the same chart.
TAB20_LIGHT = [
    "#aec7e8", "#ffbb78", "#98df8a", "#ff9896", "#c5b0d5",
    "#c49c94", "#f7b6d2", "#c7c7c7", "#dbdb8d", "#9edae5",
]

# 20 deterministic slots. Beyond that, callers fall through to
# `_categorical_palette()` (HSL rotation) for the remaining values.
CATEGORICAL_PALETTE = TAB10 + TAB20_LIGHT

# Reserved for missing / `(none)` buckets. Sits below TAB20_LIGHT[7]'s
# `#c7c7c7` so a value landing on that slot isn't confusable with null.
# Tab10[7] (`#7f7f7f`, slot 7) is darker than this; same logic — distinct.
NULL_COLOR = "#dcdcdc"
NULL_LABEL = "(none)"


# --- universe lookup ---------------------------------------------------------

def get_unique_values(
    *,
    client_factory,
    ds: str,
    mat_version,         # int | "live" | None
    table: str,
    column: str,
) -> list[str]:
    """Return the full universe of distinct string values for `column` on `table`.

    Cached per `(ds, mat_version, table)` — `client.materialize.get_unique_string_values`
    returns a dict covering every column on the table in one call, so we
    cache the whole dict and slice the column out per call. Two plots
    referencing different columns of the same table share one CAVE round-trip.

    Live mode (`mat_version == "live"` or `None`) bypasses the cache: the
    universe of values is genuinely mutable as proofreading lands, and
    serving stale colors there would defeat the "live" promise. Materialized
    versions are frozen, so caching is effectively forever (bounded by the
    7-day TTL and 512-entry maxsize, neither of which should ever bind in
    practice).

    Returns `[]` when the table has no such column or the CAVE call fails —
    the caller treats empty as "fall back to plotly's default colorway".
    """
    if mat_version == "live" or mat_version is None:
        return list(_fetch(client_factory, table).get(column) or [])

    # Tuple-shaped key with `(cache_ds, mat_version)` as the leading
    # elements so the L2 retention resolver can pick default vs
    # longlived without re-deriving them. `cache_datastack` resolves any
    # per-datastack alias so two datastacks backed by the same data
    # share one cache entry.
    cache = current_app.extensions["dcv_unique_values_cache"]
    key = (cache_datastack(ds), mat_version, table)
    hit = cache.get(key)
    if hit is None:
        values = _fetch(client_factory, table)
        cache.set(key, values)
        cached = values
    else:
        cached = hit[0]
    return list(cached.get(column) or [])


def _fetch(client_factory, table: str) -> dict[str, list[str]]:
    """Single-table CAVE call. Errors are swallowed because color is a
    visual nicety — a 5xx from CAVE shouldn't break the plot."""
    try:
        client = client_factory()
        return client.materialize.get_unique_string_values(table) or {}
    except Exception:
        return {}


# --- color resolution --------------------------------------------------------

def resolve_categorical_color_map(
    *,
    universe,
    observed=(),
) -> dict:
    """Map each value to a deterministic hex color.

    The slot a value occupies is determined by its position in the
    case-folded alphabetical sort of `universe`. That positioning is what
    makes the same value land on the same color in every plot, every
    reload, and every observed-subset — the universe is fixed for a
    materialization version, so the mapping is too.

    `observed` is the values currently present in the dataframe; it's
    only used to absorb defensive cases where a value sneaks past the
    universe (stale URL after a mat_version bump, encoding drift, etc.).
    Those values get `NULL_COLOR` rather than crashing the render.

    Null / `(none)` always lands on `NULL_COLOR` — never a palette slot.
    """
    sorted_universe = sorted(
        {str(v) for v in universe if v is not None and str(v) != NULL_LABEL},
        key=lambda s: s.casefold(),
    )

    out: dict = {}
    n_palette = len(CATEGORICAL_PALETTE)
    overflow_count = max(0, len(sorted_universe) - n_palette)
    overflow = _categorical_palette(overflow_count) if overflow_count else []

    for i, value in enumerate(sorted_universe):
        out[value] = CATEGORICAL_PALETTE[i] if i < n_palette else overflow[i - n_palette]

    out[NULL_LABEL] = NULL_COLOR
    out[None] = NULL_COLOR

    # Defensive: anything observed but not in the universe gets the null
    # color rather than KeyError'ing in the builder.
    for v in observed:
        key = NULL_LABEL if v is None else str(v)
        out.setdefault(key, NULL_COLOR)

    return out


# --- palette helpers (used by scatter's 13-30 + greyscale tier and as the
#     overflow generator above) ----------------------------------------------

def greyscale_ramp(n: int) -> list[str]:
    """Evenly-spaced greys from #333333 to #bbbbbb.

    Used by scatter's discrete-numeric hue case (13–30 distinct values)
    where a sequential ramp preserves the natural ordering of the values
    (e.g., `num_soma` = 0, 1, 2, ...). Restrained chroma so the marker
    visibility tracks the data, not the color.
    """
    if n <= 0:
        return []
    if n == 1:
        return ["#666666"]
    lo, hi = 0x33, 0xbb
    out: list[str] = []
    for i in range(n):
        v = int(lo + (hi - lo) * i / (n - 1))
        out.append(f"#{v:02x}{v:02x}{v:02x}")
    return out


def _categorical_palette(n: int) -> list[str]:
    """`n` visually-distinct hex colors via HSL hue rotation.

    The fallback when the universe blows past `len(CATEGORICAL_PALETTE)`
    (20 slots), and the workhorse for scatter's 13-30 non-numeric branch.
    Saturation and lightness are restrained to match the SPA's low-chroma
    aesthetic; the alternating lightness keeps adjacent hues from blurring
    into a continuous gradient.
    """
    if n <= 0:
        return []
    out: list[str] = []
    for i in range(n):
        h = i / n                              # full hue rotation, 0..1
        light = 0.50 + (0.06 if i % 2 == 0 else -0.06)
        sat = 0.55
        r, g, b = colorsys.hls_to_rgb(h, light, sat)
        out.append(f"#{int(r * 255):02x}{int(g * 255):02x}{int(b * 255):02x}")
    return out


# Public alias kept for the existing scatter call sites in plots.py.
categorical_palette = _categorical_palette
