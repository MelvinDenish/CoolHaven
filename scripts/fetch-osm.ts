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
import {
  GRANULARITY_M,
  M_PER_DEG_LAT,
  assertTilesWithinAoiLimit,
  gridDimsFor,
  mPerDegLon,
} from '../src/lib/config';
import { regionBbox, regionsFromArgv, type Region } from '../src/lib/regions';

/**
 * Several mirrors, because the two best-known ones go down together often
 * enough to have blocked a rebuild during this project's own development.
 * Ordered by observed reliability.
 */
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.jp/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

/**
 * Road weight by class. A six-lane arterial is far more radiating asphalt than
 * a residential street, and the demand layer should say so.
 */
const ROAD_WEIGHT: Record<string, number> = {
  motorway: 3,
  motorway_link: 2,
  trunk: 2.6,
  trunk_link: 1.8,
  primary: 2.2,
  primary_link: 1.5,
  secondary: 1.7,
  secondary_link: 1.2,
  tertiary: 1.3,
  residential: 1,
  unclassified: 0.9,
  living_street: 0.8,
};

interface OverpassWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

/**
 * Overpass is a shared free service with per-IP slot limits. It answers 429 or
 * 504 when you have no slot and, less helpfully, a bare 500 when the backend
 * is briefly overloaded. All three are transient, so each mirror gets three
 * attempts with widening backoff before we move on. Without this, a data
 * rebuild fails at random depending on who else is querying Overpass.
 */
async function overpass(query: string, attemptsPerMirror = 3): Promise<OverpassWay[]> {
  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= attemptsPerMirror; attempt++) {
      try {
        return await overpassOnce(endpoint, query);
      } catch (err) {
        lastErr = err;
        const wait = attempt * 20_000;
        console.warn(
          `[osm] ${new URL(endpoint).host} attempt ${attempt}/${attemptsPerMirror} failed ` +
            `(${err instanceof Error ? err.message.slice(0, 60) : err})` +
            (attempt < attemptsPerMirror ? `, waiting ${wait / 1000}s` : ', next mirror'),
        );
        if (attempt < attemptsPerMirror) await sleep(wait);
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('all Overpass mirrors failed');
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function overpassOnce(endpoint: string, query: string): Promise<OverpassWay[]> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      // Overpass sits behind mod_security and answers 406 to a request with no
      // Accept and no identifiable User-Agent, which is exactly what Node's
      // fetch sends by default. Both headers are required.
      accept: 'application/json',
      'user-agent': 'CoolRouteNetworkPlanner/1.0 (FortyGuard Hackathon 2026)',
    },
    body: `data=${encodeURIComponent(query)}`,
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  }
  const json = (await res.json()) as { elements?: OverpassWay[] };
  return json.elements ?? [];
}

async function main() {
  for (const region of regionsFromArgv()) {
    await fetchRegion(region);
  }
}

