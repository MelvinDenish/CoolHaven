/**
 * Scenario sharing via the URL fragment.
 *
 * A planner who builds an option and cannot send it to a colleague has not
 * really produced anything. Accounts and a database would be the obvious way
 * to fix that and the wrong one for this product: base PRD section 5 rules
 * auth out, and a server-side store would break the "runs entirely from a
 * committed snapshot" property the whole architecture rests on.
 *
 * So a scenario travels in the URL fragment. The fragment specifically, not
 * the query string - it never reaches the server, which keeps the routes
 * cacheable and means a shared link leaves no request-log footprint.
 *
 * The encoding is a compact positional tuple rather than pretty JSON, because
 * the difference between a 300-character link and a 3,000-character one is the
 * difference between something you can paste into Slack and something you
 * cannot.
 */
import { INTERVENTIONS, INTERVENTION_KINDS } from './assumptions';
import type { Intervention, InterventionKind, LonLat } from './types';

/** Bumped if the tuple layout ever changes, so old links fail loudly. */
const VERSION = 1;

type Tuple = [
  number, // kind index
  number, // lon * 1e5
  number, // lat * 1e5
  number, // radius m
  number, // deltaF * 10
  Array<[number, number]>?, // corridor, same scaling
];

export interface SharedScenario {
  regionId: string;
  view: string;
  interventions: Intervention[];
}

export function encodeScenario(
  regionId: string,
  view: string,
  interventions: Intervention[],
): string {
  const tuples: Tuple[] = interventions.map((iv) => {
    const base: Tuple = [
      INTERVENTION_KINDS.indexOf(iv.kind),
      Math.round(iv.lon * 1e5),
      Math.round(iv.lat * 1e5),
      Math.round(iv.radiusM),
      Math.round(iv.deltaF * 10),
    ];
    if (iv.corridor?.length) {
      base[5] = iv.corridor.map(
        ([lon, lat]) =>
          [Math.round(lon * 1e5), Math.round(lat * 1e5)] as [number, number],
      );
    }
    return base;
  });

  return toBase64Url(JSON.stringify([VERSION, regionId, view, tuples]));
}

export function decodeScenario(encoded: string): SharedScenario | null {
  try {
    const parsed = JSON.parse(fromBase64Url(encoded)) as [
      number,
      string,
      string,
      Tuple[],
    ];
    const [version, regionId, view, tuples] = parsed;
    if (version !== VERSION || !Array.isArray(tuples)) return null;

    const interventions: Intervention[] = tuples.map((t, i) => {
      const kind: InterventionKind = INTERVENTION_KINDS[t[0]] ?? 'cooling_station';
      const spec = INTERVENTIONS[kind];
      const corridor: LonLat[] | undefined = t[5]?.map(
        ([x, y]) => [x / 1e5, y / 1e5] as LonLat,
      );
      return {
        id: `shared-${i}-${t[1]}-${t[2]}`,
        kind,
        label: `${spec.short} ${i + 1}`,
        lon: t[1] / 1e5,
        lat: t[2] / 1e5,
        radiusM: t[3] || spec.radiusM,
        deltaF: t[4] / 10,
        corridor,
        note: 'Restored from a shared link.',
      };
    });

    return { regionId, view, interventions };
  } catch {
    // A malformed fragment is someone pasting a truncated link, not a bug
    // worth crashing the app over. Fall back to an empty scenario.
    return null;
  }
}

/*
 * Exported so src/lib/draft-region.ts can put a drawn region in the same
 * fragment with the same encoding, rather than inventing a second one.
 */
export function toBase64Url(s: string): string {
  const b64 =
    typeof window === 'undefined'
      ? Buffer.from(s, 'utf8').toString('base64')
      : btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  if (typeof window === 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf8');
  }
  const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
