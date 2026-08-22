/**
 * Build each region's work-route set on the REAL road network
 * (Addition 2 + base PRD FR7).
 *
 * FR7 required a concrete generation method for the delivery routes rather
 * than leaving it undefined. This is it:
 *
 *   1. Per region, a set of depot -> work-zone runs defined by real named
 *      locations inside the focus tiles.
 *   2. Every run is resolved by an actual routing engine (OpenRouteService if
 *      ORS_API_KEY is set, otherwise the public OSRM demo server), so the
 *      geometry follows real streets and turn restrictions.
 *   3. The result is COMMITTED to data/<region>/routes.json.
 *
 * Point 3 is what matters for the demo. Live routing on the judged path would
 * make a rehearsed demo depend on someone else's uptime; the routes a judge
 * sees are baked in, and live routing only serves ad-hoc trips a user types.
 *
 * The two regions carry deliberately different work: Phoenix is last-mile
 * parcel and municipal crews, Yuma is agricultural and utility crews moving
 * between packing sheds and field blocks. Same engine, same scoring, different
 * shape of day - which is the point of having a second region at all.
 *
 * Run:  npm run data:routes
 *       npm run data:routes -- --region=yuma
 */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { planRoute } from '../src/lib/routing';
import { regionsFromArgv, type Region } from '../src/lib/regions';
import type { LonLat, RouteFeature } from '../src/lib/types';

loadEnv({ path: '.env.local' });
loadEnv();

interface RouteSpec {
  id: string;
  name: string;
  persona: string;
  shift: string;
  stops: LonLat[];
}

interface RegionRoutes {
  runs: RouteSpec[];
  /** Two points only - both routers need that shape to return alternatives. */
  demo: { id: string; name: string; from: LonLat; to: LonLat };
}

