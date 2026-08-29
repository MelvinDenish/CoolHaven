/**
 * Pull the REAL published heat-relief network for each region.
 *
 * Addition 3: the baseline relief layer is actual published infrastructure -
 * cooling centres, respite centres and hydration stations - not hypothetical
 * points.
 *
 * Two publishers, two schemas:
 *
 *   magHRN  Maricopa Association of Governments Heat Relief Network, the layer
 *           behind the county's public Heat Relief map. Rich: per-day hours,
 *           ADA and pet flags, services, phone.
 *   azdhs   Arizona Department of Health Services Statewide Heat Preparedness
 *           Network. Same idea, different field names, sparser hours.
 *   osm     OpenStreetMap amenities, via Overpass. The fallback for cities with
 *           no agency feed. It lives in src/lib/osm-relief.ts rather than here,
 *           because the draft-region endpoints call the same adapter at request
 *           time; see that file for what it does and does not claim.
 *
 * Handling all three is the point. A "multi-city" product that only works where
 * one particular agency publishes one particular schema is not multi-city, and
 * the mapping below is where that claim is either honoured or quietly broken.
 *
 * Base PRD FR6 budgeted this as a manual geocoding task. Both agencies publish
 * queryable feature services, so this script replaces the manual pass entirely.
 *
 * Run:  npm run data:stations
 *       npm run data:stations -- --region=yuma
 *
 * Failure policy: if a service is unreachable and a previous file exists, KEEP
 * the previous file and carry on. A demo-morning network blip must not wipe a
 * working snapshot.
 */
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { parseClock } from '../src/lib/relief';
import { regionBbox, regionsFromArgv, type Region } from '../src/lib/regions';
// The OSM adapter moved to src/lib/ so the draft-region endpoints can call it at
// request time. This script's behaviour is unchanged: same function, same
// arguments, same output file.
import { fetchOsmRelief } from '../src/lib/osm-relief';
import type { ReliefSite } from '../src/lib/types';

interface ArcFeature {
  geometry: { coordinates: [number, number] } | null;
  properties: Record<string, unknown>;
}

const DAY_FIELDS = [
  ['SundayOpen', 'SundayClose'],
  ['MondayOpen', 'MondayClose'],
  ['TuesdayOpen', 'TuesdayClose'],
  ['WednesdayOpen', 'WednesdayClose'],
  ['ThursdayOpen', 'ThursdayClose'],
  ['FridayOpen', 'FridayClose'],
  ['SaturdayOpen', 'SaturdayClose'],
] as const;

async function main() {
  for (const region of regionsFromArgv()) {
    await fetchRegion(region);
  }
}

async function fetchRegion(region: Region) {
  const out = resolve(process.cwd(), `data/${region.id}/relief-sites.json`);
  const fetchedAt = new Date().toISOString();
  const today = fetchedAt.slice(0, 10);

  let sites: ReliefSite[];
  try {
    sites =
      region.relief.kind === 'osm'
        ? await fetchOsmRelief(region, today)
        : await fetchFromArcGis(region, today);
    if (sites.length === 0) throw new Error('source returned zero usable sites');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (existsSync(out)) {
      const existing = JSON.parse(readFileSync(out, 'utf8')) as { sites?: unknown[] };
      console.warn(
        `[relief:${region.id}] fetch failed (${reason}). Keeping the existing snapshot ` +
          `of ${existing.sites?.length ?? 0} sites. Nothing was overwritten.`,
      );
      return;
    }
    throw new Error(
      `[relief:${region.id}] fetch failed (${reason}) and no previous snapshot at ${out}.`,
    );
  }

  const bbox = regionBbox(region);
  const inFocus = sites.filter(
    (s) => s.lon >= bbox[0] && s.lon <= bbox[2] && s.lat >= bbox[1] && s.lat <= bbox[3],
  );

  const payload = {
    schema: 'coolroute.reliefsites.v2' as const,
    regionId: region.id,
    source: region.relief.kind,
    sourceLabel: region.relief.label,
    endpoint: region.relief.endpoint,
    where: region.relief.where,
    attribution: region.relief.attribution,
    fetchedAt,
    totalCount: sites.length,
    focusCount: inFocus.length,
    focusBbox: bbox,
    withKnownHours: sites.filter((s) => s.hoursKnown || s.open24).length,
    byKind: countBy(sites, (s) => s.kind),
    sites,
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(payload, null, 1));

  console.log(
    `[relief:${region.id}] ${sites.length} real sites (${inFocus.length} in focus tiles, ` +
      `${payload.withKnownHours} with usable hours) -> ${out}`,
  );
  console.log(`[relief:${region.id}]`, payload.byKind);
}

/* -------------------------------------------------------------------------- */
/* Source adapters                                                             */
/* -------------------------------------------------------------------------- */

