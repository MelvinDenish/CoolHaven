/**
 * The what-if engine (base PRD FR9 / FR10).
 *
 * Design rule, and the reason before/after numbers are comparable at all:
 * an intervention does not produce a delta directly. It produces a MODIFIED
 * HEAT FIELD, which is then fed to the same `scoreRoute` and the same demand
 * calculation as the baseline. There is no second estimator anywhere.
 *
 *   baseline field                  --> scoreRoute --> before
 *   applyInterventions(field, plan) --> scoreRoute --> after
 *
 * Every coefficient used here comes from lib/assumptions.ts and is rendered in
 * the scenario panel next to the control that applies it.
 */
import {
  INTERVENTIONS,
  INTERVENTION_KINDS,
  MAX_STACKED_COOLING_F,
  MOVEMENT,
} from './assumptions';
import { HeatField, cellCenter, planarM } from './grid';
import { ACCESS_INTERVENTIONS } from './types';
import type { HeatGrid, Intervention, InterventionKind, ReliefSite } from './types';

/**
 * Linear distance decay: full effect at the centre, zero at radiusM.
 *
 * A Gaussian would look prettier but would imply a calibrated dispersion we do
 * not have. Linear falloff is the honest shape for an illustrative coefficient
 * and it is trivial for a reviewer to reason about.
 */
export function decay(distanceM: number, radiusM: number): number {
  if (distanceM >= radiusM) return 0;
  return 1 - distanceM / radiusM;
}

/**
 * Distance from a point to an intervention's treated geometry.
 *
 * A station is a point, so this is a point-to-point distance. A canopy or
 * pavement corridor is a line, so it is the perpendicular distance to the
 * nearest segment - which is what makes a shade corridor cool the street it
 * runs along rather than a circle centred on its midpoint.
 */
export function distanceToIntervention(
  lon: number,
  lat: number,
  iv: Intervention,
): number {
  if (!iv.corridor || iv.corridor.length < 2) {
    return planarM([lon, lat], [iv.lon, iv.lat]);
  }
  let best = Infinity;
  for (let i = 1; i < iv.corridor.length; i++) {
    const d = pointToSegmentM([lon, lat], iv.corridor[i - 1], iv.corridor[i]);
    if (d < best) best = d;
  }
  return best;
}