async function fetchRegion(region: Region) {
  assertTilesWithinAoiLimit(region.tiles);
  const [w, s, e, n] = regionBbox(region);
  const bboxClause = `${s},${w},${n},${e}`;

  const outDensity = resolve(process.cwd(), `data/${region.id}/road-density.json`);
  const outContext = resolve(process.cwd(), `data/${region.id}/osm-context.geojson`);

  console.log(`\n[osm:${region.id}] fetching drivable roads...`);
  // `highway=service` is deliberately excluded. Including it times the Overpass
  // query out on a city-scale bbox (measured: 504 on its own), and it carries
  // the lowest weight anyway - parking aisles and alleys are not where a route
  // spends its exposure. Documented here rather than silently dropped.
  const roads = await overpass(
    `[out:json][timeout:180];
     way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|residential|unclassified|living_street)$"](${bboxClause});
     out geom;`,
  );
  console.log(`[osm:${region.id}] ${roads.length} road ways`);

  console.log(`[osm:${region.id}] fetching parks, vegetation and water...`);
  const green = await overpass(
    `[out:json][timeout:180];
     (
       way["leisure"~"^(park|garden|golf_course)$"](${bboxClause});
       way["landuse"~"^(grass|forest|recreation_ground|village_green|cemetery|farmland|orchard)$"](${bboxClause});
       way["natural"~"^(water|wood|scrub)$"](${bboxClause});
     );
     out geom;`,
  );
  console.log(`[osm:${region.id}] ${green.length} green/water ways`);

  const fetchedAt = new Date().toISOString();
  const tiles: Record<
    string,
    { cols: number; rows: number; values: number[]; veg: number[] }
  > = {};

  for (const tile of region.tiles) {
    const { cols, rows } = gridDimsFor(tile.bbox, GRANULARITY_M);
    const road = new Float64Array(cols * rows);
    const veg = new Float64Array(cols * rows);

    const dLon = (tile.bbox[2] - tile.bbox[0]) / cols;
    const dLat = (tile.bbox[3] - tile.bbox[1]) / rows;
    const idxOf = (lon: number, lat: number): number | null => {
      const c = Math.floor((lon - tile.bbox[0]) / dLon);
      const r = Math.floor((lat - tile.bbox[1]) / dLat);
      if (c < 0 || r < 0 || c >= cols || r >= rows) return null;
      return r * cols + c;
    };

    // Roads: walk each way at ~20 m and deposit weighted length in the cell.
    // Rasterising by sampling rather than by exact clipping is accurate enough
    // at 100 m cells and about two orders of magnitude simpler.
    const STEP_M = 20;
    for (const way of roads) {
      const g = way.geometry;
      if (!g || g.length < 2) continue;
      const weight = ROAD_WEIGHT[way.tags?.highway ?? ''] ?? 0.6;
      for (let i = 1; i < g.length; i++) {
        const a = g[i - 1];
        const b = g[i];
        const segM = metres(a.lon, a.lat, b.lon, b.lat);
        const steps = Math.max(1, Math.round(segM / STEP_M));
        for (let k = 0; k < steps; k++) {
          const t = (k + 0.5) / steps;
          const idx = idxOf(a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t);
          if (idx !== null) road[idx] += (segM / steps) * weight;
        }
      }
    }

    // Vegetation and water: point-in-polygon at each cell centre, then smoothed.
    const polys = green
      .map((wy) => wy.geometry?.map((p) => [p.lon, p.lat] as [number, number]))
      .filter((p): p is Array<[number, number]> => !!p && p.length >= 4);

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lon = tile.bbox[0] + (c + 0.5) * dLon;
        const lat = tile.bbox[1] + (r + 0.5) * dLat;
        for (const poly of polys) {
          if (pointInRing(lon, lat, poly)) {
            veg[r * cols + c] = 1;
            break;
          }
        }
      }
    }

    tiles[tile.id] = {
      cols,
      rows,
      values: normalise(Array.from(road)),
      veg: normalise(smooth(Array.from(veg), cols, rows)),
    };
    const built = tiles[tile.id].values.reduce((a, b) => a + b, 0) / (cols * rows);
    const vegMean = tiles[tile.id].veg.reduce((a, b) => a + b, 0) / (cols * rows);
    console.log(
      `[osm:${region.id}] ${tile.id}: ${cols}x${rows} cells, built ${built.toFixed(2)}, veg ${vegMean.toFixed(2)}`,
    );
  }

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

/**
 * Normalise to 0..1 against the 95th percentile, so one freeway cell does not
 * flatten every other cell to near zero.
 */
function normalise(values: number[]): number[] {
  const sorted = values.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || sorted[sorted.length - 1] || 1;
  return values.map((v) => Math.round(Math.min(1, v / p95) * 1000) / 1000);
}

/** 3x3 box blur - a park edge should not be a hard cliff between cells. */
function smooth(values: number[], cols: number, rows: number): number[] {
  const out = new Array(values.length).fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
          sum += values[rr * cols + cc];
          n++;
        }
      }
      out[r * cols + c] = n ? sum / n : 0;
    }
  }
  return out;
}

function pointInRing(lon: number, lat: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const mLon = mPerDegLon((lat1 + lat2) / 2);
  return Math.hypot((lon2 - lon1) * mLon, (lat2 - lat1) * M_PER_DEG_LAT);
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
