/**
 * Pre-fetch OpenStreetMap context once per region, at build time.
 *
 * Base PRD section 13 lists "Overpass slow or rate-limited live" as a risk and
 * mitigates it the same way as the FortyGuard data: fetch once, commit the
 * result, never call it from the UI.
 *
 * Two products per region:
 *
 *   data/<region>/road-density.json    per-grid-cell built-surface and
 *                                      vegetation weights. Feeds the demand
 *                                      layer (FR7) and, when no FortyGuard key
 *                                      is present, the modelled heat field.
 *   data/<region>/osm-context.geojson  park and water polygons, drawn as a map
 *                                      layer so the cool patches in the field
 *                                      are visibly explained.
 *
 * Run:  npm run data:osm
 *       npm run data:osm -- --region=yuma
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { GRANULARITY_M, assertTilesWithinAoiLimit } from '../src/lib/config';
import { regionBbox, regionsFromArgv, type Region } from '../src/lib/regions';
// The Overpass queries and the density rasteriser moved to src/lib/ so the
// draft-region endpoints can call them at request time. Same queries, same
// rasteriser, same output files - this script kept only the I/O.
import {
  OVERPASS_ENDPOINTS,
  buildRoadDensityTiles,
  fetchGreenWays,
  fetchRoadWays,
  overpassBboxClause,
  type OverpassWay,
} from '../src/lib/osm-context';

async function main() {
  for (const region of regionsFromArgv()) {
    await fetchRegion(region);
  }
}

async function fetchRegion(region: Region) {
  assertTilesWithinAoiLimit(region.tiles);
  const [w, s, e, n] = regionBbox(region);
  const bboxClause = overpassBboxClause(regionBbox(region));

  const outDensity = resolve(process.cwd(), `data/${region.id}/road-density.json`);
  const outContext = resolve(process.cwd(), `data/${region.id}/osm-context.geojson`);

  console.log(`\n[osm:${region.id}] fetching drivable roads...`);
  const roads = await fetchRoadWays(bboxClause);
  console.log(`[osm:${region.id}] ${roads.length} road ways`);

  console.log(`[osm:${region.id}] fetching parks, vegetation and water...`);
  const green = await fetchGreenWays(bboxClause);
  console.log(`[osm:${region.id}] ${green.length} green/water ways`);

  const fetchedAt = new Date().toISOString();
  const tiles = buildRoadDensityTiles(region, roads, green, (tileId, cols, rows, built, veg) =>
    console.log(
      `[osm:${region.id}] ${tileId}: ${cols}x${rows} cells, built ${built.toFixed(2)}, veg ${veg.toFixed(2)}`,
    ),
  );

  mkdirSync(dirname(outDensity), { recursive: true });
  writeFileSync(
    outDensity,
    JSON.stringify(
      {
        schema: 'coolroute.roaddensity.v2',
        regionId: region.id,
        granularityM: GRANULARITY_M,
        source: 'osm',
        endpoint: OVERPASS_ENDPOINTS[0],
        attribution: 'Data (c) OpenStreetMap contributors, ODbL, via Overpass API.',
        fetchedAt,
        roadWayCount: roads.length,
        greenWayCount: green.length,
        tiles,
      },
      null,
      1,
    ),
  );
  console.log(`[osm:${region.id}] wrote ${outDensity}`);

  // Park and water polygons for the map, clipped to the region bbox and capped
  // so the committed file stays small enough to load instantly.
  const contextFeatures = green
    .filter((wy) => wy.geometry && wy.geometry.length >= 4)
    .filter((wy) =>
      wy.geometry!.some((p) => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n),
    )
    .slice(0, 900)
    .map((wy) => ({
      type: 'Feature' as const,
      properties: {
        kind: wy.tags?.natural === 'water' ? 'water' : 'vegetation',
        name: wy.tags?.name ?? null,
        osm: `way/${wy.id}`,
      },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [wy.geometry!.map((p) => [round6(p.lon), round6(p.lat)])],
      },
    }));

  writeFileSync(
    outContext,
    JSON.stringify({
      type: 'FeatureCollection',
      metadata: {
        regionId: region.id,
        source: 'osm',
        attribution: 'Data (c) OpenStreetMap contributors, ODbL, via Overpass API.',
        fetchedAt,
      },
      features: contextFeatures,
    }),
  );
  console.log(
    `[osm:${region.id}] wrote ${contextFeatures.length} context polygons -> ${outContext}`,
  );

  writeStreets(region, roads, fetchedAt);
}

/* -------------------------------------------------------------------------- */
/* Street geometry - the per-street heat readout                              */
/* -------------------------------------------------------------------------- */

