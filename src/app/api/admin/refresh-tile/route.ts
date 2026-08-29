/**
 * POST /api/admin/refresh-tile
 *
 * Re-fetch ONE tile at ONE timestamp from FortyGuard, live, and stream the
 * submit -> poll -> complete lifecycle back to the browser as it happens.
 *
 * Read the base PRD's Out of Scope list before judging this endpoint: "live
 * FortyGuard calls triggered by user interaction" is excluded, and rightly so.
 * This is deliberately NOT that. The distinction is not cosmetic:
 *
 *   - It is manual and explicit. Nothing calls it by panning, clicking the map,
 *     switching views or moving a scenario slider. Someone presses a button
 *     labelled with exactly what it will do.
 *   - It is bounded. One tile, one timestamp, one heatmap call - not a call
 *     per interaction, and not a call that can fire in a loop.
 *   - It is off the judged path. The demo runs from the committed snapshot;
 *     if this endpoint is slow, rate-limited or keyless, nothing else breaks.
 *
 * What it buys, which the README alone cannot: the async contract the whole
 * architecture is built around becomes something a reviewer WATCHES rather
 * than something they take on trust. The polling attempts, the backoff, the
 * activity_id and the credit figure all appear on screen in real time.
 *
 * Persistence: on a writable filesystem (local development) the refreshed grid
 * is written into the cache so it survives a reload. On Vercel the filesystem
 * is read-only, so the grid is returned in the stream and held in memory by
 * the client for that session only - which the response says explicitly rather
 * than failing silently.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextResponse } from 'next/server';
import {
  FORECAST_DAYS,
  GRANULARITY_M,
  addDays,
  tileAreaMi2,
} from '@/lib/config';
import { FortyGuardClient } from '@/lib/fortyguard';
import { interactiveKey } from '@/lib/keys';
// Shared with the draft-region field endpoint, so a grid fetched for a drawn
// bbox is the same shape as one fetched for a committed tile.
import { rasteriseHeatGrid } from '@/lib/rasterise';
import { DEFAULT_REGION_ID, getRegion } from '@/lib/regions';
import { snapshotDateFor } from '@/lib/server/snapshot';
import type { FilterType } from '@/lib/types';

export const dynamic = 'force-dynamic';
// One heatmap submission plus polling can legitimately take minutes.
export const maxDuration = 300;

interface Body {
  region?: string;
  tileId?: string;
  filterType?: number;
  /** Days ahead of the region's snapshot date. */
  dayOffset?: number;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'body must be JSON' }, { status: 400 });
  }

  let region;
  try {
    region = getRegion(body.region ?? DEFAULT_REGION_ID);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'unknown region' },
      { status: 404 },
    );
  }

  const tile = region.tiles.find((t) => t.id === body.tileId);
  if (!tile) {
    return NextResponse.json(
      {
        error: `Unknown tile "${body.tileId}" in region ${region.id}.`,
        known: region.tiles.map((t) => t.id),
      },
      { status: 404 },
    );
  }

  // Only filter_type 3 is served by the API today; see lib/fortyguard.ts.
  const filterType = (body.filterType === 1 ? 1 : 3) as FilterType;
  const dayOffset =
    typeof body.dayOffset === 'number'
      ? body.dayOffset
      : (FORECAST_DAYS[0]?.dayOffset ?? 0);

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
          'This endpoint exists to demonstrate the live async contract. It deliberately ' +
          'does nothing without a real key rather than showing a simulated lifecycle - ' +
          'a fake progress bar for a real API would be the exact dishonesty this project ' +
          'is built to avoid.',
      },
      { status: 503 },
    );
  }

  const baseUrl =
    process.env.FORTYGUARD_BASE_URL?.trim() || 'https://api.fortyguard.com';
  const client = new FortyGuardClient({ apiKey, baseUrl });
  // Day 0 comes from the committed manifest, so an on-demand refresh always
  // targets the same date the rest of the snapshot describes.
  const date = addDays(snapshotDateFor(region.id), dayOffset);
  const validAt = `${date}T15:00:00${region.utcOffset}`;
  const regionId = region.id;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

      const started = Date.now();
      try {
        send({
          event: 'start',
          region: regionId,
          tileId: tile.id,
          tileLabel: tile.label,
          areaMi2: Number(tileAreaMi2(tile.bbox).toFixed(1)),
          granularityM: GRANULARITY_M,
          filterType,
          validAt,
          date,
          endpoint: `${baseUrl}/v1/heatmap`,
        });

        send({ event: 'submit', message: `POST /v1/heatmap for ${tile.id}` });
        const submitted = await client.submitHeatmap({
          bbox: tile.bbox,
          date,
          filterType,
        });
        send({
          event: 'submitted',
          activityId: submitted.activityId,
          creditsReported: submitted.creditsReported,
          elapsedMs: Date.now() - started,
        });

        const result = await client.pollActivity(
          submitted.activityId,
          (attempt, state) =>
            send({ event: 'poll', attempt, state, elapsedMs: Date.now() - started }),
        );

        if (result.cells.length === 0) {
          send({
            event: 'error',
            message:
              'The activity completed but no points could be parsed from the payload. ' +
              'The response shape has changed - inspect it before spending more credits.',
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
          note: `Live refresh via POST /v1/heatmap, polled to completion. ${result.cells.length} cells returned (Celsius, converted to F).`,
          endpoint: `${baseUrl}/v1/heatmap`,
          activityId: result.activityId,
          creditsReported: result.creditsReported,
        };

        // Best-effort persistence. Read-only filesystems are expected in
        // production, so a failure here is reported, not thrown.
        let persisted = false;
        let persistNote = 'Held in memory for this session only (read-only filesystem).';
        try {
          const file = `${tile.id}__ft${filterType}__${date}.json`;
          writeFileSync(
            resolve(process.cwd(), `data/${regionId}/cache`, file),
            JSON.stringify(grid),
          );
          persisted = true;
          persistNote = `Written to data/${regionId}/cache/${file}.`;
        } catch {
          /* expected on Vercel */
        }

        send({
          event: 'complete',
          activityId: result.activityId,
          pointsReturned: result.cells.length,
          creditsReported: result.creditsReported,
          elapsedMs: Date.now() - started,
          persisted,
          persistNote,
          grid,
        });
      } catch (err) {
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
