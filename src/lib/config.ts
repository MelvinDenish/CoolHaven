/**
 * Region-agnostic constants and AOI guards.
 *
 * Anything city-specific lives in regions.ts. What is left here is true of
 * every region: the granularity we ingest at, the AOI ceiling the API imposes,
 * the timestamps we capture, and the cell-level risk classification.
 *
 * Addendum A3: Phoenix - and every other real city - is far larger than
 * FortyGuard's ~50 mi2 / 130 km2 per-request AOI limit, so a focus area is
 * always a small set of named tiles. The limit is enforced in code
 * (assertTilesWithinAoiLimit) rather than left as prose, so a careless bbox
 * edit fails loudly instead of burning credits.
 */
import type { Tile } from './types';

/** FortyGuard per-request AOI ceiling. We target <= 20 mi2 per tile. */
export const AOI_LIMIT_MI2 = 50;
export const TILE_TARGET_MAX_MI2 = 20;

/** Addendum A2: 80-100 m granularity to control credit spend. */
export const GRANULARITY_M = 100;

export const M_PER_DEG_LAT = 110_574;

export function mPerDegLon(lat: number) {
  return 111_320 * Math.cos((lat * Math.PI) / 180);
}

export function tileAreaMi2(bbox: [number, number, number, number]): number {
  const midLat = (bbox[1] + bbox[3]) / 2;
  const wM = (bbox[2] - bbox[0]) * mPerDegLon(midLat);
  const hM = (bbox[3] - bbox[1]) * M_PER_DEG_LAT;
  return (wM * hM) / 2_589_988; // m2 per square mile
}

/**
 * Hard guard, called by every ingestion script before a single request goes
 * out. Cheaper to throw here than to have a request rejected after billing.
 */
export function assertTilesWithinAoiLimit(tiles: Tile[]) {
  for (const t of tiles) {
    const a = tileAreaMi2(t.bbox);
    if (a > TILE_TARGET_MAX_MI2) {
      throw new Error(
        `Tile "${t.id}" is ${a.toFixed(1)} mi2, over the ${TILE_TARGET_MAX_MI2} mi2 target ` +
          `(FortyGuard AOI limit is ~${AOI_LIMIT_MI2} mi2). Split it before ingesting.`,
      );
    }
  }
}

/**
 * Cell dimensions for a tile at a given granularity.
 *
 * Every producer of per-cell data - the ingestion script, the synthetic model,
 * the OSM road-density pass - derives its array length from this one function,
 * so the arrays are guaranteed to line up index for index.
 */
export function gridDimsFor(
  bbox: [number, number, number, number],
  granularityM: number,
): { cols: number; rows: number } {
  const midLat = (bbox[1] + bbox[3]) / 2;
  const widthM = (bbox[2] - bbox[0]) * mPerDegLon(midLat);
  const heightM = (bbox[3] - bbox[1]) * M_PER_DEG_LAT;
  return {
    cols: Math.max(1, Math.round(widthM / granularityM)),
    rows: Math.max(1, Math.round(heightM / granularityM)),
  };
}

/* -------------------------------------------------------------------------- */
/* Cell risk classification (base PRD FR1, FR4)                               */
/* -------------------------------------------------------------------------- */

/**
 * FR1 requires the tileset to store "temp, risk classification, timestamp".
 * This is that classification: a discrete band per grid cell, computed at
 * ingest and written into the cache alongside the temperature.
 *
 * It is deliberately NOT the same thing as a route's risk band. A route band
 * integrates exposure over time along a path; this classifies a single cell by
 * instantaneous temperature. Conflating them would be a category error - a
 * merely warm cell crossed for an hour is worse than an extreme cell crossed
 * in ten seconds, and only the route band can express that.
 *
 * Storing it rather than deriving it on render matters for a second reason:
 * the thresholds travel with the data. A snapshot ingested under one set of
 * thresholds stays interpretable after the thresholds change, because each
 * grid records the cut points it was classified with.
 */
