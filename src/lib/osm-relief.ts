/**
 * The OpenStreetMap relief adapter, callable from anywhere.
 *
 * This code was `fetchFromOsm` and its helpers inside
 * scripts/fetch-heat-relief.ts. It moved here unchanged so that two callers can
 * share it:
 *
 *   1. scripts/fetch-heat-relief.ts, which writes data/<region>/relief-sites.json
 *      for a curated region at build time. Its behaviour is unaffected - it
 *      still calls the same function with the same arguments and writes the same
 *      file.
 *   2. src/app/api/draft/bootstrap, which needs the same mapping at REQUEST time
 *      for a region a user has just drawn, and cannot import from scripts/
 *      because that module reads argv and the filesystem.
 *
 * Nothing here touches `node:fs` or `process.argv`, which is the whole point:
 * this is the half of the old script that is pure network-and-mapping, and the
 * script keeps the half that is I/O.
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
 */
import { parseClock } from './relief';
import { regionBbox, type Region } from './regions';
import type { ReliefSite } from './types';

interface OverpassRelief {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/**
 * Fetch the OSM amenity set for a region's focus area and map it to ReliefSite.
 *
 * Hours are the weakest part and are handled conservatively. OSM's
 * `opening_hours` grammar is far richer than the simple per-day windows this
 * app models, so only the unambiguous cases are parsed - "24/7", and simple
 * `Mo-Fr 09:00-17:00` forms. Anything else is marked hoursKnown: false, which
 * the existing coverage logic already treats as "counted, but reported
 * separately" rather than silently assuming the site is open.
 */
export async function fetchOsmRelief(
  region: Region,
  today: string,
  overpassAttempts = 3,
  endpoints?: string[],
  backoffMs = 20_000,
): Promise<ReliefSite[]> {
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

  /*
   * Mirror failover, and it is not optional for the draft path.
   *
   * The build script has always used the single endpoint named on the region,
   * and retried it - fine when nobody is waiting. A drafted region fetches this
   * with one attempt inside an HTTP request, and the first thing that happened
   * in testing was a 504 from the main mirror taking the whole draft down.
   *
   * Callers that pass no list keep the old single-endpoint behaviour exactly,
   * so the committed pipeline is unchanged.
   */
  const targets = endpoints?.length ? endpoints : [region.relief.endpoint];
  let json: { elements?: OverpassRelief[] } | null = null;
  let lastErr: unknown;
  for (const endpoint of targets) {
    try {
      json = await overpassJson(endpoint, query, overpassAttempts, backoffMs);
      break;
    } catch (err) {
      lastErr = err;
      if (targets.length > 1) {
        console.warn(
          `[relief] ${new URL(endpoint).host} failed ` +
            `(${err instanceof Error ? err.message.slice(0, 60) : err}), next mirror`,
        );
      }
    }
  }
  if (!json) {
    throw lastErr instanceof Error ? lastErr : new Error('Overpass failed');
  }

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

/**
 * POST a query to Overpass, with the two headers it insists on.
 *
 * Overpass sits behind mod_security and answers 406 to a request with no
 * Accept and no identifiable User-Agent - which is exactly what Node's fetch
 * sends by default. src/lib/osm-context.ts learned this the same way; the note
 * is repeated here because the failure is a 406, which reads like "bad query"
 * rather than "missing header".
 *
 * `attempts` is a parameter rather than a constant because the two callers have
 * genuinely different patience. A build-time script can afford three tries with
 * 20-second waits; a draft bootstrap answering an HTTP request cannot, and
 * passes 1.
 */
export async function overpassJson(
  endpoint: string,
  query: string,
  attempts = 3,
  backoffMs = 20_000,
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
        const wait = attempt * backoffMs;
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

export function osmKind(amenity: string): ReliefSite['kind'] {
  if (amenity === 'drinking_water' || amenity === 'water_point') return 'hydration_station';
  if (amenity === 'social_facility') return 'respite_center';
  return 'cooling_center';
}

export function osmFallbackName(amenity: string): string {
  switch (amenity) {
    case 'drinking_water':
      return 'Drinking water';
    case 'water_point':
      return 'Water point';
    default:
      return amenity.replace(/_/g, ' ') || 'Unnamed site';
  }
}

export function joinAddress(tags: Record<string, string>): string | null {
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
export function parseOsmHours(raw: string | null): {
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