/**
 * Persist the road centrelines we already fetched, so the map can answer
 * "how hot is THIS street".
 *
 * The density pass above rasterises these ways into per-cell weights and then
 * throws the geometry away, which is all the demand layer needs. A street-level
 * readout needs the lines themselves.
 *
 * Deliberately NOT precomputing a temperature per street: the field changes
 * with the forecast day and the day part, so a baked-in number would be wrong
 * for five of the six combinations the UI offers. The client samples the same
 * HeatField the routes are scored against, which keeps one source of truth.
 *
 * Three things keep the committed file small enough to ship to the browser:
 * only ways that actually touch a measured tile, geometry simplified to ~15 m,
 * and coordinates rounded to 5 dp (about a metre).
 */
function writeStreets(region: Region, roads: OverpassWay[], fetchedAt: string) {
  const out = resolve(process.cwd(), `data/${region.id}/streets.geojson`);

  const features = roads
    .filter((wy) => wy.geometry && wy.geometry.length >= 2)
    .filter((wy) => wy.geometry!.some((p) => insideAnyTile(region, p.lon, p.lat)))
    .map((wy) => {
      const line = simplify(
        wy.geometry!.map((p) => [p.lon, p.lat] as [number, number]),
        15,
      );
      return {
        type: 'Feature' as const,
        properties: {
          name: wy.tags?.name ?? null,
          highway: wy.tags?.highway ?? null,
          osm: `way/${wy.id}`,
        },
        geometry: {
          type: 'LineString' as const,
          coordinates: line.map(([lon, lat]) => [round5(lon), round5(lat)]),
        },
      };
    })
    .filter((f) => f.geometry.coordinates.length >= 2);

  writeFileSync(
    out,
    JSON.stringify({
      type: 'FeatureCollection',
      metadata: {
        regionId: region.id,
        source: 'osm',
        attribution: 'Data (c) OpenStreetMap contributors, ODbL, via Overpass API.',
        fetchedAt,
        note:
          'Road centrelines inside the measured tiles. Temperatures are NOT baked in - ' +
          'the client samples the active heat field along each line, so a street readout ' +
          'always matches the day and day part on screen.',
      },
      features,
    }),
  );
  const kb = (JSON.stringify(features).length / 1024).toFixed(0);
  console.log(`[osm:${region.id}] wrote ${features.length} streets (${kb} KB) -> ${out}`);
}

function insideAnyTile(region: Region, lon: number, lat: number): boolean {
  return region.tiles.some(
    (t) => lon >= t.bbox[0] && lon <= t.bbox[2] && lat >= t.bbox[1] && lat <= t.bbox[3],
  );
}

/**
 * Ramer-Douglas-Peucker, tolerance in metres.
 *
 * A residential street digitised with 40 vertices reads identically at 15 m
 * tolerance with four, and the difference across a whole city is megabytes.
 */
function simplify(
  pts: Array<[number, number]>,
  toleranceM: number,
): Array<[number, number]> {
  if (pts.length <= 2) return pts;

  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpendicularM(pts[i], pts[0], pts[pts.length - 1]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }

  if (maxDist <= toleranceM) return [pts[0], pts[pts.length - 1]];

  const left = simplify(pts.slice(0, index + 1), toleranceM);
  const right = simplify(pts.slice(index), toleranceM);
  return [...left.slice(0, -1), ...right];
}

/** Perpendicular distance from p to segment a-b, in metres. */
function perpendicularM(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const latScale = Math.cos((p[1] * Math.PI) / 180);
  const px = (p[0] - a[0]) * latScale * 111_320;
  const py = (p[1] - a[1]) * 110_574;
  const bx = (b[0] - a[0]) * latScale * 111_320;
  const by = (b[1] - a[1]) * 110_574;

  const lenSq = bx * bx + by * by;
  if (lenSq === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / lenSq));
  return Math.hypot(px - t * bx, py - t * by);
}

function round5(n: number): number {
  return Math.round(n * 1e5) / 1e5;
}

function round6(n: number) {
  return Math.round(n * 1e6) / 1e6;
}

main().catch((err) => {
  console.error('[osm] failed:', err instanceof Error ? err.message : err);
  if (existsSync(resolve(process.cwd(), 'data'))) {
    console.error('[osm] previously written road-density files are untouched.');
  }
  process.exit(1);
});
