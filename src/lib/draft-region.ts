/**
 * Draft regions - a city a user drew, rather than one the team curated.
 *
 * A region has always been three things: a set of bounding boxes, a relief
 * source, and a set of work routes. Two of those a user can supply from a
 * browser. This module turns that into a `Region` value at runtime, so every
 * downstream consumer - scoring, coverage, the demand layer, the what-if engine
 * - takes it without knowing the difference.
 *
 * WHAT A DRAFT IS NOT
 *
 * It is not a curated region with a shorter setup. Three things are genuinely
 * weaker, and the UI says all three rather than burying them:
 *
 *   1. Nobody chose the box. A curated tile covers where outdoor work actually
 *      happens, picked by looking. A drawn box covers what someone dragged.
 *   2. Relief is always OSM-derived - community-mapped amenities, not an
 *      agency's published network. See src/lib/osm-relief.ts.
 *   3. There are no work routes, so every route-derived metric is unavailable
 *      rather than zero.
 *
 * That is why `comparabilityKey` exists below. A drafted city's coverage number
 * must never be rendered in the same table as Phoenix's, and prose asking people
 * to remember that is not a control - the key is.
 *
 * WHERE IT LIVES
 *
 * In the URL fragment, encoded with the same helpers scenarios use
 * (src/lib/share.ts). The fragment carries the DEFINITION only - a name and up
 * to two boxes, a few hundred bytes. The data re-derives on open, because
 * relief sites and a heat field are megabytes and belong nowhere near a link.
 */
import { TILE_TARGET_MAX_MI2, tileAreaMi2 } from './config';
import { fromBase64Url, toBase64Url } from './share';
import type { Region } from './regions';
import type { Tile } from './types';

/** Bumped if the tuple layout changes, so old links fail loudly. */
const VERSION = 1;

/**
 * At most two boxes per draft.
 *
 * This is a credit control before it is a UX decision. Every tile is one
 * FortyGuard heatmap submission against the server's key, and the natural bound
 * that protected /api/admin/refresh-tile - it can only address tiles that exist
 * in REGIONS - does not exist once a user can draw one. Two matches the smaller
 * curated regions (Yuma, Tucson and Las Vegas all run two tiles), so it is not
 * a crippled tier, it is the same size.
 */
export const DRAFT_MAX_TILES = 2;

/** The smallest box worth measuring, in square miles. */
export const DRAFT_MIN_TILE_MI2 = 0.5;

export interface DraftInput {
  /** What the user called it. Free text, shown in the region dropdown. */
  name: string;
  /** One or two boxes, each [minLon, minLat, maxLon, maxLat]. */
  boxes: Array<[number, number, number, number]>;
  /**
   * Local UTC offset, as '-07:00'. Used to stamp validAt and to pick the
   * weekday when checking relief opening hours, so a wrong value shifts which
   * sites count as open - which is why it is asked for rather than guessed.
   */
  utcOffset: string;
}

export class DraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftValidationError';
  }
}

/**
 * Validate a drawn definition and build a Region from it.
 *
 * Throws rather than clamping. A box the user dragged too big is a thing they
 * can see and fix; silently shrinking it to 20 mi2 would measure somewhere
 * other than where they pointed and say nothing about it.
 */
export function buildDraftRegion(input: DraftInput): Region {
  const name = input.name.trim().slice(0, 60);
  if (!name) {
    throw new DraftValidationError('Give the area a name before fetching data.');
  }

  if (!Array.isArray(input.boxes) || input.boxes.length === 0) {
    throw new DraftValidationError('Draw at least one box on the map.');
  }
  if (input.boxes.length > DRAFT_MAX_TILES) {
    throw new DraftValidationError(
      `A drafted city can cover at most ${DRAFT_MAX_TILES} boxes. ` +
        'Each box is one live call against the temperature API, so the limit is a ' +
        'cost control rather than a technical one.',
    );
  }
  if (!/^[+-]\d{2}:\d{2}$/.test(input.utcOffset)) {
    throw new DraftValidationError(
      `"${input.utcOffset}" is not a UTC offset. Expected a form like -07:00.`,
    );
  }

  const tiles: Tile[] = input.boxes.map((raw, i) => {
    const bbox = normaliseBbox(raw);
    const area = tileAreaMi2(bbox);

    if (area > TILE_TARGET_MAX_MI2) {
      throw new DraftValidationError(
        `Box ${i + 1} is ${area.toFixed(1)} mi2, over the ${TILE_TARGET_MAX_MI2} mi2 ` +
          'limit a single temperature request can cover. Draw a smaller area, or split ' +
          'it into two boxes.',
      );
    }
    if (area < DRAFT_MIN_TILE_MI2) {
      throw new DraftValidationError(
        `Box ${i + 1} is ${area.toFixed(2)} mi2, too small to say anything useful ` +
          'about. The grid is 100 m cells, so a box this size is a handful of them.',
      );
    }

    return {
      id: `box-${i + 1}`,
      label: `Box ${i + 1}`,
      bbox,
      blurb: 'Drawn by hand in the browser. Nobody vetted this boundary.',
    };
  });

  return {
    id: draftIdFor(input),
    origin: 'draft',
    name,
    subtitle: 'Drafted in the browser',
    blurb:
      'A user-drawn area. Relief data is community-mapped OpenStreetMap amenities, ' +
      'and there are no work routes, so route-based findings are unavailable rather ' +
      'than zero.',
    center: centreOf(tiles),
    workforce: 'Unknown - no work routes have been supplied for this area',
    utcOffset: input.utcOffset,
    // Only the modelled stand-in reads this, and a drafted city has no
    // measured baseline to offset against. Zero is the honest default.
    syntheticOffsetF: 0,
    tiles,
    relief: {
      kind: 'osm',
      endpoint: 'https://overpass-api.de/api/interpreter',
      where: '',
      attribution:
        'Amenity locations (c) OpenStreetMap contributors, ODbL, via Overpass API. ' +
        'Community-mapped amenities, not an agency-published heat-relief network.',
      label: 'OpenStreetMap amenities',
      dataQuality: 'osm-derived',
    },
  };
}