/** The two ArcGIS feature services, which differ only in field names. */
async function fetchFromArcGis(region: Region, today: string): Promise<ReliefSite[]> {
  const params = new URLSearchParams({
    where: region.relief.where,
    outFields: '*',
    outSR: '4326',
    f: 'geojson',
  });

  const res = await fetch(`${region.relief.endpoint}?${params}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { features?: ArcFeature[]; error?: unknown };
  if (json.error) {
    throw new Error(`service error: ${JSON.stringify(json.error).slice(0, 160)}`);
  }

  const sites: ReliefSite[] = [];
  for (const f of json.features ?? []) {
    if (!f.geometry?.coordinates) continue;
    const [lon, lat] = f.geometry.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const site =
      region.relief.kind === 'magHRN'
        ? mapMag(f.properties, lon, lat, sites.length, today)
        : mapAzdhs(f.properties, lon, lat, sites.length, today);
    if (site) sites.push(site);
  }
  return sites;
}

/* -------------------------------------------------------------------------- */
/* Publisher-specific field mapping                                            */
/* -------------------------------------------------------------------------- */

function mapMag(
  p: Record<string, unknown>,
  lon: number,
  lat: number,
  n: number,
  today: string,
): ReliefSite | null {
  // The layer also carries donation-collection-only sites, which are not
  // somewhere a worker can cool down.
  const heatRelief = str(p.HeatRelief);
  if (heatRelief && heatRelief.toLowerCase() !== 'yes') return null;
  if (str(p.Active)?.toLowerCase() === 'no') return null;

  const hours = readDayHours(p);
  return {
    id: `hrn-${String(p.OBJECTID ?? n)}`,
    name: str(p.Location) ?? 'Heat Relief Network site',
    org: str(p.Organization),
    kind: magKind(str(p.HeatRelief_Type)),
    lon: round6(lon),
    lat: round6(lat),
    address: str(p.Address),
    city: str(p.City),
    phone: str(p.PrimaryPhone),
    hours: str(p.Hours),
    hoursByDay: hours.byDay,
    open24: hours.open24,
    hoursKnown: hours.known,
    services: str(p.Services),
    pets: yesNo(str(p.Pets)),
    adaAccessible: yesNo(str(p.ADA_accessible) ?? str(p.Wheelchair_access)),
    seasonStart: str(p.Start_Date),
    seasonEnd: str(p.End_Date),
    source: 'magHRN',
    verifiedDate: today,
  };
}

function mapAzdhs(
  p: Record<string, unknown>,
  lon: number,
  lat: number,
  n: number,
  today: string,
): ReliefSite | null {
  const cooling = yesNo(str(p.CoolingYN));
  const hydration = yesNo(str(p.HydrationYN));
  // Collection-only sites are not relief for a working crew.
  if (!cooling && !hydration) return null;

  const hours = readDayHours(p);
  const open24 = hours.open24 || yesNo(str(p.Open24seven)) === true;

  return {
    id: `azdhs-${String(p.OBJECTID ?? n)}`,
    // ADHS often leaves Facility blank and carries the name in a lookup field.
    name:
      str(p.Facility) ??
      str(p.LUT_Facility) ??
      str(p.Organization) ??
      str(p.LUT_Organization) ??
      'Heat relief site',
    org: str(p.Organization) ?? str(p.LUT_Organization),
    kind: azdhsKind(str(p.CoolingType), cooling, hydration),
    lon: round6(lon),
    lat: round6(lat),
    address: str(p.Address),
    city: str(p.City),
    phone: str(p.LocationPhone) ?? str(p.PrimaryPhone),
    hours: null, // this publisher has no free-text hours field
    hoursByDay: hours.byDay,
    open24,
    hoursKnown: hours.known || open24,
    services: str(p.Services) ?? str(p.Other_Services),
    pets: yesNo(str(p.Pets)),
    adaAccessible: yesNo(str(p.ADA_accessible) ?? str(p.Wheelchair_access)),
    seasonStart: str(p.Start_Date),
    seasonEnd: str(p.End_Date),
    source: 'azdhs',
    verifiedDate: today,
  };
}

/** Both schemas use the same <Day>Open / <Day>Close field naming. */
function readDayHours(p: Record<string, unknown>) {
  const byDay: ReliefSite['hoursByDay'] = [];
  let known = false;
  let open24 = false;

  for (const [openField, closeField] of DAY_FIELDS) {
    const openMin = parseClock(str(p[openField]));
    const closeMin = parseClock(str(p[closeField]));
    if (openMin === null || closeMin === null) {
      byDay.push(null);
      continue;
    }
    known = true;
    // 00:00-00:00 and 12:00 AM - 11:59 PM are both "all day" in these feeds.
    if (openMin === closeMin || (openMin === 0 && closeMin >= 1439)) open24 = true;
    byDay.push({ openMin, closeMin });
  }

  return { byDay, known, open24 };
}

function magKind(t: string | null): ReliefSite['kind'] {
  switch ((t ?? '').toLowerCase()) {
    case 'cooling center':
      return 'cooling_center';
    case 'hydration station':
      return 'hydration_station';
    case 'respite center':
      return 'respite_center';
    default:
      return 'collection_site';
  }
}

function azdhsKind(
  coolingType: string | null,
  cooling: boolean | null,
  hydration: boolean | null,
): ReliefSite['kind'] {
  const t = (coolingType ?? '').toLowerCase();
  if (t.includes('respite')) return 'respite_center';
  if (cooling) return 'cooling_center';
  if (hydration) return 'hydration_station';
  return 'collection_site';
}

/* -------------------------------------------------------------------------- */

function str(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === '' || s.toLowerCase() === 'null' ? null : s;
}

function yesNo(v: string | null): boolean | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (s.startsWith('y')) return true;
  if (s.startsWith('n')) return false;
  return null;
}

function round6(n: number) {
  return Math.round(n * 1e6) / 1e6;
}

function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const i of items) {
    const k = key(i);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
