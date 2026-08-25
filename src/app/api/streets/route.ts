/**
 * GET /api/streets?region=phoenix
 *
 * Road centrelines inside the measured tiles, for the street-level readout.
 *
 * Why an endpoint rather than part of /api/bootstrap: Phoenix is ~820 KB of
 * geometry and Yuma ~340 KB, and none of it is needed until someone actually
 * probes a street. The bootstrap is on the critical path for first paint, so
 * this loads on demand and is then cached by the browser.
 *
 * No temperatures are served here, deliberately. The client samples the heat
 * field it already has, so a street readout always agrees with the day and day
 * part currently on screen instead of carrying a number baked in at build time
 * that would be wrong for every other slice.
 */
import { NextResponse } from 'next/server';
import { DEFAULT_REGION_ID, REGIONS, getRegion } from '@/lib/regions';
import { loadStreets } from '@/lib/server/snapshot';

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

  const streets = loadStreets(region.id);
  if (!streets) {
    return NextResponse.json(
      {
        error: `No street geometry for ${region.id}.`,
        fix: `npm run data:osm -- --region=${region.id}`,
      },
      { status: 404 },
    );
  }

  return new NextResponse(JSON.stringify(streets), {
    headers: {
      'content-type': 'application/geo+json; charset=utf-8',
      // Committed build-time data: safe to cache hard.
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}
