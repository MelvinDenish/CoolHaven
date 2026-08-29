/**
 * EVERY tunable coefficient in the product lives here, with its provenance.
 *
 * Base PRD section 7 (Transparency) and FR9: what-if assumptions are surfaced
 * in the UI, not buried in a README. `ASSUMPTION_NOTES` and each spec's
 * `assumption` string below are the exact text the scenario panel renders, so
 * the number a judge reads on screen and the number the engine multiplies by
 * cannot drift apart.
 *
 * Confidence vocabulary:
 *   measured     - taken from a published measurement of this effect
 *   directional  - direction and rough magnitude are supported by published
 *                  work; the exact coefficient is ours
 *   illustrative - our own working figure, held for demonstration only
 */
import type { InterventionKind } from './types';

/* -------------------------------------------------------------------------- */
/* Heat risk thresholds                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Ambient 2 m air temperature, degrees F. Deliberately NOT presented as
 * compliance thresholds against any named standard (base PRD section 5, Out of
 * Scope) - these are working bands for an employer's internal planning.
 */
export const THRESHOLDS = {
  /** Below this, exposure does not accumulate at all. */
  comfortF: 90,
  /** Sustained outdoor work above this is where heat-illness risk climbs. */
  cautionF: 100,
  /** The band the Dispatcher view counts minutes against. */
  extremeF: 108,
};

/**
 * exposureIndex (degree-minutes above comfortF) -> risk band cut points.
 *
 * Anchored on time spent at 110 °F, which is 20 degrees over the comfort
 * threshold and an ordinary Phoenix summer afternoon:
 *
 *   moderate  400  ~ 20 minutes at 110 °F
 *   high      800  ~ 40 minutes at 110 °F
 *   extreme  1200  ~ 60 minutes at 110 °F
 *
 * These are calibrated for a desert summer, deliberately. Cut points tuned for
 * a temperate city saturate here - every single route in the focus area comes
 * back "extreme" at 3 PM, which is arguably true and operationally useless,
 * because a dispatcher who is told to pull all eight runs will pull none. The
 * bands have to separate the worst run from the merely bad ones on the day
 * they are actually used.
 */
export const EXPOSURE_BANDS = {
  moderate: 400,
  high: 800,
  extreme: 1200,
};

/* -------------------------------------------------------------------------- */
/* Movement - converts distance along a route into exposure time              */
/* -------------------------------------------------------------------------- */

export const MOVEMENT = {
  /**
   * Effective courier speed including stops. A last-mile van route averages
   * far below free-flow speed once drops are counted; 18 km/h is our figure.
   */
  courierKph: 18,
  /** Metres between samples when scoring a route. */
  sampleSpacingM: 50,
  /** How far a worker will realistically walk to relief mid-shift. */
  walkToReliefM: 400,
};

/* -------------------------------------------------------------------------- */
/* What-if intervention coefficients                                          */
/* -------------------------------------------------------------------------- */

export interface InterventionSpec {
  kind: InterventionKind;
  label: string;
  short: string;
  /** Peak air-temperature change at the centre of the treated area, deg F. */
  deltaF: number;
  /** Radius of influence, metres. Effect decays linearly to zero at the edge. */
  radiusM: number;
  confidence: 'measured' | 'directional' | 'illustrative';
  /** Rendered verbatim in the scenario panel next to the control. */
  assumption: string;
  basis: string;
  /** Rough capital cost, used only for the cost-per-degree comparison. */
  unitCostUsd: number;
  costUnit: string;
  /** Hex colour used for the map footprint and the panel chip. */
  color: string;
  /**
   * How this treatment is drawn, and it is not cosmetic.
   *
   * A building is a point; shade and resurfacing are specified and tendered per
   * corridor-kilometre, so they are drawn as lines along streets. This used to
   * be inferred with `kind === 'cooling_station'` in four separate files, which
   * silently made every NEW point-shaped intervention behave like a corridor.
   */
  geometry: 'point' | 'corridor';
}

