/**
 * Hourly environmental profiles from `POST /v1/env_params` (Addendum A2,
 * priority High) - and the single most useful thing in the whole API.
 *
 * WHAT THIS ENDPOINT ACTUALLY IS. Not "give me the temperature here". It takes
 * a dry-bulb temperature as INPUT - the value we already hold from the heatmap
 * grid - and returns a derived environmental profile for that point:
 *
 *     apparent temperature   heat index      wet-bulb temperature
 *     relative humidity      cloud cover     air quality (PM2.5, O3, NO2, ...)
 *
 * as **24 hourly values each**.
 *
 * That matters more than it sounds. `/v1/heatmap` has no hour parameter at all
 * - `hour` and `start_time` are accepted and ignored - so this is the only
 * place in the API where genuine intra-day resolution exists. It is per-point
 * rather than per-grid, which is exactly the shape base PRD FR17 wants:
 * "should this run go at 6 AM or 3 PM" is a question about one route, not
 * about a whole field.
 *
 * Why apparent temperature rather than the raw grid value: it is what a body
 * experiences. In Phoenix on the snapshot day the dry-bulb average is a flat
 * 100 degF across the district, while apparent temperature at a downtown point
 * swings from the low 90s overnight to the low 110s mid-afternoon. The second
 * number is the one a dispatcher can act on.
 *
 * Cost control: one call per point, and a deliberately small point set - each
 * tile centroid plus the worker demo route's endpoints. This is a profile
 * sampler, not a second grid.
 *
 * Run:  npm run data:hourly
 *       npm run data:hourly -- --region=yuma
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { FORECAST_DAYS } from '../src/lib/config';
import { FortyGuardClient, type HourlyProfile } from '../src/lib/fortyguard';
import { HeatField } from '../src/lib/grid';
import { regionsFromArgv, type Region } from '../src/lib/regions';
import type { HeatGrid, SnapshotManifest } from '../src/lib/types';

loadEnv({ path: '.env.local' });
loadEnv();

interface SamplePoint {
  id: string;
  label: string;
  lat: number;
  lon: number;
}

async function main() {
  const apiKey = process.env.FORTYGUARD_API_KEY?.trim();
  if (!apiKey) {
    console.error(
      'FORTYGUARD_API_KEY is not set.\n' +
        'There is deliberately no modelled fallback here: the whole point of these\n' +
        'profiles is that they are real hourly data from the API. A synthetic\n' +
        'diurnal curve would look more precise while being less true.',
    );
    process.exit(1);
  }

  const client = new FortyGuardClient({
    apiKey,
    baseUrl: process.env.FORTYGUARD_BASE_URL?.trim() || 'https://api.fortyguard.com',
  });

  for (const region of regionsFromArgv()) {
    await fetchRegion(region, client);
  }
}

async function fetchRegion(region: Region, client: FortyGuardClient) {
  const cacheDir = resolve(process.cwd(), `data/${region.id}/cache`);
  const manifestPath = resolve(cacheDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.warn(`[hourly:${region.id}] no snapshot. Run data:ingest first.`);
    return;
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
  const day = FORECAST_DAYS[0];
  const firstValidAt = manifest.grids[0]?.validAt;
  const grids = manifest.grids
    .filter((g) => g.validAt === firstValidAt)
    .map((g) => JSON.parse(readFileSync(resolve(cacheDir, g.file), 'utf8')) as HeatGrid);

  if (grids.length === 0) {
    console.warn(`[hourly:${region.id}] no grids for the first day.`);
    return;
  }

  const field = new HeatField(grids);
  const date = grids[0].date ?? region.snapshotDate;

  // One profile per tile centre, plus the demo route's two ends. Small on
  // purpose - this samples the diurnal shape, it does not rebuild the field.
  const points: SamplePoint[] = region.tiles.map((t) => ({
    id: t.id,
    label: t.label,
    lat: (t.bbox[1] + t.bbox[3]) / 2,
    lon: (t.bbox[0] + t.bbox[2]) / 2,
  }));

  const routesPath = resolve(process.cwd(), `data/${region.id}/routes.json`);
  if (existsSync(routesPath)) {
    const rf = JSON.parse(readFileSync(routesPath, 'utf8')) as {
      workerDemo?: { primary?: { coords?: Array<[number, number]> } };
    };
    const coords = rf.workerDemo?.primary?.coords;
    if (coords?.length) {
      points.push({
        id: 'demo-start',
        label: 'Demo route - start',
        lat: coords[0][1],
        lon: coords[0][0],
      });
      points.push({
        id: 'demo-end',
        label: 'Demo route - end',
        lat: coords[coords.length - 1][1],
        lon: coords[coords.length - 1][0],
      });
    }
  }

  console.log(
    `[hourly:${region.id}] ${points.length} points for ${date} (filter_type ${day.filterType})`,
  );

  const profiles: Array<HourlyProfile & { id: string; label: string }> = [];
  const failures: string[] = [];

  for (const p of points) {
    // The endpoint needs a dry-bulb temperature as input; take it from the
    // grid we already paid for rather than making a second heatmap call.
    const tempF = field.sample(p.lon, p.lat);
    if (tempF === null) {
      failures.push(`${p.id}: outside the cached field`);
      continue;
    }
    const temperatureC = Math.round(((tempF - 32) / 1.8) * 100) / 100;

    try {
      const profile = await client.envParamsHourly(
        { lat: p.lat, lon: p.lon, temperatureC, date, filterType: day.filterType },
        (attempt, state) =>
          process.stdout.write(
            `\r[hourly:${region.id}]   ${p.id} poll ${attempt} -> ${state}   `,
          ),
      );
      process.stdout.write('\n');
      profiles.push({ ...profile, id: p.id, label: p.label });

      const app = profile.apparentTempF;
      if (app.length) {
        const min = Math.min(...app);
        const max = Math.max(...app);
        console.log(
          `[hourly:${region.id}]   ${p.label}: apparent ${min.toFixed(0)}-${max.toFixed(0)} degF ` +
            `(peak at ${String(app.indexOf(max)).padStart(2, '0')}:00)`,
        );
      }
    } catch (err) {
      process.stdout.write('\n');
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[hourly:${region.id}]   ${p.id} FAILED: ${msg}`);
      failures.push(`${p.id}: ${msg}`);
    }
  }

  if (profiles.length === 0) {
    console.warn(
      `[hourly:${region.id}] nothing fetched; leaving any existing file alone.`,
    );
    return;
  }

  const out = resolve(process.cwd(), `data/${region.id}/hourly.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        schema: 'coolroute.hourly.v1',
        regionId: region.id,
        source: 'fortyguard',
        endpoint: '/v1/env_params',
        note:
          'Real 24-hour environmental profiles. env_params takes a dry-bulb temperature ' +
          'as input and returns apparent temperature, heat index, wet bulb, humidity, ' +
          'cloud cover and air quality as hourly series. This is the only hour-of-day ' +
          'resolution the API exposes - /v1/heatmap has no hour parameter.',
        date,
        filterType: day.filterType,
        fetchedAt: new Date().toISOString(),
        failures,
        points: profiles,
      },
      null,
      1,
    ),
  );

  console.log(
    `[hourly:${region.id}] wrote ${profiles.length} hourly profiles -> ${out}` +
      (failures.length ? ` (${failures.length} failed)` : ''),
  );
}

main().catch((err) => {
  console.error('[hourly] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
