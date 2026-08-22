/**
 * Modelled stand-in heat field, used ONLY when no FortyGuard key is present.
 *
 * Read this before anything else in the file: the output of this module is not
 * measurement and is never presented as such. Every grid it produces is
 * stamped `source: 'synthetic'`, the manifest records `liveApiUsed: false`,
 * and the app renders a persistent banner naming this model. The point of it
 * is that a reviewer can clone the repo with no credentials and still see the
 * product work end to end - not that the numbers are Phoenix's actual
 * temperatures on a given afternoon.
 *
 * The model is a standard, deliberately simple urban-heat-island form:
 *
 *   T(cell) = regional base for the hour
 *           + UHI from built surface (road density is the proxy)
 *           - vegetation and water cooling
 *           + a small deterministic texture term
 *
 * It is deterministic - same tile, same hour, same seed, same output - so a
 * committed snapshot is reproducible and a diff means something.
 */
import { ARIZONA_UTC_OFFSET, cellRiskThresholds, classifyCell } from './config';
import type { Region } from './regions';
import type { FilterType, HeatGrid, Tile } from './types';

/**
 * Regional 2 m air temperature for a late-August Phoenix day, by local hour.
 * Anchored on the shape of a typical Phoenix summer diurnal curve: still
 * climbing at noon, peaking mid-afternoon, barely down by 6 PM.
 */
const DIURNAL_BASE_F: Record<number, number> = {
  6: 91,
  9: 99,
  12: 106,
  15: 110,
  18: 106,
  21: 98,
};

function baseForHour(hourLocal: number): number {
  const hours = Object.keys(DIURNAL_BASE_F)
    .map(Number)
    .sort((a, b) => a - b);
  if (hourLocal <= hours[0]) return DIURNAL_BASE_F[hours[0]];
  if (hourLocal >= hours[hours.length - 1]) {
    return DIURNAL_BASE_F[hours[hours.length - 1]];
  }
  for (let i = 1; i < hours.length; i++) {
    if (hourLocal <= hours[i]) {
      const h0 = hours[i - 1];
      const h1 = hours[i];
      const t = (hourLocal - h0) / (h1 - h0);
      return DIURNAL_BASE_F[h0] + (DIURNAL_BASE_F[h1] - DIURNAL_BASE_F[h0]) * t;
    }
  }
  return DIURNAL_BASE_F[15];
}

export const SYNTHETIC_MODEL_ID = 'coolroute-uhi-v1';

export const SYNTHETIC_COEFFICIENTS = {
  /** Full built-up surface adds this much over the regional base. */
  uhiMaxF: 4.6,
  /** Full vegetation or water cover subtracts this much. */
  vegetationMaxF: 3.4,
  /** Amplitude of the deterministic texture term. */
  textureF: 0.7,
  /**
   * Historic baselines are smoother than a forecast snapshot: averaging many
   * days flattens the extremes. We damp the spread rather than shift the mean.
   */
  historicDamping: 0.82,
  /** Degrees of drift per forecast day, so consecutive days differ. */
  dayDriftF: 0.6,
};

export interface SyntheticInputs {
  region: Region;
  tile: Tile;
  cols: number;
  rows: number;
  /** Per-cell normalised 0..1 built-surface proxy, row-major from the south. */
  roadNorm: number[];
  /** Per-cell normalised 0..1 vegetation and water cover. */
  vegNorm: number[];
  /** Days ahead of the snapshot date. */
  dayOffset: number;
  filterType: FilterType;
  granularityM: number;
  validAt: string;
  date: string;
  fetchedAt: string;
  seed?: number;
}

/**
 * Daily swing between the coolest and hottest hours.
 *
 * The real API supplies min/average/max per cell, so the model has to as well
 * or the day-part selector would work on live data and break on modelled data.
 * A desert diurnal range of roughly 25 degF is the working figure; built-up
 * cells swing less than open ones because thermal mass holds overnight heat,
 * which is the urban-heat-island effect people actually notice at night.
 */
const DIURNAL_RANGE_F = 25;

export function buildSyntheticGrid(input: SyntheticInputs): HeatGrid {
  const {
    region,
    tile,
    cols,
    rows,
    roadNorm,
    vegNorm,
    dayOffset,
    filterType,
    granularityM,
    validAt,
    date,
    fetchedAt,
  } = input;
  const seed = input.seed ?? 20260821;
  const c = SYNTHETIC_COEFFICIENTS;

  // Mid-afternoon base, nudged per region and drifting slightly across the
  // forecast horizon so consecutive days are not identical.
  const base =
    baseForHour(15) + (region.syntheticOffsetF ?? 0) + dayOffset * c.dayDriftF;
  const damping = filterType === 1 ? c.historicDamping : 1;

  const n = cols * rows;
  const tempsF = new Array<number>(n);
  const tempsMinF = new Array<number>(n);
  const tempsMaxF = new Array<number>(n);

  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      const idx = r * cols + i;
      const road = clamp01(roadNorm[idx] ?? 0);
      const veg = clamp01(vegNorm[idx] ?? 0);
      const texture = (hash01(seed + dayOffset * 7919, idx) - 0.5) * 2 * c.textureF;

      const anomaly = c.uhiMaxF * road - c.vegetationMaxF * veg + texture;
      const avg = base + anomaly * damping;

      // Built-up cells hold heat overnight, so their daily swing is narrower.
      const swing = DIURNAL_RANGE_F * (1 - 0.35 * road);
      tempsF[idx] = round1(avg);
      tempsMinF[idx] = round1(avg - swing * 0.55);
      tempsMaxF[idx] = round1(avg + swing * 0.45);
    }
  }

  return {
    schema: 'coolroute.heatgrid.v3',
    regionId: region.id,
    tileId: tile.id,
    filterType,
    validAt,
    date,
    granularityM,
    bbox: tile.bbox,
    cols,
    rows,
    unit: 'F',
    source: 'synthetic',
    fetchedAt,
    provenance: {
      note:
        'MODELLED STAND-IN, not FortyGuard data. Generated locally because the live ' +
        'call was unavailable or failed. Structure is identical to a live fetch so the ' +
        'app path is the same either way.',
      model: SYNTHETIC_MODEL_ID,
      seed,
      creditsReported: null,
    },
    tempsF,
    tempsMinF,
    tempsMaxF,
    riskBands: tempsF.map(classifyCell),
    riskThresholds: cellRiskThresholds(),
  };
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}

/** ISO timestamp for a local Arizona hour on the snapshot date. */
export function arizonaIso(dateYmd: string, hourLocal: number): string {
  const hh = String(hourLocal).padStart(2, '0');
  return `${dateYmd}T${hh}:00:00${ARIZONA_UTC_OFFSET}`;
}

/**
 * Deterministic value hash in [0,1). A seeded PRNG would need shared state
 * across the tile loop; a hash of (seed, index) gives the same repeatability
 * with no state at all.
 */
function hash01(seed: number, i: number): number {
  let h = Math.imul(seed ^ i, 2654435761);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}
