/**
 * Demand layer (base PRD FR7) and station siting (FR8).
 *
 * FR7 was called out in the PRD's own change log as previously "left
 * undefined". It is defined here and nowhere else, and the exact sentence
 * rendered under the layer toggle is `DEMAND_NOTE` from assumptions.ts, so the
 * UI cannot describe a heuristic other than the one that ran.
 */
import {
  COVERAGE_GAP_M,
  DEMAND_WEIGHTS,
  MOVEMENT,
  RECOMMENDATION_SPACING_M,
  THRESHOLDS,
} from './assumptions';
import { HeatField, densifyPath, planarM } from './grid';
import { makeIntervention } from './whatif';
import type { DemandCell, Intervention, ReliefSite, RouteFeature } from './types';

/** Per-cell drivable road length, precomputed by scripts/fetch-osm.ts. */
export interface RoadDensity {
  schema: 'coolroute.roaddensity.v1';
  granularityM: number;
  source: string;
  fetchedAt: string;
  tiles: Record<string, { cols: number; rows: number; values: number[] }>;
}

/**
 * Composite exposure demand per grid cell.
 *
 * Three normalised terms, weights in assumptions.ts:
 *   heat         - how far above the comfort threshold this cell runs
 *   roadDensity  - OSM drivable road length in the cell (where work happens)
 *   routeDensity - how many generated courier routes actually pass through
 *
 * The third term is what stops the layer from simply re-drawing the heat map:
 * the hottest cell in a rail yard nobody delivers to should not outrank a
 * merely hot cell that eight routes cross every afternoon.
 */
export function buildDemandLayer(
  field: HeatField,
  roads: RoadDensity | null,
  routes: RouteFeature[],
  sites: ReliefSite[],
): DemandCell[] {
  const routeHits = routeDensityIndex(field, routes);

  const raw: Array<{
    lon: number;
    lat: number;
    tempF: number;
    heat: number;
    road: number;
    route: number;
  }> = [];

  let maxHeat = 0;
  let maxRoad = 0;
  let maxRoute = 0;

  // Cell order from field.cells() is stable (tile, then row, then col), the
  // same order scripts/fetch-osm.ts writes road density in.
  const perTileCursor: Record<string, number> = {};

  for (const cell of field.cells()) {
    const idx = (perTileCursor[cell.tileId] = (perTileCursor[cell.tileId] ?? -1) + 1);
    const heat = Math.max(0, cell.tempF - THRESHOLDS.comfortF);
    const road = roads?.tiles[cell.tileId]?.values[idx] ?? 0;
    const route = routeHits.get(keyOf(cell.lon, cell.lat)) ?? 0;

    if (heat > maxHeat) maxHeat = heat;
    if (road > maxRoad) maxRoad = road;
    if (route > maxRoute) maxRoute = route;

    raw.push({ lon: cell.lon, lat: cell.lat, tempF: cell.tempF, heat, road, route });
  }

  const sitePts = sites.map((s) => [s.lon, s.lat] as [number, number]);

  return raw.map((r) => {
    const heatN = maxHeat ? r.heat / maxHeat : 0;
    const roadN = maxRoad ? r.road / maxRoad : 0;
    const routeN = maxRoute ? r.route / maxRoute : 0;
    const demand =
      DEMAND_WEIGHTS.heat * heatN +
      DEMAND_WEIGHTS.roadDensity * roadN +
      DEMAND_WEIGHTS.routeDensity * routeN;

    const reliefDistanceM = nearestDistanceM([r.lon, r.lat], sitePts);
    // Gap ramps from 0 at the walk radius to 1 at the coverage-gap threshold.
    const gap = clamp01(
      (reliefDistanceM - MOVEMENT.walkToReliefM) /
        Math.max(1, COVERAGE_GAP_M - MOVEMENT.walkToReliefM),
    );

    return {
      lon: r.lon,
      lat: r.lat,
      tempF: r.tempF,
      demand: round3(demand),
      roadWeight: round3(roadN),
      routeWeight: round3(routeN),
      reliefDistanceM: Math.round(reliefDistanceM),
      gap: round3(gap),
    };
  });
}

