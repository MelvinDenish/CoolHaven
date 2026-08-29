/**
 * Turn a coordinate into a place a person can picture.
 *
 * Recommended sites were listed as "33.4264, -112.0295". That is precise,
 * exportable and completely unusable in the room where the decision gets made
 * - nobody argues for a hydration station in decimal degrees. This resolves a
 * point to the street it sits on, and where possible to the nearest crossing,
 * so the same recommendation reads "S 7th Ave near W Buckeye Rd".
 *
 * No new data and no network call: streets.geojson is already downloaded for
 * the street-temperature probe, so this is a lookup over bytes the browser
 * already holds. The coordinates stay on screen underneath, because the GIS
 * export and anyone checking the work still need them.
 */
import { densifyPath, planarM } from './grid';
import type { StreetCollection, StreetFeature } from './basemaps';

/** How far from a point we will still claim a street describes it. */
const MAX_SNAP_M = 220;
/** How far from the snapped point to look for a named crossing. */
const MAX_CROSS_M = 320;
/** Closer than this and it is the same carriageway under a second name. */
const MIN_CROSS_SEPARATION_M = 25;

export interface PlaceLabel {
  /** "S 7th Ave near W Buckeye Rd", or null when nothing named is close. */
  label: string | null;
  /** The street the point sits on, if it has a name. */
  street: string | null;
  /** The nearest named road crossing it, if one is close enough. */
  cross: string | null;
  /** Distance from the point to the host centreline, metres. */
  distanceM: number;
}

const EMPTY: PlaceLabel = { label: null, street: null, cross: null, distanceM: Infinity };

/**
 * Nearest named street to a point, plus a crossing when one is nearby.
 *
 * Unnamed geometry is skipped rather than reported: 334 of Phoenix's 4,207
 * centrelines carry no `name` in OpenStreetMap - mostly freeway ramps - and
 * "near Unnamed street" is worse than no label at all. When everything nearby
 * is unnamed the caller falls back to coordinates, which is the honest result.
 */
export function describePlace(
  lon: number,
  lat: number,
  streets: StreetCollection | null,
): PlaceLabel {
  if (!streets?.features?.length) return EMPTY;

  const host = nearbyNamed(lon, lat, streets.features);
  if (!host) return EMPTY;

  const street = host.feature.properties.name!;
  const cross = nearestCrossing(street, host.snap, streets.features);

  return {
    label: cross ? `${street} near ${cross}` : street,
    street,
    cross,
    distanceM: Math.round(host.distM),
  };
}

