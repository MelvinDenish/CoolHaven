/**
 * Real routing (Addition 2).
 *
 * Provider order, and the reasoning behind it:
 *
 *   1. OpenRouteService  - preferred. Free key, real alternative-route support,
 *                          and the alternatives are genuinely distinct paths
 *                          rather than minor variations.
 *   2. OSRM public demo  - keyless fallback so the repo works for anyone who
 *                          clones it without signing up for anything.
 *   3. offline           - a straight line with an assumed speed, clearly
 *                          labelled as such in the UI.
 *
 * What this does NOT do is put live routing on the judged path. The demo
 * routes and the demo worker trip are resolved at BUILD time by
 * scripts/generate-routes.ts and committed to data/routes.json, so the
 * rehearsed demo runs with the network unplugged (base PRD section 7, Demo
 * reliability). Live routing serves arbitrary user-entered trips only, and
 * degrades visibly when it is unavailable.
 */
import { measureRoute } from './scoring';
import type { DataSource, LonLat, RouteFeature } from './types';

export interface RoutePlanRequest {
  start: LonLat;
  end: LonLat;
  /** Optional single via point - the Worker view exposes one. */
  via?: LonLat;
  /** Ask the router for a second, distinct path to compare on heat. */
  wantAlternatives?: boolean;
  profile?: 'driving-car' | 'cycling-regular' | 'foot-walking';
}

export interface RoutePlanResult {
  routes: RouteFeature[];
  provider: DataSource;
  /** Set when we fell back; the UI shows this verbatim. */
  degradedReason?: string;
}

/**
 * OpenRouteService base URL.
 *
 * Overridable because ORS is mid-migration: the dashboard now warns that
 * `api.openrouteservice.org` is being deprecated in favour of `api.heigit.org`.
 * The old host still answers, so it stays the default rather than betting the
 * demo on a cutover date we do not control - set ORS_BASE_URL to switch hosts
 * without a code change once the new one is confirmed working on your key.
 */
const ORS_BASE =
  process.env.ORS_BASE_URL?.trim() || 'https://api.openrouteservice.org';

export async function planRoute(
  req: RoutePlanRequest,
  env: { orsKey?: string; osrmBase?: string } = {},
): Promise<RoutePlanResult> {
  const orsKey = env.orsKey ?? process.env.ORS_API_KEY;
  const osrmBase =
    env.osrmBase ?? process.env.OSRM_BASE_URL ?? 'https://router.project-osrm.org';

  if (orsKey) {
    try {
      return await viaOrs(req, orsKey);
    } catch (err) {
      // Fall through rather than fail: a rate-limited key should not take the
      // feature down when a keyless provider is sitting right there.
      const reason = err instanceof Error ? err.message : String(err);
      try {
        const osrm = await viaOsrm(req, osrmBase);
        return {
          ...osrm,
          degradedReason: `OpenRouteService unavailable (${reason}); used OSRM.`,
        };
      } catch {
        return offlineFallback(req, `Both routers unavailable (${reason}).`);
      }
    }
  }

  try {
    return await viaOsrm(req, osrmBase);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return offlineFallback(req, `No ORS_API_KEY set and OSRM unavailable (${reason}).`);
  }
}

/* -------------------------------------------------------------------------- */
/* OpenRouteService                                                           */
/* -------------------------------------------------------------------------- */

async function viaOrs(req: RoutePlanRequest, apiKey: string): Promise<RoutePlanResult> {
  const coordinates = req.via ? [req.start, req.via, req.end] : [req.start, req.end];
  const profile = req.profile ?? 'driving-car';

  const body: Record<string, unknown> = { coordinates, instructions: false };
  // ORS only computes alternatives for a plain two-point request.
  if (req.wantAlternatives && coordinates.length === 2) {
    body.alternative_routes = { target_count: 2, share_factor: 0.6, weight_factor: 1.6 };
  }

  const res = await fetch(`${ORS_BASE}/v2/directions/${profile}/geojson`, {
    method: 'POST',
    headers: {
      authorization: apiKey,
      'content-type': 'application/json',
      accept: 'application/geo+json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`ORS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    features?: Array<{
      geometry: { coordinates: LonLat[] };
      properties?: { summary?: { distance?: number; duration?: number } };
    }>;
  };

  const routes = (json.features ?? []).map((f, i) =>
    toRouteFeature({
      coords: f.geometry.coordinates,
      distanceM: f.properties?.summary?.distance,
      durationS: f.properties?.summary?.duration,
      index: i,
      provider: 'ors',
    }),
  );

  if (routes.length === 0) throw new Error('ORS returned no route');
  return { routes, provider: 'ors' };
}

/* -------------------------------------------------------------------------- */
/* OSRM                                                                       */
/* -------------------------------------------------------------------------- */

async function viaOsrm(req: RoutePlanRequest, base: string): Promise<RoutePlanResult> {
  const pts = req.via ? [req.start, req.via, req.end] : [req.start, req.end];
  const path = pts.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';');
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    // OSRM only honours alternatives on a two-point query, same as ORS.
    alternatives: req.wantAlternatives && pts.length === 2 ? 'true' : 'false',
  });

  const res = await fetch(
    `${base.replace(/\/+$/, '')}/route/v1/driving/${path}?${params}`,
    { headers: { accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`OSRM ${res.status}`);

  const json = (await res.json()) as {
    code?: string;
    routes?: Array<{
      geometry: { coordinates: LonLat[] };
      distance: number;
      duration: number;
    }>;
  };
  if (json.code !== 'Ok' || !json.routes?.length) {
    throw new Error(`OSRM returned ${json.code ?? 'no routes'}`);
  }

  return {
    provider: 'osrm',
    routes: json.routes.map((r, i) =>
      toRouteFeature({
        coords: r.geometry.coordinates,
        distanceM: r.distance,
        durationS: r.duration,
        index: i,
        provider: 'osrm',
      }),
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Offline                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Straight line between the points. This is NOT a route and the UI says so -
 * it exists so that an offline demo of an ad-hoc trip still draws something
 * scoreable rather than throwing.
 */
function offlineFallback(req: RoutePlanRequest, reason: string): RoutePlanResult {
  const coords = req.via ? [req.start, req.via, req.end] : [req.start, req.end];
  const distanceM = measureRoute(coords);
  return {
    provider: 'offline',
    degradedReason: `${reason} Showing a direct line, not a road route.`,
    routes: [
      {
        id: 'offline-0',
        name: 'Direct line (not a road route)',
        persona: 'ad-hoc',
        coords,
        distanceM,
        // 25 km/h assumed straight-line speed, only used to fill the field.
        durationS: Math.round((distanceM / 25_000) * 3600),
        provider: 'offline',
      },
    ],
  };
}

function toRouteFeature(args: {
  coords: LonLat[];
  distanceM?: number;
  durationS?: number;
  index: number;
  provider: DataSource;
}): RouteFeature {
  const distanceM = args.distanceM ?? measureRoute(args.coords);
  return {
    id: `${args.provider}-${args.index}`,
    name: args.index === 0 ? 'Fastest route' : `Alternative ${args.index}`,
    persona: 'ad-hoc',
    coords: args.coords,
    distanceM: Math.round(distanceM),
    durationS: Math.round(args.durationS ?? (distanceM / 30_000) * 3600),
    provider: args.provider,
    fetchedAt: new Date().toISOString(),
    alternativeOf: args.index > 0 ? `${args.provider}-0` : undefined,
  };
}
