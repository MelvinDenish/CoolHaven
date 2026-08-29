/**
 * POST /api/draft/bootstrap
 *
 * The /api/bootstrap of a region nobody committed: a user drew the boxes a
 * moment ago, so there is no manifest, no relief-sites.json and no
 * road-density.json to read. Everything is derived here, live, from the
 * definition in the request body.
 *
 * It returns the SAME payload shape /api/bootstrap returns, minus the parts a
 * drafted region genuinely does not have, listed explicitly in `unavailable` so
 * the client degrades with a stated reason instead of rendering a zero:
 *
 *   routes   nobody has supplied work routes for this area. Everything derived
 *            from routes - the worst uncovered stretch, route-weighted demand,
 *            the whole Dispatcher and Worker view - is unavailable, not zero.
 *   hourly   scripts/fetch-hourly.ts samples route endpoints, which do not exist.
 *   ground   street-view segmentation is a curated, sampled dataset.
 *
 * WHAT THIS BREAKS, SAID OUT LOUD
 *
 * README's measured-NFR section says the running app makes no Overpass call.
 * That remains true for every curated region and is false for this endpoint,
 * which is why drafting is an explicit user action behind its own button rather
 * than something the app does on load. The curated path is untouched: this
 * route never reads from disk, and /api/bootstrap never calls Overpass.
 *
 * Overpass is slow - relief plus roads for a fresh box is tens of seconds on a
 * good mirror - so this runs with a reduced attempt count and a long
 * maxDuration, and the client is expected to show progress rather than a
 * spinner.
 */
import { NextResponse } from 'next/server';
import {
  ASSUMPTION_NOTES,
  INTERVENTIONS,
  MOVEMENT,
  THRESHOLDS,
} from '@/lib/assumptions';
import { CELL_RISK_BANDS, GRANULARITY_M, tileAreaMi2 } from '@/lib/config';
import {
  DraftValidationError,
  buildDraftRegion,
  comparabilityKey,
  type DraftInput,
} from '@/lib/draft-region';
import {
  OVERPASS_ENDPOINTS,
  buildRoadDensityTiles,
  fetchGreenWays,
  fetchRoadWays,
  overpassBboxClause,
} from '@/lib/osm-context';
import { fetchOsmRelief } from '@/lib/osm-relief';
import { REGIONS, regionBbox } from '@/lib/regions';
import { cacheContext, cachedContext, draftBudgetStatus } from '@/lib/server/draft-guard';

export const dynamic = 'force-dynamic';
// Two Overpass queries against a cold mirror can legitimately take minutes.
export const maxDuration = 300;

/*
 * Two attempts per mirror with a short backoff, rather than the script's three
 * with a 20-second one.
 *
 * The first version of this used a single attempt, on the reasoning that five
 * mirrors is already redundancy. Testing disagreed within minutes: Overpass
 * answered 504 from the busiest mirror and a bare 500 from two others - the
 * exact transient failures the note in osm-context.ts describes - and a
 * one-shot attempt turned a blip into a dead feature.
 *
 * Worst case is bounded at roughly 5 mirrors x 2 attempts x (request + 3 s),
 * comfortably inside maxDuration, and the client streams progress rather than
 * showing a spinner.
 */
const OVERPASS_ATTEMPTS = 2;
const OVERPASS_BACKOFF_MS = 3_000;

interface DraftPayload {
  regions: unknown[];
  region: Record<string, unknown>;
  granularityM: number;
  cellRiskBands: unknown;
  tiles: unknown[];
  timeSlices: unknown[];
  relief: unknown;
  roadDensity: unknown;
  routes: null;
  hourly: null;
  assumptions: unknown;
  unavailable: Array<{ what: string; why: string }>;
  budget: unknown;
  cached: boolean;
}