/**
 * Which regions' numbers may be compared with each other.
 *
 * Curated agency regions share a key and can sit in one table. Curated OSM
 * regions share a different one. Every draft gets a key of its own, because two
 * people's hand-drawn boxes are not measuring comparable things either - not
 * even against each other.
 */
export function comparabilityKey(region: Region): string {
  if (region.origin === 'draft') return `draft:${region.id}`;
  return `curated:${region.relief.dataQuality}`;
}

export function isDraft(region: Region): region is Region & { origin: 'draft' } {
  return region.origin === 'draft';
}

/* -------------------------------------------------------------------------- */
/* Fragment encoding                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A compact positional tuple, same approach and same base64url helpers as
 * scenario sharing. Coordinates keep 5 decimal places - about a metre, and far
 * more than a hand-drawn box justifies.
 */
export function encodeDraft(input: DraftInput): string {
  const boxes = input.boxes.map((b) => b.map((n) => Math.round(n * 1e5)));
  return toBase64Url(JSON.stringify([VERSION, input.name, input.utcOffset, boxes]));
}

export function decodeDraft(encoded: string): DraftInput | null {
  try {
    const parsed = JSON.parse(fromBase64Url(encoded)) as [
      number,
      string,
      string,
      number[][],
    ];
    const [version, name, utcOffset, boxes] = parsed;
    if (version !== VERSION || !Array.isArray(boxes) || boxes.length === 0) return null;

    return {
      name,
      utcOffset,
      boxes: boxes.map(
        (b) =>
          [b[0] / 1e5, b[1] / 1e5, b[2] / 1e5, b[3] / 1e5] as [
            number,
            number,
            number,
            number,
          ],
      ),
    };
  } catch {
    // A truncated paste, not a bug worth crashing over. The caller falls back
    // to the default curated region.
    return null;
  }
}

/* -------------------------------------------------------------------------- */

/**
 * A stable id for a definition.
 *
 * Stable matters: it is the cache key for the derived data, so re-opening the
 * same link inside a warm server instance costs nothing rather than re-running
 * Overpass and re-spending a credit.
 */
export function draftIdFor(input: DraftInput): string {
  const canonical = JSON.stringify([
    input.name.trim().toLowerCase(),
    input.utcOffset,
    input.boxes.map((b) => normaliseBbox(b).map((n) => Math.round(n * 1e4))),
  ]);
  let hash = 5381;
  for (let i = 0; i < canonical.length; i++) {
    hash = ((hash << 5) + hash + canonical.charCodeAt(i)) | 0;
  }
  return `draft-${(hash >>> 0).toString(36)}`;
}

/** Accept a box dragged in any direction. */
function normaliseBbox(
  b: [number, number, number, number],
): [number, number, number, number] {
  const [a, c, d, e] = b;
  if (![a, c, d, e].every((n) => Number.isFinite(n))) {
    throw new DraftValidationError('That box has invalid coordinates.');
  }
  return [Math.min(a, d), Math.min(c, e), Math.max(a, d), Math.max(c, e)];
}

function centreOf(tiles: Tile[]): [number, number] {
  const lon = tiles.reduce((a, t) => a + (t.bbox[0] + t.bbox[2]) / 2, 0) / tiles.length;
  const lat = tiles.reduce((a, t) => a + (t.bbox[1] + t.bbox[3]) / 2, 0) / tiles.length;
  return [lon, lat];
}
