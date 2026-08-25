/**
 * Server-side snapshot loader, keyed by region.
 *
 * The one place the app reads from disk. Everything here is committed data
 * written by scripts/ - there is no network call anywhere in this file, which
 * is what makes base PRD FR3 ("all frontend interactions read from the local
 * cache, never call FortyGuard directly") checkable rather than aspirational.
 *
 * Files are read once per region and held in module scope. On Vercel that
 * means the first request in a warm instance pays the read and the rest do
 * not; locally it means editing a data file needs a dev-server restart, which
 * is the right trade for a build-time dataset.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { HeatGrid, ReliefSite, RouteFeature, SnapshotManifest } from '../types';
import type { RoadDensity } from '../recommend';

const DATA = resolve(process.cwd(), 'data');

const regionDir = (regionId: string) => resolve(DATA, regionId);
const cacheDir = (regionId: string) => resolve(regionDir(regionId), 'cache');

/** Per-region memo caches. */
const manifests = new Map<string, SnapshotManifest>();
const gridSets = new Map<string, Map<string, HeatGrid>>();
const siteFiles = new Map<string, ReliefSitesFile>();
const routeFiles = new Map<string, RoutesFile>();
const roadFiles = new Map<string, RoadDensity | null>();

export interface ReliefSitesFile {
  schema: string;
  regionId: string;
  source: string;
  sourceLabel: string;
  endpoint: string;
  where: string;
  attribution: string;
  fetchedAt: string;
  totalCount: number;
  focusCount: number;
  withKnownHours: number;
  sites: ReliefSite[];
}

export interface RoutesFile {
  schema: string;
  regionId: string;
  generatedAt: string;
  provider: string;
  note: string;
  routes: RouteFeature[];
  workerDemo: { primary: RouteFeature; alternative: RouteFeature | null };
}

export class MissingSnapshotError extends Error {
  constructor(what: string, fix: string) {
    super(`${what} is missing. Run \`${fix}\` to build it.`);
    this.name = 'MissingSnapshotError';
  }
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function loadManifest(regionId: string): SnapshotManifest {
  const hit = manifests.get(regionId);
  if (hit) return hit;

  const path = resolve(cacheDir(regionId), 'manifest.json');
  if (!existsSync(path)) {
    throw new MissingSnapshotError(
      `data/${regionId}/cache/manifest.json`,
      `npm run data:ingest -- --region=${regionId}`,
    );
  }
  const manifest = readJson<SnapshotManifest>(path);
  manifests.set(regionId, manifest);
  return manifest;
}

/**
 * The date a region's committed snapshot describes.
 *
 * Read from the data rather than from a constant in regions.ts, so the client's
 * idea of "day 0" is always whatever the ingest actually wrote. When the two
 * were allowed to drift apart, the client asked /api/field for a date that no
 * longer existed on disk and the field silently failed to load.
 *
 * Falls back to the earliest grid date for manifests written before the
 * snapshotDate field existed.
 */
export function snapshotDateFor(regionId: string): string {
  const manifest = loadManifest(regionId);
  if (manifest.snapshotDate) return manifest.snapshotDate;
  const dates = manifest.grids.map((g) => g.validAt.slice(0, 10)).sort();
  if (dates.length === 0) {
    throw new MissingSnapshotError(
      `data/${regionId}/cache/manifest.json lists no grids`,
      `npm run data:ingest -- --region=${regionId}`,
    );
  }
  return dates[0];
}

/** Every cached grid for a region, keyed by filename. */
export function loadGrids(regionId: string): Map<string, HeatGrid> {
  const hit = gridSets.get(regionId);
  if (hit) return hit;

  const dir = cacheDir(regionId);
  const map = new Map<string, HeatGrid>();
  if (existsSync(dir)) {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json') || file === 'manifest.json') continue;
      map.set(file, readJson<HeatGrid>(resolve(dir, file)));
    }
  }
  if (map.size === 0) {
    throw new MissingSnapshotError(
      `the heat-grid cache for ${regionId}`,
      `npm run data:ingest -- --region=${regionId}`,
    );
  }
  gridSets.set(regionId, map);
  return map;
}

/**
 * Grids for one (region, filterType, validAt) triple - one HeatField's worth.
 * Returned in the manifest's order so the client can rely on it.
 */
export function gridsFor(
  regionId: string,
  filterType: number,
  validAt: string,
): HeatGrid[] {
  const manifest = loadManifest(regionId);
  const grids = loadGrids(regionId);
  return manifest.grids
    .filter((g) => g.filterType === filterType && g.validAt === validAt)
    .map((g) => grids.get(g.file))
    .filter((g): g is HeatGrid => Boolean(g));
}

export function loadReliefSites(regionId: string): ReliefSitesFile {
  const hit = siteFiles.get(regionId);
  if (hit) return hit;

  const path = resolve(regionDir(regionId), 'relief-sites.json');
  if (!existsSync(path)) {
    throw new MissingSnapshotError(
      `data/${regionId}/relief-sites.json`,
      `npm run data:stations -- --region=${regionId}`,
    );
  }
  const file = readJson<ReliefSitesFile>(path);
  siteFiles.set(regionId, file);
  return file;
}

export function loadRoutes(regionId: string): RoutesFile {
  const hit = routeFiles.get(regionId);
  if (hit) return hit;

  const path = resolve(regionDir(regionId), 'routes.json');
  if (!existsSync(path)) {
    throw new MissingSnapshotError(
      `data/${regionId}/routes.json`,
      `npm run data:routes -- --region=${regionId}`,
    );
  }
  const file = readJson<RoutesFile>(path);
  routeFiles.set(regionId, file);
  return file;
}

export function loadRoadDensity(regionId: string): RoadDensity | null {
  if (roadFiles.has(regionId)) return roadFiles.get(regionId) ?? null;

  const path = resolve(regionDir(regionId), 'road-density.json');
  const file = existsSync(path) ? readJson<RoadDensity>(path) : null;
  roadFiles.set(regionId, file);
  return file;
}

/** Park and water polygons, served by /api/context and drawn as a map layer. */
/**
 * Real hourly environmental profiles from /v1/env_params.
 *
 * Optional: absent until `npm run data:hourly` has run with a key. The Worker
 * view degrades to the day-part comparison when it is missing rather than
 * showing an empty chart.
 */
export function loadHourly(regionId: string): unknown | null {
  const path = resolve(DATA, regionId, 'hourly.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadOsmContext(regionId: string): unknown | null {
  const path = resolve(regionDir(regionId), 'osm-context.geojson');
  if (!existsSync(path)) return null;
  return readJson<unknown>(path);
}

/**
 * Road centrelines for the street-level readout, served by /api/streets.
 *
 * Kept out of the bootstrap for the same reason as the context layer: it is
 * most of a megabyte that only matters once someone probes a street, and the
 * bootstrap is on the critical path for first paint.
 */
export function loadStreets(regionId: string): unknown | null {
  const path = resolve(regionDir(regionId), 'streets.geojson');
  if (!existsSync(path)) return null;
  return readJson<unknown>(path);
}

/**
 * Ground-level segmentation from /v1/streetview and /v1/satellite.
 *
 * Optional: absent until `npm run data:ground` has run with a key. The Planner
 * omits the section rather than showing an empty frame, the same way the Worker
 * view handles a missing hourly profile.
 */
export function loadGround(regionId: string): unknown | null {
  const path = resolve(regionDir(regionId), 'ground.json');
  if (!existsSync(path)) return null;
  return readJson<unknown>(path);
}
