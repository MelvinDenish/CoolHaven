/**
 * Scenario solvers - the difference between a tool that annotates and a tool
 * that plans.
 *
 * The siting engine in recommend.ts answers "where are the worst gaps". That is
 * the analyst's question. A council asks two different ones, and until now
 * neither had an answer:
 *
 *   BUDGET   "We have $500,000. What is the best mix we can buy?"
 *   TARGET   "We want a quarter of the focus area within a walk of relief.
 *             What does that cost, and how many sites?"
 *
 * Both run entirely in the browser against the cached snapshot, like every
 * other computation in the product, so a solve is instant and costs no credits.
 *
 * ---------------------------------------------------------------------------
 * WHY GREEDY, AND WHAT THAT COSTS
 *
 * Maximising coverage for a budget is a variant of maximum coverage, which is
 * NP-hard - and because placements interact (two stations 300 m apart cover
 * overlapping ground), the value of a candidate depends on what is already
 * chosen. So these solve greedily by MARGINAL coverage per dollar: at each
 * step, re-evaluate every remaining candidate against the coverage already
 * bought, take the best ratio, repeat.
 *
 * Greedy on a submodular objective is not optimal, but it is provably within a
 * constant factor of it, and it has a property that matters more here than the
 * last few percent: a planner can follow the reasoning. "It bought this one
 * first because it covered the most uncovered ground per dollar" is defensible
 * in a meeting. A branch-and-bound optimum that lands on a different set for
 * reasons nobody can reconstruct is not.
 *
 * The UI says it is greedy rather than implying an optimum.
 */
import { INTERVENTIONS } from './assumptions';
import { MOVEMENT } from './assumptions';
import { planarM } from './grid';
import type { DemandCell, Intervention, InterventionKind } from './types';
import type { Recommendation } from './recommend';

export interface SolveCandidate extends Recommendation {
  /** Cells this candidate would newly bring within a walk, given what is chosen. */
  marginalCells: number;
}

export interface SolveResult {
  chosen: Intervention[];
  /** Coverage before any of it, 0..1. */
  baseCoverage: number;
  /** Coverage after the chosen set, 0..1. */
  finalCoverage: number;
  totalUsd: number;
  /** Dollars per coverage point gained, or null when nothing was gained. */
  usdPerPoint: number | null;
  /** True when the solver ran out of candidates before satisfying the ask. */
  exhausted: boolean;
  /** One sentence the panel renders verbatim. */
  note: string;
}

/**
 * Which cells sit within a walk of at least one relief point.
 *
 * Represented as a Uint8Array over the demand grid rather than a Set of ids -
 * the solver re-tests every candidate against it on every iteration, so this is
 * the hot path.
 */
function coveredMask(cells: DemandCell[]): Uint8Array {
  const mask = new Uint8Array(cells.length);
  for (let i = 0; i < cells.length; i++) {
    mask[i] = cells[i].reliefDistanceM <= MOVEMENT.walkToReliefM ? 1 : 0;
  }
  return mask;
}

/** Cells a point at (lon, lat) would bring within the walk radius. */
function cellsCoveredBy(
  cells: DemandCell[],
  lon: number,
  lat: number,
  radiusM: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    if (planarM([lon, lat], [cells[i].lon, cells[i].lat]) <= radiusM) out.push(i);
  }
  return out;
}

interface SolveOptions {
  /** Hard cap in dollars, or null for "no budget limit". */
  budgetUsd: number | null;
  /** Stop once coverage reaches this fraction, or null for "spend it all". */
  targetCoverage: number | null;
  /** Which intervention to place. Only access kinds change coverage. */
  kind: InterventionKind;
  /** Safety rail so a pathological ask cannot spin. */
  maxPlacements?: number;
}

/**
 * The shared engine behind both solvers.
 *
 * Only ACCESS interventions are placed, because coverage is the objective and a
 * canopy corridor does not change who has somewhere to stop. Mixing a cooling
 * effect into a coverage objective would be comparing two different things and
 * calling the result a plan.
 */
