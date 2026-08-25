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
 *           no agency feed - see the block above `fetchFromOsm` for what this
 *           does and does not claim.
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
        ? await fetchFromOsm(region, today)
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

/**
 * OpenStreetMap fallback, for cities with no published heat-relief network.
 *
 * WHAT THIS IS: publicly mapped amenities that a worker could plausibly use to
 * get out of the heat or refill water - drinking fountains, libraries,
 * community centres, and social facilities.
 *
 * WHAT THIS IS NOT, and the UI says so on every region that uses it: an
 * agency-verified relief network. Maricopa's network is a list of places that
 * have agreed to take someone in, staffed, with published summer hours. This is
 * a list of places that exist. The difference matters for a coverage number, so
 * regions on this adapter are labelled `dataQuality: 'osm-derived'` and the
 * provenance bar says "community-mapped" rather than naming an agency.
 *
 * Hours are the weakest part and are handled conservatively. OSM's
 * `opening_hours` grammar is far richer than the simple per-day windows this
 * app models, so only the unambiguous cases are parsed - "24/7", and simple
 * `Mo-Fr 09:00-17:00` forms. Anything else is marked hoursKnown: false, which
 * the existing coverage logic already treats as "counted, but reported
 * separately" rather than silently assuming the site is open.
 */
async function fetchFromOsm(region: Region, today: string): Promise<ReliefSite[]> {
  const [w, s, e, n] = regionBbox(region);
  // A margin, so a site just outside the tiles still counts for a route that
  // clips the edge - the same +2 km logic verify-coverage uses.
  const pad = 0.02;
  const bbox = `${s - pad},${w - pad},${n + pad},${e + pad}`;

  /*
   * What counts as relief, and what does not.
   *
   * `amenity=shelter` is deliberately EXCLUDED, and this was a correctness bug
   * before it was a policy. Including it returned 427 of Tucson's 472 "relief
   * sites" - almost all bus shelters, tagged with stop names like
   * "Grant/1st Avenue". That produced a mean relief gap of 340 m against
   * Phoenix's 6,580 m, i.e. it made the OSM city look an order of magnitude
   * better served than the one with a real agency network.
   *
   * That is not a close call. A bus shelter is a few square metres of roof: no
   * water, no cooling, no staff, and nobody has undertaken to let a worker rest
   * there. Counting it as equivalent to a staffed cooling centre would have
   * inverted the finding this entire product exists to make.
   *
   * What is left is places a worker can actually get out of the heat or refill:
   * drinking water, libraries, community centres, social facilities.
   */
  const query = `[out:json][timeout:120];
    (
      node["amenity"="drinking_water"](${bbox});
      node["amenity"="water_point"](${bbox});
      nwr["amenity"="library"](${bbox});
      nwr["amenity"="community_centre"](${bbox});
      nwr["amenity"="social_facility"](${bbox});
    );
    out center tags;`;

  const json = await overpassJson(region.relief.endpoint, query);

  const sites: ReliefSite[] = [];
  for (const el of json.elements ?? []) {
    const lon = el.lon ?? el.center?.lon;
    const lat = el.lat ?? el.center?.lat;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const tags = el.tags ?? {};
    const amenity = tags.amenity ?? '';

    const hours = parseOsmHours(tags.opening_hours ?? null);
    sites.push({
      id: `osm-${el.type}-${el.id}`,
      name: tags.name ?? osmFallbackName(amenity),
      org: tags.operator ?? null,
      kind: osmKind(amenity),
      lon: lon!,
      lat: lat!,
      address: joinAddress(tags),
      city: tags['addr:city'] ?? null,
      phone: tags.phone ?? tags['contact:phone'] ?? null,
      hours: tags.opening_hours ?? null,
      hoursByDay: hours.byDay,
      open24: hours.open24,
      hoursKnown: hours.known,
      services: amenity.replace(/_/g, ' '),
      // OSM models these separately and often leaves them unset; null is
      // "unknown", which the popup renders as unknown rather than as "no".
      pets: null,
      adaAccessible: tags.wheelchair === 'yes' ? true : tags.wheelchair === 'no' ? false : null,
      seasonStart: null,
      seasonEnd: null,
      source: 'osm',
      verifiedDate: today,
    });
  }
  return sites;
}

