/**
 * Sanity-check the relief-coverage numbers the impact summary leads on.
 *
 * The headline is "the average route has a 6.5 km continuous stretch with no
 * Heat Relief Network site within a 400 m walk". That is a big claim, and it
 * is the kind of number that is either the strongest finding in the project or
 * evidence of a bug in `reliefCoverage()`. This script tells you which.
 *
 * The discriminating test: the largest gaps must land on the industrial and
 * airport-perimeter runs, and the downtown postal loop - short, and ringed by
 * relief sites - must NOT show a multi-kilometre gap. If it does, the coverage
 * logic is wrong and the headline is inflated.
 *
 * Run:  npm run verify:coverage
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { MOVEMENT } from '../src/lib/assumptions';
import { HeatField, planarM } from '../src/lib/grid';
import { regionsFromArgv, type Region } from '../src/lib/regions';
import { filterOpenAt, localDayIndex } from '../src/lib/relief';
import { scoreRoute } from '../src/lib/scoring';
import type {
  HeatGrid,
  ReliefSite,
  RouteFeature,
  SnapshotManifest,
} from '../src/lib/types';

for (const region of regionsFromArgv()) {
  verifyRegion(region);
}

function verifyRegion(region: Region) {
const CACHE = resolve(process.cwd(), `data/${region.id}/cache`);

const manifest = JSON.parse(
  readFileSync(resolve(CACHE, 'manifest.json'), 'utf8'),
) as SnapshotManifest;

const grids: Record<string, HeatGrid> = Object.fromEntries(
  readdirSync(CACHE)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .map((f) => [f, JSON.parse(readFileSync(resolve(CACHE, f), 'utf8')) as HeatGrid]),
);

// The Planner reads the first available day. filter_type 1 (historic) returns
// HTTP 500 on this key, so everything in the snapshot is filter_type 3 and the
// verifier must not assume otherwise.
const firstDay = manifest.grids[0]?.validAt;
const field = new HeatField(
  manifest.grids.filter((g) => g.validAt === firstDay).map((g) => grids[g.file]),
);

const sitesFile = JSON.parse(
  readFileSync(resolve(process.cwd(), `data/${region.id}/relief-sites.json`), 'utf8'),
) as { sites: ReliefSite[] };
const routesFile = JSON.parse(
  readFileSync(resolve(process.cwd(), `data/${region.id}/routes.json`), 'utf8'),
) as { routes: RouteFeature[] };

// Same focus filter the app applies, so these numbers match the UI exactly.
const bbox = field.grids.reduce(
  (acc, g) => [
    Math.min(acc[0], g.bbox[0]),
    Math.min(acc[1], g.bbox[1]),
    Math.max(acc[2], g.bbox[2]),
    Math.max(acc[3], g.bbox[3]),
  ],
  [180, 90, -180, -90] as number[],
);
const MARGIN = 0.02;
const sites = sitesFile.sites.filter(
  (s) =>
    s.lon >= bbox[0] - MARGIN &&
    s.lon <= bbox[2] + MARGIN &&
    s.lat >= bbox[1] - MARGIN &&
    s.lat <= bbox[3] + MARGIN,
);

// The app counts a site as relief only if it is OPEN at the hour being
// modelled. This script has to apply the same rule or it verifies a number
// the product never shows - which is worse than not verifying at all.
const dayIndex = localDayIndex(field.validAt);
const hourLocal = Number(field.validAt.slice(11, 13));
const { open: openSites, closed, unknownHours } = filterOpenAt(sites, dayIndex, hourLocal);

console.log(
  `\n== ${region.name} ==\n${sites.length} relief sites in the focus area (+2 km margin); ` +
    `${openSites.length} open at ${hourLocal}:00, ${closed.length} shut, ` +
    `${unknownHours} publishing no hours (counted as open). ` +
    `Walk radius ${MOVEMENT.walkToReliefM} m.\n`,
);
console.log(
  'route'.padEnd(30) +
    'len_km'.padStart(7) +
    'worstGap_m'.padStart(12) +
    'gap/len'.padStart(9) +
    'nearest_m'.padStart(11) +
    'sitesInReach'.padStart(14),
);
console.log('-'.repeat(83));

let total = 0;
for (const r of routesFile.routes) {
  const score = scoreRoute(r, field, openSites);
  // How many focus sites come within the walk radius of ANY point on the route.
  const inReach = openSites.filter((s) =>
    r.coords.some((c) => planarM(c, [s.lon, s.lat]) <= MOVEMENT.walkToReliefM),
  ).length;

  total += score.worstReliefGapM;
  console.log(
    r.id.padEnd(30) +
      (r.distanceM / 1000).toFixed(1).padStart(7) +
      String(score.worstReliefGapM).padStart(12) +
      `${((score.worstReliefGapM / r.distanceM) * 100).toFixed(0)}%`.padStart(9) +
      String(score.nearestRelief?.distanceM ?? -1).padStart(11) +
      String(inReach).padStart(14),
  );
}

console.log('-'.repeat(83));
console.log(`mean worst gap: ${Math.round(total / routesFile.routes.length)} m\n`);
console.log(
  'Expected shape: the industrial and airport-perimeter runs carry the largest gaps;\n' +
    'the downtown postal loop should have several sites in reach and a small gap.\n' +
    'If the postal loop shows a multi-km gap, reliefCoverage() is wrong.\n',
);
}