export function solveCoverage(
  candidates: Recommendation[],
  cells: DemandCell[],
  opts: SolveOptions,
): SolveResult {
  const spec = INTERVENTIONS[opts.kind];
  const unitCost = spec.unitCostUsd;
  const radius = MOVEMENT.walkToReliefM;
  const maxPlacements = opts.maxPlacements ?? 40;

  const mask = coveredMask(cells);
  const total = cells.length || 1;
  let coveredCount = mask.reduce((a, b) => a + b, 0);
  const baseCoverage = coveredCount / total;

  // Precompute each candidate's footprint once; membership does not change,
  // only how much of it is still uncovered.
  const footprints = candidates.map((c) => cellsCoveredBy(cells, c.lon, c.lat, radius));

  const chosen: Intervention[] = [];
  const used = new Set<number>();
  let spent = 0;
  let exhausted = false;

  for (let step = 0; step < maxPlacements; step++) {
    if (opts.targetCoverage !== null && coveredCount / total >= opts.targetCoverage) break;
    if (opts.budgetUsd !== null && spent + unitCost > opts.budgetUsd) break;

    let best = -1;
    let bestGain = 0;
    for (let i = 0; i < candidates.length; i++) {
      if (used.has(i)) continue;
      let gain = 0;
      for (const idx of footprints[i]) if (!mask[idx]) gain++;
      // Strictly greater: ties keep the earlier, higher-demand candidate.
      if (gain > bestGain) {
        bestGain = gain;
        best = i;
      }
    }

    // No remaining candidate adds anything - stop rather than buy a site that
    // covers only ground already covered.
    if (best < 0 || bestGain === 0) {
      exhausted = true;
      break;
    }

    for (const idx of footprints[best]) {
      if (!mask[idx]) {
        mask[idx] = 1;
        coveredCount++;
      }
    }
    used.add(best);
    spent += unitCost;

    const c = candidates[best];
    chosen.push({
      id: `solve-${opts.kind}-${step}-${Math.round(c.lon * 1e5)}-${Math.round(c.lat * 1e5)}`,
      kind: opts.kind,
      label: `${spec.short} ${chosen.length + 1}`,
      lon: c.lon,
      lat: c.lat,
      radiusM: spec.radiusM,
      deltaF: spec.deltaF,
      recommended: true,
      note:
        `Chosen by the ${opts.budgetUsd !== null ? 'budget' : 'target'} solver: ` +
        `brought ${bestGain} more cells within a ${radius} m walk at this step.`,
    });
  }

  const finalCoverage = coveredCount / total;
  const gainedPoints = (finalCoverage - baseCoverage) * 100;

  return {
    chosen,
    baseCoverage,
    finalCoverage,
    totalUsd: spent,
    usdPerPoint: gainedPoints > 0 ? spent / gainedPoints : null,
    exhausted,
    note: buildNote(opts, chosen.length, gainedPoints, spent, exhausted, finalCoverage),
  };
}

/** "I have $X" - spend up to the cap, maximising marginal coverage per dollar. */
export function solveForBudget(
  candidates: Recommendation[],
  cells: DemandCell[],
  budgetUsd: number,
  kind: InterventionKind = 'cooling_station',
): SolveResult {
  return solveCoverage(candidates, cells, {
    budgetUsd,
    targetCoverage: null,
    kind,
  });
}

/** "I want X% coverage" - buy until the target is met, and report the bill. */
export function solveForTarget(
  candidates: Recommendation[],
  cells: DemandCell[],
  targetCoverage: number,
  kind: InterventionKind = 'cooling_station',
): SolveResult {
  return solveCoverage(candidates, cells, {
    budgetUsd: null,
    targetCoverage,
    kind,
  });
}

function buildNote(
  opts: SolveOptions,
  count: number,
  gainedPoints: number,
  spent: number,
  exhausted: boolean,
  finalCoverage: number,
): string {
  if (count === 0) {
    return exhausted
      ? 'No candidate site would bring new ground within a walk. The gaps left are beyond the siting floor.'
      : 'The budget does not cover a single site.';
  }

  const money = `$${Math.round(spent / 1000)}k`;
  const cov = `${(finalCoverage * 100).toFixed(1)}%`;

  if (opts.targetCoverage !== null) {
    const target = `${(opts.targetCoverage * 100).toFixed(0)}%`;
    return exhausted
      ? `Ran out of viable sites at ${cov}, short of the ${target} target. ${count} sites, ${money}. Reaching it needs candidates below the current demand floor, or a different intervention.`
      : `${count} sites reach ${target} coverage for about ${money}. Greedy by marginal coverage per site, so this is a defensible plan rather than a proven optimum.`;
  }

  return `${money} buys ${count} sites and ${gainedPoints.toFixed(1)} coverage points, reaching ${cov}. Each was chosen for the most new ground per dollar at the time it was picked.`;
}
