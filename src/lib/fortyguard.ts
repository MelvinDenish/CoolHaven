/**
 * FortyGuard API client - the actual integration deliverable.
 *
 * Base PRD section 8 calls this out: "we understood and correctly handled the
 * async API" is a stronger technical signal than "we called an endpoint", so
 * this file is written to be read.
 *
 * ---------------------------------------------------------------------------
 * THE REAL CONTRACT, discovered against the live API on 2026-08-22.
 *
 * The earlier version of this file guessed the shape from the handbook and got
 * several things wrong. Everything below is what the server actually does,
 * verified by request:
 *
 *   Auth        `api-key: <key>` request header.
 *               NOT `Authorization: Bearer` and NOT `x-api-key` - both return
 *               401 with "Missing required 'api-key' header".
 *
 *   Submit      POST /v1/heatmap
 *               { "polygon_aoi": <GeoJSON Polygon>,
 *                 "date_time": { "start_date": "YYYY-MM-DD",
 *                                "filter_type": 1 | 2 | 3 | 4 } }
 *               -> { data: { activity_id } }
 *
 *               `filter_type` lives INSIDE `date_time`, not at the top level.
 *               Unknown fields are silently ignored, so a wrong parameter name
 *               fails quietly rather than loudly - which is exactly why the
 *               fields below are pinned to what was verified rather than to
 *               what seemed reasonable.
 *
 *   Poll        GET /v1/status/{activity_id}
 *               -> { data: { status: "Processing" | "Completed",
 *                            result: { map_data, stats_data } } }
 *
 *   Result      `map_data` is a GeoJSON FeatureCollection of POLYGON cells.
 *               Each feature carries:
 *                 tile_id, average_temperature, min_temperature, max_temperature
 *               Temperatures are CELSIUS. The app works in Fahrenheit
 *               throughout, so conversion happens here, once, at the boundary.
 *
 * Known limitations of this key, established by probing and documented rather
 * than worked around silently:
 *
 *   - Only `filter_type: 3` succeeds. Values 1, 2 and 4 pass validation and
 *     then return HTTP 500 for every date range tried. The Addendum A2 mapping
 *     of Planner->historic cannot be honoured against this key; the code keeps
 *     the separation intact so it starts working the moment the API serves
 *     historic, and the UI states which it is actually reading.
 *   - There is NO hour-of-day parameter. `hour` and `start_time` are accepted
 *     and ignored - two submissions differing only by `hour` returned
 *     byte-identical statistics. One (polygon, date) yields one field.
 *   - There is NO granularity parameter. `granularity` is likewise ignored;
 *     the server chooses the cell size (~2,160 cells for an 8.4 mi2 tile,
 *     which lands close to the 100 m the Addendum asked for).
 * ---------------------------------------------------------------------------
 */
import type { FilterType } from './types';

export interface FortyGuardConfig {
  apiKey: string;
  baseUrl: string;
  /** Total wall-clock budget for one activity's polling, milliseconds. */
  pollTimeoutMs?: number;
}

export interface HeatmapRequest {
  /** [minLon, minLat, maxLon, maxLat] - converted to a closed GeoJSON ring. */
  bbox: [number, number, number, number];
  /** Local calendar date, YYYY-MM-DD. The API has no hour dimension. */
  date: string;
  filterType: FilterType;
}

export interface SubmitResult {
  activityId: string;
  /** Whatever the API reported about cost, if anything. Used by credit-probe. */
  creditsReported: number | null;
  raw: unknown;
}

export interface HeatmapCell {
  lon: number;
  lat: number;
  /** Converted to Fahrenheit at this boundary. */
  tempF: number;
  minTempF: number;
  maxTempF: number;
}

export interface HeatmapResult {
  activityId: string;
  cells: HeatmapCell[];
  /** The API's own summary, in Fahrenheit. Useful as an independent check. */
  stats: { minF: number; maxF: number; meanF: number } | null;
  creditsReported: number | null;
  raw: unknown;
}

export class FortyGuardError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'FortyGuardError';
  }
}

export function bboxToPolygon(bbox: [number, number, number, number]) {
  const [w, s, e, n] = bbox;
  return {
    type: 'Polygon' as const,
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  };
}

export function cToF(c: number): number {
  return c * 1.8 + 32;
}

