/**
 * Forma import - the return leg.
 *
 * The export in forma-export.ts sends our analysis out as site context. This
 * brings a DESIGN back in and scores it against the heat field, which is the
 * half that makes the loop worth having: design in Forma, validate here.
 *
 * WHAT IT ACCEPTS
 *
 * Standard GeoJSON, which is what Forma exports and what every GIS in the chain
 * speaks. Deliberately permissive about structure and strict about geometry:
 *
 *   Point / MultiPoint          -> a proposed facility at that location
 *   Polygon / MultiPolygon      -> a proposed building or treated area, scored
 *                                  at its centroid and outlined on the map
 *   LineString / MultiLineString-> a corridor treatment
 *   Feature / FeatureCollection / bare geometry / an array of features
 *
 * It also round-trips its own export: a file written by forma-export.ts carries
 * `coolroute:kind`, and re-importing it restores the original intervention
 * types rather than guessing from geometry.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not read Forma's proprietary project format, and it is not an
 * Autodesk integration - there is no account, no SDK and no extension involved.
 * It reads a file you exported. Saying otherwise would be the same kind of
 * overclaim the rest of this project spends its effort avoiding.
 *
 * Coordinates must be WGS84 lon/lat (EPSG:4326). Forma exports in the project's
 * local coordinate system by default, so a file in metres lands somewhere in
 * the Gulf of Guinea - detected below and reported as a CRS problem rather than
 * silently scoring open ocean.
 */
import { INTERVENTIONS } from './assumptions';
import { planarM } from './grid';
import type { Intervention, InterventionKind, LonLat } from './types';

export interface ImportedDesign {
  interventions: Intervention[];
  /** Polygon rings, for drawing the imported footprints on the map. */
  footprints: Array<{ id: string; label: string; ring: LonLat[] }>;
  /** Human-readable outcome, rendered verbatim. */
  note: string;
  warnings: string[];
}

interface GeoFeature {
  type?: string;
  properties?: Record<string, unknown> | null;
  geometry?: { type?: string; coordinates?: unknown } | null;
}

/** Everything the parser will accept at the top level. */
type GeoInput = GeoFeature | { type?: string; features?: GeoFeature[] } | GeoFeature[];

export function importFormaGeoJson(raw: string, regionBbox?: [number, number, number, number]): ImportedDesign {
  const warnings: string[] = [];
  let parsed: GeoInput;
  try {
    parsed = JSON.parse(raw) as GeoInput;
  } catch {
    return fail('That file is not valid JSON.');
  }

  const features = collectFeatures(parsed);
  if (features.length === 0) {
    return fail('No GeoJSON features found in that file.');
  }

  const interventions: Intervention[] = [];
  const footprints: ImportedDesign['footprints'] = [];
  let skipped = 0;
  let outOfRegion = 0;
  let crsSuspect = 0;

  for (const [i, f] of features.entries()) {
    const geom = f.geometry;
    if (!geom?.type || geom.coordinates === undefined) {
      skipped++;
      continue;
    }

    const props = (f.properties ?? {}) as Record<string, unknown>;
    const kind = kindFrom(props, geom.type);
    const spec = INTERVENTIONS[kind];
    const label = labelFrom(props, spec.short, interventions.length + 1);

    const shapes = extractShapes(geom.type, geom.coordinates);
    if (shapes.length === 0) {
      skipped++;
      continue;
    }

    for (const shape of shapes) {
      const centre = centroid(shape);
      if (!Number.isFinite(centre[0]) || !Number.isFinite(centre[1])) {
        skipped++;
        continue;
      }
      // A projected file (metres, not degrees) shows up immediately as
      // coordinates far outside the legal lon/lat range.
      if (Math.abs(centre[0]) > 180 || Math.abs(centre[1]) > 90) {
        crsSuspect++;
        continue;
      }
      if (regionBbox && !within(centre, regionBbox)) outOfRegion++;

      interventions.push({
        id: `forma-${i}-${interventions.length}`,
        kind,
        label,
        lon: centre[0],
        lat: centre[1],
        radiusM: radiusFrom(props, shape, spec.radiusM),
        deltaF: numberFrom(props['coolroute:deltaF']) ?? spec.deltaF,
        recommended: false,
        note: `Imported from ${sourceLabel(props)}.`,
        ...(shape.length > 2 && spec.geometry === 'corridor'
          ? { path: shape }
          : {}),
      });

      if (shape.length > 2) {
        footprints.push({
          id: `forma-fp-${i}-${footprints.length}`,
          label,
          ring: shape,
        });
      }
    }
  }

  if (crsSuspect > 0 && interventions.length === 0) {
    return fail(
      `All ${crsSuspect} feature(s) have coordinates outside the legal lon/lat range. ` +
        'This file is almost certainly in a projected CRS (metres). Re-export from ' +
        'Forma as WGS84 / EPSG:4326.',
    );
  }

  if (interventions.length === 0) {
    return fail('No usable geometry in that file - every feature was skipped.');
  }

  if (skipped > 0) warnings.push(`${skipped} feature(s) had no usable geometry and were skipped.`);
  if (crsSuspect > 0) {
    warnings.push(
      `${crsSuspect} feature(s) fell outside the legal lon/lat range and were dropped - check the export CRS.`,
    );
  }
  if (outOfRegion > 0) {
    warnings.push(
      `${outOfRegion} feature(s) sit outside this region's measured tiles. They are scored by ` +
        'extrapolation from the nearest tile edge, which is an estimate rather than a measurement.',
    );
  }

  return {
    interventions,
    footprints,
    warnings,
    note:
      `Imported ${interventions.length} element(s) from the design. They are now scenario ` +
      'interventions: scored against the heat field, costed, and included in the before/after.',
  };
}

