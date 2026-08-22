/**
 * Geometry helpers and the heat-field sampler.
 *
 * A `HeatField` is the set of tiles that share one (filterType, validAt) pair.
 * The rest of the app never touches an individual tile: it asks the field for
 * a temperature at a point and gets a value back. That indirection is what
 * lets us add tiles (Addendum A3) without any caller changing.
 */
import type { DataSource, FilterType, HeatGrid, LonLat } from './types';
import { M_PER_DEG_LAT, mPerDegLon, type DayPart } from './config';

/* -------------------------------------------------------------------------- */
/* Geometry                                                                   */
/* -------------------------------------------------------------------------- */

const R_EARTH_M = 6_371_008.8;

export function haversineM(a: LonLat, b: LonLat): number {
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Cheap planar distance - fine at city scale and much faster in tight loops. */
export function planarM(a: LonLat, b: LonLat): number {
  const mLon = mPerDegLon((a[1] + b[1]) / 2);
  const dx = (b[0] - a[0]) * mLon;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

export function pathLengthM(coords: LonLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineM(coords[i - 1], coords[i]);
  return total;
}

/**
 * Resample a polyline to evenly spaced points. Route scoring depends on even
 * spacing: without it, a route with dense vertices downtown and sparse
 * vertices on a freeway would double-count the downtown heat.
 */
export function densifyPath(
  coords: LonLat[],
  spacingM: number,
): Array<{ lon: number; lat: number; distanceM: number }> {
  const out: Array<{ lon: number; lat: number; distanceM: number }> = [];
  if (coords.length === 0) return out;
  out.push({ lon: coords[0][0], lat: coords[0][1], distanceM: 0 });
  let carried = 0;
  let travelled = 0;

  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const segLen = haversineM(a, b);
    if (segLen === 0) continue;
    let t = spacingM - carried;
    while (t <= segLen) {
      const f = t / segLen;
      out.push({
        lon: a[0] + (b[0] - a[0]) * f,
        lat: a[1] + (b[1] - a[1]) * f,
        distanceM: travelled + t,
      });
      t += spacingM;
    }
    carried = (carried + segLen) % spacingM;
    travelled += segLen;
  }

  const last = coords[coords.length - 1];
  const tail = out[out.length - 1];
  if (planarM([tail.lon, tail.lat], last) > spacingM * 0.25) {
    out.push({ lon: last[0], lat: last[1], distanceM: travelled });
  }
  return out;
}

export function bboxContains(
  bbox: [number, number, number, number],
  lon: number,
  lat: number,
): boolean {
  return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];
}

/* -------------------------------------------------------------------------- */
/* Single-tile sampling                                                       */
/* -------------------------------------------------------------------------- */

export function gridCellSizeDeg(g: HeatGrid) {
  return {
    dLon: (g.bbox[2] - g.bbox[0]) / g.cols,
    dLat: (g.bbox[3] - g.bbox[1]) / g.rows,
  };
}

/** Centre coordinate of cell (col, row). Row 0 is the south edge. */
export function cellCenter(g: HeatGrid, col: number, row: number): LonLat {
  const { dLon, dLat } = gridCellSizeDeg(g);
  return [g.bbox[0] + (col + 0.5) * dLon, g.bbox[1] + (row + 0.5) * dLat];
}

export function cellIndexAt(g: HeatGrid, lon: number, lat: number): number | null {
  if (!bboxContains(g.bbox, lon, lat)) return null;
  const { dLon, dLat } = gridCellSizeDeg(g);
  const col = Math.min(g.cols - 1, Math.max(0, Math.floor((lon - g.bbox[0]) / dLon)));
  const row = Math.min(g.rows - 1, Math.max(0, Math.floor((lat - g.bbox[1]) / dLat)));
  return row * g.cols + col;
}

/**
 * Bilinear interpolation between cell centres. Nearest-cell lookup makes a
 * route line visibly stair-step across cell boundaries at 100 m granularity;
 * bilinear removes that without pretending to more resolution than we have.
 */
/**
 * The temperature array a given day part reads.
 *
 * The API supplies min / average / max per cell for the day. This is the only
 * real intra-day signal it exposes - there is no hour parameter - so the whole
 * "earlier or later" question is answered from these three arrays rather than
 * from invented hourly slices.
 */
export function valuesFor(g: HeatGrid, part: DayPart = 'avg'): number[] {
  if (part === 'low') return g.tempsMinF ?? g.tempsF;
  if (part === 'peak') return g.tempsMaxF ?? g.tempsF;
  return g.tempsF;
}

/** True when the API gave no intra-day range for this grid (min == max). */
export function hasDayRange(g: HeatGrid): boolean {
  if (!g.tempsMinF || !g.tempsMaxF) return false;
  for (let i = 0; i < g.tempsF.length; i += 37) {
    if (Math.abs(g.tempsMaxF[i] - g.tempsMinF[i]) > 0.05) return true;
  }
  return false;
}

