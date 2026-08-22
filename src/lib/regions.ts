/**
 * Region definitions - the multi-city layer.
 *
 * Addendum A3 promised that expansion is additive: "same pattern, more tiles,
 * not a redesign". This file is that promise made real. A region is a name, a
 * set of AOI tiles, and a source for its relief network. Everything downstream
 * - ingestion, caching, scoring, the demand layer, the UI - is region-agnostic
 * and takes a `Region` as input.
 *
 * Adding a third city is: add an entry here, then
 * `npm run data:all -- --region=<id>`. No code changes anywhere else.
 *
 * Why these two:
 *
 *   Phoenix  - the flagship. Dense last-mile courier work, and the Maricopa
 *              Association of Governments publishes the richest Heat Relief
 *              Network dataset in the state.
 *   Yuma     - the stress test, and arguably the stronger case for the
 *              product. One of the hottest cities in the United States, with
 *              an outdoor agricultural workforce rather than a courier one, a
 *              different relief-data publisher with a different schema, and
 *              roughly a tenth of Phoenix's site density. If the engine works
 *              here it is not quietly overfitted to Phoenix.
 */
import type { Tile } from './types';

/**
 * Where a region's relief-network data comes from.
 *
 * The two publishers expose different schemas, which is exactly the kind of
 * thing that makes "just add a city" quietly expensive if it is not handled
 * once. `kind` selects the field mapping in scripts/fetch-heat-relief.ts.
 */
export interface ReliefSource {
  /** Field-mapping strategy. */
  kind: 'magHRN' | 'azdhs';
  /** ArcGIS FeatureServer layer query endpoint. */
  endpoint: string;
  /** Server-side filter, so we never download a whole state to discard it. */
  where: string;
  attribution: string;
  /** Human-readable provenance, rendered in the UI. */
  label: string;
}

export interface Region {
  id: string;
  /** Shown in the region dropdown. */
  name: string;
  /** Second line in the dropdown - the administrative area. */
  subtitle: string;
  /** One line on why this region is in the product. */
  blurb: string;
  center: [number, number];
  tiles: Tile[];
  relief: ReliefSource;
  /** The date the committed snapshot describes. */
  snapshotDate: string;
  /** Persona framing for this region's sample fleet. */
  workforce: string;
  /**
   * Regional temperature offset in degrees F for the modelled stand-in only
   * (src/lib/synthetic.ts). Ignored entirely when live FortyGuard data is
   * present. Phoenix is the 0 reference; Yuma runs consistently hotter, and a
   * model that gave two cities 300 km apart the identical curve would be a
   * more obvious fiction than the model already is.
   */
  syntheticOffsetF: number;
}

export const REGIONS: Region[] = [
  {
    id: 'phoenix',
    name: 'Phoenix, AZ',
    subtitle: 'Maricopa County',
    blurb:
      'Dense last-mile courier work across the downtown core, the Sky Harbor freight corridor and the midtown drop grid.',
    center: [-112.062, 33.462],
    workforce: 'Parcel couriers, postal carriers, utility and municipal crews',
    snapshotDate: '2026-08-21',
    syntheticOffsetF: 0,
    tiles: [
      {
        id: 'downtown-core',
        label: 'Downtown Core',
        bbox: [-112.098, 33.435, -112.045, 33.475],
        blurb:
          'Civic centre, courthouse and the dense last-mile drop cluster around Van Buren.',
      },
      {
        id: 'sky-harbor-corridor',
        label: 'Sky Harbor Logistics Corridor',
        bbox: [-112.045, 33.415, -111.985, 33.455],
        blurb:
          'Airport freight, depots and the Washington/Buckeye industrial run - highest courier volume.',
      },
      {
        id: 'midtown-camelback',
        label: 'Midtown / Camelback',
        bbox: [-112.098, 33.475, -112.045, 33.515],
        blurb:
          'Central Ave offices and the midtown residential drop grid worked through the afternoon peak.',
      },
    ],
    relief: {
      kind: 'magHRN',
      endpoint:
        'https://services1.arcgis.com/MdyCMZnX1raZ7TS3/arcgis/rest/services/HRN_Public_view/FeatureServer/0/query',
      where: '1=1',
      attribution:
        'Maricopa Association of Governments (MAG) Heat Relief Network, public feature service. Locations, hours and services as published by MAG.',
      label: 'MAG Heat Relief Network',
    },
  },
  {
    id: 'yuma',
    name: 'Yuma, AZ',
    subtitle: 'Yuma County',
    blurb:
      'One of the hottest cities in the US. Agricultural and municipal outdoor work across the city core and the Somerton field corridor, at roughly a tenth of Phoenix relief density.',
    center: [-114.635, 32.665],
    workforce: 'Agricultural crews, municipal and utility workers, delivery drivers',
    snapshotDate: '2026-08-21',
    // Yuma runs a few degrees above Phoenix through the summer afternoon.
    syntheticOffsetF: 2.5,
    tiles: [
      {
        id: 'yuma-core',
        label: 'Yuma City Core',
        // Spans the airport in the south through Yuma Regional Medical Center
        // to the historic downtown grid in the north. 18.8 mi2.
        bbox: [-114.652, 32.655, -114.586, 32.726],
        blurb:
          'Historic downtown, the medical district, the airport freight apron and the 4th Avenue commercial strip.',
      },
      {
        id: 'somerton-corridor',
        label: 'Somerton Field Corridor',
        // Somerton plus the irrigated field blocks running north toward Yuma.
        bbox: [-114.745, 32.57, -114.679, 32.625],
        blurb:
          'Somerton and the surrounding irrigated field blocks - agricultural crews working ground with almost no built shade.',
      },
    ],
    relief: {
      kind: 'azdhs',
      endpoint:
        'https://services1.arcgis.com/mpVYz37anSdrK4d8/arcgis/rest/services/AZCoolingandHydration/FeatureServer/19/query',
      where: "Year=2026 AND SeasonStatus='Active' AND County='Yuma County'",
      attribution:
        'Arizona Department of Health Services Statewide Heat Preparedness Network, public feature service. Locations and services as published by ADHS.',
      label: 'AZDHS Heat Preparedness Network',
    },
  },
];

export const DEFAULT_REGION_ID = 'phoenix';

export function getRegion(id: string | null | undefined): Region {
  const found = REGIONS.find((r) => r.id === id);
  if (!found) {
    throw new Error(
      `Unknown region "${id}". Known regions: ${REGIONS.map((r) => r.id).join(', ')}`,
    );
  }
  return found;
}

/** Bounding box containing every tile in a region. */
export function regionBbox(region: Region): [number, number, number, number] {
  return region.tiles.reduce(
    (acc, t) =>
      [
        Math.min(acc[0], t.bbox[0]),
        Math.min(acc[1], t.bbox[1]),
        Math.max(acc[2], t.bbox[2]),
        Math.max(acc[3], t.bbox[3]),
      ] as [number, number, number, number],
    [180, 90, -180, -90] as [number, number, number, number],
  );
}

/**
 * Which regions a script should process.
 * `--region=yuma` for one, omitted for all of them.
 */
export function regionsFromArgv(argv: string[] = process.argv): Region[] {
  const arg = argv.find((a) => a.startsWith('--region='));
  if (!arg) return REGIONS;
  return [getRegion(arg.split('=')[1])];
}