export async function POST(req: Request) {
  let body: DraftInput;
  try {
    body = (await req.json()) as DraftInput;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  let region;
  try {
    region = buildDraftRegion(body);
  } catch (err) {
    if (err instanceof DraftValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const bbox = regionBbox(region);
  const today = localToday(region.utcOffset);
  const cacheKey = `${region.id}|${today}`;

  const cached = cachedContext<DraftPayload>(cacheKey);
  if (cached) {
    return NextResponse.json({ ...cached, cached: true });
  }

  let relief;
  let roadDensity;
  try {
    // Sequential rather than parallel, deliberately: these hit the same free
    // Overpass mirrors, and two concurrent city-scale queries from one address
    // is how you get rate-limited by a service that is doing us a favour.
    // All five mirrors, not the single endpoint named on the region: a 504 from
    // the busiest mirror must not take a whole drafted city down.
    const sites = await fetchOsmRelief(
      region,
      today,
      OVERPASS_ATTEMPTS,
      OVERPASS_ENDPOINTS,
      OVERPASS_BACKOFF_MS,
    );
    const clause = overpassBboxClause(bbox);
    const roads = await fetchRoadWays(clause, OVERPASS_ATTEMPTS, OVERPASS_BACKOFF_MS);
    const green = await fetchGreenWays(clause, OVERPASS_ATTEMPTS, OVERPASS_BACKOFF_MS);

    const inFocus = sites.filter(
      (s) => s.lon >= bbox[0] && s.lon <= bbox[2] && s.lat >= bbox[1] && s.lat <= bbox[3],
    );

    relief = {
      source: 'osm',
      sourceLabel: region.relief.label,
      endpoint: region.relief.endpoint,
      attribution: region.relief.attribution,
      fetchedAt: new Date().toISOString(),
      totalCount: sites.length,
      focusCount: inFocus.length,
      withKnownHours: sites.filter((s) => s.hoursKnown || s.open24).length,
      sites,
    };

    roadDensity = {
      schema: 'coolroute.roaddensity.v2' as const,
      regionId: region.id,
      granularityM: GRANULARITY_M,
      source: 'osm',
      endpoint: region.relief.endpoint,
      attribution: 'Data (c) OpenStreetMap contributors, ODbL, via Overpass API.',
      fetchedAt: new Date().toISOString(),
      roadWayCount: roads.length,
      greenWayCount: green.length,
      tiles: buildRoadDensityTiles(region, roads, green),
    };
  } catch (err) {
    // Overpass being down is the single most likely failure here, and it is
    // neither this app's fault nor the user's. Say which service failed.
    return NextResponse.json(
      {
        error:
          'OpenStreetMap (Overpass) did not answer for that area. It is a free shared ' +
          'service and this is usually temporary - try again in a minute.',
        detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
      },
      { status: 502 },
    );
  }

  const payload: DraftPayload = {
    regions: REGIONS.map((r) => ({
      id: r.id,
      name: r.name,
      subtitle: r.subtitle,
      blurb: r.blurb,
      workforce: r.workforce,
      reliefQuality: r.relief.dataQuality,
      reliefLabel: r.relief.label,
      tileCount: r.tiles.length,
      areaMi2: Number(r.tiles.reduce((a, t) => a + tileAreaMi2(t.bbox), 0).toFixed(1)),
    })),
    region: {
      id: region.id,
      origin: 'draft',
      name: region.name,
      subtitle: region.subtitle,
      blurb: region.blurb,
      workforce: region.workforce,
      center: region.center,
      bbox,
      // No manifest exists, so day 0 is simply today in the area's own local
      // time. The field endpoint is handed this date rather than choosing one,
      // so the two cannot drift the way they once did for curated regions.
      snapshotDate: today,
      comparabilityKey: comparabilityKey(region),
    },
    granularityM: GRANULARITY_M,
    cellRiskBands: CELL_RISK_BANDS,
    tiles: region.tiles.map((t) => ({
      ...t,
      areaMi2: Number(tileAreaMi2(t.bbox).toFixed(1)),
    })),
    // Populated by the client as each box's field arrives from /api/draft/field.
    timeSlices: [],
    relief,
    roadDensity,
    routes: null,
    hourly: null,
    assumptions: {
      notes: ASSUMPTION_NOTES,
      thresholds: THRESHOLDS,
      movement: MOVEMENT,
      interventions: INTERVENTIONS,
    },
    unavailable: [
      {
        what: 'routes',
        why:
          'No work routes have been supplied for this area. Route-based findings - the ' +
          'longest stretch with no relief in reach, crew-hours above threshold, the ' +
          'Dispatcher and Worker views - are unavailable rather than zero.',
      },
      {
        what: 'hourly',
        why:
          'Hourly apparent-temperature profiles are sampled at route endpoints, which ' +
          'this area does not have.',
      },
      {
        what: 'ground',
        why:
          'Street-view segmentation is sampled at curated points and is not fetched for ' +
          'drafted areas.',
      },
    ],
    budget: draftBudgetStatus(),
    cached: false,
  };

  cacheContext(cacheKey, payload);
  return NextResponse.json(payload);
}

/**
 * Today's calendar date at a given UTC offset, as YYYY-MM-DD.
 *
 * The generalisation of `arizonaToday` in config.ts, which is hardcoded to -07.
 * A drafted city can be anywhere, and using the UTC date would label a field as
 * "today" during the hours when the two disagree.
 */
function localToday(utcOffset: string, now: Date = new Date()): string {
  const m = utcOffset.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return now.toISOString().slice(0, 10);
  const sign = m[1] === '-' ? -1 : 1;
  const ms = sign * (Number(m[2]) * 60 + Number(m[3])) * 60 * 1000;
  return new Date(now.getTime() + ms).toISOString().slice(0, 10);
}
