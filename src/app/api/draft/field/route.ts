/**
 * POST /api/draft/field
 *
 * Fetch ONE drawn box's temperature field from FortyGuard, live, streaming the
 * submit -> poll -> complete lifecycle exactly as /api/admin/refresh-tile does.
 *
 * WHY THIS IS A SEPARATE ROUTE, NOT A FLAG ON refresh-tile
 *
 * refresh-tile is safe unauthenticated because of a property it has and this
 * one cannot: it can only address the twelve tiles declared in REGIONS. A
 * bounded set is a bounded spend. Here the caller supplies the box, so the
 * bound has to be re-established explicitly - area cap, per-IP rate limit,
 * per-instance daily ceiling, and a result cache so the same box never costs
 * twice. Keeping them in a separate file means the demo path stays exactly as
 * it was and every control lives in one obvious place.
 *
 * The caps are enforced in src/lib/server/draft-guard.ts, including an honest
 * note about what module-scope counters can and cannot guarantee on a
 * serverless platform.
 *
 * The grid is returned in the stream and held in memory by the client for that
 * session, the same way refresh-tile behaves on a read-only filesystem. Nothing
 * a drafted region produces is ever written to disk.
 */
import { NextResponse } from 'next/server';
import { GRANULARITY_M, TILE_TARGET_MAX_MI2, tileAreaMi2 } from '@/lib/config';
import { FortyGuardClient } from '@/lib/fortyguard';
import { interactiveKey } from '@/lib/keys';
import { rasteriseHeatGrid } from '@/lib/rasterise';
import {
  DraftLimitError,
  cacheGrid,
  cachedGrid,
  chargeLiveCall,
  clientIp,
  draftBudgetStatus,
  refundLiveCall,
} from '@/lib/server/draft-guard';
import type { FilterType, Tile } from '@/lib/types';

export const dynamic = 'force-dynamic';
// One heatmap submission plus polling can legitimately take minutes.
export const maxDuration = 300;