/** The label, or a formatted coordinate pair when there is none. */
export function placeOrCoords(
  lon: number,
  lat: number,
  streets: StreetCollection | null,
): string {
  return describePlace(lon, lat, streets).label ?? `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

/* -------------------------------------------------------------------------- */

interface Hit {
  feature: StreetFeature;
  distM: number;
  /** The closest point ON the centreline - the anchor for the crossing search. */
  snap: [number, number];
}

function nearbyNamed(lon: number, lat: number, features: StreetFeature[]): Hit | null {
  let best: Hit | null = null;

  for (const f of features) {
    if (!f.properties.name) continue;
    const coords = f.geometry.coordinates;
    for (let i = 1; i < coords.length; i++) {
      const { distM, point } = segmentDistance([lon, lat], coords[i - 1], coords[i]);
      if (distM < (best?.distM ?? Infinity)) best = { feature: f, distM, snap: point };
    }
  }

  return best && best.distM <= MAX_SNAP_M ? best : null;
}

/**
 * The nearest differently named street whose geometry comes close to the
 * snapped point.
 *
 * Not a true topological intersection: OSM ways do not always share a node
 * where two roads cross, and chasing that properly would cost far more than
 * this label is worth. The claim on screen is "near", and "near" is exactly
 * what this measures.
 */
function nearestCrossing(
  hostName: string,
  snap: [number, number],
  features: StreetFeature[],
): string | null {
  let bestName: string | null = null;
  let bestDist = Infinity;

  for (const f of features) {
    const name = f.properties.name;
    if (!name || name === hostName) continue;

    const coords = f.geometry.coordinates;
    for (let i = 1; i < coords.length; i++) {
      const { distM } = segmentDistance(snap, coords[i - 1], coords[i]);
      if (distM < bestDist) {
        bestDist = distM;
        bestName = name;
      }
    }
  }

  if (bestName === null) return null;
  if (bestDist > MAX_CROSS_M) return null;
  if (bestDist < MIN_CROSS_SEPARATION_M) return null;
  return bestName;
}

/** Distance from p to segment a-b, and the closest point on that segment. */
function segmentDistance(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): { distM: number; point: [number, number] } {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = p[0] - a[0];
  const wy = p[1] - a[1];

  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const point: [number, number] = [a[0] + t * vx, a[1] + t * vy];
  return { distM: planarM(p, point), point };
}

/* -------------------------------------------------------------------------- */
/* Siting eligibility                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Road classes a walk-up relief site cannot sit on.
 *
 * This exists because naming the recommendations exposed a real defect in the
 * siting, not in the labelling. The demand layer weights drivable road length
 * and courier-route density, and both peak on grade-separated highway - so the
 * top-ranked cells came back as "Maricopa Freeway near Papago Freeway". The
 * exposure there is real; a hydration station on the shoulder of an urban
 * freeway is not a thing anyone can walk to.
 *
 * Only motorway classes are excluded. Arterials stay eligible - a station on
 * a six-lane arterial is unpleasant but reachable on foot, and excluding them
 * would gut the candidate pool in exactly the industrial districts this
 * product exists to serve.
 */
const UNSITABLE_HIGHWAY = new Set(['motorway', 'motorway_link']);

/** Metres between samples when rasterising centrelines into the index. */
const INDEX_SPACING_M = 30;
/** Degree size of an index bucket - roughly 120 m at these latitudes. */
const BUCKET_DEG = 0.0012;

export interface StreetIndex {
  /** bucket key -> samples that fall in it */
  buckets: Map<string, Array<{ lon: number; lat: number; unsitable: boolean }>>;
}

/**
 * Rasterise every centreline into a bucketed point index, once per region.
 *
 * Built once and reused, because the alternative - scanning 4,207 features per
 * candidate cell - is tens of millions of distance calculations every time a
 * scenario changes. Bucketing turns each lookup into a 3x3 neighbourhood scan.
 */
export function buildStreetIndex(streets: StreetCollection | null): StreetIndex | null {
  if (!streets?.features?.length) return null;

  const buckets = new Map<string, Array<{ lon: number; lat: number; unsitable: boolean }>>();

  for (const f of streets.features) {
    const unsitable = UNSITABLE_HIGHWAY.has(f.properties.highway ?? '');
    for (const p of densifyPath(f.geometry.coordinates, INDEX_SPACING_M)) {
      const k = bucketKey(p.lon, p.lat);
      const list = buckets.get(k);
      if (list) list.push({ lon: p.lon, lat: p.lat, unsitable });
      else buckets.set(k, [{ lon: p.lon, lat: p.lat, unsitable }]);
    }
  }

  return { buckets };
}

/**
 * True when the centreline nearest this point is a motorway.
 *
 * "Nearest wins" rather than "within N metres of a freeway": a cell that sits
 * on a frontage road running beside a freeway is perfectly sitable, and a
 * buffer would throw it away along with the shoulder. A point with no road
 * near it at all is not motorway-dominated, so it stays eligible.
 */
export function isMotorwayDominated(
  lon: number,
  lat: number,
  index: StreetIndex | null,
): boolean {
  if (!index) return false;

  let bestDist = Infinity;
  let bestUnsitable = false;

  const bx = Math.floor(lon / BUCKET_DEG);
  const by = Math.floor(lat / BUCKET_DEG);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const list = index.buckets.get(`${bx + dx},${by + dy}`);
      if (!list) continue;
      for (const s of list) {
        const d = planarM([lon, lat], [s.lon, s.lat]);
        if (d < bestDist) {
          bestDist = d;
          bestUnsitable = s.unsitable;
        }
      }
    }
  }

  return bestUnsitable;
}

/**
 * Drop cells a station cannot be built on, leaving everything else untouched.
 *
 * Applied to the SITING candidate pool only. The demand layer the map paints
 * still includes freeway cells, because the exposure there is real and hiding
 * it would be a different kind of lie - what changes is only whether the tool
 * will propose putting a building on one.
 */
export function sitableCells<T extends { lon: number; lat: number }>(
  cells: T[],
  index: StreetIndex | null,
): T[] {
  if (!index) return cells;
  return cells.filter((c) => !isMotorwayDominated(c.lon, c.lat, index));
}

function bucketKey(lon: number, lat: number): string {
  return `${Math.floor(lon / BUCKET_DEG)},${Math.floor(lat / BUCKET_DEG)}`;
}
