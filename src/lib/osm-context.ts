/**
 * OpenStreetMap road and vegetation context, callable from anywhere.
 *
 * This is the network-and-mapping half of scripts/fetch-osm.ts, moved out
 * unchanged so two callers can share it:
 *
 *   1. scripts/fetch-osm.ts, which writes data/<region>/road-density.json,
 *      osm-context.geojson and streets.geojson at build time. Its behaviour is
 *      unaffected: it calls the same queries and the same rasteriser and writes
 *      the same files.
 *   2. src/app/api/draft/bootstrap, which needs road density at REQUEST time for
 *      a region a user has just drawn.
 *
 * The script keeps everything that touches the filesystem, plus the street
 * geometry pass, which only the committed snapshot uses.
 *
 * IMPORTANT for the draft path: Overpass is a shared free service, and a
 * city-scale road query takes tens of seconds on a good day. That is fine for a
 * build script and marginal inside an HTTP request, which is why every entry
 * point here takes an explicit attempt count rather than assuming the script's
 * patience.
 */
import {
  GRANULARITY_M,
  M_PER_DEG_LAT,
  gridDimsFor,
  mPerDegLon,
} from './config';
import type { Region } from './regions';

/**
 * Several mirrors, because the two best-known ones go down together often
 * enough to have blocked a rebuild during this project's own development.
 * Ordered by observed reliability.
 */
export const OVERPASS_ENDPOINTS = [
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

export interface OverpassWay {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

/** Per-tile road and vegetation weights, the payload of road-density.json. */
export type RoadDensityTiles = Record<
  string,
  { cols: number; rows: number; values: number[]; veg: number[] }
>;

/**
 * Overpass is a shared free service with per-IP slot limits. It answers 429 or
 * 504 when you have no slot and, less helpfully, a bare 500 when the backend
 * is briefly overloaded. All three are transient, so each mirror gets several
 * attempts with widening backoff before we move on. Without this, a data
 * rebuild fails at random depending on who else is querying Overpass.
 */
export async function overpass(
  query: string,
  attemptsPerMirror = 3,
  backoffMs = 20_000,
): Promise<OverpassWay[]> {
  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    for (let attempt = 1; attempt <= attemptsPerMirror; attempt++) {
      try {
        return await overpassOnce(endpoint, query);
      } catch (err) {
        lastErr = err;
        const wait = attempt * backoffMs;
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

/** Overpass wants `south,west,north,east`, which is not the order we store. */
export function overpassBboxClause(bbox: [number, number, number, number]): string {
  const [w, s, e, n] = bbox;
  return `${s},${w},${n},${e}`;
}

/**
 * Drivable road centrelines.
 *
 * `highway=service` is deliberately excluded. Including it times the Overpass
 * query out on a city-scale bbox (measured: 504 on its own), and it carries the
 * lowest weight anyway - parking aisles and alleys are not where a route spends
 * its exposure. Documented here rather than silently dropped.
 */
export function fetchRoadWays(
  bboxClause: string,
  attemptsPerMirror = 3,
  backoffMs = 20_000,
): Promise<OverpassWay[]> {
  return overpass(
    `[out:json][timeout:180];
     way["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|residential|unclassified|living_street)$"](${bboxClause});
     out geom;`,
    attemptsPerMirror,
    backoffMs,
  );
}

/** Parks, vegetation and water - the cool patches the field should explain. */
export function fetchGreenWays(
  bboxClause: string,
  attemptsPerMirror = 3,
  backoffMs = 20_000,
): Promise<OverpassWay[]> {
  return overpass(
    `[out:json][timeout:180];
     (
       way["leisure"~"^(park|garden|golf_course)$"](${bboxClause});
       way["landuse"~"^(grass|forest|recreation_ground|village_green|cemetery|farmland|orchard)$"](${bboxClause});
       way["natural"~"^(water|wood|scrub)$"](${bboxClause});
     );
     out geom;`,
    attemptsPerMirror,
    backoffMs,
  );
}

/**
 * Rasterise road ways and green polygons onto each tile's grid lattice.
 *
 * `onTile` exists so the build script can keep printing its per-tile summary
 * line while an API route stays silent. Without it, moving this loop out of the
 * script would have quietly changed the script's console output.
 */
export function buildRoadDensityTiles(
  region: Region,
  roads: OverpassWay[],
  green: OverpassWay[],
  onTile?: (tileId: string, cols: number, rows: number, built: number, veg: number) => void,
): RoadDensityTiles {
  const tiles: RoadDensityTiles = {};

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

    if (onTile) {
      const built = tiles[tile.id].values.reduce((a, b) => a + b, 0) / (cols * rows);
      const vegMean = tiles[tile.id].veg.reduce((a, b) => a + b, 0) / (cols * rows);
      onTile(tile.id, cols, rows, built, vegMean);
    }
  }

  return tiles;
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
