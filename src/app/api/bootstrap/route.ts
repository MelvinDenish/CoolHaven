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
import { CELL_RISK_BANDS, GRANULARITY_M, TIME_SLICES, tileAreaMi2 } from '@/lib/config';
import { DEFAULT_REGION_ID, REGIONS, getRegion, regionBbox } from '@/lib/regions';
import {
  MissingSnapshotError,
  loadManifest,
  loadReliefSites,
  loadHourly,
  loadRoadDensity,
  loadRoutes,
} from '@/lib/server/snapshot';

export const dynamic = 'force-dynamic';

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
      // Every region, so the dropdown never drifts from the ingest config.
      regions: REGIONS.map((r) => ({
        id: r.id,
        name: r.name,
        subtitle: r.subtitle,
        blurb: r.blurb,
        workforce: r.workforce,
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
        snapshotDate: region.snapshotDate,
      },
      granularityM: GRANULARITY_M,
      cellRiskBands: CELL_RISK_BANDS,
      tiles: region.tiles.map((t) => ({
        ...t,
        areaMi2: Number(tileAreaMi2(t.bbox).toFixed(1)),
      })),
      timeSlices: TIME_SLICES,
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
