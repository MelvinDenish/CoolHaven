/**
 * Point-accurate temperatures at every relief site (Addendum A2, priority High).
 *
 * The heat grid is 100 m cells. That is the right resolution for a field you
 * paint across a district, and the wrong one for the question "how hot is it
 * at the door of this specific cooling centre" - a site sitting under mature
 * canopy on the shaded side of a building can differ from its cell average by
 * more than the entire effect of any intervention in the scenario studio.
 *
 * `POST /v1/env_params` answers that properly, so this script asks it once per
 * in-focus site and commits the answers. Addendum A2 rates env_params High and
 * describes exactly this use: "point queries at existing/proposed cooling
 * stations and key route waypoints ... instead of nearest-grid-cell
 * approximation".
 *
 * NO KEY, NO OUTPUT. There is deliberately no modelled fallback here. The
 * whole value of this file is that it is more accurate than the grid; a
 * synthetic version would be less accurate than the grid while looking more
 * precise, which is the worst combination available.
 *
 * Run:  npm run data:site-temps
 *       npm run data:site-temps -- --region=yuma
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { FORECAST_DAYS } from '../src/lib/config';
import { FortyGuardClient } from '../src/lib/fortyguard';
import { regionBbox, regionsFromArgv, type Region } from '../src/lib/regions';

import type { ReliefSite } from '../src/lib/types';

loadEnv({ path: '.env.local' });
loadEnv();

/** env_params is a per-point cost; batch and cap so one run cannot run away. */
const BATCH_SIZE = 25;
const MAX_SITES_PER_REGION = 120;

async function main() {
  const apiKey = process.env.FORTYGUARD_API_KEY?.trim();
  if (!apiKey) {
    console.error(
      'FORTYGUARD_API_KEY is not set.\n' +
        'This script has no modelled fallback on purpose: its entire value is being\n' +
        'more accurate than the grid, and a synthetic version would be less accurate\n' +
        'while looking more precise. Set the key and re-run, or skip it - the app\n' +
        'works without it and falls back to grid sampling.',
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
  const sitesPath = resolve(process.cwd(), `data/${region.id}/relief-sites.json`);
  if (!existsSync(sitesPath)) {
    console.warn(
      `[site-temps:${region.id}] no relief-sites.json. Run data:stations first.`,
    );
    return;
  }

  const { sites } = JSON.parse(readFileSync(sitesPath, 'utf8')) as {
    sites: ReliefSite[];
  };
  const bbox = regionBbox(region);
  const margin = 0.02;
  const inFocus = sites
    .filter(
      (s) =>
        s.lon >= bbox[0] - margin &&
        s.lon <= bbox[2] + margin &&
        s.lat >= bbox[1] - margin &&
        s.lat <= bbox[3] + margin,
    )
    .slice(0, MAX_SITES_PER_REGION);

  if (inFocus.length === 0) {
    console.warn(`[site-temps:${region.id}] no sites inside the focus tiles.`);
    return;
  }

  // The baseline hour, so these line up with what the Planner reads.
  const slice = FORECAST_DAYS[0];
  const date = region.snapshotDate;

  console.log(
    `[site-temps:${region.id}] querying ${inFocus.length} sites for ${date} ` +
      `(filter_type ${slice.filterType})`,
  );

  const temps: Record<string, number> = {};
  let missing = 0;

  for (let i = 0; i < inFocus.length; i += BATCH_SIZE) {
    const batch = inFocus.slice(i, i + BATCH_SIZE);
    const results = await client.fetchEnvParams(
      batch.map((s) => ({ lon: s.lon, lat: s.lat })),
      slice.filterType,
      date,
    );
    results.forEach((r, j) => {
      if (r.tempF === null) {
        missing++;
        return;
      }
      temps[batch[j].id] = Math.round(r.tempF * 10) / 10;
    });
    console.log(
      `[site-temps:${region.id}]   ${Math.min(i + BATCH_SIZE, inFocus.length)}/${inFocus.length}`,
    );
  }

  const out = resolve(process.cwd(), `data/${region.id}/site-temps.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        schema: 'coolroute.sitetemps.v1',
        regionId: region.id,
        source: 'fortyguard',
        endpoint: '/v1/env_params',
        note:
          'Point-accurate 2 m temperatures at relief-site coordinates, from ' +
          'POST /v1/env_params. More accurate than sampling the 100 m grid at the ' +
          'same coordinate, which is the reason this file exists.',
        filterType: slice.filterType,
        validAt: date,
        fetchedAt: new Date().toISOString(),
        siteCount: Object.keys(temps).length,
        unresolved: missing,
        temps,
      },
      null,
      1,
    ),
  );

  console.log(
    `[site-temps:${region.id}] wrote ${Object.keys(temps).length} point temperatures ` +
      `(${missing} unresolved) -> ${out}`,
  );
}

main().catch((err) => {
  console.error('[site-temps] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
