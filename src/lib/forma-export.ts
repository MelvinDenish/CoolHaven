/**
 * Intervention export (Addition 1).
 *
 * Output is a plain RFC 7946 GeoJSON FeatureCollection in EPSG:4326 - the
 * format Autodesk Forma and effectively every other AEC early-design tool
 * accepts as imported site context. That is the whole claim, and it is worth
 * being precise about it: this is a STANDARD GEOJSON EXPORT that Forma can
 * read, not a certified Forma integration and not a Forma-proprietary file.
 *
 * Each feature carries the assumed effect that produced it, so the coefficient
 * travels with the geometry into whatever tool opens it next. A planner who
 * imports these into Forma sees "-2.5 degF assumed, directional confidence"
 * attached to the polygon, not a bare shape with no provenance.
 */
import { INTERVENTIONS } from './assumptions';
import { M_PER_DEG_LAT, mPerDegLon } from './config';
import type { Intervention, InterventionKind } from './types';

export interface ExportContext {
  scenarioName: string;
  /** ISO-8601 UTC. Caller supplies it so the module stays pure. */
  generatedAt: string;
  heatDataSource: string;
  heatValidAt: string;
  filterType: number;
  before: { exposureIndex: number; coverageShare: number; meanTempF: number };
  after: { exposureIndex: number; coverageShare: number; meanTempF: number };
}

export interface FormaFeature {
  type: 'Feature';
  id: string;
  geometry:
    | { type: 'Point'; coordinates: [number, number] }
    | { type: 'Polygon'; coordinates: Array<Array<[number, number]>> };
  properties: Record<string, string | number | boolean | null>;
}

export interface FormaExport {
  type: 'FeatureCollection';
  /** Foreign members are legal GeoJSON and are ignored by importers that do
   *  not understand them, so the file stays valid for Forma either way. */
  metadata: Record<string, unknown>;
  features: FormaFeature[];
}

/**
 * Forma's own site-context vocabulary is coarse. We map each intervention to
 * the nearest thing Forma models natively so an import lands in a sensible
 * layer, and keep our own precise kind alongside it.
 */
const FORMA_CATEGORY: Record<InterventionKind, string> = {
  cooling_station: 'building',
  tree_canopy: 'vegetation',
  cool_pavement: 'ground-surface',
};

export function buildFormaExport(
  interventions: Intervention[],
  ctx: ExportContext,
): FormaExport {
  const features = interventions.map((iv) => toFeature(iv));

  return {
    type: 'FeatureCollection',
    metadata: {
      generator: 'CoolRoute Network Planner',
      scenario: ctx.scenarioName,
      generatedAt: ctx.generatedAt,
      crs: 'EPSG:4326',
      compatibility:
        'Standard RFC 7946 GeoJSON. Importable into Autodesk Forma as site context / GeoJSON, and into any GIS or AEC tool that reads GeoJSON. Not a certified Forma integration.',
      heatData: {
        source: ctx.heatDataSource,
        validAt: ctx.heatValidAt,
        filterType: ctx.filterType,
        filterTypeMeaning: ctx.filterType === 1 ? 'historic' : 'forecast',
      },
      modelledOutcome: {
        before: ctx.before,
        after: ctx.after,
        exposureReductionPct: pct(ctx.before.exposureIndex, ctx.after.exposureIndex),
        coverageGainPoints:
          Math.round((ctx.after.coverageShare - ctx.before.coverageShare) * 1000) / 10,
      },
      caveat:
        'Intervention effects are modelling assumptions, not measured outcomes for these specific sites. Each feature carries its own assumption string and confidence level.',
    },
    features,
  };
}

function toFeature(iv: Intervention): FormaFeature {
  const spec = INTERVENTIONS[iv.kind];
  const isCorridor = Boolean(iv.corridor && iv.corridor.length >= 2);
  const areaTreatment = iv.kind !== 'cooling_station';

  const properties: FormaFeature['properties'] = {
    name: iv.label,
    'coolroute:kind': iv.kind,
    'coolroute:geometryKind': isCorridor ? 'corridor' : 'point',
    'coolroute:corridorLengthM': isCorridor
      ? Math.round(corridorLengthM(iv.corridor!))
      : 0,
    'coolroute:deltaF': iv.deltaF,
    'coolroute:radiusM': iv.radiusM,
    'coolroute:confidence': spec.confidence,
    'coolroute:assumption': spec.assumption,
    'coolroute:basis': spec.basis,
    'coolroute:unitCostUsd': spec.unitCostUsd,
    'coolroute:costUnit': spec.costUnit,
    'coolroute:recommended': iv.recommended ?? false,
    'coolroute:note': iv.note ?? null,
    'forma:category': FORMA_CATEGORY[iv.kind],
    // Forma reads a height field when extruding imported context. A station is
    // a small structure; area treatments are ground-level and stay flat.
    'forma:height': iv.kind === 'cooling_station' ? 3.5 : 0,
  };

  return {
    type: 'Feature',
    id: iv.id,
    geometry: isCorridor
      ? { type: 'Polygon', coordinates: [bufferLine(iv.corridor!, iv.radiusM)] }
      : areaTreatment
        ? { type: 'Polygon', coordinates: [circle(iv.lon, iv.lat, iv.radiusM)] }
        : { type: 'Point', coordinates: [round6(iv.lon), round6(iv.lat)] },
    properties,
  };
}

