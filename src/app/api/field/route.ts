/**
 * GET /api/field?ft=1&validAt=2026-08-21T15:00:00-07:00
 *
 * Serves the cached tiles for exactly one (filter_type, timestamp) pair.
 *
 * The pairing is enforced here rather than left to the client: Addendum A3
 * forbids blending historic and forecast data, and the cheapest way to keep
 * that promise is to make it impossible to ask for a mixture in the first
 * place. A request without both parameters is a 400.
 */
import { NextResponse } from 'next/server';
import { DEFAULT_REGION_ID, REGIONS, getRegion } from '@/lib/regions';
import { MissingSnapshotError, gridsFor, loadManifest } from '@/lib/server/snapshot';

// NOT force-static: a static route handler has its query string stripped at
// runtime, so `ft` and `validAt` would both arrive empty and every request
// would 400. This route is keyed entirely by its parameters.
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const ft = Number(url.searchParams.get('ft'));
  const validAt = url.searchParams.get('validAt');
  const requestedRegion = url.searchParams.get('region') ?? DEFAULT_REGION_ID;

  let region;
  try {
    region = getRegion(requestedRegion);
  } catch {
    return NextResponse.json(
      { error: `Unknown region "${requestedRegion}".`, known: REGIONS.map((r) => r.id) },
      { status: 404 },
    );
  }

  if (ft !== 1 && ft !== 3) {
    return NextResponse.json(
      { error: 'ft must be 1 (historic) or 3 (forecast)' },
      { status: 400 },
    );
  }
  if (!validAt) {
    return NextResponse.json({ error: 'validAt is required' }, { status: 400 });
  }

  try {
    const grids = gridsFor(region.id, ft, validAt);
    if (grids.length === 0) {
      const available = loadManifest(region.id)
        .grids.filter((g) => g.filterType === ft)
        .map((g) => g.validAt);
      return NextResponse.json(
        {
          error: `No cached tiles for ${region.id} filter_type ${ft} at ${validAt}.`,
          availableTimestamps: Array.from(new Set(available)),
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      regionId: region.id,
      filterType: ft,
      validAt,
      sources: Array.from(new Set(grids.map((g) => g.source))),
      grids,
    });
  } catch (err) {
    if (err instanceof MissingSnapshotError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
