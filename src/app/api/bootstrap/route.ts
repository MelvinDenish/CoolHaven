/**
 * GET /api/bootstrap?region=phoenix
 *
 * One payload with everything the app needs to render a region before the user
 * touches anything: the snapshot manifest (including its provenance), the tile
 * definitions, the real relief-network sites, the pre-resolved work routes, the
 * road weights the demand layer needs, and the assumption strings the UI is
 * required to display.
 *
 * It also returns the full region list, so the region dropdown is populated
 * from the same source of truth the ingestion scripts use rather than from a
 * duplicated list in the client.
 *
 * The heat grids are NOT in here - they are fetched per field from /api/field
 * so switching between historic and forecast does not re-download everything.
 */
import { NextResponse } from 'next/server';
import {
  ASSUMPTION_NOTES,
  INTERVENTIONS,
  MOVEMENT,
  THRESHOLDS,
} from '@/lib/assumptions';
import {
  CELL_RISK_BANDS,
  GRANULARITY_M,
  TIME_SLICES,
  addDays,
  tileAreaMi2,
} from '@/lib/config';
import { DEFAULT_REGION_ID, REGIONS, getRegion, regionBbox } from '@/lib/regions';
import {
  MissingSnapshotError,
  loadManifest,
  loadReliefSites,
  loadHourly,
  loadRoadDensity,
  loadRoutes,
  snapshotDateFor,
} from '@/lib/server/snapshot';

export const dynamic = 'force-dynamic';

/**
 * The forecast days this region's committed snapshot can actually serve.
 *
 * Keeps the labels and filter types from config while dropping any day with no
 * grids behind it, so the Dispatcher and Worker day selectors only ever offer
 * something /api/field can answer.
 */
/** True when a region has enough committed data to actually render. */
function hasSnapshot(region: { id: string }): boolean {
  try {
    loadManifest(region.id);
    loadReliefSites(region.id);
    loadRoutes(region.id);
    return true;
  } catch {
    return false;
  }
}

function availableSlices(regionId: string) {
  const manifest = loadManifest(regionId);
  const day0 = snapshotDateFor(regionId);
  return TIME_SLICES.filter((slice) => {
    const date = addDays(day0, slice.dayOffset);
    return manifest.grids.some(
      (g) => g.filterType === slice.filterType && g.validAt.startsWith(date),
    );
  });
}

export async function GET(req: Request) {
  const requested = new URL(req.url).searchParams.get('region') ?? DEFAULT_REGION_ID;

  let region;
  try {
    region = getRegion(requested);
  } catch {
    return NextResponse.json(
      { error: `Unknown region "${requested}".`, known: REGIONS.map((r) => r.id) },
      { status: 404 },
    );
  }

  try {
    const manifest = loadManifest(region.id);
    const sitesFile = loadReliefSites(region.id);
    const routesFile = loadRoutes(region.id);

    return NextResponse.json({
      /*
       * Only regions with a committed snapshot behind them.
       *
       * REGIONS is the ingest configuration - a region can legitimately exist
       * there before its data has been generated. Listing those in the dropdown
       * offers the user a city that answers 503 the moment they pick it, which
       * looks like a broken app rather than an unbuilt one.
       */
      regions: REGIONS.filter(hasSnapshot).map((r) => ({
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
        name: region.name,
        subtitle: region.subtitle,
        blurb: region.blurb,
        workforce: region.workforce,
        center: region.center,
        bbox: regionBbox(region),
        // From the manifest, not from config: the client derives every
        // /api/field request from this, so it has to be what was ingested.
        snapshotDate: snapshotDateFor(region.id),
      },
      granularityM: GRANULARITY_M,
      cellRiskBands: CELL_RISK_BANDS,
      tiles: region.tiles.map((t) => ({
        ...t,
        areaMi2: Number(tileAreaMi2(t.bbox).toFixed(1)),
      })),
      // Only the days this snapshot actually has grids for.
      //
      // FORECAST_DAYS is what the ingest ATTEMPTS; the API's horizon moves, and
      // a day it served last week may return nothing this week. Advertising the
      // static list would put a "Next day" button on screen that answers 404.
      timeSlices: availableSlices(region.id),
      manifest,
      relief: {
        source: sitesFile.source,
        sourceLabel: sitesFile.sourceLabel,
        endpoint: sitesFile.endpoint,
        attribution: sitesFile.attribution,
        fetchedAt: sitesFile.fetchedAt,
        totalCount: sitesFile.totalCount,
        focusCount: sitesFile.focusCount,
        withKnownHours: sitesFile.withKnownHours,
        sites: sitesFile.sites,
      },
      routes: {
        provider: routesFile.provider,
        generatedAt: routesFile.generatedAt,
        note: routesFile.note,
        list: routesFile.routes,
        workerDemo: routesFile.workerDemo,
      },
      // The demand layer (FR7) is computed in the browser so a scenario
      // recomputes without a round trip, which means the road weights have to
      // travel with the bootstrap.
      hourly: loadHourly(region.id),
      roadDensity: loadRoadDensity(region.id),
      assumptions: {
        notes: ASSUMPTION_NOTES,
        thresholds: THRESHOLDS,
        movement: MOVEMENT,
        interventions: INTERVENTIONS,
      },
    });
  } catch (err) {
    if (err instanceof MissingSnapshotError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