function corridorLengthM(line: Array<[number, number]>): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) {
    const mLon = mPerDegLon((line[i][1] + line[i - 1][1]) / 2);
    total += Math.hypot(
      (line[i][0] - line[i - 1][0]) * mLon,
      (line[i][1] - line[i - 1][1]) * M_PER_DEG_LAT,
    );
  }
  return total;
}

/**
 * Buffer a corridor into a closed polygon ring.
 *
 * Walks one side of the line offsetting each vertex along its segment normal,
 * then returns down the other side, capping each end with a half-circle. It is
 * not a robust general-purpose buffer - self-intersecting corridors will
 * produce a bow tie - but the corridors this tool draws are short, roughly
 * straight street runs, and a real buffer library would be a large dependency
 * for one export path.
 */
function bufferLine(
  line: Array<[number, number]>,
  radiusM: number,
  capSegments = 8,
): Array<[number, number]> {
  const left: Array<[number, number]> = [];
  const right: Array<[number, number]> = [];

  for (let i = 0; i < line.length; i++) {
    const prev = line[Math.max(0, i - 1)];
    const next = line[Math.min(line.length - 1, i + 1)];
    const lat = line[i][1];
    const mLon = mPerDegLon(lat);

    // Segment direction in metres, then a unit normal.
    const dx = (next[0] - prev[0]) * mLon;
    const dy = (next[1] - prev[1]) * M_PER_DEG_LAT;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    const offLon = (nx * radiusM) / mLon;
    const offLat = (ny * radiusM) / M_PER_DEG_LAT;

    left.push([round6(line[i][0] + offLon), round6(line[i][1] + offLat)]);
    right.push([round6(line[i][0] - offLon), round6(line[i][1] - offLat)]);
  }

  const endCap = semicircle(line[line.length - 1], radiusM, capSegments);
  const startCap = semicircle(line[0], radiusM, capSegments);
  const ring = [...left, ...endCap, ...right.reverse(), ...startCap];
  ring.push(ring[0]);
  return ring;
}

function semicircle(
  centre: [number, number],
  radiusM: number,
  segments: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const dLon = radiusM / mPerDegLon(centre[1]);
  const dLat = radiusM / M_PER_DEG_LAT;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI;
    out.push([
      round6(centre[0] + Math.cos(a) * dLon),
      round6(centre[1] + Math.sin(a) * dLat),
    ]);
  }
  return out;
}

/** Closed ring approximating the treated area. 32 segments reads as round. */
function circle(lon: number, lat: number, radiusM: number, segments = 32) {
  const ring: Array<[number, number]> = [];
  const dLon = radiusM / mPerDegLon(lat);
  const dLat = radiusM / M_PER_DEG_LAT;
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    ring.push([round6(lon + Math.cos(a) * dLon), round6(lat + Math.sin(a) * dLat)]);
  }
  return ring;
}

/**
 * The same plan as a flat table, for anyone who wants it in a spreadsheet or a
 * council paper rather than a map tool.
 */
export function toCsv(interventions: Intervention[]): string {
  const header = [
    'id',
    'kind',
    'label',
    'lon',
    'lat',
    'radius_m',
    'assumed_delta_f',
    'confidence',
    'unit_cost_usd',
    'cost_unit',
    'recommended',
    'assumption',
  ];
  const rows = interventions.map((iv) => {
    const spec = INTERVENTIONS[iv.kind];
    return [
      iv.id,
      iv.kind,
      iv.label,
      round6(iv.lon),
      round6(iv.lat),
      iv.radiusM,
      iv.deltaF,
      spec.confidence,
      spec.unitCostUsd,
      spec.costUnit,
      iv.recommended ? 'yes' : 'no',
      spec.assumption,
    ]
      .map(csvCell)
      .join(',');
  });
  return [header.join(','), ...rows].join('\n');
}

function csvCell(v: string | number | boolean): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function pct(before: number, after: number): number {
  if (!before) return 0;
  return Math.round(((before - after) / before) * 1000) / 10;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
