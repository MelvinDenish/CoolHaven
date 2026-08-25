/**
 * Shared domain types for CoolRoute Network Planner.
 *
 * One rule runs through this file: anything that came from outside the repo
 * carries its own provenance. A number without a `source` is not allowed to
 * reach the UI, because "is this real FortyGuard data or a modeled stand-in?"
 * is the first question a judge (or a city) will ask.
 */

export type LonLat = [number, number];

/** Where a value came from. Rendered in the UI, never only in a comment. */
export type DataSource =
  | 'fortyguard' // returned by the live FortyGuard API
  | 'synthetic' // deterministic modeled stand-in (see scripts/lib/synthetic-grid.ts)
  | 'magHRN' // Maricopa Association of Governments Heat Relief Network
  | 'azdhs' // Arizona Dept of Health Services Heat Preparedness Network
  | 'osm' // OpenStreetMap via Overpass
  | 'ors' // OpenRouteService
  | 'osrm' // public OSRM demo server
  | 'offline'; // computed locally with no network

/**
 * FortyGuard `filter_type`. Addendum A2 binds these to views:
 *   Planner  -> 1 (historic)   long-horizon siting decisions
 *   Dispatcher/Worker -> 3 (forecast)  "what happens in the next few hours"
 * A3 forbids mixing the two without labeling which is which in the UI.
 */
export const FILTER_TYPE = { HISTORIC: 1, FORECAST: 3 } as const;
export type FilterType = (typeof FILTER_TYPE)[keyof typeof FILTER_TYPE];

/** One AOI tile. Kept small on purpose - see lib/config.ts and Addendum A3. */
export interface Tile {
  id: string;
  label: string;
  /** [minLon, minLat, maxLon, maxLat] */
  bbox: [number, number, number, number];
  blurb: string;
}

/**
 * A rasterised temperature field for one tile at one timestamp.
 * Stored as a flat row-major array rather than GeoJSON features: 2,000 cells
 * per tile per timestamp is 12 kB as numbers and 900 kB as polygons.
 */
export interface HeatGrid {
  schema: 'coolroute.heatgrid.v3';
  regionId: string;
  tileId: string;
  filterType: FilterType;
  /** ISO-8601 with offset, at a nominal mid-afternoon hour. The API's field is
   *  daily, so this identifies the DAY; the hour is presentational. */
  validAt: string;
  /** The calendar date submitted to the API, YYYY-MM-DD. */
  date: string;
  granularityM: number;
  bbox: [number, number, number, number];
  cols: number;
  rows: number;
  unit: 'F';
  source: DataSource;
  fetchedAt: string;
  provenance: GridProvenance;
  /** length === cols * rows, row 0 is the SOUTH edge, col 0 is the WEST edge */
  tempsF: number[];
  /**
   * The daily range the API reports per cell, alongside the average.
   *
   * FortyGuard has no hour-of-day parameter - one (polygon, date) returns one
   * field - but every cell carries min/average/max for that day. That range is
   * the only real intra-day signal available, so it is what the day-part
   * selector reads. Inventing hourly slices instead would have been faking it,
   * which base PRD FR17 explicitly forbids.
   */
  tempsMinF: number[];
  tempsMaxF: number[];
  /**
   * Per-cell risk classification, same indexing as `tempsF` (base PRD FR1:
   * "stores results (temp, risk classification, timestamp)"). Values index
   * CELL_RISK_BANDS in config.ts.
   */
  riskBands: number[];
  /** The cut points this grid was classified with, so it stays self-describing. */
  riskThresholds: Record<string, number>;
}

export interface GridProvenance {
  /** Human-readable one-liner rendered in the UI provenance banner. */
  note: string;
  endpoint?: string;
  activityId?: string;
  creditsReported?: number | null;
  /** Only present when source === 'synthetic'. */
  model?: string;
  seed?: number;
}

export interface SnapshotManifest {
  schema: 'coolroute.manifest.v2';
  regionId: string;
  /**
   * The calendar date (Arizona local) this snapshot describes - its day 0.
   *
   * Optional only so manifests written before the rolling-date change still
   * parse; readers fall back to the earliest grid date. It lives here rather
   * than in regions.ts because a date describes a RUN, not a place, and keeping
   * it with the data means the client can never disagree with what was written.
   */
  snapshotDate?: string;
  generatedAt: string;
  /** true when every grid in the snapshot has source === 'fortyguard' */
  liveApiUsed: boolean;
  /**
   * How many grids this run pulled over the wire. Zero means everything was
   * already cached - which is a legitimate outcome, but not a "refresh".
   */
  fetchedThisRun?: number;
  /**
   * (tileId|date) pairs the API completed but had no data for.
   *
   * Remembered so the next run does not spend three and a half minutes and a
   * credit re-discovering that the forecast horizon has not moved. Expires by
   * construction: tomorrow's day +1 is a different date.
   */
  unavailable?: string[];
  sources: DataSource[];
  grids: Array<{
    file: string;
    tileId: string;
    filterType: FilterType;
    validAt: string;
    source: DataSource;
    granularityM: number;
  }>;
  notes: string[];
}