/* -------------------------------------------------------------------------- */

function fail(note: string): ImportedDesign {
  return { interventions: [], footprints: [], note, warnings: [] };
}

function collectFeatures(input: GeoInput): GeoFeature[] {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') {
    const asCollection = input as { type?: string; features?: GeoFeature[] };
    if (Array.isArray(asCollection.features)) return asCollection.features;
    const asFeature = input as GeoFeature;
    if (asFeature.geometry) return [asFeature];
    // A bare geometry object, which Forma sometimes emits for a single shape.
    if (typeof asFeature.type === 'string' && 'coordinates' in asFeature) {
      return [{ type: 'Feature', geometry: asFeature as GeoFeature['geometry'] }];
    }
  }
  return [];
}

/**
 * Which intervention an imported feature becomes.
 *
 * Our own export is recognised first, so a round trip is lossless. Otherwise
 * geometry decides, because that is the only honest signal available: a
 * polygon in a design file is a footprint, a line is a corridor, a point is a
 * facility.
 */
function kindFrom(props: Record<string, unknown>, geomType: string): InterventionKind {
  const declared = props['coolroute:kind'];
  if (typeof declared === 'string' && declared in INTERVENTIONS) {
    return declared as InterventionKind;
  }

  // Forma's own category hints, when present.
  const category = String(props['forma:category'] ?? props.category ?? '').toLowerCase();
  if (category.includes('veget') || category.includes('tree')) return 'tree_canopy';
  if (category.includes('ground') || category.includes('surface')) return 'cool_pavement';

  const t = geomType.toLowerCase();
  if (t.includes('line')) return 'tree_canopy';
  if (t.includes('polygon')) return 'shade_sail';
  return 'cooling_station';
}

function labelFrom(props: Record<string, unknown>, short: string, n: number): string {
  for (const key of ['name', 'label', 'title', 'coolroute:label']) {
    const v = props[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return `${short} ${n} (imported)`;
}

function sourceLabel(props: Record<string, unknown>): string {
  return typeof props['coolroute:kind'] === 'string'
    ? 'a CoolRoute export'
    : 'a Forma / GIS design file';
}

/**
 * Radius for an imported shape.
 *
 * A polygon carries its own extent, so use it: half the longest span from the
 * centroid is a better description of a real footprint than the palette
 * default. Points fall back to the spec.
 */
function radiusFrom(
  props: Record<string, unknown>,
  shape: LonLat[],
  fallback: number,
): number {
  const declared = numberFrom(props['coolroute:radiusM']);
  if (declared && declared > 0) return declared;
  if (shape.length < 3) return fallback;
  const c = centroid(shape);
  let max = 0;
  for (const p of shape) max = Math.max(max, planarM(c, p));
  return Math.max(20, Math.round(max));
}

function numberFrom(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Flatten any GeoJSON geometry into a list of coordinate rings/paths. */
function extractShapes(type: string, coords: unknown): LonLat[][] {
  const t = type.toLowerCase();
  if (t === 'point') return isPair(coords) ? [[coords]] : [];
  if (t === 'multipoint' || t === 'linestring') {
    return Array.isArray(coords) ? [coords.filter(isPair) as LonLat[]] : [];
  }
  if (t === 'multilinestring' || t === 'polygon') {
    return Array.isArray(coords)
      ? coords.map((ring) => (Array.isArray(ring) ? (ring.filter(isPair) as LonLat[]) : []))
          .filter((r) => r.length > 0)
      : [];
  }
  if (t === 'multipolygon') {
    if (!Array.isArray(coords)) return [];
    const out: LonLat[][] = [];
    for (const poly of coords) {
      if (!Array.isArray(poly)) continue;
      // Outer ring only - holes do not change where a facility sits.
      const ring = Array.isArray(poly[0]) ? (poly[0].filter(isPair) as LonLat[]) : [];
      if (ring.length) out.push(ring);
    }
    return out;
  }
  return [];
}

function isPair(v: unknown): v is LonLat {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number'
  );
}

function centroid(shape: LonLat[]): LonLat {
  if (shape.length === 1) return shape[0];
  let lon = 0;
  let lat = 0;
  for (const p of shape) {
    lon += p[0];
    lat += p[1];
  }
  return [lon / shape.length, lat / shape.length];
}

function within(p: LonLat, bbox: [number, number, number, number]): boolean {
  return p[0] >= bbox[0] && p[0] <= bbox[2] && p[1] >= bbox[1] && p[1] <= bbox[3];
}
