/**
 * GET /api/context?region=phoenix
 *
 * Park, vegetation and water polygons for the region, drawn as an optional map
 * layer.
 *
 * Why this is worth an endpoint rather than folding into /api/bootstrap: it is
 * roughly half a megabyte of geometry that only matters once someone turns the
 * layer on, and the bootstrap is on the critical path for first paint.
 *
 * Why it is worth having at all: the cool patches in the heat field are
 * otherwise unexplained. Turning this layer on shows that the blue smudge in
 * midtown is Encanto Park and the cool band across Somerton is irrigated
 * farmland - which is also the honest way to show that the model's vegetation
 * term is doing real work rather than inventing texture.
 */
import { NextResponse } from 'next/server';
import { DEFAULT_REGION_ID, REGIONS, getRegion } from '@/lib/regions';
import { loadOsmContext } from '@/lib/server/snapshot';

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

  const context = loadOsmContext(region.id);
  if (!context) {
    return NextResponse.json(
      {
        error: `No context layer for ${region.id}.`,
        fix: `npm run data:osm -- --region=${region.id}`,
      },
      { status: 404 },
    );
  }

  return new NextResponse(JSON.stringify(context), {
    headers: {
      'content-type': 'application/geo+json; charset=utf-8',
      // Committed build-time data: safe to cache hard.
      'cache-control': 'public, max-age=3600, stale-while-revalidate=86400',
    },
  });
}
