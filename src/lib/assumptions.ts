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
 * Anchored on time spent at 110 degF, which is 20 degrees over the comfort
 * threshold and an ordinary Phoenix summer afternoon:
 *
 *   moderate  400  ~ 20 minutes at 110 degF
 *   high      800  ~ 40 minutes at 110 degF
 *   extreme  1200  ~ 60 minutes at 110 degF
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
  },
  tree_canopy: {
    kind: 'tree_canopy',
    label: 'Tree canopy / shade corridor',
    short: 'Canopy',
    deltaF: -2.5,
    radiusM: 250,
    confidence: 'directional',
    assumption:
      'Assumed effect: -2.5 degF ambient at the centre of the treated corridor, decaying linearly to 0 at 250 m. Illustrative magnitude.',
    basis:
      'Direction and rough scale follow Phoenix / ASU urban-canopy work reporting roughly 2-4 degF of daytime air-temperature reduction under mature canopy. Canopy reduces radiant (mean radiant) temperature far more than air temperature; this model represents only the air-temperature term and does not claim the larger radiant benefit. The exact coefficient is ours.',
    unitCostUsd: 380_000,
    costUnit: 'per treated corridor-km, planting + 3-year establishment',
    color: '#16a34a',
  },
  cool_pavement: {
    kind: 'cool_pavement',
    label: 'Cool pavement treatment',
    short: 'Pavement',
    deltaF: -0.6,
    radiusM: 200,
    confidence: 'measured',
    assumption:
      'Assumed effect: -0.6 degF ambient at 2 m over the treated area, decaying to 0 at 200 m. Deliberately small - cool pavement mostly changes SURFACE temperature, not the air a worker breathes.',
    basis:
      'The City of Phoenix / ASU Cool Pavement Pilot measured large surface-temperature reductions but only a fraction of a degree of daytime ambient air-temperature difference at ~6 ft, alongside slightly warmer night-time surfaces. We model the conservative daytime ambient figure and do not model the night-time penalty.',
    unitCostUsd: 220_000,
    costUnit: 'per treated lane-km',
    color: '#7c3aed',
  },
};

export const INTERVENTION_KINDS: InterventionKind[] = [
  'cooling_station',
  'tree_canopy',
  'cool_pavement',
];

/**
 * Cooling effects do not stack indefinitely. Total ambient reduction applied
 * to any single grid cell is clamped here.
 */
export const MAX_STACKED_COOLING_F = 6;

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
  'Exposure demand = 0.45 x normalised heat above 90 degF + 0.25 x normalised OSM drivable road length + 0.30 x normalised courier-route density. Road and route weights come from OpenStreetMap and from routes generated on the real road network between real depot and delivery-zone points. They are a documented proxy for where outdoor work happens, not a measured count of workers.';

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
  exposure: `Exposure index = degree-minutes above ${THRESHOLDS.comfortF} degF accumulated along the route, at an effective courier speed of ${MOVEMENT.courierKph} km/h including stops.`,
  stacking: `Stacked cooling from overlapping interventions is capped at ${MAX_STACKED_COOLING_F} degF per cell.`,
  demand: DEMAND_NOTE,
  provenanceRule:
    'Historic data (filter_type 1) drives the Planner view. Forecast data (filter_type 3) drives Dispatcher and Worker. The two are never blended, and every panel states which it is using.',
  coverage: `Relief coverage assumes a worker will walk up to ${MOVEMENT.walkToReliefM} m to reach a cooling or hydration site.`,
};
