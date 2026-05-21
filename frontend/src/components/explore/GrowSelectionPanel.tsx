import { useMemo, useState } from "react";
import { useDistanceToSetMutation } from "../../api/embeddings";
import { useUrlParam } from "../../hooks/useUrlState";
import {
  DISTANCE_TO_SET_COMPUTE_SIZE,
  DISTANCE_TO_SET_MAX_SELECTION,
  type FeatureTableListItem,
} from "../../api/types";
import { DistanceCdf } from "./DistanceCdf";
import { RangeSlider } from "./RangeSlider";

export type GrowthSpace = "raw" | "pca" | "mahalanobis";
export type GrowthReduction = "centroid" | "nearest" | "mean";

// Tooltip + inline help copy. The three spaces are easy to confuse — the
// hover tooltip is the short pitch, the inline help line under the
// segmented control is the differentiator. The contrast we want users
// to hold in mind:
//   - Raw:         every feature counts; correlated ones double-count.
//   - PCA:         drop the low-variance directions (treats them as noise).
//   - Mahalanobis: keep every direction, rescale so each contributes equally.
const SPACE_TOOLTIP: Record<GrowthSpace, string> = {
  raw: "Z-scored Euclidean — correlated features count twice",
  pca: "Top-K principal components — drops low-variance / noisy directions",
  mahalanobis:
    "Whitened over all components — every direction contributes equally after correlation correction",
};
const SPACE_HELP: Record<GrowthSpace, string> = {
  raw: "Each feature contributes once it's been z-scored, but correlated features double-count. Good as a sanity baseline.",
  pca: "Throws away the weakest directions and uses the strongest K. Smaller K = stronger denoising but more information loss.",
  mahalanobis:
    "Keeps every direction, rescaled so each carries equal weight. Use when you trust every feature and don't want to discard any axis.",
};

/** What lives in component state after a successful /distance_to_set call.
 *
 *  ``byCellId`` powers the synthetic ``__distance`` channel; the sorted
 *  arrays power the elbow-plot widget and the within-threshold action.
 *
 *  Probe lifecycle: the probe is **sticky** — it survives bag mutations
 *  (deselect, lasso replace, Esc clear). The seed list captured here is
 *  the user's bag at the moment of Compute, frozen, and "Reset to
 *  seeds" reverts the live selection back to it. A new round needs the
 *  user to repopulate the bag and click Compute again.
 *
 *  ``variance`` is what the user requested, ``varianceExplained`` is
 *  what the resolved K actually captured (always >= requested, since
 *  PCA is discrete). ``kPca`` is the resolved count. All three are null
 *  unless ``space === "pca"``. */
export interface DistanceProbe {
  byCellId: Map<string, number>;
  sortedCellIds: string[];
  sortedDistances: number[];
  space: GrowthSpace;
  reduction: GrowthReduction;
  variance: number | null;
  kPca: number | null;
  varianceExplained: number | null;
  /** Full set of cells the user had selected at Compute time. Powers
   *  "Reset to seeds" and stays frozen across later bag mutations. */
  seedCellIds: string[];
  featureColumns: string[];
  nSeedInIndex: number;
  nSeedMissing: number;
  /** Length of the returned distance arrays (= min(limit, n_universe)). */
  nReturned: number;
  /** Full universe size before top-K truncation. Lets the panel show
   *  "showing K of N" so the user knows the chart is a slice, not the
   *  whole universe. */
  nUniverse: number;
}

interface Props {
  ds: string;
  featureTableId: string;
  featureTable: FeatureTableListItem | null;
  selectionBag: string[];
  distanceProbe: DistanceProbe | null;
  onDistanceProbe: (probe: DistanceProbe | null) => void;
  onUnionIntoSelection: (cellIds: string[]) => void;
  /** Replace the selection bag wholesale. Used by the "Select" action
   *  on the within-threshold result so the user can refine their bag
   *  to (seeds + discovered similar cells) in one click. */
  onReplaceSelection: (cellIds: string[]) => void;
}