/** Perpendicular distance from a point to a segment, in metres. */
function pointToSegmentM(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  // Project into a local metric frame first; doing the projection in degrees
  // skews everything by the cos(lat) factor and quietly biases corridors
  // running east-west.
  const mLon = 111_320 * Math.cos((p[1] * Math.PI) / 180);
  const mLat = 110_574;
  const px = p[0] * mLon;
  const py = p[1] * mLat;
  const ax = a[0] * mLon;
  const ay = a[1] * mLat;
  const bx = b[0] * mLon;
  const by = b[1] * mLat;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Bounding box of an intervention's influence, in degrees. */
function influenceBbox(iv: Intervention): [number, number, number, number] {
  const pts: Array<[number, number]> = iv.corridor?.length
    ? iv.corridor
    : [[iv.lon, iv.lat]];
  const degLat = iv.radiusM / 110_574;
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of pts) {
    const degLon = iv.radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
    minLon = Math.min(minLon, lon - degLon);
    maxLon = Math.max(maxLon, lon + degLon);
    minLat = Math.min(minLat, lat - degLat);
    maxLat = Math.max(maxLat, lat + degLat);
  }
  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Build a new HeatField with every intervention's cooling applied.
 *
 * Cost note: this is O(interventions x affected cells), not O(interventions x
 * all cells) - each intervention only touches the cell window its radius
 * covers, which keeps a 12-intervention scenario under a few milliseconds and
 * lets the panel recompute on every slider move (NFR: <3 s in-app).
 */
export function applyInterventions(
  field: HeatField,
  interventions: Intervention[],
): HeatField {
  const cooling = interventions.filter((i) => i.deltaF !== 0);
  if (cooling.length === 0) return field;

  const modified: HeatGrid[] = field.grids.map((g) => {
    // Accumulated cooling per cell, so the stack cap applies to the total.
    const delta = new Float32Array(g.tempsF.length);

    const dLon = (g.bbox[2] - g.bbox[0]) / g.cols;
    const dLat = (g.bbox[3] - g.bbox[1]) / g.rows;

    for (const iv of cooling) {
      // Cell window covering this intervention's influence, plus one cell
      // margin. For a corridor that window is the whole line's envelope, not
      // a circle around its midpoint.
      const [bLon0, bLat0, bLon1, bLat1] = influenceBbox(iv);
      const c0 = Math.floor((bLon0 - g.bbox[0]) / dLon) - 1;
      const c1 = Math.ceil((bLon1 - g.bbox[0]) / dLon) + 1;
      const r0 = Math.floor((bLat0 - g.bbox[1]) / dLat) - 1;
      const r1 = Math.ceil((bLat1 - g.bbox[1]) / dLat) + 1;

      for (let r = Math.max(0, r0); r <= Math.min(g.rows - 1, r1); r++) {
        for (let c = Math.max(0, c0); c <= Math.min(g.cols - 1, c1); c++) {
          const [lon, lat] = cellCenter(g, c, r);
          const f = decay(distanceToIntervention(lon, lat, iv), iv.radiusM);
          if (f > 0) delta[r * g.cols + c] += iv.deltaF * f;
        }
      }
    }

    // Cooling applies to the whole daily range, not just the average: shade
    // that drops the mean also drops the peak. Applying it to one array only
    // would make the day-part selector show an intervention working at noon
    // and doing nothing at the peak, which is the wrong way round.
    const shift = (arr: number[] | undefined) =>
      (arr ?? g.tempsF).map((t, i) => {
        const d = Math.max(delta[i], -MAX_STACKED_COOLING_F);
        return Math.round((t + d) * 10) / 10;
      });

    const tempsF = shift(g.tempsF);

    return {
      ...g,
      tempsF,
      tempsMinF: shift(g.tempsMinF),
      tempsMaxF: shift(g.tempsMaxF),
      provenance: {
        ...g.provenance,
        note: `${g.provenance.note} | scenario applied: ${cooling.length} cooling intervention(s), stack capped at ${MAX_STACKED_COOLING_F} °F`,
      },
    };
  });

  return new HeatField(modified, field.dayPart);
}

/**
 * Relief sites as they exist under a scenario: the real published Heat Relief
 * Network plus any station the scenario proposes.
 *
 * This is the half of the model that makes the ACCESS interventions matter at
 * all. Their specs set deltaF to 0 on purpose - a station does not cool the
 * street, it changes whether a worker has anywhere to stop - so their whole
 * effect flows through coverage, here.
 *
 * Driven by ACCESS_INTERVENTIONS rather than an inline `kind === 'cooling_station'`
 * test, so adding a zero-effect intervention (the bus-shelter retrofit) cannot
 * silently contribute nothing.
 */
export function effectiveReliefSites(
  sites: ReliefSite[],
  interventions: Intervention[],
): ReliefSite[] {
  const proposed = interventions
    .filter((i) => ACCESS_INTERVENTIONS.includes(i.kind))
    .map<ReliefSite>((i) => ({
      id: i.id,
      name: i.label,
      org: 'Proposed (scenario)',
      kind: 'cooling_center',
      lon: i.lon,
      lat: i.lat,
      address: null,
      city: null,
      phone: null,
      hours: null,
      // A proposed station is notional, so it has no published hours. It is
      // marked open-24 rather than unknown so scenario coverage is evaluated
      // on the merits of the placement, not on a hours field that cannot
      // exist yet for a building nobody has built.
      hoursByDay: [null, null, null, null, null, null, null],
      open24: true,
      hoursKnown: false,
      services: null,
      pets: null,
      adaAccessible: null,
      seasonStart: null,
      seasonEnd: null,
      source: 'offline',
      verifiedDate: '',
      proposed: true,
    }));
  return [...sites, ...proposed];
}

export interface ScenarioCost {
  totalUsd: number;
  byKind: Record<InterventionKind, { count: number; usd: number }>;
}

export function scenarioCost(interventions: Intervention[]): ScenarioCost {
  // Built from the palette rather than listed by hand, so a new intervention
  // kind cannot be left out of the cost breakdown and silently cost nothing.
  const byKind = Object.fromEntries(
    INTERVENTION_KINDS.map((k) => [k, { count: 0, usd: 0 }]),
  ) as ScenarioCost['byKind'];

  for (const iv of interventions) {
    const spec = INTERVENTIONS[iv.kind];
    byKind[iv.kind].count += 1;
    byKind[iv.kind].usd += spec.unitCostUsd;
  }
  const totalUsd = Object.values(byKind).reduce((a, b) => a + b.usd, 0);
  return { totalUsd, byKind };
}

/** Build an intervention from a click on the map, using the spec defaults. */
export function makeIntervention(
  kind: InterventionKind,
  lon: number,
  lat: number,
  index: number,
  opts: { recommended?: boolean; note?: string; label?: string } = {},
): Intervention {
  const spec = INTERVENTIONS[kind];
  return {
    id: `${kind}-${index}-${Math.round(lon * 1e5)}-${Math.round(lat * 1e5)}`,
    kind,
    label: opts.label ?? `${spec.short} ${index}`,
    lon,
    lat,
    radiusM: spec.radiusM,
    deltaF: spec.deltaF,
    recommended: opts.recommended,
    note: opts.note,
  };
}

/**
 * Mean temperature over just the cells a scenario actually treats.
 *
 * Why this exists: the area-wide mean is nearly immune to local work. One
 * 250 m canopy corridor covers roughly 19 of the focus area's 6,776 cells, so
 * it moves the district average by about 0.003 °F - which rounds to "no
 * change" and makes a working tool look broken.
 *
 * Reporting both is the honest answer, and the pair is the more useful reading
 * anyway: the treated-area figure says what the intervention did where it was
 * put, and the district figure says how little that shifts a whole district -
 * itself a real and important message about the scale of work required.
 *
 * Returns null when the scenario treats nothing.
 */
export function treatedAreaMeanF(
  field: HeatField,
  interventions: Intervention[],
): number | null {
  const treating = interventions.filter((i) => i.deltaF !== 0);
  if (treating.length === 0) return null;

  let sum = 0;
  let n = 0;
  for (const cell of field.cells()) {
    const inside = treating.some(
      (iv) => distanceToIntervention(cell.lon, cell.lat, iv) <= iv.radiusM,
    );
    if (inside) {
      sum += cell.tempF;
      n++;
    }
  }
  return n ? sum / n : null;
}

/**
 * Share of the focus area within a walk of relief.
 * This is the headline the Planner panel leads with, because it is the number
 * a city actually buys: coverage, not degrees.
 */
export function coverageShare(field: HeatField, sites: ReliefSite[]): number {
  const pts = sites.map((s) => [s.lon, s.lat] as [number, number]);
  let covered = 0;
  let total = 0;
  for (const cell of field.cells()) {
    total++;
    for (const p of pts) {
      if (planarM([cell.lon, cell.lat], p) <= MOVEMENT.walkToReliefM) {
        covered++;
        break;
      }
    }
  }
  return total ? covered / total : 0;
}