export const INTERVENTIONS: Record<InterventionKind, InterventionSpec> = {
  cooling_station: {
    kind: 'cooling_station',
    label: 'Cooling / hydration station',
    short: 'Station',
    // A station does not cool the street. Its value is ACCESS to relief, which
    // the engine models as coverage. Keeping this at 0 rather than inventing a
    // temperature delta is the honest modelling choice.
    deltaF: 0,
    radiusM: 400,
    confidence: 'directional',
    assumption:
      'Assumed effect: no ambient cooling. A station changes relief ACCESS, not street temperature - it removes exposure by giving a worker somewhere to stop within a 400 m walk.',
    basis:
      'Modelled as coverage only. 400 m is the ~5-minute walk radius used in cooling-centre access studies and is consistent with how the MAG Heat Relief Network is distributed.',
    unitCostUsd: 45_000,
    costUnit: 'per station, first-year capital + seasonal staffing',
    color: '#2563eb',
    geometry: 'point',
  },
  tree_canopy: {
    kind: 'tree_canopy',
    label: 'Tree canopy / shade corridor',
    short: 'Canopy',
    deltaF: -2.5,
    radiusM: 250,
    confidence: 'directional',
    assumption:
      'Assumed effect: -2.5 °F ambient at the centre of the treated corridor, decaying linearly to 0 at 250 m. Illustrative magnitude.',
    basis:
      'Direction and rough scale follow Phoenix / ASU urban-canopy work reporting roughly 2-4 °F of daytime air-temperature reduction under mature canopy. Canopy reduces radiant (mean radiant) temperature far more than air temperature; this model represents only the air-temperature term and does not claim the larger radiant benefit. The exact coefficient is ours.',
    unitCostUsd: 380_000,
    costUnit: 'per treated corridor-km, planting + 3-year establishment',
    color: '#16a34a',
    geometry: 'corridor',
  },
  cool_pavement: {
    kind: 'cool_pavement',
    label: 'Cool pavement treatment',
    short: 'Pavement',
    deltaF: -0.6,
    radiusM: 200,
    confidence: 'measured',
    assumption:
      'Assumed effect: -0.6 °F ambient at 2 m over the treated area, decaying to 0 at 200 m. Deliberately small - cool pavement mostly changes SURFACE temperature, not the air a worker breathes.',
    basis:
      'The City of Phoenix / ASU Cool Pavement Pilot measured large surface-temperature reductions but only a fraction of a degree of daytime ambient air-temperature difference at ~6 ft, alongside slightly warmer night-time surfaces. We model the conservative daytime ambient figure and do not model the night-time penalty.',
    unitCostUsd: 220_000,
    costUnit: 'per treated lane-km',
    color: '#7c3aed',
    geometry: 'corridor',
  },
  misting_station: {
    kind: 'misting_station',
    label: 'Misting station',
    short: 'Misting',
    // Evaporative cooling is powerful and extremely local - a few metres, not a
    // few hundred. The radius is small on purpose; a misting line that appeared
    // to cool a district would be a fiction.
    deltaF: -8,
    radiusM: 30,
    confidence: 'directional',
    assumption:
      'Assumed effect: -8 °F within 30 m, decaying to 0 at the edge. Large but tiny in extent - evaporative cooling works on the person standing in it, not on the block.',
    basis:
      'Direction and scale follow published evaporative-cooling figures for outdoor misting in arid climates, where 10-20 °F at the nozzle is routinely reported. We model the conservative end and a deliberately short radius. Effectiveness collapses as humidity rises, which this model does NOT represent - in a Phoenix monsoon week the real figure is far lower. The exact coefficient is ours.',
    unitCostUsd: 18_000,
    costUnit: 'per station, install + seasonal water and maintenance',
    color: '#0891b2',
    geometry: 'point',
  },
  shade_sail: {
    kind: 'shade_sail',
    label: 'Shade sail / structure',
    short: 'Shade',
    // Between canopy and nothing: built shade works immediately and needs no
    // establishment period, but covers far less ground than a tree corridor.
    deltaF: -1.8,
    radiusM: 60,
    confidence: 'directional',
    assumption:
      'Assumed effect: -1.8 °F ambient under and immediately around the structure, decaying to 0 at 60 m. Smaller than canopy in reach, and available the day it is installed.',
    basis:
      'Built shade removes direct solar load immediately, with no establishment period and no irrigation - which is why cities use it at stops and yards where a tree cannot go. As with canopy, the radiant benefit to a person underneath is far larger than this air-temperature figure; we model only the ambient term. The exact coefficient is ours.',
    unitCostUsd: 65_000,
    costUnit: 'per structure, fabricated and installed',
    color: '#ca8a04',
    geometry: 'point',
  },
  shelter_retrofit: {
    kind: 'shelter_retrofit',
    label: 'Bus-shelter retrofit',
    short: 'Retrofit',
    /*
     * The cheapest move in the palette, and it exists because of a finding.
     *
     * The OSM relief pull initially counted bus shelters as relief sites; they
     * were excluded because a bare shelter is not one - no water, no cooling,
     * nobody responsible for you. But the STRUCTURES are already there, on
     * exactly the corridors workers use. Retrofitting one with shade cloth and
     * a water point converts existing street furniture into real relief for a
     * fraction of a new station's cost.
     */
    deltaF: 0,
    radiusM: 400,
    confidence: 'directional',
    assumption:
      'Assumed effect: no ambient cooling, same as a station - it buys relief ACCESS within a 400 m walk. Modelled identically to a new station because functionally that is what it becomes.',
    basis:
      'Costed as a retrofit of existing street furniture rather than new build: shade cloth, seating and a water point on a structure that already exists. The 400 m walk radius is the same one used for cooling centres. Whether a given shelter can take the retrofit is a site question this model does not answer.',
    unitCostUsd: 12_000,
    costUnit: 'per shelter, shade + water point retrofit',
    color: '#65a30d',
    geometry: 'point',
  },
};