interface OverpassRelief {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * POST a query to Overpass, with the two headers it insists on.
 *
 * Overpass sits behind mod_security and answers 406 to a request with no
 * Accept and no identifiable User-Agent - which is exactly what Node's fetch
 * sends by default. scripts/fetch-osm.ts learned this the same way; the note is
 * repeated here because the failure is a 406, which reads like "bad query"
 * rather than "missing header".
 */
async function overpassJson(
  endpoint: string,
  query: string,
  attempts = 3,
): Promise<{ elements?: OverpassRelief[] }> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': 'CoolRouteNetworkPlanner/1.0 (FortyGuard Hackathon 2026)',
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) {
        throw new Error(`Overpass HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      }
      return (await res.json()) as { elements?: OverpassRelief[] };
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        const wait = attempt * 20_000;
        console.warn(
          `[relief] Overpass attempt ${attempt}/${attempts} failed ` +
            `(${err instanceof Error ? err.message.slice(0, 60) : err}), waiting ${wait / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Overpass failed');
}

function osmKind(amenity: string): ReliefSite['kind'] {
  if (amenity === 'drinking_water' || amenity === 'water_point') return 'hydration_station';
  if (amenity === 'social_facility') return 'respite_center';
  return 'cooling_center';
}

function osmFallbackName(amenity: string): string {
  switch (amenity) {
    case 'drinking_water':
      return 'Drinking water';
    case 'water_point':
      return 'Water point';
    default:
      return amenity.replace(/_/g, ' ') || 'Unnamed site';
  }
}

function joinAddress(tags: Record<string, string>): string | null {
  const parts = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/**
 * Parse the subset of OSM `opening_hours` this app can represent honestly.
 *
 * The grammar supports things this model has no way to express - seasonal
 * ranges, public-holiday exceptions, "sunrise-sunset", comma-separated split
 * shifts. Rather than half-parse those into a plausible-looking window, they
 * return known: false and the site is counted with the caveat the UI already
 * reports for publishers that give no hours at all.
 */
function parseOsmHours(raw: string | null): {
  byDay: ReliefSite['hoursByDay'];
  open24: boolean;
  known: boolean;
} {
  const empty: ReliefSite['hoursByDay'] = [null, null, null, null, null, null, null];
  if (!raw) return { byDay: empty, open24: false, known: false };

  const value = raw.trim();
  if (value === '24/7') {
    return { byDay: empty, open24: true, known: true };
  }

  // Only the simple `Mo-Fr 09:00-17:00` / `Sa 10:00-14:00` shape, possibly
  // several separated by ';'. Anything with a comma, a month or a keyword is
  // beyond what this model represents.
  if (/[,]|sunrise|sunset|PH|SH|off|\b\d{4}\b/i.test(value)) {
    return { byDay: empty, open24: false, known: false };
  }

  const DAY_INDEX: Record<string, number> = {
    su: 0, mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6,
  };
  const byDay: ReliefSite['hoursByDay'] = [null, null, null, null, null, null, null];
  let matched = false;

  for (const clause of value.split(';')) {
    const m = clause
      .trim()
      .match(/^([A-Za-z]{2})(?:\s*-\s*([A-Za-z]{2}))?\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!m) continue;
    const from = DAY_INDEX[m[1].toLowerCase()];
    const to = m[2] ? DAY_INDEX[m[2].toLowerCase()] : from;
    const openMin = parseClock(m[3]);
    const closeMin = parseClock(m[4]);
    if (from === undefined || to === undefined || openMin === null || closeMin === null) {
      continue;
    }
    // Ranges wrap: Fr-Mo is a legal way to write a weekend-inclusive span.
    for (let i = from; ; i = (i + 1) % 7) {
      byDay[i] = { openMin, closeMin };
      matched = true;
      if (i === to) break;
    }
  }

  return { byDay, open24: false, known: matched };
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
