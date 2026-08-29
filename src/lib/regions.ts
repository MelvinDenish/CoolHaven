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
 * Why these four:
 *
 *   Phoenix   - the flagship. Dense last-mile courier work, and the Maricopa
 *               Association of Governments publishes the richest Heat Relief
 *               Network dataset in the state.
 *   Yuma      - the stress test, and arguably the stronger case for the
 *               product. One of the hottest cities in the United States, with
 *               an outdoor agricultural workforce rather than a courier one, a
 *               different relief-data publisher with a different schema, and
 *               roughly a tenth of Phoenix's site density. If the engine works
 *               here it is not quietly overfitted to Phoenix.
 *   Las Vegas - out of Arizona entirely, and onto the OSM relief adapter.
 *   Tucson    - a second OSM-adapter city, to show the fallback is a pattern
 *               rather than a one-off.
 *
 * The last two carry `dataQuality: 'osm-derived'` and their coverage numbers
 * are NOT comparable with the first two. That is a real limitation of having no
 * agency feed, and it is labelled everywhere it surfaces rather than averaged
 * away.
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
  kind: 'magHRN' | 'azdhs' | 'osm';
  /** ArcGIS FeatureServer query endpoint, or the Overpass endpoint for `osm`. */
  endpoint: string;
  /**
   * Server-side filter, so we never download a whole state to discard it.
   * Unused by the `osm` adapter, which filters by bounding box instead.
   */
  where: string;
  attribution: string;
  /** Human-readable provenance, rendered in the UI. */
  label: string;
  /**
   * How much the coverage numbers for this region are worth.
   *
   * `agency`      a published heat-relief network: places that have AGREED to
   *               take someone in, with staffed summer hours.
   * `osm-derived` publicly mapped amenities that a worker could plausibly use.
   *               Real places, but nobody has undertaken to be a relief site,
   *               and hours are patchy.
   *
   * This is surfaced in the UI rather than kept in a comment, because a
   * coverage percentage computed over the second kind means something weaker
   * than one computed over the first, and a planner has to know which they are
   * looking at.
   */
  dataQuality: 'agency' | 'osm-derived';
}

export interface Region {
  id: string;
  /**
   * Where this region came from.
   *
   * `curated` (the default, and what every entry in REGIONS below is) means a
   * bounding box someone chose for a reason, backed by a committed snapshot.
   * `draft` means a user drew it in the browser: same code path, same scoring,
   * but nobody vetted the box, there is no committed data behind it, and its
   * coverage numbers are NOT comparable with a curated region's. See
   * src/lib/draft-region.ts.
   *
   * Optional so the four entries below need no change - absent means curated.
   */
  origin?: 'curated' | 'draft';
  /** Shown in the region dropdown. */
  name: string;
  /** Second line in the dropdown - the administrative area. */
  subtitle: string;
  /** One line on why this region is in the product. */
  blurb: string;
  center: [number, number];
  tiles: Tile[];
  relief: ReliefSource;
  /** Persona framing for this region's sample fleet. */
  workforce: string;
  /**
   * Local UTC offset, used to stamp `validAt` and to pick the weekday when
   * checking relief opening hours.
   *
   * Per region rather than a single Arizona constant, because the product is no
   * longer Arizona-only. Every current region reads -07:00 through the summer -
   * Arizona does not observe DST and Nevada is on PDT - so today they agree,
   * which is exactly the kind of coincidence that hides a bug until October.
   */
  utcOffset: string;
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
    utcOffset: '-07:00',
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
      dataQuality: 'agency',
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
    utcOffset: '-07:00',
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
      dataQuality: 'agency',
    },
  },

  /* ------------------------------------------------------------------------ */
  /* OSM-derived regions                                                      */
  /* ------------------------------------------------------------------------ */
  /*
   * Cities with no agency relief feed the project could find, served by the
   * OpenStreetMap adapter instead. They demonstrate the thing Addendum A3
   * promised - that expansion is additive - across state lines and away from
   * the two publishers the curated regions depend on.
   *
   * Their coverage numbers are deliberately NOT comparable with Phoenix's: see
   * `dataQuality` above. The UI labels them, and the Planner says so on screen.
   */
  {
    id: 'las-vegas',
    name: 'Las Vegas, NV',
    subtitle: 'Clark County',
    blurb:
      'Resort-corridor service work, warehousing along the I-15 spine and municipal crews, in a metro that regularly runs hotter than Phoenix on the same afternoon.',
    center: [-115.155, 36.145],
    workforce: 'Hospitality and resort-corridor crews, couriers, warehouse and municipal workers',
    // Pacific: -07:00 through PDT, -08:00 in winter. The only region here that moves.
    utcOffset: '-07:00',
    syntheticOffsetF: 1,
    tiles: [
      {
        id: 'strip-corridor',
        label: 'Resort Corridor',
        bbox: [-115.185, 36.095, -115.135, 36.135],
        blurb:
          'The resort spine and its service roads - dense pedestrian and delivery movement with almost unbroken hardstanding.',
      },
      {
        id: 'downtown-vegas',
        label: 'Downtown / Fremont',
        bbox: [-115.16, 36.155, -115.11, 36.19],
        blurb:
          'The civic core, Fremont Street and the older commercial grid north of the corridor.',
      },
    ],
    relief: {
      kind: 'osm',
      endpoint: 'https://overpass-api.de/api/interpreter',
      where: '',
      attribution:
        'Amenity locations (c) OpenStreetMap contributors, ODbL, via Overpass API. Community-mapped amenities, not an agency-published heat-relief network.',
      label: 'OpenStreetMap amenities',
      dataQuality: 'osm-derived',
    },
  },
  {
    id: 'tucson',
    name: 'Tucson, AZ',
    subtitle: 'Pima County',
    blurb:
      'University, civic and industrial work across the Santa Cruz corridor, with a lower-density street grid than Phoenix and a different shade profile.',
    center: [-110.965, 32.225],
    workforce: 'Couriers, university and municipal crews, utility and landscaping workers',
    utcOffset: '-07:00',
    syntheticOffsetF: -1.5,
    tiles: [
      {
        id: 'tucson-downtown',
        label: 'Downtown / University',
        bbox: [-110.985, 32.205, -110.935, 32.245],
        blurb:
          'The civic core, the university campus edge and the Fourth Avenue commercial strip.',
      },
      {
        id: 'tucson-south-industrial',
        label: 'South Industrial',
        bbox: [-110.99, 32.165, -110.94, 32.205],
        blurb:
          'Rail-adjacent warehousing and the airport freight approach - low shade, high vehicle movement.',
      },
    ],
    relief: {
      kind: 'osm',
      endpoint: 'https://overpass-api.de/api/interpreter',
      where: '',
      attribution:
        'Amenity locations (c) OpenStreetMap contributors, ODbL, via Overpass API. Community-mapped amenities, not an agency-published heat-relief network.',
      label: 'OpenStreetMap amenities',
      dataQuality: 'osm-derived',
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
