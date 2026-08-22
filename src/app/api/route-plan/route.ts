/**
 * POST /api/route-plan
 *
 * Live routing for ad-hoc trips a user enters in the Worker view (Addition 2).
 * Server-side so ORS_API_KEY never reaches the browser.
 *
 * This is the ONLY route in the app that touches the network at request time,
 * and it is deliberately off the judged demo path: the rehearsed demo uses the
 * routes committed in data/routes.json. If this endpoint degrades, the Worker
 * view says so in the UI and everything else keeps working.
 */
import { NextResponse } from 'next/server';
import { planRoute } from '@/lib/routing';
import type { LonLat } from '@/lib/types';

export const dynamic = 'force-dynamic';

function isLonLat(v: unknown): v is LonLat {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    // A swapped lat/lon pair is the most common way this endpoint gets called
    // wrong, and it fails silently by routing into the Indian Ocean rather
    // than erroring, so the ranges are checked explicitly.
    v[0] >= -180 &&
    v[0] <= 180 &&
    v[1] >= -90 &&
    v[1] <= 90
  );
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const { start, end, via, wantAlternatives } = (body ?? {}) as {
    start?: unknown;
    end?: unknown;
    via?: unknown;
    wantAlternatives?: unknown;
  };

  if (!isLonLat(start) || !isLonLat(end)) {
    return NextResponse.json(
      { error: 'start and end must be [lon, lat] pairs' },
      { status: 400 },
    );
  }
  if (via !== undefined && !isLonLat(via)) {
    return NextResponse.json(
      { error: 'via must be a [lon, lat] pair' },
      { status: 400 },
    );
  }

  const result = await planRoute({
    start,
    end,
    via: via as LonLat | undefined,
    wantAlternatives: wantAlternatives === true,
  });

  return NextResponse.json(result);
}
