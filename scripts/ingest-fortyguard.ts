/**
 * Data Ingestion & Caching Service - base PRD section 8, FR1 / FR2 / FR3.
 *
 * This script IS the FortyGuard integration. Nothing in the running app talks
 * to FortyGuard; the app reads what this writes.
 *
 * Per region, per tile, per forecast day:
 *
 *   1. Refuse to run if any tile exceeds the AOI target (config.ts).
 *   2. Skip anything already cached. Addendum A2's operating rules are explicit
 *      that an (area, date) pair is never re-requested - credits spent twice on
 *      the same field are credits gone.
 *   3. Submit the AOI to POST /v1/heatmap, then poll GET /v1/status/{id} with
 *      exponential backoff until it completes.
 *   4. Rasterise the returned polygon cells onto the tile's lattice, classify
 *      each cell, and write a HeatGrid with full provenance.
 *   5. Write a manifest recording whether the live API was used at all.
 *
 * WHAT THE API ACTUALLY GIVES US (see src/lib/fortyguard.ts for the full
 * contract): one field per (polygon, date) with `filter_type: 3`, each cell
 * carrying min/average/max temperature in Celsius. There is no hour parameter
 * and no granularity parameter, and filter_type 1/2/4 return HTTP 500 on this
 * key. All three are limitations of the service, recorded in the manifest
 * notes rather than papered over.
 *
 * WITHOUT A KEY: the script still produces a complete, structurally identical
 * snapshot from the local model in src/lib/synthetic.ts, every grid stamped
 * `source: 'synthetic'` and the manifest `liveApiUsed: false`, which the app
 * banners. That exists so the repo runs for anyone who clones it - not to make
 * a modelled field look measured.
 *
 * Run:  npm run data:ingest
 *       npm run data:ingest -- --region=yuma
 *       npm run data:ingest -- --force        (re-request even if cached)
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  FORECAST_DAYS,
  GRANULARITY_M,
  addDays,
  assertTilesWithinAoiLimit,
  cellRiskThresholds,
  classifyCell,
  gridDimsFor,
  resolveSnapshotDate,
  tileAreaMi2,
} from '../src/lib/config';
import { FortyGuardClient, type HeatmapCell } from '../src/lib/fortyguard';
import { regionsFromArgv, type Region } from '../src/lib/regions';
import { buildSyntheticGrid } from '../src/lib/synthetic';
import type { HeatGrid, SnapshotManifest, Tile } from '../src/lib/types';

loadEnv({ path: '.env.local' });
loadEnv();

const force = process.argv.includes('--force');

interface RoadDensityFile {
  tiles: Record<string, { cols: number; rows: number; values: number[]; veg: number[] }>;
}

async function main() {
  const apiKey = process.env.FORTYGUARD_API_KEY?.trim();
  const baseUrl =
    process.env.FORTYGUARD_BASE_URL?.trim() || 'https://api.fortyguard.com';
  const client = apiKey ? new FortyGuardClient({ apiKey, baseUrl }) : null;

  if (!client) {
    console.warn(
      '\n[ingest] FORTYGUARD_API_KEY is not set.\n' +
        '[ingest] Writing a MODELLED snapshot instead. Every grid will be stamped\n' +
        "[ingest] source: 'synthetic' and the app will show a provenance banner.\n",
    );
  }

  // One date for the whole run, resolved once so every region in a multi-region
  // run describes the same day even if the run straddles local midnight.
  const snapshotDate = resolveSnapshotDate(process.argv);
  console.log(`[ingest] snapshot date: ${snapshotDate} (Arizona local)`);

  for (const region of regionsFromArgv()) {
    await ingestRegion(region, client, baseUrl, snapshotDate);
  }
}

async function ingestRegion(
  region: Region,
  client: FortyGuardClient | null,
  baseUrl: string,
  snapshotDate: string,
) {
  assertTilesWithinAoiLimit(region.tiles);
  const cacheDir = resolve(process.cwd(), `data/${region.id}/cache`);
  mkdirSync(cacheDir, { recursive: true });

  const roadPath = resolve(process.cwd(), `data/${region.id}/road-density.json`);
  const roads: RoadDensityFile | null = existsSync(roadPath)
    ? (JSON.parse(readFileSync(roadPath, 'utf8')) as RoadDensityFile)
    : null;
  if (!roads && !client) {
    throw new Error(
      `No key and no data/${region.id}/road-density.json. Run \`npm run data:osm\` first.`,
    );
  }

  const planned = region.tiles.length * FORECAST_DAYS.length;
  console.log(
    `\n[ingest:${region.id}] ${region.tiles.length} tiles x ${FORECAST_DAYS.length} forecast days = ${planned} heatmap calls`,
  );
  for (const t of region.tiles) {
    console.log(`[ingest:${region.id}]   ${t.id}: ${tileAreaMi2(t.bbox).toFixed(1)} mi2`);
  }

  /*
   * Dates this region already asked for and was told there is nothing for.
   *
   * Without this, every scheduled run re-attempts day +1: three submissions
   * that each poll for three and a half minutes before completing with zero
   * cells. At a 30-minute cadence that is ~144 pointless calls a day against a
   * finite credit budget, to re-learn a fact that has not changed.
   *
   * Keyed by (tile, date), so it expires naturally - tomorrow's day +1 is a new
   * date and gets a fresh attempt. `--force` ignores it entirely, which is the
   * escape hatch for when the horizon reopens.
   */
  const previouslyUnavailable = new Set<string>();
  const manifestPath = resolve(cacheDir, 'manifest.json');
  if (existsSync(manifestPath) && !force) {
    try {
      const prev = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
      for (const key of prev.unavailable ?? []) previouslyUnavailable.add(key);
    } catch {
      /* a corrupt manifest just means we retry everything */
    }
  }

  const grids: SnapshotManifest['grids'] = [];
  const notes: string[] = [];
  let liveCount = 0;
  /**
   * Grids this run actually pulled over the wire.
   *
   * Distinct from liveCount, which also counts grids found already cached with
   * source 'fortyguard'. Conflating the two is what let 24 commits announce
   * "refresh snapshot (liveApiUsed=true)" while nothing had been fetched.
   */
  let fetchedCount = 0;
  let creditsSpent = 0;
  /** Real errors: HTTP failures, timeouts, malformed payloads. */
  const failures: string[] = [];
  /** (tile, date) pairs the API completed but had no data for - a horizon limit. */
  const unavailable: string[] = [];

  for (const tile of region.tiles) {
    for (const day of FORECAST_DAYS) {
      const date = addDays(snapshotDate, day.dayOffset);
      // Nominal mid-afternoon stamp. The API's field is daily; the hour here is
      // presentational only and the UI never claims otherwise.
      const validAt = `${date}T15:00:00${region.utcOffset}`;
      const file = `${tile.id}__ft${day.filterType}__${date}.json`;
      const path = resolve(cacheDir, file);

      if (existsSync(path) && !force) {
        const cached = JSON.parse(readFileSync(path, 'utf8')) as HeatGrid;
        console.log(`[ingest:${region.id}] cached   ${file} (${cached.source})`);
        grids.push(entry(file, cached));
        if (cached.source === 'fortyguard') liveCount++;
        continue;
      }

      const unavailableKey = `${tile.id}|${date}`;
      if (previouslyUnavailable.has(unavailableKey)) {
        console.log(
          `[ingest:${region.id}] skip     ${tile.id} ${date} (no data on a previous run)`,
        );
        unavailable.push(unavailableKey);
        continue;
      }

      const { cols, rows } = gridDimsFor(tile.bbox, GRANULARITY_M);
      let grid: HeatGrid | null = null;

      if (client) {
        try {
          console.log(
            `[ingest:${region.id}] submit   ${tile.id} ${date} ft=${day.filterType}`,
          );
          const result = await client.heatmap(
            { bbox: tile.bbox, date, filterType: day.filterType },
            (attempt, state) =>
              process.stdout.write(
                `\r[ingest:${region.id}]   poll ${attempt} -> ${state}    `,
              ),
          );
          process.stdout.write('\n');

          if (result.cells.length === 0) {
            // Not an error: the activity completed, the service simply has
            // nothing for this date. Recorded as a horizon limit, not a fault,
            // so it does not block pruning the way a real failure should.
            process.stdout.write('\n');
            console.warn(
              `[ingest:${region.id}] no data   ${tile.id} ${date} (completed, zero cells)`,
            );
            unavailable.push(unavailableKey);
            continue;
          }

          grid = rasterise({
            region,
            tile,
            cols,
            rows,
            cells: result.cells,
            filterType: day.filterType,
            validAt,
            date,
          });
          grid.provenance = {
            note:
              `FortyGuard POST /v1/heatmap, polled to completion. ` +
              `${result.cells.length} cells returned (Celsius, converted to F).` +
              (result.stats
                ? ` API stats: ${result.stats.minF.toFixed(1)}-${result.stats.maxF.toFixed(1)} degF, mean ${result.stats.meanF.toFixed(1)}.`
                : ''),
            endpoint: `${baseUrl}/v1/heatmap`,
            activityId: result.activityId,
            creditsReported: result.creditsReported,
          };
          creditsSpent += result.creditsReported ?? 0;
          liveCount++;
          fetchedCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stdout.write('\n');
          console.warn(`[ingest:${region.id}] LIVE FAILED ${tile.id} ${date}: ${msg}`);
          failures.push(`${tile.id} ${date}: ${msg}`);
        }
      }

      /*
       * A day the API cannot serve is DROPPED, not modelled.
       *
       * The forecast horizon moves: day +1 currently completes and returns zero
       * parseable cells (it used to return data, and +2 used to 500). When that
       * happens with a working key, substituting a synthetic grid would quietly
       * mix a modelled field into a live snapshot and hand the day-part selector
       * an invented day - which is precisely what FR17 forbids.
       *
       * The modelled fallback still exists, but only for its actual purpose:
       * letting someone who clones the repo with NO key run the app end to end.
       */
      if (!grid && client) {
        console.warn(
          `[ingest:${region.id}] dropping ${tile.id} ${date} - the API served no data for it.`,
        );
        continue;
      }

      if (!grid) {
        // No key at all. Fall back to the model rather than leaving a hole in
        // the field - and stamp it so it cannot be mistaken for measurement.
        const rd = roads?.tiles[tile.id];
        if (!rd || rd.cols !== cols || rd.rows !== rows) {
          throw new Error(
            `road-density.json does not match the grid for ${tile.id} ` +
              `(have ${rd?.cols}x${rd?.rows}, need ${cols}x${rows}). Re-run \`npm run data:osm\`.`,
          );
        }
        grid = buildSyntheticGrid({
          region,
          tile,
          cols,
          rows,
          roadNorm: rd.values,
          vegNorm: rd.veg,
          dayOffset: day.dayOffset,
          filterType: day.filterType,
          granularityM: GRANULARITY_M,
          validAt,
          date,
          fetchedAt: new Date().toISOString(),
        });
        console.log(`[ingest:${region.id}] modelled ${file}`);
      }

      writeFileSync(path, JSON.stringify(grid));
      grids.push(entry(file, grid));
    }
  }

  if (liveCount > 0) {
    notes.push(
      `Snapshot date ${snapshotDate}. ${liveCount} of ${grids.length} grids are FortyGuard data; ` +
        `${fetchedThisRunLabel(fetchedCount, grids.length)}.`,
    );
    notes.push(
      creditsSpent > 0
        ? `Credits reported by the API for this run: ${creditsSpent}.`
        : 'The API does not report credit consumption in its response payload.',
    );
    notes.push(
      'Temperatures arrive in Celsius and are converted to Fahrenheit at the client boundary.',
    );
  }
  if (liveCount < grids.length) {
    notes.push(
      `${grids.length - liveCount} grid(s) are MODELLED stand-ins from coolroute-uhi-v1, ` +
        'not measurements. The app banners this.',
    );
  }
  notes.push(
    'API limitation: only filter_type 3 (forecast) succeeds on this key; 1, 2 and 4 ' +
      'return HTTP 500. The historic/forecast separation is still enforced in code.',
  );
  notes.push(
    'API limitation: no hour-of-day parameter exists, so slices are forecast DAYS. ' +
      'Intra-day variation comes from the min/average/max each cell carries.',
  );
  if (unavailable.length) {
    notes.push(
      `The API completed but returned no data for: ${unavailable.join(', ')}. ` +
        'Those days are omitted from the snapshot rather than filled with a modelled ' +
        'stand-in, so the day selector only offers days the service actually served.',
    );
  }
  if (failures.length) notes.push(`Failed calls this run: ${failures.join(' | ')}`);

  /*
   * Prune grids the snapshot no longer describes.
   *
   * With a rolling date, yesterday's files would otherwise pile up forever, and
   * they are not free: loadGrids() in the server snapshot loader reads and
   * parses EVERY file in this directory on each cold start, and next.config.mjs
   * traces all of data/ into every serverless function. An archive nothing can
   * reach - the UI's forecast-day selector only ever offers the dates below -
   * would be pure cost.
   *
   * Guarded deliberately: only prune when this run wrote a complete, live set.
   * A partial or fallback run keeps whatever was already on disk, so a failed
   * refresh degrades to "yesterday's real data" rather than deleting good grids
   * and leaving a hole.
   */
  const keepFiles = new Set(grids.map((g) => g.file));
  let pruned = 0;
  /*
   * Completeness is "every tile has the snapshot day", not "every planned call
   * succeeded". Those differ because the forecast horizon moves: if the API has
   * no day +1 this week, day +1 is legitimately absent and must not block the
   * prune forever - but a MISSING TILE on day 0 leaves a hole in the field, and
   * then yesterday's grids are the better thing to keep.
   */
  const dayZeroTiles = new Set(
    grids.filter((g) => g.validAt.startsWith(snapshotDate)).map((g) => g.tileId),
  );
  // Note what is deliberately NOT in this condition: `failures.length === 0`.
  // A failure on a day that gets dropped anyway - day +1 currently 404s or
  // returns nothing - says nothing about whether day 0 is good, and gating on
  // it meant a complete, fully live snapshot never pruned its predecessors.
  const completeAndLive =
    dayZeroTiles.size === region.tiles.length &&
    grids.length > 0 &&
    liveCount === grids.length;
  if (completeAndLive) {
    for (const file of readdirSync(cacheDir)) {
      if (!file.endsWith('.json') || file === 'manifest.json') continue;
      if (keepFiles.has(file)) continue;
      unlinkSync(resolve(cacheDir, file));
      pruned++;
    }
    if (pruned > 0) {
      console.log(`[ingest:${region.id}] pruned ${pruned} grid(s) outside ${snapshotDate}..`);
      notes.push(
        `Pruned ${pruned} grid file(s) describing dates outside this snapshot. ` +
          'The cache holds only the dates the UI can reach.',
      );
    }
  } else if (grids.length !== planned || failures.length > 0) {
    notes.push(
      'Incomplete or fallback run: older grid files were NOT pruned, so the ' +
        'previous snapshot stays on disk rather than leaving a gap.',
    );
  }

  const manifest: SnapshotManifest = {
    schema: 'coolroute.manifest.v2',
    regionId: region.id,
    snapshotDate,
    generatedAt: new Date().toISOString(),
    // Every grid, not merely one. types.ts documents this flag as "true when
    // every grid in the snapshot has source === 'fortyguard'", and the UI turns
    // its provenance bar green on the strength of it - so a snapshot that is
    // half modelled must not set it.
    liveApiUsed: grids.length > 0 && liveCount === grids.length,
    /** How many grids this run actually fetched, as opposed to found cached. */
    fetchedThisRun: fetchedCount,
    unavailable,
    sources: Array.from(new Set(grids.map((g) => g.source))),
    grids,
    notes,
  };
  writeFileSync(resolve(cacheDir, 'manifest.json'), JSON.stringify(manifest, null, 1));

  console.log(
    `[ingest:${region.id}] ${grids.length} grids for ${snapshotDate} | live=${liveCount} | ` +
      `fetched this run=${fetchedCount} | pruned=${pruned} | liveApiUsed=${manifest.liveApiUsed}`,
  );
}