/**
 * Palette order, which is also rough cost order - cheapest structural move
 * last, so the list reads from "build something new" down to "improve what is
 * already on the street".
 */
export const INTERVENTION_KINDS: InterventionKind[] = [
  'cooling_station',
  'tree_canopy',
  'cool_pavement',
  'misting_station',
  'shade_sail',
  'shelter_retrofit',
];

/**
 * Cooling effects do not stack indefinitely. Total ambient reduction applied
 * to any single grid cell is clamped here.
 */
export const MAX_STACKED_COOLING_F = 6;

/* -------------------------------------------------------------------------- */
/* Shade headroom, from measured ground segmentation                          */
/* -------------------------------------------------------------------------- */

/**
 * Canopy classes used by the Planner when reading a site's measured tree cover.
 *
 * Thresholds are ours and are working bands, not a standard. They exist to
 * answer one question a planner actually asks - "is there room to plant here?"
 * - and the cut points are set where the answer changes rather than at round
 * numbers: below 5% a street frame has essentially no canopy, above 25% it is
 * meaningfully shaded and the marginal tree buys less.
 */
export const CANOPY_BANDS = [
  { id: 'bare', maxTreePct: 5, label: 'Effectively bare', headroom: 'high' },
  { id: 'sparse', maxTreePct: 15, label: 'Sparse canopy', headroom: 'high' },
  { id: 'partial', maxTreePct: 25, label: 'Partial canopy', headroom: 'moderate' },
  { id: 'shaded', maxTreePct: 101, label: 'Already shaded', headroom: 'low' },
] as const;

export interface CanopyReading {
  treePct: number;
  skyPct: number;
  builtPct: number;
  band: (typeof CANOPY_BANDS)[number] | null;
  /** True when the frame is an interior, so canopy has no meaning here. */
  indoor: boolean;
  /** The sentence the UI renders. States what is measured and what is not. */
  note: string;
}

/**
 * Classes that only appear when the camera is INSIDE a building.
 *
 * Street View has interior coverage in some places - shopping centres, transit
 * halls, and notably Las Vegas casino floors, where the nearest panorama to a
 * point on the Strip can be a hotel lobby. The segmentation is perfectly
 * accurate about what it sees; it is just not seeing a street.
 *
 * This matters because the failure is silent and wrong in the confident
 * direction: an interior frame reports ~0% tree cover, which reads as
 * "effectively bare, high headroom - there is room to plant here" for a
 * building's atrium.
 */
const INDOOR_CLASSES = ['ceiling', 'floor', 'door', 'wall', 'windowpane', 'stairs'];