/**
 * Selection-growth controls + the result-driven CDF widget.
 *
 * Render contract: only mounted when ``selectionBag.length > 0``. The
 * panel takes the bag as the seed, lets the user pick a distance space
 * (Raw / PCA / Mahalanobis), a reduction over the seed set
 * (Centroid / Nearest / Mean), and optionally a subset of feature
 * columns. "Compute distances" hits ``/distance_to_set`` and lifts the
 * result up to the parent as a {@link DistanceProbe}.
 *
 * Once a probe exists, the user can (a) bind the synthetic
 * ``__distance`` channel via the channel picker (handled outside this
 * panel — the parent surfaces ``__distance`` once ``distanceProbe`` is
 * non-null), (b) click on the CDF to set a threshold and union all
 * within-threshold cells into the bag, or (c) union the top-K
 * closest cells.
 *
 * URL state: ``growth_space``, ``growth_kpca``, ``growth_reduction``,
 * ``growth_threshold``, ``growth_features`` reproduce the panel's
 * *settings* across refresh; the probe itself is local-state (large
 * arrays, can't ride the URL) and is cleared on reload.
 */
export function GrowSelectionPanel({
  ds,
  featureTableId,
  featureTable,
  selectionBag,
  distanceProbe,
  onDistanceProbe,
  onUnionIntoSelection,
  onReplaceSelection,
}: Props) {
  const [spaceRaw, setSpaceRaw] = useUrlParam("growth_space");
  const [varianceRaw, setVarianceRaw] = useUrlParam("growth_variance");
  const [reductionRaw, setReductionRaw] = useUrlParam("growth_reduction");
  const [thresholdRaw, setThresholdRaw] = useUrlParam("growth_threshold");
  const [featuresRaw, setFeaturesRaw] = useUrlParam("growth_features");
  // CDF viewport + "union top N" share one knob. Default is derived
  // from seed count once a probe exists; absent URL param means "use
  // the derived default." Keeping URL state for it makes shared links
  // open at the same zoom level.
  const [topNRaw, setTopNRaw] = useUrlParam("growth_topn");
  // In-progress edit string for the top-N input. Non-null only while
  // the user is actively typing — see the input's onChange / onBlur.
  const [topNDraft, setTopNDraft] = useState<string | null>(null);

  const space: GrowthSpace =
    spaceRaw === "raw" || spaceRaw === "mahalanobis" ? spaceRaw : "pca";
  const reduction: GrowthReduction =
    reductionRaw === "nearest" || reductionRaw === "mean"
      ? reductionRaw
      : "centroid";
  // Default 0.9 = "keep 90% of the variance," a standard PCA cutoff
  // that works regardless of feature count. The user can dial it down
  // for stronger denoising or up to 1.0 for full PCA rotation (close
  // to Mahalanobis but without the per-axis whitening).
  const variance = Math.max(
    0.01,
    Math.min(parseFloat(varianceRaw ?? "0.9") || 0.9, 1.0),
  );
  const threshold = thresholdRaw ? parseFloat(thresholdRaw) : null;

  // Seeds are already in the bag — the user's question is "what comes
  // Population for the chart + threshold actions. Seeds are *included*:
  // their distance is meaningful for non-centroid reductions (`nearest`,
  // `mean`) where it characterizes how tight the seed cluster is, and
  // even for `centroid` the cluster of seeds at d≈0 is informative as
  // the visual left edge. Earlier versions filtered seeds out; the
  // filter was deleted because (a) for `mean`/`nearest` it hid useful
  // structure, (b) Add is idempotent for already-in-bag cells so seed
  // inclusion is a no-op for those, and (c) Select uses the full
  // within-threshold list anyway. The chart can highlight seed
  // positions by index via `seedRanks` below.
  const population = useMemo(() => {
    if (!distanceProbe) return null;
    return {
      ids: distanceProbe.sortedCellIds,
      dists: distanceProbe.sortedDistances,
    };
  }, [distanceProbe]);

  // Default chart zoom. Keep it small — the elbow lives in the
  // closest few-dozen cells, and a default that's too wide compresses
  // the action region into the leftmost pixels. `max(20, 2 × seed)`
  // gives ≥20 for tiny seed sets and scales linearly with the seed
  // count without an upper cap (a 200-seed bag pre-zooms to 400,
  // which is still narrow relative to a 94k universe).
  const seedCount =
    distanceProbe?.seedCellIds.length ?? selectionBag.length;
  const universeCount = population?.ids.length ?? 0;
  const defaultTopN = Math.max(20, seedCount * 2);
  const topN = topNRaw
    ? Math.max(1, parseInt(topNRaw, 10) || defaultTopN)
    : defaultTopN;
  const effectiveTopN =
    universeCount > 0 ? Math.min(topN, universeCount) : topN;

  const manifestFeatures = useMemo<string[]>(
    () => featureTable?.feature_columns ?? [],
    [featureTable],
  );

  const chosenFeatures = useMemo<string[] | null>(() => {
    // Three states encoded in the URL param:
    //   - absent (``null``)  → use the manifest default (no override).
    //   - empty string       → explicit empty override (no features chosen).
    //                          Surfaces as "0 of N" in the picker so the
    //                          user can see they've cleared the selection;
    //                          Compute stays disabled until they re-add.
    //   - csv                → narrow override.
    // The empty-string case is what powers "deselect a whole category" —
    // without distinguishing it from null, removing the last column would
    // silently snap back to "all manifest features chosen."
    if (featuresRaw === null) return null;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of featuresRaw.split(",")) {
      const v = f.trim();
      if (!v || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
    }
    return out;
  }, [featuresRaw]);

  const chosenSet = useMemo(
    () => new Set(chosenFeatures ?? manifestFeatures),
    [chosenFeatures, manifestFeatures],
  );

  // The Advanced picker is meaningful only when the manifest declares
  // feature columns we can enumerate. Without it we still let the user
  // compute against the backend default — we just can't surface a list
  // to toggle.
  const canPick = manifestFeatures.length > 0;

  // Manifest-declared categories, intersected with manifestFeatures so
  // we never surface a column that isn't eligible for distance. Any
  // manifestFeature not referenced by any category lands in the
  // synthetic "Uncategorized" bucket — same fallback the channel picker
  // uses, so the two surfaces feel consistent.
  const categorizedFeatures = useMemo<
    Array<{ title: string; columns: string[] }>
  >(() => {
    const featureSet = new Set(manifestFeatures);
    const sections: Array<{ title: string; columns: string[] }> = [];
    const referenced = new Set<string>();
    for (const cat of featureTable?.categories ?? []) {
      const cols = cat.columns.filter((c) => featureSet.has(c));
      if (cols.length === 0) continue;
      for (const c of cols) referenced.add(c);
      sections.push({ title: cat.title, columns: cols });
    }
    const orphans = manifestFeatures.filter((c) => !referenced.has(c));
    if (orphans.length > 0) {
      sections.push({ title: "Uncategorized", columns: orphans });
    }
    return sections;
  }, [featureTable, manifestFeatures]);

  // Write a column set to URL state, normalizing back to ``null`` when
  // the set equals the manifest default — keeps shareable links clean
  // when the user hasn't actually overridden anything. Rejects sets of
  // 0 columns (the backend would 422 anyway and the URL would orphan a
  // useless override).
  const writeChosen = (next: string[]) => {
    if (next.length === 0) return;
    const dedup = Array.from(new Set(next));
    if (
      dedup.length === manifestFeatures.length &&
      manifestFeatures.every((c) => dedup.includes(c))
    ) {
      setFeaturesRaw(null);
    } else {
      setFeaturesRaw(dedup.join(","));
    }
  };

  const toggleFeature = (col: string) => {
    const base = chosenFeatures ?? manifestFeatures.slice();
    const next = base.includes(col)
      ? base.filter((c) => c !== col)
      : [...base, col];
    writeChosen(next);
  };

  // Bulk add a whole category to the chosen set (idempotent if all are
  // already on). Useful when the user wants to scope distance to a
  // semantic feature group without ticking each column.
  const setCategoryAll = (cols: string[]) => {
    const base = chosenFeatures ?? manifestFeatures.slice();
    const baseSet = new Set(base);
    for (const c of cols) baseSet.add(c);
    writeChosen(Array.from(baseSet));
  };
  // Bulk remove a whole category. If the result would leave <2 columns
  // the backend won't accept it; we still write the result (the Compute
  // button stays disabled below to surface the constraint).
  const setCategoryNone = (cols: string[]) => {
    const base = chosenFeatures ?? manifestFeatures.slice();
    const drop = new Set(cols);
    const next = base.filter((c) => !drop.has(c));
    // Keep at least the manifest default if the user empties everything
    // — otherwise writeChosen() would no-op and the URL state lies.
    if (next.length === 0) {
      setFeaturesRaw("");  // empty override — picker shows nothing checked
      return;
    }
    writeChosen(next);
  };

  const resetFeatures = () => setFeaturesRaw(null);

  const mutation = useDistanceToSetMutation();

  // Deterministic seed sample. Distance-to-set compute scales with
  // the seed-set size (and large seeds make the distance ambiguous
  // anyway — a centroid of 500 cells is hardly a "seed"), so we cap
  // what we send at DISTANCE_TO_SET_COMPUTE_SIZE. Picking the sample
  // matters:
  //   - random-each-time loses reproducibility (URL share + reload
  //     would compute against different seeds).
  //   - first-N-by-id is biased toward the front of the id space.
  //   - stride over the sorted id list is deterministic, easy to
  //     explain, and effectively uniform because cell_ids are not
  //     correlated with feature-space position.
  // Bag <= compute size → use everything as-is.
  const seedCellIds = useMemo(() => {
    if (selectionBag.length <= DISTANCE_TO_SET_COMPUTE_SIZE) {
      return selectionBag;
    }
    const sorted = [...selectionBag].sort();
    const out: string[] = [];
    const N = sorted.length;
    const K = DISTANCE_TO_SET_COMPUTE_SIZE;
    for (let i = 0; i < K; i++) {
      out.push(sorted[Math.floor((i * (N - 1)) / (K - 1))]);
    }
    return out;
  }, [selectionBag]);
  const seedIsSampled = seedCellIds.length < selectionBag.length;
  const seedAboveCeiling = selectionBag.length > DISTANCE_TO_SET_MAX_SELECTION;

  const compute = async () => {
    if (selectionBag.length === 0) return;
    if (chosenSet.size < 2) return;
    try {
      const resp = await mutation.mutateAsync({
        ds,
        featureTableId,
        cellIds: seedCellIds,
        space,
        reduction,
        variance: space === "pca" ? variance : undefined,
        featureColumns: chosenFeatures ?? undefined,
      });

      // Pre-sort by distance once so both the CDF render and the
      // "within threshold" / "top K" actions can binary-search instead
      // of re-sorting per interaction.
      const pairs = resp.cell_ids.map(
        (cid, i) => [cid, resp.distances[i]] as const,
      );
      pairs.sort((a, b) => a[1] - b[1]);
      const sortedCellIds = pairs.map(([c]) => c);
      const sortedDistances = pairs.map(([, d]) => d);
      const byCellId = new Map<string, number>();
      for (let i = 0; i < resp.cell_ids.length; i++) {
        byCellId.set(resp.cell_ids[i], resp.distances[i]);
      }

      onDistanceProbe({
        byCellId,
        sortedCellIds,
        sortedDistances,
        space: resp.space,
        reduction: resp.reduction,
        variance: resp.variance,
        kPca: resp.k_pca,
        varianceExplained: resp.variance_explained,
        nReturned: resp.n_returned,
        nUniverse: resp.n_universe,
        // Freeze the FULL bag as the seed list — not the sampled
        // subset that went to the API. "Reset to seeds" restores
        // exactly what the user had picked. The "computed on X of Y"
        // disclosure rides on `n_seed_in_index` from the server.
        seedCellIds: selectionBag.slice(),
        featureColumns: resp.feature_columns,
        nSeedInIndex: resp.n_seed_in_index,
        nSeedMissing: resp.n_seed_missing,
      });
    } catch {
      // useMutation's error state surfaces in render; nothing to do here.
    }
  };

  // Count of cells (seeds + non-seeds) whose distance is ≤ threshold.
  // Binary search on the pre-sorted distance array; the bound is the
  // first index where `dist > threshold`, which is also the count of
  // within-threshold cells.
  const withinCount = useMemo(() => {
    if (!population || threshold == null) return 0;
    let lo = 0;
    let hi = population.dists.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (population.dists[mid] <= threshold) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }, [population, threshold]);

  // Within-threshold action pair. Both are gated on a threshold being
  // set and at least one cell qualifying.
  //
  //   Add     — union the within-threshold cells into the current bag.
  //             Cells already in the bag (including seeds) are no-ops
  //             so the count answers "the set of cells the threshold
  //             cuts," even when many of them are already selected.
  //   Select  — replace the bag with exactly the within-threshold set.
  //             Drops cells the user manipulated into the bag between
  //             Compute and clicking; Select is a reset, not a merge.
  const addWithinThreshold = () => {
    if (!population || threshold == null || withinCount === 0) return;
    onUnionIntoSelection(population.ids.slice(0, withinCount));
  };
  const selectWithinThreshold = () => {
    if (!population || threshold == null || withinCount === 0) return;
    onReplaceSelection(population.ids.slice(0, withinCount));
  };
  // "Reset to seeds" — revert the live selection to the frozen seed
  // bag captured at Compute time. Useful after the user has explored
  // (e.g. lassoed onto an interesting subcluster) and wants to get
  // back to their seed population without re-running Compute.
  const resetToSeeds = () => {
    if (!distanceProbe) return;
    onReplaceSelection(distanceProbe.seedCellIds);
  };

  const computeDisabled =
    mutation.isPending ||
    selectionBag.length === 0 ||
    chosenSet.size < 2;

  return (
    <div className="explore-grow" aria-label="Grow selection by similarity">
      <div className="explore-grow-segmented" role="radiogroup" aria-label="Distance space">
        {(["raw", "pca", "mahalanobis"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={space === s}
            className={space === s ? "active" : ""}
            onClick={() => setSpaceRaw(s === "pca" ? null : s)}
            title={SPACE_TOOLTIP[s]}
          >
            {s === "pca" ? "PCA" : s === "raw" ? "Raw" : "Mahalanobis"}
          </button>
        ))}
      </div>
      <div className="explore-grow-help">{SPACE_HELP[space]}</div>

      {space === "pca" && (
        <>
          <RangeSlider
            label="variance"
            mode="single"
            min={variance}
            max={1.0}
            bound={{ lo: 0.5, hi: 1.0 }}
            step={0.05}
            formatValue={(v) => `${(v * 100).toFixed(0)}%`}
            onChange={({ min: v }) => {
              if (v === undefined || !Number.isFinite(v)) return;
              // Default 0.9 → null in URL (clean shareable link); any
              // other value persists.
              setVarianceRaw(Math.abs(v - 0.9) < 1e-6 ? null : v.toFixed(2));
            }}
          />
          {distanceProbe?.kPca != null &&
            distanceProbe.varianceExplained != null && (
              <div className="explore-grow-pca-info">
                {distanceProbe.kPca} of{" "}
                {distanceProbe.featureColumns.length} components (
                {(distanceProbe.varianceExplained * 100).toFixed(1)}% actual)
              </div>
            )}
        </>
      )}

      <div
        className="explore-grow-segmented"
        role="radiogroup"
        aria-label="Seed reduction"
      >
        {(["centroid", "nearest", "mean"] as const).map((r) => (
          <button
            key={r}
            type="button"
            role="radio"
            aria-checked={reduction === r}
            className={reduction === r ? "active" : ""}
            onClick={() => setReductionRaw(r === "centroid" ? null : r)}
            title={
              r === "centroid"
                ? "Distance to the seed centroid — best when seeds are tight"
                : r === "nearest"
                  ? "Min distance to any seed — picks up cells near any one of them"
                  : "Mean distance to every seed — penalizes outliers from the whole set"
            }
          >
            {r[0].toUpperCase() + r.slice(1)}
          </button>
        ))}
      </div>

      {canPick && (
        <details className="explore-grow-advanced">
          <summary>
            Features in distance ({chosenSet.size} of {manifestFeatures.length})
          </summary>
          {categorizedFeatures.map((section) => {
            const onCount = section.columns.reduce(
              (n, c) => (chosenSet.has(c) ? n + 1 : n),
              0,
            );
            return (
              <div
                key={section.title}
                className="explore-grow-feature-section"
              >
                <div className="explore-grow-feature-section-header">
                  <span className="explore-grow-feature-section-title">
                    {section.title}{" "}
                    <span className="explore-grow-feature-section-count">
                      ({onCount}/{section.columns.length})
                    </span>
                  </span>
                  <span className="explore-grow-feature-section-actions">
                    <button
                      type="button"
                      onClick={() => setCategoryAll(section.columns)}
                      disabled={onCount === section.columns.length}
                      title={`Include every ${section.title} feature in the distance`}
                    >
                      all
                    </button>
                    <button
                      type="button"
                      onClick={() => setCategoryNone(section.columns)}
                      disabled={onCount === 0}
                      title={`Exclude every ${section.title} feature from the distance`}
                    >
                      none
                    </button>
                  </span>
                </div>
                <div className="explore-grow-features">
                  {section.columns.map((c) => (
                    <label key={c}>
                      <input
                        type="checkbox"
                        checked={chosenSet.has(c)}
                        onChange={() => toggleFeature(c)}
                      />
                      {c}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
          {chosenFeatures !== null && (
            <button
              type="button"
              className="explore-grow-feature-reset"
              onClick={resetFeatures}
              title="Restore the feature selection to the manifest's default set"
            >
              Reset to manifest default
            </button>
          )}
        </details>
      )}

      <div className="explore-grow-actions">
        <button
          type="button"
          className="primary"
          onClick={compute}
          disabled={computeDisabled}
          title="Compute distances from the current seeds across all cells in scope"
        >
          {mutation.isPending ? "Computing…" : "Compute distances"}
        </button>
        {distanceProbe && (
          <>
            <button
              type="button"
              onClick={resetToSeeds}
              title="Re-anchor the distance probe back to the current selection"
            >
              Reset to seeds
            </button>
            <button
              type="button"
              onClick={() => onDistanceProbe(null)}
              title="Clear the distance probe and discard computed distances"
            >
              Clear probe
            </button>
          </>
        )}
      </div>

      {chosenSet.size < 2 && (
        <div className="explore-grow-error">
          Pick at least two feature columns to compute distance.
        </div>
      )}
      {seedIsSampled && (
        <div className="explore-grow-help">
          Seed: using a {DISTANCE_TO_SET_COMPUTE_SIZE}-cell deterministic
          sample of your {selectionBag.length.toLocaleString()}-cell
          selection. Larger seeds make the distance ambiguous and the
          pairwise compute expensive; the same sample is reused on
          reload so a shared URL recomputes the same distances.
        </div>
      )}
      {seedAboveCeiling && (
        <div className="explore-grow-error">
          Selection is large ({selectionBag.length.toLocaleString()}{" "}
          cells, ceiling{" "}
          {DISTANCE_TO_SET_MAX_SELECTION.toLocaleString()}). Compute will
          still run on a {DISTANCE_TO_SET_COMPUTE_SIZE}-cell sample, but
          a sample drawn from this many cells may not represent the
          population you actually mean.
        </div>
      )}
      {mutation.error && (
        <div className="explore-grow-error">{mutation.error.message}</div>
      )}

      {distanceProbe && (
        <>
          <div className="explore-grow-stats">
            top {(population?.ids.length ?? 0).toLocaleString()} of{" "}
            {distanceProbe.nUniverse.toLocaleString()} cells —
            range [{population?.dists[0]?.toFixed(2) ?? "0.00"},{" "}
            {population?.dists[population.dists.length - 1]?.toFixed(2) ?? "0.00"}]
            {distanceProbe.nSeedMissing > 0 &&
              ` · ${distanceProbe.nSeedMissing} seeds dropped (not in feature matrix)`}
          </div>

          {/* Chart zoom knob — caps the elbow plot at the leftmost N
              cells where the kink lives. Default
              ``max(20, 2 × seed count)`` is sized to the seed bag.

              `topNDraft` is the in-progress text the user is typing.
              While non-null it owns the displayed value, so the user
              can pass through intermediate "" / leading-zero states
              without the controlled `value` snapping back. We commit
              on blur / Enter, then clear the draft so the input
              re-syncs to `effectiveTopN`. */}
          <div className="explore-grow-row">
            <label htmlFor="explore-grow-topn">top N closest</label>
            <input
              id="explore-grow-topn"
              type="number"
              min={1}
              max={universeCount}
              value={topNDraft ?? String(effectiveTopN)}
              onChange={(e) => setTopNDraft(e.target.value)}
              onBlur={() => {
                if (topNDraft == null) return;
                const v = parseInt(topNDraft, 10);
                if (Number.isFinite(v) && v >= 1) {
                  setTopNRaw(v === defaultTopN ? null : String(v));
                }
                setTopNDraft(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  (e.currentTarget as HTMLInputElement).blur();
                } else if (e.key === "Escape") {
                  setTopNDraft(null);
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }}
            />
            {topNRaw && (
              <button
                type="button"
                className="explore-grow-feature-reset"
                onClick={() => {
                  setTopNRaw(null);
                  setTopNDraft(null);
                }}
                title={`Reset to seed-derived default (${defaultTopN})`}
              >
                reset
              </button>
            )}
            <span className="explore-grow-stats">
              {effectiveTopN === universeCount
                ? "all returned"
                : `${((effectiveTopN / (distanceProbe?.nUniverse ?? universeCount)) * 100).toFixed(2)}% of universe`}
            </span>
          </div>

          <DistanceCdf
            sortedDistances={
              population?.dists.slice(0, effectiveTopN) ?? []
            }
            threshold={threshold}
            onThresholdChange={(v) => setThresholdRaw(v.toFixed(4))}
            withinCount={withinCount}
          />

          <div className="explore-grow-row">
            <label htmlFor="explore-grow-threshold">threshold</label>
            <input
              id="explore-grow-threshold"
              type="number"
              step="0.01"
              value={threshold ?? ""}
              placeholder="click CDF"
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v)) setThresholdRaw(String(v));
                else setThresholdRaw(null);
              }}
            />
            <span className="explore-grow-stats">
              {withinCount.toLocaleString()} within
            </span>
          </div>

          {/* Threshold action pair — Select replaces the bag with
              (seeds + within-threshold non-seeds); Add unions the
              within-threshold non-seeds into the existing bag.
              Mirrors the Select/Add semantics used elsewhere in the
              SPA so the user doesn't have to learn a per-panel
              vocabulary. The top-N input above is now purely a
              CDF-zoom control and no longer drives an action. */}
          <div className="explore-grow-actions">
            <button
              type="button"
              className="primary"
              onClick={selectWithinThreshold}
              disabled={threshold == null || withinCount === 0}
              title={
                threshold == null
                  ? "Click the CDF or type a threshold first"
                  : withinCount === 0
                    ? "No non-seed cells within this threshold"
                    : `Replace the selection with the ${distanceProbe?.seedCellIds.length ?? 0} seed${(distanceProbe?.seedCellIds.length ?? 0) === 1 ? "" : "s"} plus the ${withinCount.toLocaleString()} within-threshold cells`
              }
            >
              Select
            </button>
            <button
              type="button"
              onClick={addWithinThreshold}
              disabled={threshold == null || withinCount === 0}
              title={
                threshold == null
                  ? "Click the CDF or type a threshold first"
                  : withinCount === 0
                    ? "No non-seed cells within this threshold"
                    : `Add the ${withinCount.toLocaleString()} within-threshold cells to the current selection`
              }
            >
              Add
            </button>
            <span className="explore-grow-stats">
              {threshold == null
                ? "set a threshold to enable"
                : `${withinCount.toLocaleString()} within threshold`}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