interface Body {
  /** The drawn box, [minLon, minLat, maxLon, maxLat]. */
  bbox?: [number, number, number, number];
  /** Which box this is within the draft, for labelling only. */
  tileId?: string;
  regionId?: string;
  /** Day 0 for this draft, as handed out by /api/draft/bootstrap. */
  date?: string;
  utcOffset?: string;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  const bbox = body.bbox;
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    !bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
  ) {
    return NextResponse.json(
      { error: 'bbox must be [minLon, minLat, maxLon, maxLat].' },
      { status: 400 },
    );
  }

  const area = tileAreaMi2(bbox);
  if (area > TILE_TARGET_MAX_MI2) {
    return NextResponse.json(
      {
        error:
          `That box is ${area.toFixed(1)} mi2, over the ${TILE_TARGET_MAX_MI2} mi2 limit ` +
          'a single temperature request can cover.',
        areaMi2: Number(area.toFixed(1)),
        limitMi2: TILE_TARGET_MAX_MI2,
      },
      { status: 400 },
    );
  }

  const date = body.date?.trim();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: 'date must be YYYY-MM-DD, as returned by /api/draft/bootstrap.' },
      { status: 400 },
    );
  }

  const utcOffset = /^[+-]\d{2}:\d{2}$/.test(body.utcOffset ?? '')
    ? (body.utcOffset as string)
    : '+00:00';
  const regionId = body.regionId?.trim() || 'draft';
  const tile: Tile = {
    id: body.tileId?.trim() || 'box-1',
    label: 'Drawn box',
    bbox,
    blurb: 'Drawn by hand in the browser.',
  };

  // Only filter_type 3 is served by the API today; see lib/fortyguard.ts.
  const filterType: FilterType = 3;
  const validAt = `${date}T15:00:00${utcOffset}`;

  /*
   * The cache key is the BOX, not the draft, and coordinates are rounded to
   * about 10 m before hashing. Two people drawing "downtown" a few metres apart
   * should not each pay for a field, and the difference is far below the 100 m
   * grid anyway.
   */
  const cacheKey = [bbox.map((n) => n.toFixed(4)).join(','), date, filterType].join('|');

  const hit = cachedGrid(cacheKey);
  if (hit) {
    return NextResponse.json({
      event: 'cached',
      grid: { ...hit, regionId, tileId: tile.id },
      note:
        "Served from this instance's cache - the same box and date was already fetched, " +
        'so no new API call was made and no credit was spent.',
      budget: draftBudgetStatus(),
    });
  }

  /*
   * Interactive traffic takes the LAST key in the pool, so a demo cannot be
   * killed by a backfill that drained the first one. With a single key
   * configured this resolves to exactly the same key as before.
   */
  const key = interactiveKey();
  const apiKey = key?.value;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: 'No FortyGuard API key is configured on the server.',
        detail:
          'Drafted areas need a live temperature request, and this deployment has no ' +
          'key. The curated cities are unaffected: they run from a committed snapshot ' +
          'and make no live calls at all.',
      },
      { status: 503 },
    );
  }

  const ip = clientIp(req);
  try {
    chargeLiveCall(ip);
  } catch (err) {
    if (err instanceof DraftLimitError) {
      return NextResponse.json(
        { error: err.message, budget: draftBudgetStatus() },
        { status: err.status },
      );
    }
    throw err;
  }

  const baseUrl = process.env.FORTYGUARD_BASE_URL?.trim() || 'https://api.fortyguard.com';
  const client = new FortyGuardClient({ apiKey, baseUrl });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      const started = Date.now();
      let reachedApi = false;
      try {
        send({
          event: 'start',
          region: regionId,
          tileId: tile.id,
          tileLabel: tile.label,
          areaMi2: Number(area.toFixed(1)),
          granularityM: GRANULARITY_M,
          filterType,
          validAt,
          date,
          endpoint: `${baseUrl}/v1/heatmap`,
          budget: draftBudgetStatus(),
        });

        send({
          event: 'submit',
          message: `POST /v1/heatmap for a ${area.toFixed(1)} mi2 box`,
        });
        reachedApi = true;
        const submitted = await client.submitHeatmap({ bbox, date, filterType });
        send({
          event: 'submitted',
          activityId: submitted.activityId,
          creditsReported: submitted.creditsReported,
          elapsedMs: Date.now() - started,
        });

        const result = await client.pollActivity(submitted.activityId, (attempt, state) =>
          send({ event: 'poll', attempt, state, elapsedMs: Date.now() - started }),
        );

        if (result.cells.length === 0) {
          /*
           * A completed activity with no cells is the API's horizon limit, not
           * a fault - every committed manifest carries examples of it. For a
           * drafted area it usually means the date has not been published yet,
           * or the box is outside the service's coverage, which is US-only.
           */
          send({
            event: 'empty',
            message:
              'The request completed but returned no data for that area and date. ' +
              'FortyGuard covers the United States, and the current day is not always ' +
              'published yet - both look identical from here, which is why this says ' +
              'what happened rather than guessing why.',
          });
          controller.close();
          return;
        }

        const grid = rasteriseHeatGrid(
          regionId,
          tile,
          result.cells,
          filterType,
          validAt,
          date,
        );
        grid.provenance = {
          note:
            `Live request via POST /v1/heatmap for a user-drawn ${area.toFixed(1)} mi2 ` +
            `box, polled to completion. ${result.cells.length} cells returned (Celsius, ` +
            'converted to F).',
          endpoint: `${baseUrl}/v1/heatmap`,
          activityId: result.activityId,
          creditsReported: result.creditsReported,
        };

        cacheGrid(cacheKey, grid);

        send({
          event: 'complete',
          activityId: result.activityId,
          pointsReturned: result.cells.length,
          creditsReported: result.creditsReported,
          elapsedMs: Date.now() - started,
          persisted: false,
          persistNote:
            'Held in memory for this session. Drafted areas are never written to the ' +
            'repository - the definition lives in the URL and the data re-derives.',
          budget: draftBudgetStatus(),
          grid,
        });
      } catch (err) {
        // A failure before the request left the building did not consume a
        // credit, so it should not consume a slot in the budget either.
        if (!reachedApi) refundLiveCall(ip);
        send({
          event: 'error',
          message: err instanceof Error ? err.message : String(err),
          elapsedMs: Date.now() - started,
        });
      } finally {
        controller.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      // Without this a proxy may buffer the whole stream and defeat the point.
      'x-accel-buffering': 'no',
    },
  });
}