/**
 * Interpret a measured street-level frame, WITHOUT inventing a temperature.
 *
 * This is the boundary between what /v1/streetview measures and what it cannot
 * establish, and it is worth being exact about because the temptation runs the
 * other way.
 *
 * MEASURED: the share of the frame that is tree, sky, building and road, at
 * this point, on the date the imagery was captured.
 *
 * NOT MEASURED, and not derived here: how many degrees planting would buy. A
 * photograph contains no temperature. Deriving a °F figure from a canopy
 * percentage would require paired shaded/unshaded observations at the same
 * hour, which this project does not have - so `tree_canopy.deltaF` stays the
 * labelled assumption it always was.
 *
 * What this DOES add is headroom: whether a site has room for more canopy. A
 * recommendation to plant on a block already at 40% tree cover is a weaker
 * proposition than the same recommendation at 2%, and the tool could not tell
 * those apart before.
 */
export function canopyHeadroom(segments: Record<string, number>): CanopyReading {
  const treePct = segments.tree ?? segments.plant ?? 0;
  const skyPct = segments.sky ?? 0;
  const builtPct =
    (segments.building ?? 0) + (segments.road ?? segments['road, route'] ?? 0);

  // No sky and a meaningful share of interior classes means the camera was
  // indoors. Report that rather than a canopy verdict about a lobby.
  const indoorShare = INDOOR_CLASSES.reduce((a, k) => a + (segments[k] ?? 0), 0);
  const indoor = skyPct < 1 && indoorShare > 20;
  if (indoor) {
    return {
      treePct,
      skyPct,
      builtPct,
      band: null,
      indoor: true,
      note:
        'The nearest street-level imagery at this point is an INTERIOR view, so ' +
        'canopy cover has no meaning here. The segmentation is accurate about what ' +
        'it sees - it is simply not seeing a street. Sample a different point.',
    };
  }

  const band = CANOPY_BANDS.find((b) => treePct < b.maxTreePct) ?? CANOPY_BANDS[3];

  const note =
    `Measured at this point: ${treePct.toFixed(1)}% of the street frame is tree cover, ` +
    `${skyPct.toFixed(1)}% open sky, ${builtPct.toFixed(1)}% building and road. ` +
    (band.headroom === 'low'
      ? 'This block is already shaded - canopy here buys less than the assumed figure suggests.'
      : 'There is room to plant here.') +
    ' The temperature effect of planting remains an assumption; segmentation measures cover, not degrees.';

  return { treePct, skyPct, builtPct, band, indoor: false, note };
}

/* -------------------------------------------------------------------------- */
/* Demand layer heuristic (base PRD FR7 - "not left undefined")               */
/* -------------------------------------------------------------------------- */

export const DEMAND_WEIGHTS = {
  /** Heat above the comfort threshold, normalised across the focus area. */
  heat: 0.45,
  /** OSM drivable road length within the cell - proxy for where work happens. */
  roadDensity: 0.25,
  /** Density of the generated courier routes through the cell. */
  routeDensity: 0.3,
};

export const DEMAND_NOTE =
  'Work exposure = 0.45 × normalised heat above 90 °F + 0.25 × normalised OSM drivable road length + 0.30 × normalised courier-route density. Road and route weights come from OpenStreetMap and from routes generated on the real road network between real depot and delivery-zone points. They are a documented proxy for where outdoor work happens, not a measured count of workers.';

/** A cell only counts as a siting candidate if it is this far from relief. */
export const COVERAGE_GAP_M = 600;
/** Minimum separation between two recommended stations. */
export const RECOMMENDATION_SPACING_M = 700;

/* -------------------------------------------------------------------------- */
/* The exact strings the UI renders                                           */
/* -------------------------------------------------------------------------- */

export const ASSUMPTION_NOTES = {
  headline:
    'Scenario effects are modelling assumptions, not measured outcomes for these specific sites.',
  exposure: `Exposure index = degree-minutes above ${THRESHOLDS.comfortF} °F accumulated along the route, at an effective courier speed of ${MOVEMENT.courierKph} km/h including stops.`,
  stacking: `Stacked cooling from overlapping moves is capped at ${MAX_STACKED_COOLING_F} °F per cell.`,
  demand: DEMAND_NOTE,
  provenanceRule:
    'Historic data (filter_type 1) drives the Planner view. Forecast data (filter_type 3) drives Dispatcher and Worker. The two are never blended, and every panel states which it is using.',
  coverage: `Relief coverage assumes a worker will walk up to ${MOVEMENT.walkToReliefM} m to reach a cooling or hydration site.`,
};
