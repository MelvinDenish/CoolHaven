/**
 * The single scoring function. Worker, Dispatcher and the what-if before/after
 * all call `scoreRoute` - there is no second implementation anywhere.
 *
 * Base PRD section 6.4: "This view reuses the exact same scoring function as
 * the Worker view - it's the same math run across many routes instead of one."
 * That is why the Dispatcher view cost about an hour rather than a day, and
 * why a scenario's before/after numbers are commensurable.
 */
import { EXPOSURE_BANDS, MOVEMENT, THRESHOLDS } from './assumptions';
import { HeatField, planarM, densifyPath, pathLengthM } from './grid';
import type { ReliefSite, RiskBand, RouteFeature, RouteScore } from './types';

export function bandFor(exposureIndex: number): RiskBand {
  if (exposureIndex >= EXPOSURE_BANDS.extreme) return 'extreme';
  if (exposureIndex >= EXPOSURE_BANDS.high) return 'high';
  if (exposureIndex >= EXPOSURE_BANDS.moderate) return 'moderate';
  return 'low';
}

export const BAND_META: Record<
  RiskBand,
  { label: string; color: string; action: string }
> = {
  low: { label: 'Low', color: '#0e9f6e', action: 'Normal shift. Standard water breaks.' },
  moderate: {
    label: 'Moderate',
    color: '#d97706',
    action: 'Add a scheduled stop at the nearest relief site.',
  },
  high: {
    label: 'High',
    color: '#ea580c',
    action: 'Shift the run earlier, or reroute around the peak segment.',
  },
  extreme: {
    label: 'Extreme',
    color: '#b91c1c',
    action: 'Pull or re-time this run. Do not work the peak segment as planned.',
  },
};

/**
 * Score a route against a heat field.
 *
 * The exposure index is degree-minutes above the comfort threshold: for each
 * 50 m sample we know how long the courier spends there (from the assumed
 * effective speed) and how far above 90 degF it is, and we integrate. That
 * makes a long mild route and a short brutal route comparable on one number,
 * which is exactly what a dispatcher ranking eight runs needs.
 *
 * @param field  baseline or scenario-modified field - the caller decides which
 * @param sites  relief sites AS THEY EXIST in the scenario being scored
 */
export function scoreRoute(
  route: RouteFeature,
  field: HeatField,
  sites: ReliefSite[],
): RouteScore {
  const pts = densifyPath(route.coords, MOVEMENT.sampleSpacingM);
  const metresPerMinute = (MOVEMENT.courierKph * 1000) / 60;
  const minutesPerSample = MOVEMENT.sampleSpacingM / metresPerMinute;

  const samples: RouteScore['samples'] = [];
  let sumTemp = 0;
  let peakTempF = -Infinity;
  let exposureIndex = 0;
  let minutesInExtreme = 0;
  let minutesExposed = 0;

  for (const p of pts) {
    const { tempF } = field.sampleClamped(p.lon, p.lat);
    const t = Number.isFinite(tempF) ? tempF : THRESHOLDS.comfortF;
    samples.push({ lon: p.lon, lat: p.lat, tempF: t, distanceM: p.distanceM });
    sumTemp += t;
    if (t > peakTempF) peakTempF = t;
    const over = Math.max(0, t - THRESHOLDS.comfortF);
    if (over > 0) {
      exposureIndex += over * minutesPerSample;
      minutesExposed += minutesPerSample;
    }
    if (t >= THRESHOLDS.extremeF) minutesInExtreme += minutesPerSample;
  }

  const meanTempF = samples.length ? sumTemp / samples.length : NaN;

  return {
    routeId: route.id,
    meanTempF: round1(meanTempF),
    peakTempF: round1(peakTempF),
    exposureIndex: Math.round(exposureIndex),
    minutesInExtreme: round1(minutesInExtreme),
    minutesExposed: round1(minutesExposed),
    band: bandFor(exposureIndex),
    peakSegment: findPeakSegment(samples),
    ...reliefCoverage(samples, sites),
    samples,
  };
}

/**
 * Worst contiguous stretch of the route, as a rolling window.
 * "Your route is hot" is not actionable; "the 600 m along Van Buren between
 * 7th and 3rd is the problem" is.
 */
function findPeakSegment(samples: RouteScore['samples']): RouteScore['peakSegment'] {
  const windowM = 600;
  const span = Math.max(2, Math.round(windowM / MOVEMENT.sampleSpacingM));
  if (samples.length < span) return null;

  let best = { startIdx: 0, endIdx: span - 1, sum: -Infinity };
  let running = 0;
  for (let i = 0; i < samples.length; i++) {
    running += samples[i].tempF;
    if (i >= span) running -= samples[i - span].tempF;
    if (i >= span - 1 && running > best.sum) {
      best = { startIdx: i - span + 1, endIdx: i, sum: running };
    }
  }
  return {
    startIdx: best.startIdx,
    endIdx: best.endIdx,
    meanTempF: round1(best.sum / span),
    lengthM: Math.round(samples[best.endIdx].distanceM - samples[best.startIdx].distanceM),
  };
}

/**
 * Relief coverage along the route.
 *
 * `worstReliefGapM` is the longest continuous stretch with no relief site
 * within the assumed walk radius. It is the number that changes when a
 * scenario adds a station, and the reason `cooling_station` can carry a
 * deltaF of zero and still improve a route's outcome.
 */