/** Says plainly whether anything came over the wire, for the manifest notes. */
function fetchedThisRunLabel(fetched: number, total: number): string {
  if (fetched === 0) return 'none were fetched this run, every grid was already cached';
  if (fetched === total) return `all ${fetched} were fetched this run`;
  return `${fetched} of them were fetched this run, the rest were already cached`;
}

/**
 * Rasterise returned cells onto our lattice.
 *
 * The API returns its own polygon cells at its own resolution, close to but
 * not identical with ours. Cells are averaged into whichever of our cells
 * their centroid lands in; anything uncovered is filled from its nearest
 * covered neighbours, expanding ring by ring, so the field has no holes.
 */
function rasterise(args: {
  region: Region;
  tile: Tile;
  cols: number;
  rows: number;
  cells: HeatmapCell[];
  filterType: 1 | 3;
  validAt: string;
  date: string;
}): HeatGrid {
  const { region, tile, cols, rows, cells, filterType, validAt, date } = args;
  const n = cols * rows;
  const sum = new Float64Array(n);
  const sumMin = new Float64Array(n);
  const sumMax = new Float64Array(n);
  const count = new Int32Array(n);

  const dLon = (tile.bbox[2] - tile.bbox[0]) / cols;
  const dLat = (tile.bbox[3] - tile.bbox[1]) / rows;

  for (const c of cells) {
    const cx = Math.floor((c.lon - tile.bbox[0]) / dLon);
    const ry = Math.floor((c.lat - tile.bbox[1]) / dLat);
    if (cx < 0 || ry < 0 || cx >= cols || ry >= rows) continue;
    const i = ry * cols + cx;
    sum[i] += c.tempF;
    sumMin[i] += c.minTempF;
    sumMax[i] += c.maxTempF;
    count[i] += 1;
  }

  const tempsF = new Array<number>(n);
  const tempsMinF = new Array<number>(n);
  const tempsMaxF = new Array<number>(n);
  const missing: number[] = [];

  for (let i = 0; i < n; i++) {
    if (count[i] > 0) {
      tempsF[i] = round1(sum[i] / count[i]);
      tempsMinF[i] = round1(sumMin[i] / count[i]);
      tempsMaxF[i] = round1(sumMax[i] / count[i]);
    } else {
      missing.push(i);
    }
  }
  if (missing.length === n) throw new Error('no returned cell fell inside the tile bbox');

  for (const idx of missing) {
    const r0 = Math.floor(idx / cols);
    const c0 = idx % cols;
    let filled = false;
    for (let radius = 1; radius < Math.max(cols, rows) && !filled; radius++) {
      let a = 0;
      let mn = 0;
      let mx = 0;
      let k = 0;
      for (let r = r0 - radius; r <= r0 + radius; r++) {
        for (let c = c0 - radius; c <= c0 + radius; c++) {
          if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
          const j = r * cols + c;
          if (count[j] > 0) {
            a += sum[j] / count[j];
            mn += sumMin[j] / count[j];
            mx += sumMax[j] / count[j];
            k++;
          }
        }
      }
      if (k > 0) {
        tempsF[idx] = round1(a / k);
        tempsMinF[idx] = round1(mn / k);
        tempsMaxF[idx] = round1(mx / k);
        filled = true;
      }
    }
  }

  return {
    schema: 'coolroute.heatgrid.v3',
    regionId: region.id,
    tileId: tile.id,
    filterType,
    validAt,
    date,
    granularityM: GRANULARITY_M,
    bbox: tile.bbox,
    cols,
    rows,
    unit: 'F',
    source: 'fortyguard',
    fetchedAt: new Date().toISOString(),
    provenance: { note: 'set by caller' },
    tempsF,
    tempsMinF,
    tempsMaxF,
    riskBands: tempsF.map(classifyCell),
    riskThresholds: cellRiskThresholds(),
  };
}

function entry(file: string, g: HeatGrid): SnapshotManifest['grids'][number] {
  return {
    file,
    tileId: g.tileId,
    filterType: g.filterType,
    validAt: g.validAt,
    source: g.source,
    granularityM: g.granularityM,
  };
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}

main().catch((err) => {
  console.error('\n[ingest] FAILED:', err instanceof Error ? err.message : err);
  console.error('[ingest] Any previously cached grids are untouched.');
  process.exit(1);
});
