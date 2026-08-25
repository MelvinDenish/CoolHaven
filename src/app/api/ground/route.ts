/**
 * GET /api/ground?region=phoenix
 *
 * Street-level and overhead segmentation for the region's sample points, from
 * FortyGuard's /v1/streetview and /v1/satellite.
 *
 * Its own endpoint rather than part of the bootstrap because it carries base64
 * imagery for a handful of points, and none of it is needed for first paint.
 * The percentages are small; the pictures are not.
 */
import { NextResponse } from 'next/server';
import { DEFAULT_REGION_ID, REGIONS, getRegion } from '@/lib/regions';
import { loadGround } from '@/lib/server/snapshot';

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

  const ground = loadGround(region.id);
  if (!ground) {
    return NextResponse.json(
      {
        error: `No ground segmentation for ${region.id}.`,
        fix: `npm run data:ground -- --region=${region.id}`,
      },
      { status: 404 },
    );
  }

  return new NextResponse(JSON.stringify(ground), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}
