/**
 * Ground truth: street-level and overhead views with land-cover segmentation.
 *
 * Addendum A2 lists Satellite and Streetview as Premium/optional and the
 * project long recorded them as unavailable. They are available on this key;
 * what was missing was the request shape (see the contract notes on
 * FortyGuardClient.streetView and .satellite).
 *
 * WHY THIS IS WORTH CALLS AND BYTES
 *
 * Every other layer in this product describes the street from above as a
 * number. This describes it as it is: how much of the frame at a given point is
 * tree, sky, building and road. Two consequences:
 *
 *   1. It explains the field. "This corridor runs hot" becomes "this corridor
 *      is 35% road, 2.5% tree, with the sky wide open" - visible rather than
 *      asserted.
 *   2. It puts a measurement under the canopy scenario. The intervention's
 *      degF coefficient remains an assumption and is still labelled as one -
 *      you cannot derive a temperature delta from a photograph. What the
 *      measurement does establish is SHADE HEADROOM: whether a site has room
 *      for more canopy at all. Recommending tree planting on a block already at
 *      40% canopy is a different proposition from recommending it at 2%, and
 *      until now the tool could not tell them apart.
 *
 * SIZE POLICY. The segmented overlay PNG is ~670 KB per frame - larger than
 * every heat grid in the region combined, and all of data/ is traced into every
 * serverless function. So: `segments` (the numbers, a few hundred bytes) are
 * kept for every point; the imagery is kept only for the first --images points,
 * which is what the UI shows as a worked example. The rest carry their
 * measurements without their pictures.
 *
 * Run:  npm run data:ground
 *       npm run data:ground -- --region=yuma --images=2
 */
import { loadKeys, describeKeys } from '../src/lib/keys';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { FortyGuardClient } from '../src/lib/fortyguard';
import { regionsFromArgv, type Region } from '../src/lib/regions';
import type { SnapshotManifest } from '../src/lib/types';

loadEnv({ path: '.env.local' });
loadEnv();

/** How many points keep their imagery. The rest keep only their percentages. */
const DEFAULT_IMAGE_POINTS = 2;

interface GroundPoint {
  id: string;
  label: string;
  lat: number;
  lon: number;
  /** Frame composition, percent. The reason this endpoint is worth calling. */
  street: Record<string, number> | null;
  /** Land cover from above, percent. */
  overhead: Record<string, number> | null;
  imageDate: string | null;
  imageYear: string | number | null;
  /** base64, present only for the first --images points. */
  streetImage: string | null;
  streetSegmented: string | null;
  activityIds: { street: string | null; satellite: string | null };
}

async function main() {
  /*
   * Batch work starts at the FIRST key. The interactive endpoints start at the
   * last, so a long backfill and a live demo do not drain the same quota.
   */
  const keyPool = loadKeys();
  const apiKey = keyPool[0]?.value;
  if (keyPool.length > 1) {
    console.log(`[${'ground'}] ${describeKeys()}`);
  }
  if (!apiKey) {
    console.error(
      '\n[ground] FORTYGUARD_API_KEY is not set.\n' +
        '[ground] This script only produces real imagery and real segmentation.\n' +
        '[ground] There is no modelled fallback: a fabricated photograph of a street\n' +
        '[ground] would be a different order of dishonesty from a modelled temperature.\n',
    );
    process.exit(1);
  }

  const imageArg = process.argv.find((a) => a.startsWith('--images='))?.split('=')[1];
  const imagePoints = imageArg ? Number(imageArg) : DEFAULT_IMAGE_POINTS;

  const client = new FortyGuardClient({
    apiKey,
    baseUrl: process.env.FORTYGUARD_BASE_URL?.trim() || 'https://api.fortyguard.com',
  });

  for (const region of regionsFromArgv()) {
    await fetchRegion(region, client, imagePoints);
  }
}