export const CELL_RISK_BANDS = [
  { index: 0, id: 'safe', label: 'Below caution (<90)', minF: -Infinity, color: '#1d4ed8' },
  { index: 1, id: 'caution', label: 'Caution (90-100)', minF: 90, color: '#facc15' },
  { index: 2, id: 'high', label: 'High (100-108)', minF: 100, color: '#f97316' },
  { index: 3, id: 'extreme', label: 'Extreme (108-114)', minF: 108, color: '#dc2626' },
  { index: 4, id: 'severe', label: 'Severe (114+)', minF: 114, color: '#7f1d1d' },
] as const;

export type CellRiskIndex = 0 | 1 | 2 | 3 | 4;

/**
 * Five bands, not four, and the top one exists for a specific reason.
 *
 * With a ceiling of 108 degF, a desert region in August classifies as 100%
 * extreme at 3 PM - which is true, and useless. The layer becomes a solid red
 * rectangle carrying no information, and a planner cannot tell the worst
 * blocks from the merely terrible ones. Measured on the committed Yuma
 * snapshot: 8,680 of 8,680 cells landed in one band.
 *
 * 114 degF splits that top band along a line that means something
 * operationally - it is roughly where even brief unshaded exposure stops being
 * survivable for a working shift - and restores the layer's ability to
 * discriminate in exactly the cities that need it most.
 */
export function classifyCell(tempF: number): CellRiskIndex {
  if (tempF >= 114) return 4;
  if (tempF >= 108) return 3;
  if (tempF >= 100) return 2;
  if (tempF >= 90) return 1;
  return 0;
}

/** The cut points, recorded in each grid so the data is self-describing. */
export function cellRiskThresholds(): Record<string, number> {
  return { caution: 90, high: 100, extreme: 108, severe: 114 };
}

/* -------------------------------------------------------------------------- */
/* Time slices                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What gets captured per run, per region.
 *
 * This used to be four hour-of-day timestamps. The live API does not support
 * that: `hour` and `start_time` are accepted and silently ignored, and two
 * submissions differing only by hour return byte-identical statistics. One
 * (polygon, date) yields exactly one field.
 *
 * So the real axes are the two the API actually exposes:
 *
 *   FORECAST DAY  - a separate submission per calendar date.
 *   DAY PART      - min / average / max temperature, which every returned cell
 *                   carries for that day.
 *
 * Only `filter_type: 3` (forecast) works on the hackathon key; 1, 2 and 4 pass
 * validation and then return HTTP 500 for every date range tried. The
 * historic/forecast separation the Addendum asks for is still enforced
 * everywhere in the code, so it starts working the moment historic is served -
 * but this snapshot is forecast throughout, and the UI says so.
 */
export const FORECAST_DAYS = [
  { key: 'd0', dayOffset: 0, filterType: 3 as const, label: 'Snapshot day' },
  { key: 'd1', dayOffset: 1, filterType: 3 as const, label: 'Next day' },
];

/**
 * Two days, not three, and this was measured rather than chosen.
 *
 * Submitting snapshot-date + 2 returned HTTP 500 for every tile in both
 * regions, so the usable forecast horizon on this key is about one day ahead.
 * Day +1 also comes back with min == average == max - the API gives a value
 * but no intra-day range for it - which is why DAY_PARTS below is only
 * meaningful on the snapshot day, and why the UI says so instead of showing
 * three identical numbers.
 */

/** Backwards-compatible alias - the rest of the app still says "time slice". */
export const TIME_SLICES = FORECAST_DAYS;

export type TimeSliceKey = (typeof FORECAST_DAYS)[number]['key'];

/**
 * Which of the three per-cell values a view reads.
 *
 * This is the honest replacement for the old hour slider. "The coolest part of
 * this day" and "the peak of this day" are real, API-supplied numbers; "3 PM
 * versus 6 PM" was not available and would have had to be invented.
 */
export const DAY_PARTS = [
  { key: 'low', label: 'Day low', blurb: "The day's coolest hours" },
  { key: 'avg', label: 'Day average', blurb: 'Mean across the day' },
  { key: 'peak', label: 'Day peak', blurb: "The day's hottest hours" },
] as const;

export type DayPart = (typeof DAY_PARTS)[number]['key'];

/** Add whole days to a YYYY-MM-DD string without touching timezones. */
export function addDays(dateYmd: string, days: number): string {
  const d = new Date(`${dateYmd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}


/** Arizona does not observe DST. Both regions are in it. */
export const ARIZONA_UTC_OFFSET = '-07:00';