/** A Heat Relief Network site, as published by MAG. */
export interface ReliefSite {
  id: string;
  name: string;
  org: string | null;
  kind: 'cooling_center' | 'hydration_station' | 'respite_center' | 'collection_site';
  lon: number;
  lat: number;
  address: string | null;
  city: string | null;
  phone: string | null;
  /** Free-text hours exactly as published, for display. */
  hours: string | null;
  /**
   * Machine-readable opening hours: index 0 = Sunday .. 6 = Saturday, minutes
   * from local midnight, null when the site is closed or the publisher left
   * the field blank.
   *
   * This exists because coverage that ignores opening hours is wrong, not
   * merely incomplete: a hydration station that shut at 3 PM does not help a
   * crew at 4 PM, and counting it inflates every coverage number the Planner
   * reports. `openAt()` in relief.ts is the only reader.
   */
  hoursByDay: Array<{ openMin: number; closeMin: number } | null>;
  /** True when the publisher marks the site as always open. */
  open24: boolean;
  /** False when the publisher gave us nothing to reason about. */
  hoursKnown: boolean;
  services: string | null;
  pets: boolean | null;
  adaAccessible: boolean | null;
  /** May-Sept season window as published. */
  seasonStart: string | null;
  seasonEnd: string | null;
  source: DataSource;
  verifiedDate: string;
  /** true for user/scenario-added stations, false for real published sites */
  proposed?: boolean;
}

export type InterventionKind =
  | 'cooling_station'
  | 'tree_canopy'
  | 'cool_pavement'
  | 'misting_station'
  | 'shade_sail'
  | 'shelter_retrofit';

/**
 * Which interventions provide relief ACCESS rather than ambient cooling.
 *
 * These are the ones that add a stopping point to the relief network, so a
 * scenario containing them changes coverage and relief-gap figures even though
 * their deltaF is zero. Keeping the list here rather than testing
 * `deltaF === 0` in three places means a new zero-effect intervention cannot be
 * silently left out of the coverage maths.
 */
export const ACCESS_INTERVENTIONS: InterventionKind[] = [
  'cooling_station',
  'shelter_retrofit',
];

/** One what-if move. The unit of both the scenario engine and the Forma export. */
export interface Intervention {
  id: string;
  kind: InterventionKind;
  label: string;
  /** Centre point. For a corridor this is its midpoint, used for labelling. */
  lon: number;
  lat: number;
  /**
   * Treated radius for a point intervention, or the half-width of the treated
   * band for a corridor.
   */
  radiusM: number;
  /**
   * Ordered [lon, lat] vertices when this treatment follows a street rather
   * than covering a disc.
   *
   * Canopy and cool pavement are specified, tendered and built per corridor-km
   * - a shade corridor is a street, not a circle - so modelling them as discs
   * was always the wrong shape. Cooling stations stay points, because a
   * building is a point.
   */
  corridor?: LonLat[];
  /** Air-temperature effect at the centre, degrees F, negative = cooling. */
  deltaF: number;
  /** Set when this came from the Recommend engine rather than a manual click. */
  recommended?: boolean;
  note?: string;
}

export interface Scenario {
  id: string;
  name: string;
  interventions: Intervention[];
}

/** A route as scored by lib/scoring.ts - one shape for Worker and Dispatcher. */
export interface RouteFeature {
  id: string;
  name: string;
  persona: string;
  /** Ordered [lon, lat] positions along real roads. */
  coords: LonLat[];
  distanceM: number;
  durationS: number;
  provider: DataSource;
  fetchedAt?: string;
  /** Populated for build-time routes that have a real alternative path. */
  alternativeOf?: string;
}

export type RiskBand = 'low' | 'moderate' | 'high' | 'extreme';

export interface RouteScore {
  routeId: string;
  /** Mean 2 m air temperature along the path, degrees F. */
  meanTempF: number;
  peakTempF: number;
  /** Degree-minutes above the comfort threshold. The headline exposure number. */
  exposureIndex: number;
  minutesInExtreme: number;
  minutesExposed: number;
  band: RiskBand;
  /** Worst contiguous stretch, for "where exactly is this bad". */
  peakSegment: { startIdx: number; endIdx: number; meanTempF: number; lengthM: number } | null;
  /** Longest run of the route with no relief site within the walk radius. */
  worstReliefGapM: number;
  nearestRelief: { siteId: string; name: string; distanceM: number; atIdx: number } | null;
  /**
   * Fraction of the route, 0..1, whose temperature came from a measured grid
   * cell rather than from the nearest tile edge.
   *
   * The AOI is a handful of ~10 mi tiles, not a continuous surface - the API's
   * area cap forces that - so a run leaving the tiles gets an edge-extrapolated
   * value. That is a defensible estimate, but it is not a measurement, and a
   * product whose whole argument is provenance cannot present the two
   * identically. Below 1, the UI says so.
   */
  coveredFraction: number;
  /** Metres of the route outside measured coverage. The absolute form of the above. */
  offCoverageM: number;
  /** Per-sample temps, for drawing the heat-coloured route line. */
  samples: Array<{
    lon: number;
    lat: number;
    tempF: number;
    distanceM: number;
    /** false = tempF is extrapolated from the nearest tile edge, not measured. */
    inCoverage: boolean;
  }>;
}

export interface DemandCell {
  lon: number;
  lat: number;
  /** 0..1 normalised composite exposure-demand score. */
  demand: number;
  tempF: number;
  roadWeight: number;
  routeWeight: number;
  /** metres to the nearest existing relief site */
  reliefDistanceM: number;
  /** 0..1, how badly this cell is uncovered */
  gap: number;
}