async function fetchRegion(region: Region, client: FortyGuardClient, imagePoints: number) {
  const out = resolve(process.cwd(), `data/${region.id}/ground.json`);
  const manifestPath = resolve(process.cwd(), `data/${region.id}/cache/manifest.json`);
  if (!existsSync(manifestPath)) {
    console.warn(`[ground:${region.id}] no snapshot yet. Run data:ingest first.`);
    return;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SnapshotManifest;
  const date =
    manifest.snapshotDate ?? manifest.grids[0]?.validAt.slice(0, 10) ?? '';

  const points = samplePoints(region);
  console.log(
    `[ground:${region.id}] ${points.length} points, imagery for the first ${imagePoints}`,
  );

  const results: GroundPoint[] = [];
  const failures: string[] = [];

  for (const [i, p] of points.entries()) {
    const keepImages = i < imagePoints;
    const row: GroundPoint = {
      id: p.id,
      label: p.label,
      lat: p.lat,
      lon: p.lon,
      street: null,
      overhead: null,
      imageDate: null,
      imageYear: null,
      streetImage: null,
      streetSegmented: null,
      activityIds: { street: null, satellite: null },
    };

    try {
      const sv = await client.streetView({ lat: p.lat, lon: p.lon, backView: false });
      row.activityIds.street = sv.activityId;
      if (sv.front) {
        row.street = sv.front.segments;
        row.imageDate = sv.front.imageDate;
        if (keepImages) {
          row.streetImage = sv.front.originalImage;
          row.streetSegmented = sv.front.segmentedImage;
        }
      }
      console.log(
        `[ground:${region.id}]   ${p.id} street: ` +
          (row.street ? summarise(row.street) : 'no frame returned'),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${p.id} streetview: ${msg}`);
      console.warn(`[ground:${region.id}]   ${p.id} streetview FAILED: ${msg}`);
    }

    try {
      const sat = await client.satellite({
        lat: p.lat,
        lon: p.lon,
        date,
        filterType: 3,
      });
      row.activityIds.satellite = sat.activityId;
      row.overhead = sat.segments;
      row.imageYear = sat.imageYear;
      // The overhead PHOTOGRAPH is deliberately not kept: the satellite basemap
      // already shows the user the view from above, interactively and at any
      // zoom. Storing a second static copy per point cost ~380 KB and rendered
      // nowhere. The land-cover percentages above are the part only this
      // endpoint can give us.
      console.log(
        `[ground:${region.id}]   ${p.id} overhead: ` +
          (row.overhead ? summarise(row.overhead) : 'no segmentation returned'),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${p.id} satellite: ${msg}`);
      console.warn(`[ground:${region.id}]   ${p.id} satellite FAILED: ${msg}`);
    }

    if (row.street || row.overhead) results.push(row);
  }

  if (results.length === 0) {
    if (existsSync(out)) {
      console.warn(
        `[ground:${region.id}] every point failed. Keeping the existing file untouched.`,
      );
      return;
    }
    throw new Error(`[ground:${region.id}] every point failed and there is no previous file.`);
  }

  const payload = {
    schema: 'coolroute.ground.v1' as const,
    regionId: region.id,
    source: 'fortyguard' as const,
    endpoints: ['/v1/streetview', '/v1/satellite'],
    snapshotDate: date,
    fetchedAt: new Date().toISOString(),
    note:
      'Frame composition from FortyGuard segmentation, percent of frame. Street-level ' +
      'imagery is Google Street View served through the FortyGuard API and carries its ' +
      'own attribution. Percentages are measurements; no temperature effect is derived ' +
      'from them - see canopyHeadroom() in src/lib/assumptions.ts.',
    imagePointCount: Math.min(imagePoints, results.length),
    points: results,
    failures,
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(payload));
  const kb = (JSON.stringify(payload).length / 1024).toFixed(0);
  console.log(
    `[ground:${region.id}] wrote ${results.length} points (${kb} KB) -> ${out}` +
      (failures.length ? ` | ${failures.length} failure(s)` : ''),
  );
}

/**
 * Where to look.
 *
 * Tile centres give a representative reading per district; the demo route's
 * ends are the two places the Worker view already talks about, so a ground view
 * there lands in a context the user is already looking at.
 */
function samplePoints(region: Region) {
  const points = region.tiles.map((t) => ({
    id: t.id,
    label: t.label,
    lat: (t.bbox[1] + t.bbox[3]) / 2,
    lon: (t.bbox[0] + t.bbox[2]) / 2,
  }));

  const routesPath = resolve(process.cwd(), `data/${region.id}/routes.json`);
  if (existsSync(routesPath)) {
    const rf = JSON.parse(readFileSync(routesPath, 'utf8')) as {
      workerDemo?: { primary?: { coords?: Array<[number, number]> } };
      routes?: Array<{ id: string; name: string; coords: Array<[number, number]> }>;
    };
    const demo = rf.workerDemo?.primary?.coords;
    if (demo?.length) {
      points.push({
        id: 'demo-start',
        label: 'Demo run - start',
        lat: demo[0][1],
        lon: demo[0][0],
      });
      points.push({
        id: 'demo-end',
        label: 'Demo run - end',
        lat: demo[demo.length - 1][1],
        lon: demo[demo.length - 1][0],
      });
    }
    // The midpoint of the first route, which is usually the industrial run the
    // relief-gap finding is about - the most useful place to see the ground.
    const first = rf.routes?.[0];
    if (first?.coords?.length) {
      const mid = first.coords[Math.floor(first.coords.length / 2)];
      points.push({
        id: `${first.id}-mid`,
        label: `${first.name} - midpoint`,
        lat: mid[1],
        lon: mid[0],
      });
    }
  }
  return points;
}

/** One-line "tree 2.5% / sky 31.3% / road 35.1%" for the console. */
function summarise(segments: Record<string, number>): string {
  return Object.entries(segments)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, v]) => `${k} ${v.toFixed(1)}%`)
    .join(', ');
}

main().catch((err) => {
  console.error('\n[ground] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