export function sampleGrid(
  g: HeatGrid,
  lon: number,
  lat: number,
  part: DayPart = 'avg',
): number | null {
  if (!bboxContains(g.bbox, lon, lat)) return null;
  const { dLon, dLat } = gridCellSizeDeg(g);
  const fx = (lon - g.bbox[0]) / dLon - 0.5;
  const fy = (lat - g.bbox[1]) / dLat - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;

  const vals = valuesFor(g, part);
  const at = (cx: number, cy: number) => {
    const c = Math.min(g.cols - 1, Math.max(0, cx));
    const r = Math.min(g.rows - 1, Math.max(0, cy));
    return vals[r * g.cols + c];
  };

  const v00 = at(x0, y0);
  const v10 = at(x0 + 1, y0);
  const v01 = at(x0, y0 + 1);
  const v11 = at(x0 + 1, y0 + 1);
  return (
    v00 * (1 - tx) * (1 - ty) + v10 * tx * (1 - ty) + v01 * (1 - tx) * ty + v11 * tx * ty
  );
}

/* -------------------------------------------------------------------------- */
/* Heat field - the multi-tile view every caller actually uses                */
/* -------------------------------------------------------------------------- */

export interface HeatFieldStats {
  minF: number;
  maxF: number;
  meanF: number;
  cellCount: number;
}

export class HeatField {
  readonly grids: HeatGrid[];
  readonly filterType: FilterType;
  readonly validAt: string;
  readonly sources: DataSource[];
  /** Which of min / average / max this field reads. */
  readonly dayPart: DayPart;

  constructor(grids: HeatGrid[], dayPart: DayPart = 'avg') {
    if (grids.length === 0) throw new Error('HeatField needs at least one tile');
    this.grids = grids;
    this.dayPart = dayPart;
    this.filterType = grids[0].filterType;
    this.validAt = grids[0].validAt;
    this.sources = Array.from(new Set(grids.map((g) => g.source)));
    for (const g of grids) {
      if (g.filterType !== this.filterType) {
        // Addendum A3 explicitly forbids blending historic and forecast data.
        throw new Error(
          `HeatField mixes filter_type ${this.filterType} and ${g.filterType}. ` +
            'Historic and forecast fields must stay separate.',
        );
      }
    }
  }

  /** True when any tile is a modelled stand-in rather than live API data. */
  get isSynthetic(): boolean {
    return this.sources.includes('synthetic');
  }

  /** Temperature at a point, or null when the point is outside every tile. */
  sample(lon: number, lat: number): number | null {
    for (const g of this.grids) {
      const v = sampleGrid(g, lon, lat, this.dayPart);
      if (v !== null) return v;
    }
    return null;
  }

  /** True when at least one tile carries a real min/max spread. */
  get hasDayRange(): boolean {
    return this.grids.some(hasDayRange);
  }

  /**
   * Nearest in-coverage temperature. Used for route sampling, where a road can
   * briefly leave a tile: returning null there would punch holes in the score,
   * so we clamp to the tile edge and flag the sample as out of coverage.
   */
  sampleClamped(lon: number, lat: number): { tempF: number; inCoverage: boolean } {
    const direct = this.sample(lon, lat);
    if (direct !== null) return { tempF: direct, inCoverage: true };

    let best: { d: number; v: number } | null = null;
    for (const g of this.grids) {
      const cLon = Math.min(g.bbox[2], Math.max(g.bbox[0], lon));
      const cLat = Math.min(g.bbox[3], Math.max(g.bbox[1], lat));
      const d = planarM([lon, lat], [cLon, cLat]);
      const v = sampleGrid(g, cLon, cLat, this.dayPart);
      if (v !== null && (best === null || d < best.d)) best = { d, v };
    }
    return { tempF: best ? best.v : NaN, inCoverage: false };
  }

  stats(): HeatFieldStats {
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let n = 0;
    for (const g of this.grids) {
      for (const t of valuesFor(g, this.dayPart)) {
        if (t < min) min = t;
        if (t > max) max = t;
        sum += t;
        n++;
      }
    }
    return { minF: min, maxF: max, meanF: n ? sum / n : NaN, cellCount: n };
  }

  /** Every cell as a point, for the demand layer and the recommender. */
  *cells(): Generator<{ lon: number; lat: number; tempF: number; tileId: string }> {
    for (const g of this.grids) {
      const vals = valuesFor(g, this.dayPart);
      for (let r = 0; r < g.rows; r++) {
        for (let c = 0; c < g.cols; c++) {
          const [lon, lat] = cellCenter(g, c, r);
          yield { lon, lat, tempF: vals[r * g.cols + c], tileId: g.tileId };
        }
      }
    }
  }
}

/** Colour ramp shared by the map, the route line and every legend. */
export function tempColor(tempF: number): string {
  const stops: Array<[number, string]> = [
    [84, '#1d4ed8'],
    [90, '#22d3ee'],
    [96, '#facc15'],
    [102, '#f97316'],
    [108, '#dc2626'],
    [114, '#7f1d1d'],
  ];
  if (!Number.isFinite(tempF)) return '#94a3b8';
  if (tempF <= stops[0][0]) return stops[0][1];
  if (tempF >= stops[stops.length - 1][0]) return stops[stops.length - 1][1];
  for (let i = 1; i < stops.length; i++) {
    if (tempF <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      return mixHex(c0, c1, (tempF - t0) / (t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
}

function mixHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const mixed = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
