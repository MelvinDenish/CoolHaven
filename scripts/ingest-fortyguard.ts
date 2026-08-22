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
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import {
  ARIZONA_UTC_OFFSET,
  FORECAST_DAYS,
  GRANULARITY_M,
  addDays,
  assertTilesWithinAoiLimit,
  cellRiskThresholds,
  classifyCell,
  gridDimsFor,
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

  for (const region of regionsFromArgv()) {
    await ingestRegion(region, client, baseUrl);
  }
}

async function ingestRegion(
  region: Region,
  client: FortyGuardClient | null,
  baseUrl: string,
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

  const grids: SnapshotManifest['grids'] = [];
  const notes: string[] = [];
  let liveCount = 0;
  let creditsSpent = 0;
  const failures: string[] = [];

  for (const tile of region.tiles) {
    for (const day of FORECAST_DAYS) {
      const date = addDays(region.snapshotDate, day.dayOffset);
      // Nominal mid-afternoon stamp. The API's field is daily; the hour here is
      // presentational only and the UI never claims otherwise.
      const validAt = `${date}T15:00:00${ARIZONA_UTC_OFFSET}`;
      const file = `${tile.id}__ft${day.filterType}__${date}.json`;
      const path = resolve(cacheDir, file);

      if (existsSync(path) && !force) {
        const cached = JSON.parse(readFileSync(path, 'utf8')) as HeatGrid;
        console.log(`[ingest:${region.id}] cached   ${file} (${cached.source})`);
        grids.push(entry(file, cached));
        if (cached.source === 'fortyguard') liveCount++;
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
            throw new Error('completed but returned no parseable cells');
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
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          process.stdout.write('\n');
          console.warn(`[ingest:${region.id}] LIVE FAILED ${tile.id} ${date}: ${msg}`);
          failures.push(`${tile.id} ${date}: ${msg}`);
        }
      }

      if (!grid) {
        // Either no key, or the live call failed. Fall back to the model rather
        // than leaving a hole in the field - and stamp it so it cannot be
        // mistaken for measurement.
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
      `Live FortyGuard ingest: ${liveCount} of ${grids.length} grids fetched from the API.`,
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
  if (failures.length) notes.push(`Failed calls this run: ${failures.join(' | ')}`);

  const manifest: SnapshotManifest = {
    schema: 'coolroute.manifest.v2',
    regionId: region.id,
    generatedAt: new Date().toISOString(),
    liveApiUsed: liveCount > 0,
    sources: Array.from(new Set(grids.map((g) => g.source))),
    grids,
    notes,
  };
  writeFileSync(resolve(cacheDir, 'manifest.json'), JSON.stringify(manifest, null, 1));

  console.log(
    `[ingest:${region.id}] wrote ${grids.length} grids | live=${liveCount} | liveApiUsed=${manifest.liveApiUsed}`,
  );
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