const ROUTE_SETS: Record<string, RegionRoutes> = {
  phoenix: {
    runs: [
      {
        id: 'r1-airport-downtown',
        name: 'Air cargo to downtown core',
        persona: 'Parcel courier - van',
        shift: '11:00 - 15:00',
        stops: [
          [-112.0055, 33.4266],
          [-112.0362, 33.4453],
          [-112.0642, 33.4501],
          [-112.0754, 33.4498],
        ],
      },
      {
        id: 'r2-warehouse-civic',
        name: 'South 7th warehouse to civic centre',
        persona: 'Parcel courier - van',
        shift: '12:00 - 16:00',
        stops: [
          [-112.0664, 33.4197],
          [-112.0688, 33.4402],
          [-112.0723, 33.4506],
          [-112.0537, 33.452],
        ],
      },
      {
        id: 'r3-buckeye-industrial',
        name: 'Buckeye Road industrial run',
        persona: 'Utility / meter crew',
        shift: '10:00 - 14:00',
        stops: [
          [-112.0402, 33.4198],
          [-112.0154, 33.4225],
          [-111.9946, 33.4262],
          [-111.9903, 33.44],
        ],
      },
      {
        id: 'r4-central-spine',
        name: 'Central Avenue office spine',
        persona: 'Bike courier',
        shift: '13:00 - 17:00',
        stops: [
          [-112.074, 33.456],
          [-112.0738, 33.4794],
          [-112.0736, 33.502],
          [-112.0691, 33.509],
        ],
      },
      {
        id: 'r5-midtown-grid',
        name: 'Midtown residential drop grid',
        persona: 'Parcel courier - van',
        shift: '14:00 - 18:00',
        stops: [
          [-112.0908, 33.4842],
          [-112.0612, 33.487],
          [-112.0585, 33.5058],
          [-112.0894, 33.5062],
        ],
      },
      {
        id: 'r6-postal-loop',
        name: 'Downtown postal relief loop',
        persona: 'Postal carrier',
        shift: '09:00 - 13:00',
        stops: [
          [-112.0836, 33.4455],
          [-112.0836, 33.4655],
          [-112.0562, 33.4658],
          [-112.0566, 33.4452],
        ],
      },
      {
        id: 'r7-sky-harbor-perimeter',
        name: 'Sky Harbor perimeter service run',
        persona: 'Municipal crew',
        shift: '12:00 - 16:00',
        stops: [
          [-112.0219, 33.4358],
          [-111.9925, 33.4356],
          [-111.9887, 33.4487],
          [-112.0195, 33.4523],
        ],
      },
      {
        id: 'r8-westside-connector',
        name: 'West downtown to midtown connector',
        persona: 'Rideshare / delivery hybrid',
        shift: '15:00 - 19:00',
        stops: [
          [-112.0954, 33.4392],
          [-112.0946, 33.4652],
          [-112.081, 33.4884],
          [-112.0603, 33.4966],
        ],
      },
    ],
    // Both ends sit INSIDE the measured tiles, which is a hard requirement
    // rather than a nicety. downtown-core and midtown-camelback form a
    // contiguous two-tile column (lon -112.0980..-112.0450, lat
    // 33.4350..33.5150); an endpoint outside it lets the router escape onto a
    // freeway, and then the Worker view scores a run whose temperatures are
    // extrapolated from a tile edge instead of measured. The earlier start at
    // 33.4197 sat below downtown-core's south edge and did exactly that: 83%
    // of its samples fell outside coverage.
    demo: {
      id: 'worker-demo',
      name: 'Union Station depot to Camelback drop',
      from: [-112.0736, 33.4438], // Phoenix Union Station, in downtown-core
      to: [-112.0691, 33.509], //    Camelback Rd, in midtown-camelback
    },
  },

  yuma: {
    runs: [
      {
        id: 'y1-airport-downtown',
        name: 'Airport freight to downtown',
        persona: 'Parcel courier - van',
        shift: '11:00 - 15:00',
        stops: [
          [-114.606, 32.6566],
          [-114.6209, 32.6858],
          [-114.6244, 32.7256],
        ],
      },
      {
        id: 'y2-medical-district',
        name: 'Medical district supply run',
        persona: 'Medical courier',
        shift: '12:00 - 16:00',
        stops: [
          [-114.6297, 32.6858],
          [-114.6135, 32.6994],
          [-114.6218, 32.7204],
        ],
      },
      {
        id: 'y3-4th-avenue',
        name: '4th Avenue commercial strip',
        persona: 'Delivery driver',
        shift: '13:00 - 17:00',
        stops: [
          [-114.6231, 32.6602],
          [-114.6229, 32.6889],
          [-114.6226, 32.7124],
        ],
      },
      {
        id: 'y4-somerton-fields',
        name: 'Somerton field block circuit',
        persona: 'Agricultural crew transport',
        shift: '05:00 - 13:00',
        stops: [
          [-114.7099, 32.5964],
          [-114.7301, 32.6062],
          [-114.6961, 32.6183],
          [-114.6994, 32.5822],
        ],
      },
      {
        id: 'y5-packing-shed',
        name: 'Packing shed to field crew relay',
        persona: 'Agricultural crew transport',
        shift: '06:00 - 14:00',
        stops: [
          [-114.6853, 32.5771],
          [-114.7188, 32.5891],
          [-114.7387, 32.6134],
        ],
      },
      {
        id: 'y6-utility-south',
        name: 'South county utility circuit',
        persona: 'Utility / meter crew',
        shift: '10:00 - 14:00',
        stops: [
          [-114.6893, 32.6216],
          [-114.7204, 32.6098],
          [-114.7362, 32.5849],
        ],
      },
      {
        id: 'y7-municipal-parks',
        name: 'Municipal parks and grounds run',
        persona: 'Municipal crew',
        shift: '09:00 - 15:00',
        stops: [
          [-114.6402, 32.6712],
          [-114.6089, 32.6903],
          [-114.5981, 32.7141],
        ],
      },
    ],
    // Yuma's two tiles are genuinely disjoint - somerton-corridor sits south-
    // west of yuma-core with unmeasured desert between them - so a Somerton
    // start put roughly half the demo run on extrapolated ground. Both ends
    // now sit inside yuma-core (lon -114.6520..-114.5860, lat
    // 32.6550..32.7260). The Somerton runs are still in the fleet; it is only
    // the single scored demo trip that has to stay on measured streets.
    demo: {
      id: 'worker-demo',
      name: 'Airport freight depot to Yuma Regional Medical Center',
      from: [-114.606, 32.6566], // Yuma International Airport, in yuma-core
      to: [-114.6297, 32.6858], //  Yuma Regional Medical Center, in yuma-core
    },
  },
};