function reliefCoverage(
  samples: RouteScore['samples'],
  sites: ReliefSite[],
): Pick<RouteScore, 'worstReliefGapM' | 'nearestRelief'> {
  if (samples.length === 0) return { worstReliefGapM: 0, nearestRelief: null };

  let nearest: RouteScore['nearestRelief'] = null;
  let worstGapM = 0;
  let gapStartM = samples[0].distanceM;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    let bestD = Infinity;
    let bestSite: ReliefSite | null = null;
    for (const site of sites) {
      const d = planarM([s.lon, s.lat], [site.lon, site.lat]);
      if (d < bestD) {
        bestD = d;
        bestSite = site;
      }
    }
    if (bestSite && (nearest === null || bestD < nearest.distanceM)) {
      nearest = {
        siteId: bestSite.id,
        name: bestSite.name,
        distanceM: Math.round(bestD),
        atIdx: i,
      };
    }
    if (bestD <= MOVEMENT.walkToReliefM) {
      worstGapM = Math.max(worstGapM, s.distanceM - gapStartM);
      gapStartM = s.distanceM;
    }
  }
  worstGapM = Math.max(worstGapM, samples[samples.length - 1].distanceM - gapStartM);

  return { worstReliefGapM: Math.round(worstGapM), nearestRelief: nearest };
}

/* -------------------------------------------------------------------------- */
/* Fleet aggregation - Dispatcher view (FR12, FR13)                           */
/* -------------------------------------------------------------------------- */

export interface FleetSummary {
  routeCount: number;
  highOrWorse: number;
  totalMinutesInExtreme: number;
  meanExposure: number;
  worstRouteId: string | null;
  /** The one-line stat the demo narrative uses. */
  headline: string;
}

export function summarizeFleet(scores: RouteScore[]): FleetSummary {
  const highOrWorse = scores.filter((s) => s.band === 'high' || s.band === 'extreme').length;
  const totalMinutesInExtreme = scores.reduce((a, s) => a + s.minutesInExtreme, 0);
  const meanExposure = scores.length
    ? scores.reduce((a, s) => a + s.exposureIndex, 0) / scores.length
    : 0;
  const worst = scores.slice().sort((a, b) => b.exposureIndex - a.exposureIndex)[0];

  return {
    routeCount: scores.length,
    highOrWorse,
    totalMinutesInExtreme: round1(totalMinutesInExtreme),
    meanExposure: Math.round(meanExposure),
    worstRouteId: worst?.routeId ?? null,
    headline: `${highOrWorse} of ${scores.length} active routes are in high-exposure zones right now`,
  };
}

/** Rank routes worst-first. The Dispatcher list is literally this. */
export function rankRoutes(scores: RouteScore[]): RouteScore[] {
  return scores.slice().sort((a, b) => b.exposureIndex - a.exposureIndex);
}

/**
 * Compare two candidate paths for the same trip (Addition 2: the router
 * returns real alternatives, and we pick the one a worker should actually take
 * on a 112 degF afternoon rather than the one that is 40 seconds faster).
 */
export interface RouteComparison {
  primary: RouteScore;
  alternative: RouteScore | null;
  /** Positive = the alternative is cooler. */
  exposureSavedIndex: number;
  extraDistanceM: number;
  extraDurationS: number;
  recommendation: 'take-alternative' | 'keep-primary' | 'no-alternative';
  rationale: string;
}

export function compareRoutes(
  primary: { route: RouteFeature; score: RouteScore },
  alternative: { route: RouteFeature; score: RouteScore } | null,
): RouteComparison {
  if (!alternative) {
    return {
      primary: primary.score,
      alternative: null,
      exposureSavedIndex: 0,
      extraDistanceM: 0,
      extraDurationS: 0,
      recommendation: 'no-alternative',
      rationale: 'The router returned only one viable path for this trip.',
    };
  }

  const saved = primary.score.exposureIndex - alternative.score.exposureIndex;
  const extraDistanceM = Math.round(alternative.route.distanceM - primary.route.distanceM);
  const extraDurationS = Math.round(alternative.route.durationS - primary.route.durationS);
  // A cooler path is only worth it if the detour is modest. 12% of exposure for
  // up to 6 extra minutes is our working trade-off, stated rather than hidden.
  const worthIt = saved > primary.score.exposureIndex * 0.12 && extraDurationS < 360;
  const extraMin = Math.round(Math.abs(extraDurationS) / 60);

  // Three distinct cases, and the middle one matters: an alternative that is
  // HOTTER has to say so. Clamping a negative saving to zero would report
  // "saves only 0" for a path that actually costs the worker 99 degree-minutes.
  let rationale: string;
  if (worthIt) {
    rationale = `The alternative cuts ${saved} degree-minutes of exposure for ${extraMin} extra minutes of driving.`;
  } else if (saved < 0) {
    rationale =
      `The alternative is hotter, not cooler - ${Math.abs(saved)} degree-minutes worse` +
      (extraDurationS > 0 ? ` and ${extraMin} minutes longer` : '') +
      '. Stay on the primary path.';
  } else {
    rationale = `The alternative saves only ${saved} degree-minutes and costs ${extraMin} extra minutes. Stay on the primary path.`;
  }

  return {
    primary: primary.score,
    alternative: alternative.score,
    exposureSavedIndex: saved,
    extraDistanceM,
    extraDurationS,
    recommendation: worthIt ? 'take-alternative' : 'keep-primary',
    rationale,
  };
}

/** Route distance from geometry, for routes not supplied by a router. */
export function measureRoute(coords: RouteFeature['coords']): number {
  return Math.round(pathLengthM(coords));
}

function round1(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 10) / 10 : n;
}
