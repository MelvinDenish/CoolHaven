/**
 * Credit budget empirical check - Addendum A4.
 *
 * A4 makes this a HARD PREREQUISITE for the caching-layer build, not an
 * optional check: FortyGuard does not publish a per-call credit formula, so
 * the number is established by measurement before any UI code is written
 * against the data.
 *
 * The procedure, exactly as A4 specifies it:
 *
 *   1. Submit ONE heatmap call at the smallest realistic tile and the target
 *      granularity (80-100 m).
 *   2. Record the credit consumption reported for that call.
 *   3. Multiply: credits/tile x tiles x timestamps x refresh cycles.
 *   4. Compare against the 2,000,000 allotment.
 *
 * Interpretation, also from A4: well under budget means proceed with headroom;
 * approaching the limit means drop granularity (100 -> 150 m) or cut
 * tiles/timestamps BEFORE writing UI code against the data, not after.
 *
 * Run:  npm run data:credit-probe
 */
import { loadKeys, describeKeys } from '../src/lib/keys';
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  FORECAST_DAYS,
  GRANULARITY_M,
  assertTilesWithinAoiLimit,
  gridDimsFor,
  resolveSnapshotDate,
  tileAreaMi2,
} from '../src/lib/config';
import { FortyGuardClient } from '../src/lib/fortyguard';
import { regionsFromArgv } from '../src/lib/regions';


loadEnv({ path: '.env.local' });
loadEnv();

const ALLOTMENT = 2_000_000;
/** Two weeks of refreshes at a few per day, plus room for re-runs. */
const EXPECTED_REFRESH_CYCLES = 30;
const OUT = resolve(process.cwd(), 'docs/credit-probe.json');

async function main() {
  // The probe measures ONE call, so it always uses the first requested region.
  const region = regionsFromArgv()[0];
  assertTilesWithinAoiLimit(region.tiles);

  /*
   * Batch work starts at the FIRST key. The interactive endpoints start at the
   * last, so a long backfill and a live demo do not drain the same quota.
   */
  const keyPool = loadKeys();
  const apiKey = keyPool[0]?.value;
  if (keyPool.length > 1) {
    console.log(`[${'credit-probe'}] ${describeKeys()}`);
  }
  if (!apiKey) {
    console.error(
      'FORTYGUARD_API_KEY is not set. This probe deliberately does nothing without a\n' +
        'real key: its entire purpose is to measure real credit consumption, and a\n' +
        'guessed number is worse than no number (Addendum A4).',
    );
    process.exit(1);
  }

  // Smallest tile in the focus set - A4 says start small.
  const tile = region.tiles
    .slice()
    .sort((a, b) => tileAreaMi2(a.bbox) - tileAreaMi2(b.bbox))[0];
  const { cols, rows } = gridDimsFor(tile.bbox, GRANULARITY_M);
  const date = resolveSnapshotDate(process.argv);

  console.log(
    `[probe] one call: ${tile.id}, ${tileAreaMi2(tile.bbox).toFixed(1)} mi2, ` +
      `${GRANULARITY_M} m (${cols}x${rows} = ${cols * rows} cells), filter_type 3`,
  );

  const client = new FortyGuardClient({
    apiKey,
    baseUrl: process.env.FORTYGUARD_BASE_URL?.trim() || 'https://api.fortyguard.com',
  });

  const started = Date.now();
  const result = await client.heatmap(
    // filter_type 3 is the only value this key serves; 1/2/4 return HTTP 500.
    { bbox: tile.bbox, date, filterType: 3 },
    (attempt, state) => console.log(`[probe]   poll ${attempt} -> ${state}`),
  );
  const elapsedMs = Date.now() - started;

  const perTile = result.creditsReported;
  const callsPerCycle = region.tiles.length * FORECAST_DAYS.length;
  const projection =
    perTile === null
      ? null
      : {
          creditsPerTile: perTile,
          callsPerRefreshCycle: callsPerCycle,
          refreshCycles: EXPECTED_REFRESH_CYCLES,
          projectedTotal: perTile * callsPerCycle * EXPECTED_REFRESH_CYCLES,
          allotment: ALLOTMENT,
          headroomPct: Math.round(
            (1 - (perTile * callsPerCycle * EXPECTED_REFRESH_CYCLES) / ALLOTMENT) * 100,
          ),
        };

  const payload = {
    probedAt: new Date().toISOString(),
    region: region.id,
    tile: tile.id,
    areaMi2: Number(tileAreaMi2(tile.bbox).toFixed(2)),
    granularityM: GRANULARITY_M,
    cells: cols * rows,
    filterType: 3,
    activityId: result.activityId,
    pointsReturned: result.cells.length,
    elapsedMs,
    creditsReported: perTile,
    projection,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log(`\n[probe] activity ${result.activityId} completed in ${elapsedMs} ms`);
  console.log(`[probe] points returned: ${result.cells.length}`);

  if (projection === null) {
    console.warn(
      '\n[probe] The API did not report credit consumption in its response.\n' +
        '[probe] Read the figure from the FortyGuard dashboard before and after this\n' +
        '[probe] single call and record the difference - the multiplication in A4 still\n' +
        `[probe] applies: credits x ${callsPerCycle} calls x ${EXPECTED_REFRESH_CYCLES} cycles vs ${ALLOTMENT.toLocaleString()}.`,
    );
  } else {
    console.log(
      `\n[probe] ${projection.creditsPerTile} credits/tile x ${callsPerCycle} calls x ` +
        `${EXPECTED_REFRESH_CYCLES} cycles = ${projection.projectedTotal.toLocaleString()} ` +
        `of ${ALLOTMENT.toLocaleString()} (${projection.headroomPct}% headroom)`,
    );
    if (projection.projectedTotal > ALLOTMENT * 0.6) {
      console.warn(
        '[probe] ACTION REQUIRED (A4): projected spend is close to the allotment.\n' +
          '[probe] Drop granularity to 150 m or cut tiles/timestamps BEFORE building\n' +
          '[probe] anything else against this data.',
      );
    }
  }
  console.log(`[probe] wrote ${OUT}`);
}

main().catch((err) => {
  console.error('[probe] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