async function main() {
  const hasOrs = Boolean(process.env.ORS_API_KEY);
  console.log(
    `[routes] router: ${hasOrs ? 'OpenRouteService (ORS_API_KEY present)' : 'public OSRM demo (no ORS_API_KEY)'}`,
  );
  for (const region of regionsFromArgv()) {
    await buildRegion(region);
  }
}

async function buildRegion(region: Region) {
  const set = ROUTE_SETS[region.id];
  if (!set) {
    throw new Error(
      `[routes:${region.id}] no route set defined. Add one to ROUTE_SETS in this file.`,
    );
  }

  const out = resolve(process.cwd(), `data/${region.id}/routes.json`);
  const routes: RouteFeature[] = [];
  const failures: string[] = [];
  let provider = 'offline';

  for (const spec of set.runs) {
    // Multi-stop runs are resolved leg by leg and stitched: both routers drop
    // alternatives once there is a via point anyway, and leg stitching keeps
    // one slow leg from failing an entire run.
    const legs: LonLat[][] = [];
    let distanceM = 0;
    let durationS = 0;
    let ok = true;

    for (let i = 1; i < spec.stops.length; i++) {
      const res = await planRoute({ start: spec.stops[i - 1], end: spec.stops[i] });
      if (res.provider === 'offline') {
        ok = false;
        failures.push(
          `${spec.id} leg ${i}: ${res.degradedReason ?? 'router unavailable'}`,
        );
        break;
      }
      provider = res.provider;
      const r = res.routes[0];
      legs.push(i === 1 ? r.coords : r.coords.slice(1));
      distanceM += r.distanceM;
      durationS += r.durationS;
      await sleep(350); // be polite to the public demo server
    }

    if (!ok) continue;

    routes.push({
      id: spec.id,
      name: spec.name,
      persona: `${spec.persona} | ${spec.shift}`,
      coords: legs.flat(),
      distanceM: Math.round(distanceM),
      durationS: Math.round(durationS),
      provider: provider as RouteFeature['provider'],
      fetchedAt: new Date().toISOString(),
    });
    console.log(
      `[routes:${region.id}] ${spec.id}: ${(distanceM / 1000).toFixed(1)} km, ${legs.flat().length} points`,
    );
  }

  console.log(`[routes:${region.id}] resolving the demo trip with alternatives...`);
  const demo = await planRoute({
    start: set.demo.from,
    end: set.demo.to,
    wantAlternatives: true,
  });

  const workerPrimary: RouteFeature = {
    ...demo.routes[0],
    id: `${set.demo.id}-primary`,
    name: `${set.demo.name} - fastest`,
    persona: region.workforce.split(',')[0],
  };
  const workerAlt: RouteFeature | null = demo.routes[1]
    ? {
        ...demo.routes[1],
        id: `${set.demo.id}-alt`,
        name: `${set.demo.name} - alternative`,
        persona: region.workforce.split(',')[0],
        alternativeOf: `${set.demo.id}-primary`,
      }
    : null;

  console.log(
    `[routes:${region.id}] demo: primary ${(workerPrimary.distanceM / 1000).toFixed(1)} km` +
      (workerAlt
        ? `, alternative ${(workerAlt.distanceM / 1000).toFixed(1)} km`
        : ', NO alternative returned'),
  );

  if (routes.length === 0) {
    if (existsSync(out)) {
      console.warn(`[routes:${region.id}] every request failed. Keeping ${out}.`);
      console.warn(failures.map((f) => `  - ${f}`).join('\n'));
      return;
    }
    throw new Error(
      `[routes:${region.id}] no routes resolved and no previous file:\n${failures.join('\n')}`,
    );
  }

  const payload = {
    schema: 'coolroute.routes.v2' as const,
    regionId: region.id,
    generatedAt: new Date().toISOString(),
    provider,
    note:
      'Routes follow the real road network, resolved once at build time and committed so the ' +
      'demo runs with no network. Depot and work-zone endpoints are real named locations ' +
      'inside the focus tiles; the runs themselves are representative, not an operator manifest.',
    failures,
    routes,
    workerDemo: { primary: workerPrimary, alternative: workerAlt },
  };

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(payload, null, 1));
  console.log(`[routes:${region.id}] wrote ${routes.length} routes -> ${out}`);
  if (failures.length) {
    console.warn(`[routes:${region.id}] ${failures.length} leg(s) failed`);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