/** How many route samples fall in each grid cell. */
function routeDensityIndex(field: HeatField, routes: RouteFeature[]): Map<string, number> {
  const hits = new Map<string, number>();
  const g = field.grids[0];
  const cellDeg = {
    lon: (g.bbox[2] - g.bbox[0]) / g.cols,
    lat: (g.bbox[3] - g.bbox[1]) / g.rows,
  };

  for (const route of routes) {
    for (const p of densifyPath(route.coords, MOVEMENT.sampleSpacingM)) {
      // Snap the sample onto the shared cell lattice.
      const lon = Math.round(p.lon / cellDeg.lon) * cellDeg.lon;
      const lat = Math.round(p.lat / cellDeg.lat) * cellDeg.lat;
      const k = keyOf(lon, lat);
      hits.set(k, (hits.get(k) ?? 0) + 1);
    }
  }

  // Smooth into a 1-cell neighbourhood so a route lights up the block it runs
  // along rather than a single-cell hairline.
  const smoothed = new Map<string, number>();
  for (const cell of field.cells()) {
    const lon = Math.round(cell.lon / cellDeg.lon) * cellDeg.lon;
    const lat = Math.round(cell.lat / cellDeg.lat) * cellDeg.lat;
    let sum = 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        sum += hits.get(keyOf(lon + dx * cellDeg.lon, lat + dy * cellDeg.lat)) ?? 0;
      }
    }
    if (sum > 0) smoothed.set(keyOf(cell.lon, cell.lat), sum);
  }
  return smoothed;
}

/* -------------------------------------------------------------------------- */
/* Station siting (FR8)                                                       */
/* -------------------------------------------------------------------------- */

export interface Recommendation extends Intervention {
  demand: number;
  gap: number;
  /**
   * Metres to the nearest OPEN relief site.
   *
   * This is carried alongside `gap` because `gap` cannot be shown to a user on
   * its own. It is a ramp normalised over walkToReliefM -> COVERAGE_GAP_M,
   * which is a 200 m window, so every candidate worth recommending saturates
   * at 1.0 and the ranked list reads "gap 100%" all the way down. The distance
   * is the number that actually discriminates - measured across the committed
   * Phoenix snapshot, the top six candidates span 778 m to 3,525 m while all
   * six report the same 100%.
   */
  reliefDistanceM: number;
  tempF: number;
  rank: number;
}

/**
 * Greedy siting: rank candidate cells by demand x coverage gap, take the best,
 * then suppress everything within RECOMMENDATION_SPACING_M and repeat.
 *
 * Greedy rather than clustered on purpose - a planner can follow "the highest
 * uncovered-demand cell, then the next one at least 700 m away" and check it
 * by eye. A k-means centroid is harder to argue in front of a council.
 */
export function recommendStations(cells: DemandCell[], count: number): Recommendation[] {
  const candidates = cells
    .filter((c) => c.gap > 0.15 && c.demand > 0.2)
    .map((c) => ({ cell: c, score: c.demand * (0.35 + 0.65 * c.gap) }))
    .sort((a, b) => b.score - a.score);

  const picked: Recommendation[] = [];
  for (const cand of candidates) {
    if (picked.length >= count) break;
    const tooClose = picked.some(
      (p) =>
        planarM([p.lon, p.lat], [cand.cell.lon, cand.cell.lat]) < RECOMMENDATION_SPACING_M,
    );
    if (tooClose) continue;

    const rank = picked.length + 1;
    const iv = makeIntervention('cooling_station', cand.cell.lon, cand.cell.lat, rank, {
      recommended: true,
      label: `Recommended station #${rank}`,
      note:
        `Work exposure ${cand.cell.demand.toFixed(2)}, ` +
        `${cand.cell.reliefDistanceM} m from the nearest existing Heat Relief Network site, ` +
        `baseline ${cand.cell.tempF.toFixed(1)} °F.`,
    });

    picked.push({
      ...iv,
      demand: cand.cell.demand,
      gap: cand.cell.gap,
      reliefDistanceM: cand.cell.reliefDistanceM,
      tempF: cand.cell.tempF,
      rank,
    });
  }
  return picked;
}

/* -------------------------------------------------------------------------- */

function nearestDistanceM(p: [number, number], pts: Array<[number, number]>): number {
  let best = Infinity;
  for (const q of pts) {
    const d = planarM(p, q);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : 99_999;
}

function keyOf(lon: number, lat: number): string {
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
