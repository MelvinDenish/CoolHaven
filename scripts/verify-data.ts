/**
 * Snapshot integrity and freshness check.
 *
 * `verify-coverage.ts` re-derives the headline finding. This script asks a
 * different and more basic question: is the committed data internally
 * consistent, and is it actually what it claims to be?
 *
 * It exists because the two ways this project could quietly go wrong are both
 * invisible from the UI:
 *
 *   1. STALENESS. A snapshot that stopped advancing still renders perfectly.
 *      The app shows a date; nothing on screen says that date is three days
 *      old. This is not hypothetical - the ingest previously derived its dates
 *      from a hardcoded constant, so every scheduled run found its target
 *      already cached and skipped, and 24 commits reported a refresh that never
 *      happened.
 *   2. DRIFT. Arrays that no longer line up, risk bands that no longer match
 *      the temperatures they were derived from, a manifest listing a file that
 *      is not there. Each of those degrades a number rather than throwing.
 *
 * Every check prints PASS, WARN or FAIL with the number it actually measured,
 * so the output is evidence rather than a green tick. A FAIL exits non-zero,
 * which is what the refresh workflow gates on; a WARN never does, because
 * "yesterday's data" is a judgement call, not a broken build.
 *
 * Run:  npm run verify:data
 *       npm run verify:data -- --region=phoenix
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { HeatField } from '../src/lib/grid';
import { arizonaToday, classifyCell, gridDimsFor } from '../src/lib/config';
import { regionBbox, regionsFromArgv, type Region } from '../src/lib/regions';
import type { HeatGrid, ReliefSite, SnapshotManifest } from '../src/lib/types';

type Level = 'PASS' | 'WARN' | 'FAIL';

let failures = 0;
let warnings = 0;

function report(level: Level, check: string, detail: string) {
  if (level === 'FAIL') failures++;
  if (level === 'WARN') warnings++;
  const tag = level.padEnd(4);
  console.log(`  ${tag} ${check.padEnd(34)} ${detail}`);
}

function main() {
  const today = arizonaToday();
  console.log(`Snapshot verification - today is ${today} (Arizona local)\n`);

  for (const region of regionsFromArgv()) {
    console.log(`== ${region.name} (${region.id}) ==`);
    verifyRegion(region, today);
    console.log('');
  }

  console.log(
    failures > 0
      ? `FAILED: ${failures} check(s) failed, ${warnings} warning(s).`
      : `OK: every check passed${warnings ? `, with ${warnings} warning(s)` : ''}.`,
  );
  process.exit(failures > 0 ? 1 : 0);
}

function verifyRegion(region: Region, today: string) {
  const dir = resolve(process.cwd(), `data/${region.id}`);
  const cacheDir = resolve(dir, 'cache');
  const manifestPath = resolve(cacheDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    report('FAIL', 'manifest present', `missing ${manifestPath}`);
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;

  /* ------------------------------------------------------------ freshness */
  const snapshotDate =
    manifest.snapshotDate ??
    manifest.grids.map((g) => g.validAt.slice(0, 10)).sort()[0] ??
    '';
  const ageDays = daysBetween(snapshotDate, today);
  report(
    ageDays <= 0 ? 'PASS' : ageDays <= 1 ? 'WARN' : 'FAIL',
    'snapshot freshness',
    `day 0 is ${snapshotDate}, ${ageDays} day(s) behind today`,
  );

  // A refresh that fetched nothing is legitimate (everything already cached)
  // but worth saying out loud, because it is indistinguishable from a broken
  // pipeline unless someone reports the number.
  if (typeof manifest.fetchedThisRun === 'number') {
    report(
      'PASS',
      'grids fetched last run',
      `${manifest.fetchedThisRun} of ${manifest.grids.length}`,
    );
  }

  /* ------------------------------------------------- manifest <-> files */
  const onDisk = existsSync(cacheDir)
    ? readdirSync(cacheDir).filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    : [];
  const listed = new Set(manifest.grids.map((g) => g.file));
  const missing = manifest.grids.filter((g) => !existsSync(resolve(cacheDir, g.file)));
  const orphans = onDisk.filter((f) => !listed.has(f));

  report(
    missing.length === 0 ? 'PASS' : 'FAIL',
    'manifest files exist',
    missing.length === 0
      ? `${manifest.grids.length} listed, all present`
      : `missing: ${missing.map((m) => m.file).join(', ')}`,
  );
  report(
    orphans.length === 0 ? 'PASS' : 'WARN',
    'no orphaned grid files',
    orphans.length === 0
      ? `${onDisk.length} file(s), all listed`
      : `unlisted on disk: ${orphans.join(', ')}`,
  );

  /* ------------------------------------------------------------ provenance */
  const grids = manifest.grids
    .filter((g) => existsSync(resolve(cacheDir, g.file)))
    .map((g) => JSON.parse(readFileSync(resolve(cacheDir, g.file), 'utf8')) as HeatGrid);

  const live = grids.filter((g) => g.source === 'fortyguard');
  const withActivity = live.filter((g) => g.provenance?.activityId);
  report(
    live.length === grids.length ? 'PASS' : 'WARN',
    'grids are live API data',
    `${live.length} of ${grids.length} source=fortyguard`,
  );
  report(
    withActivity.length === live.length ? 'PASS' : 'FAIL',
    'live grids carry activity_id',
    `${withActivity.length} of ${live.length}`,
  );
  report(
    manifest.liveApiUsed === live.length > 0 ? 'PASS' : 'FAIL',
    'liveApiUsed matches grids',
    `manifest says ${manifest.liveApiUsed}, ${live.length} live grid(s)`,
  );

  /* -------------------------------------------------------- grid integrity */
  let badDims = 0;
  let badBands = 0;
  let badRange = 0;
  for (const g of grids) {
    const { cols, rows } = gridDimsFor(g.bbox, g.granularityM);
    if (g.cols !== cols || g.rows !== rows || g.tempsF.length !== g.cols * g.rows) badDims++;
    // Risk bands must still be what the temperatures classify to. If they
    // drift, the risk layer and the heat layer are telling different stories.
    for (let i = 0; i < g.tempsF.length; i += 29) {
      if (g.riskBands[i] !== classifyCell(g.tempsF[i])) {
        badBands++;
        break;
      }
    }
    for (let i = 0; i < g.tempsF.length; i += 29) {
      const mn = g.tempsMinF?.[i];
      const mx = g.tempsMaxF?.[i];
      if (mn === undefined || mx === undefined) continue;
      if (!(mn <= g.tempsF[i] + 0.05 && g.tempsF[i] <= mx + 0.05)) {
        badRange++;
        break;
      }
    }
  }
  report(badDims === 0 ? 'PASS' : 'FAIL', 'grid dimensions consistent', `${grids.length - badDims}/${grids.length} ok`);
  report(badBands === 0 ? 'PASS' : 'FAIL', 'risk bands match temps', `${grids.length - badBands}/${grids.length} ok`);
  report(badRange === 0 ? 'PASS' : 'FAIL', 'min <= average <= max', `${grids.length - badRange}/${grids.length} ok`);

  /* --------------------------------------------------------- field sanity */
  const dayZero = grids.filter((g) => g.date === snapshotDate);
  if (dayZero.length > 0) {
    const field = new HeatField(dayZero, 'avg');
    const st = field.stats();
    const plausible = st.minF > 40 && st.maxF < 140;
    report(
      plausible ? 'PASS' : 'FAIL',
      'temperatures plausible',
      `${st.minF.toFixed(1)} - ${st.maxF.toFixed(1)} degF across day 0`,
    );
    report('PASS', 'field spread', `${(st.maxF - st.minF).toFixed(2)} degF across the focus area`);
  }

  /* ----------------------------------------------------------- relief data */
  const reliefPath = resolve(dir, 'relief-sites.json');
  if (!existsSync(reliefPath)) {
    report('FAIL', 'relief sites present', `missing ${reliefPath}`);
  } else {
    const file = JSON.parse(readFileSync(reliefPath, 'utf8')) as {
      sites: ReliefSite[];
      fetchedAt: string;
      sourceLabel: string;
    };
    const bbox = regionBbox(region);
    const inFocus = file.sites.filter(
      (s) => s.lon >= bbox[0] && s.lon <= bbox[2] && s.lat >= bbox[1] && s.lat <= bbox[3],
    );
    const withHours = file.sites.filter((s) => s.hoursKnown || s.open24);
    report(
      inFocus.length > 0 ? 'PASS' : 'FAIL',
      'relief sites in focus area',
      `${inFocus.length} of ${file.sites.length} (${file.sourceLabel})`,
    );
    report(
      region.relief.dataQuality === 'agency' ? 'PASS' : 'WARN',
      'relief data quality',
      region.relief.dataQuality === 'agency'
        ? 'agency-published network'
        : 'OSM-derived - coverage NOT comparable with agency regions',
    );
    report(
      withHours.length > 0 ? 'PASS' : 'WARN',
      'sites with usable hours',
      `${withHours.length} of ${file.sites.length} parse to real windows`,
    );
  }

  /* --------------------------------------------------------------- routes */
  const routesPath = resolve(dir, 'routes.json');
  if (!existsSync(routesPath)) {
    report('FAIL', 'routes present', `missing ${routesPath}`);
  } else {
    const file = JSON.parse(readFileSync(routesPath, 'utf8')) as {
      routes: Array<{ id: string; coords: Array<[number, number]>; distanceM: number }>;
      provider: string;
    };
    const degenerate = file.routes.filter((r) => r.coords.length < 4 || r.distanceM < 200);
    report(
      degenerate.length === 0 ? 'PASS' : 'FAIL',
      'routes have real geometry',
      `${file.routes.length} routes via ${file.provider}, ${degenerate.length} degenerate`,
    );
  }

  /* -------------------------------------------------------------- streets */
  const streetsPath = resolve(dir, 'streets.geojson');
  if (!existsSync(streetsPath)) {
    report('WARN', 'street geometry present', `missing - run npm run data:osm`);
  } else {
    const fc = JSON.parse(readFileSync(streetsPath, 'utf8')) as {
      features: Array<{ properties: { name: string | null } }>;
    };
    const named = fc.features.filter((f) => f.properties.name).length;
    report(
      fc.features.length > 0 ? 'PASS' : 'FAIL',
      'street centrelines',
      `${fc.features.length} streets, ${named} named`,
    );
  }
}

function daysBetween(fromYmd: string, toYmd: string): number {
  if (!fromYmd) return 999;
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

main();