export class FortyGuardClient {
  private readonly cfg: Required<FortyGuardConfig>;

  constructor(cfg: FortyGuardConfig) {
    if (!cfg.apiKey) throw new FortyGuardError('FORTYGUARD_API_KEY is not set');
    this.cfg = {
      pollTimeoutMs: 8 * 60_000,
      ...cfg,
      baseUrl: cfg.baseUrl.replace(/\/+$/, ''),
    };
  }

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'application/json',
      // The one header the API actually accepts. See the note at the top.
      'api-key': this.cfg.apiKey,
    };
  }

  /** Submit one AOI. One call per tile per date (Addendum A3). */
  async submitHeatmap(req: HeatmapRequest): Promise<SubmitResult> {
    const body = {
      polygon_aoi: bboxToPolygon(req.bbox),
      date_time: {
        start_date: req.date,
        filter_type: req.filterType,
      },
    };

    const res = await fetch(`${this.cfg.baseUrl}/v1/heatmap`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new FortyGuardError(
        `heatmap submit failed (${res.status})` +
          (res.status === 500 && req.filterType !== 3
            ? ` - filter_type ${req.filterType} is known to return 500 on this key; only 3 (forecast) works`
            : ''),
        res.status,
        text.slice(0, 500),
      );
    }

    const json = safeJson(text);
    const activityId = pick<string>(json, [
      'data.activity_id',
      'activity_id',
      'activityId',
      'id',
    ]);
    if (!activityId) {
      throw new FortyGuardError(
        'heatmap submit returned no activity_id',
        res.status,
        text.slice(0, 500),
      );
    }
    return { activityId, creditsReported: readCredits(json), raw: json };
  }

  /**
   * Poll one activity to completion.
   *
   * Backoff doubles from 1 s to a 15 s ceiling. The ceiling matters: unbounded
   * doubling on a slow activity ends up sleeping for minutes past completion,
   * which is how a demo-morning re-run turns into a coffee break.
   */
  async pollActivity(
    activityId: string,
    onTick?: (attempt: number, state: string) => void,
  ): Promise<HeatmapResult> {
    const started = Date.now();
    let delay = 1_000;

    for (let attempt = 1; ; attempt++) {
      if (Date.now() - started > this.cfg.pollTimeoutMs) {
        throw new FortyGuardError(
          `activity ${activityId} did not complete within ${this.cfg.pollTimeoutMs} ms`,
        );
      }

      const res = await fetch(`${this.cfg.baseUrl}/v1/status/${activityId}`, {
        headers: this.headers(),
      });
      const text = await res.text();

      // 429 and 5xx are retryable; anything else is a real error.
      if (res.status === 429 || res.status >= 500) {
        onTick?.(attempt, `retry-${res.status}`);
        await sleep(delay);
        delay = Math.min(delay * 2, 15_000);
        continue;
      }
      if (!res.ok) {
        throw new FortyGuardError(
          `status check failed (${res.status})`,
          res.status,
          text.slice(0, 500),
        );
      }

      const json = safeJson(text);
      const state = String(
        pick<string>(json, ['data.status', 'status', 'state']) ?? 'unknown',
      ).toLowerCase();
      onTick?.(attempt, state);

      if (['completed', 'complete', 'success', 'succeeded', 'done'].includes(state)) {
        return {
          activityId,
          cells: extractCells(json),
          stats: extractStats(json),
          creditsReported: readCredits(json),
          raw: json,
        };
      }
      if (['failed', 'error', 'cancelled', 'canceled'].includes(state)) {
        throw new FortyGuardError(
          `activity ${activityId} ended in state "${state}"`,
          res.status,
          text.slice(0, 500),
        );
      }

      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }

  /** submit + poll, the pairing every caller actually wants. */
  async heatmap(
    req: HeatmapRequest,
    onTick?: (attempt: number, state: string) => void,
  ): Promise<HeatmapResult> {
    const submitted = await this.submitHeatmap(req);
    const result = await this.pollActivity(submitted.activityId, onTick);
    return {
      ...result,
      creditsReported: result.creditsReported ?? submitted.creditsReported,
    };
  }

  /**
   * Point query (Addendum A2, priority High) - and the most surprising
   * endpoint in the API.
   *
   * It is NOT "give me the temperature here". It takes a temperature as INPUT
   * (the dry-bulb value we already hold from the heatmap grid) and returns a
   * derived environmental profile for that point: heat index, apparent
   * temperature, humidity, wet bulb, cloud cover and air quality.
   *
   * The important part: those come back as **24 hourly values**. The heatmap
   * endpoint has no hour parameter at all, so this is the only place in the
   * API where real intra-day resolution exists. It is per-point rather than
   * per-grid, which is exactly the shape base PRD FR17 needs - "should I run
   * this at 6 AM or 3 PM" is a question about one route, not about a field.
   *
   * Like /v1/heatmap it is asynchronous: submit, then poll the same
   * /v1/status/{activity_id} endpoint.
   */
  async envParamsHourly(
    req: { lat: number; lon: number; temperatureC: number; date: string; filterType: FilterType },
    onTick?: (attempt: number, state: string) => void,
  ): Promise<HourlyProfile> {
    const res = await fetch(`${this.cfg.baseUrl}/v1/env_params`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        latitude: req.lat,
        longitude: req.lon,
        temperature: req.temperatureC,
        date_time: { start_date: req.date, filter_type: req.filterType },
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new FortyGuardError(
        `env_params submit failed (${res.status})`,
        res.status,
        text.slice(0, 400),
      );
    }

    const activityId = pick<string>(safeJson(text), ['data.activity_id', 'activity_id']);
    if (!activityId) throw new FortyGuardError('env_params returned no activity_id');

    const json = await this.pollRaw(activityId, onTick);
    const loc = pick<Record<string, unknown>>(json, ['data.result.locations.0']);
    const timestamps =
      pick<string[]>(json, ['data.result.metadata.timestamps']) ?? [];
    const params = (loc?.parameters ?? {}) as Record<string, number[]>;

    const toF = (arr?: number[]) => (arr ?? []).map(cToF).map((v) => Math.round(v * 10) / 10);

    return {
      activityId,
      lat: req.lat,
      lon: req.lon,
      elevationM: typeof loc?.elevation === 'number' ? loc.elevation : null,
      inputTempC: req.temperatureC,
      timestamps,
      apparentTempF: toF(params.apparent_temperature_celsius),
      heatIndexF: toF(params.heat_index_celsius),
      wetBulbF: toF(params.wet_bulb_temperature_celsius),
      humidityPct: params.relative_humidity_percent ?? [],
      cloudCoverOctas: params.cloud_cover_octas ?? [],
      airQualityIdx: params['air_quality:idx'] ?? [],
    };
  }

  /**
   * Street-level view with semantic segmentation (Addendum A2, "Streetview").
   *
   * The contract, established by probing because the handbook does not carry
   * it. Required fields beyond the coordinate pair:
   *
   *   vertical_angle    camera pitch, 0 is level
   *   horizontal_angle  bearing offset from the road direction
   *   back_view         1 to also return the rearward view
   *
   * Returns a `front` and, with back_view, a `back` - each carrying the source
   * photograph, a segmented overlay, and `segments`: the share of the frame
   * occupied by building, sky, tree, road, sidewalk, car and so on.
   *
   * `segments.tree` and `segments.sky` are the interesting pair. Together they
   * are a MEASURED description of how exposed a specific point on a specific
   * street is - which is the one thing the canopy scenario previously had to
   * assume. See groundCanopy() in assumptions.ts for exactly what that does and
   * does not license us to claim.
   */
  async streetView(
    req: { lat: number; lon: number; verticalAngle?: number; horizontalAngle?: number; backView?: boolean },
    onTick?: (attempt: number, state: string) => void,
  ): Promise<StreetViewResult> {
    const activityId = await this.submitSimple('/v1/streetview', {
      latitude: req.lat,
      longitude: req.lon,
      vertical_angle: req.verticalAngle ?? 0,
      horizontal_angle: req.horizontalAngle ?? 0,
      back_view: req.backView === false ? 0 : 1,
    });
    const json = await this.pollRaw(activityId, onTick);
    const result = pick<Record<string, unknown>>(json, ['data.result']) ?? {};
    return {
      activityId,
      lat: req.lat,
      lon: req.lon,
      front: viewFrom(result.front),
      back: viewFrom(result.back),
    };
  }

  /**
   * Overhead imagery with land-cover segmentation (Addendum A2, "Satellite").
   *
   * Note the shape: `sat` and `date_time` are nested OBJECTS, not scalars, and
   * `sat` repeats the coordinate pair. Passing them flat returns a 422 that
   * names the field but not the nesting, which is what made this endpoint look
   * unavailable rather than merely undocumented.
   */
  async satellite(
    req: { lat: number; lon: number; date: string; filterType: FilterType },
    onTick?: (attempt: number, state: string) => void,
  ): Promise<SatelliteResult> {
    const activityId = await this.submitSimple('/v1/satellite', {
      latitude: req.lat,
      longitude: req.lon,
      sat: { latitude: req.lat, longitude: req.lon },
      date_time: { start_date: req.date, filter_type: req.filterType },
    });
    const json = await this.pollRaw(activityId, onTick);
    const result = pick<Record<string, unknown>>(json, ['data.result']) ?? {};
    const seg = (result.segmentation ?? {}) as Record<string, unknown>;
    const original = Array.isArray(result.original_image)
      ? (result.original_image[0] as string)
      : (result.original_image as string | undefined);

    return {
      activityId,
      lat: req.lat,
      lon: req.lon,
      imageYear: (result.image_year as string | number | undefined) ?? null,
      originalImage: original ?? null,
      segmentedImage: (seg.image_content as string | undefined) ?? null,
      segments: (seg.segments as Record<string, number> | undefined) ?? {},
    };
  }

  /** Submit a body to an async endpoint and return its activity_id. */
  private async submitSimple(path: string, body: unknown): Promise<string> {
    const res = await fetch(`${this.cfg.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new FortyGuardError(
        `${path} submit failed (${res.status})`,
        res.status,
        text.slice(0, 400),
      );
    }
    const activityId = pick<string>(safeJson(text), ['data.activity_id', 'activity_id']);
    if (!activityId) throw new FortyGuardError(`${path} returned no activity_id`);
    return activityId;
  }

  /** Poll to completion and hand back the raw payload. */
  private async pollRaw(
    activityId: string,
    onTick?: (attempt: number, state: string) => void,
  ): Promise<unknown> {
    const started = Date.now();
    let delay = 1_000;
    for (let attempt = 1; ; attempt++) {
      if (Date.now() - started > this.cfg.pollTimeoutMs) {
        throw new FortyGuardError(`activity ${activityId} timed out`);
      }
      const res = await fetch(`${this.cfg.baseUrl}/v1/status/${activityId}`, {
        headers: this.headers(),
      });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) {
        onTick?.(attempt, `retry-${res.status}`);
        await sleep(delay);
        delay = Math.min(delay * 2, 15_000);
        continue;
      }
      if (!res.ok) {
        throw new FortyGuardError(`status failed (${res.status})`, res.status, text.slice(0, 300));
      }
      const json = safeJson(text);
      const state = String(pick<string>(json, ['data.status']) ?? '').toLowerCase();
      onTick?.(attempt, state);
      if (['completed', 'complete', 'success', 'done'].includes(state)) return json;
      if (['failed', 'error', 'cancelled'].includes(state)) {
        throw new FortyGuardError(`activity ${activityId} ended "${state}"`);
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 15_000);
    }
  }
}

/**
 * One camera direction from /v1/streetview.
 *
 * `segments` values are percentages of the frame and sum to about 100.
 * Images are base64 without a data: prefix - the caller adds one.
 */
export interface StreetViewFrame {
  originalImage: string | null;
  segmentedImage: string | null;
  segments: Record<string, number>;
  imageDate: string | null;
}

export interface StreetViewResult {
  activityId: string;
  lat: number;
  lon: number;
  front: StreetViewFrame | null;
  back: StreetViewFrame | null;
}

export interface SatelliteResult {
  activityId: string;
  lat: number;
  lon: number;
  imageYear: string | number | null;
  originalImage: string | null;
  segmentedImage: string | null;
  segments: Record<string, number>;
}

function viewFrom(raw: unknown): StreetViewFrame | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as Record<string, unknown>;
  return {
    originalImage: (v.original_image as string | undefined) ?? null,
    segmentedImage: (v.segmented_image as string | undefined) ?? null,
    segments: (v.segments as Record<string, number> | undefined) ?? {},
    imageDate: (v.image_date as string | undefined) ?? null,
  };
}

/** One point's 24-hour environmental profile, temperatures in Fahrenheit. */
export interface HourlyProfile {
  activityId: string;
  lat: number;
  lon: number;
  elevationM: number | null;
  inputTempC: number;
  /** ISO-8601 local timestamps, 24 of them. */
  timestamps: string[];
  apparentTempF: number[];
  heatIndexF: number[];
  wetBulbF: number[];
  humidityPct: number[];
  cloudCoverOctas: number[];
  airQualityIdx: number[];
}

/* -------------------------------------------------------------------------- */
/* Payload handling                                                           */
/* -------------------------------------------------------------------------- */

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { _unparsed: text.slice(0, 2000) };
  }
}

function pick<T>(obj: unknown, paths: string[]): T | undefined {
  for (const path of paths) {
    let cur: unknown = obj;
    for (const part of path.split('.')) {
      if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[part];
      } else {
        cur = undefined;
        break;
      }
    }
    if (cur !== undefined && cur !== null) return cur as T;
  }
  return undefined;
}

function readCredits(json: unknown): number | null {
  const v = pick<number>(json, [
    'data.credits_used',
    'credits_used',
    'creditsUsed',
    'credit_cost',
    'cost',
    'usage.credits',
    'meta.credits_used',
  ]);
  return typeof v === 'number' ? v : null;
}

/**
 * Turn `result.map_data` into flat cells with Fahrenheit temperatures.
 *
 * Each feature is a Polygon covering one cell, so the representative point is
 * the ring's centroid. Averaging the ring vertices is exact enough for the
 * near-rectangular cells the API returns, and avoids pulling in a geometry
 * library for one call site.
 */
function extractCells(json: unknown): HeatmapCell[] {
  const features = pick<
    Array<{
      properties?: Record<string, unknown>;
      geometry?: { type?: string; coordinates?: unknown };
    }>
  >(json, ['data.result.map_data.features', 'result.map_data.features', 'features']);

  if (!Array.isArray(features)) return [];
  const out: HeatmapCell[] = [];

  for (const f of features) {
    const p = f.properties ?? {};
    const avgC = num(p.average_temperature ?? p.temperature ?? p.temp ?? p.value);
    if (avgC === null) continue;

    const centre = centroidOf(f.geometry);
    if (!centre) continue;

    const minC = num(p.min_temperature);
    const maxC = num(p.max_temperature);
    out.push({
      lon: centre[0],
      lat: centre[1],
      tempF: cToF(avgC),
      minTempF: cToF(minC ?? avgC),
      maxTempF: cToF(maxC ?? avgC),
    });
  }
  return out;
}

function extractStats(json: unknown): HeatmapResult['stats'] {
  const t = pick<Record<string, number>>(json, [
    'data.result.stats_data.temperature_stats',
    'result.stats_data.temperature_stats',
  ]);
  if (!t) return null;
  const min = num(t.minimum);
  const max = num(t.maximum);
  const mean = num(t.mean);
  if (min === null || max === null || mean === null) return null;
  return { minF: cToF(min), maxF: cToF(max), meanF: cToF(mean) };
}

function centroidOf(geometry: unknown): [number, number] | null {
  if (!geometry || typeof geometry !== 'object') return null;
  const g = geometry as { type?: string; coordinates?: unknown };

  if (g.type === 'Point' && Array.isArray(g.coordinates)) {
    const c = g.coordinates as number[];
    return [c[0], c[1]];
  }

  // Polygon -> outer ring; MultiPolygon -> first polygon's outer ring.
  let ring: unknown;
  if (g.type === 'Polygon') ring = (g.coordinates as unknown[])?.[0];
  else if (g.type === 'MultiPolygon') {
    ring = ((g.coordinates as unknown[])?.[0] as unknown[])?.[0];
  }
  if (!Array.isArray(ring) || ring.length === 0) return null;

  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const pt of ring as Array<[number, number]>) {
    if (!Array.isArray(pt) || pt.length < 2) continue;
    sx += pt[0];
    sy += pt[1];
    n++;
  }
  return n ? [sx / n, sy / n] : null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
