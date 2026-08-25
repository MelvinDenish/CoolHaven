# Methodology

Every number this product shows, and where it comes from.

The single source of truth for all of it is
[`src/lib/assumptions.ts`](../src/lib/assumptions.ts). The strings in that file
are the strings the UI renders, so the number a reviewer reads on screen and
the number the engine multiplies by cannot drift apart.

**Confidence vocabulary**

| Label | Meaning |
|---|---|
| `measured` | Taken from a published measurement of this effect |
| `directional` | Direction and rough magnitude supported by published work; the exact coefficient is ours |
| `illustrative` | Our own working figure, held for demonstration only |

---

## 1. The heat field

### Source

`POST /v1/heatmap` at 100 m granularity, one call per tile per timestamp,
polled to completion via `GET /v1/status/{activity_id}`. Returned points are
averaged into the cell they fall in; any cell the API did not cover is filled
from its nearest covered neighbours, expanding ring by ring, so the field has
no holes.

**The committed snapshot is live FortyGuard data.** 10 grids, all
`source: "fortyguard"`, each stamped with the `activity_id` of the call that
produced it. The modelled stand-in in section 6 is the fallback used only when
no key is present or a live call fails.

### Regions, tiles and timestamps

Two regions. Phoenix: three tiles, 26.3 mi². Yuma: two tiles, 33.2 mi². Four
timestamps each:

| Key | Local hour | `filter_type` | Used by |
|---|---|---|---|
| `baseline` | 15:00 | 1 (historic) | Planner |
| `f-12` | 12:00 | 3 (forecast) | Dispatcher, Worker |
| `f-15` | 15:00 | 3 (forecast) | Dispatcher, Worker |
| `f-18` | 18:00 | 3 (forecast) | Dispatcher, Worker |

Historic and forecast fields are never blended. Three forecast slices is what
makes the Worker view's "leave earlier / later" comparison a real re-scoring
rather than an estimate — base PRD FR17 is explicit that if only one timestamp
had been captured, this should have been cut to a static note instead of faked.

---

## 2. Risk thresholds and the exposure index

All in ambient 2 m air temperature, °F. **Not** compliance thresholds against
any named standard (base PRD section 5, Out of Scope) — working bands for an
employer's internal planning.

| Threshold | Value | Meaning |
|---|---|---|
| `comfortF` | 90 °F | Below this, exposure does not accumulate at all |
| `cautionF` | 100 °F | Sustained outdoor work above this is where heat-illness risk climbs |
| `extremeF` | 108 °F | The band the Dispatcher counts minutes against |

### The exposure index

**Degree-minutes above 90 °F, accumulated along the route.**

The route is resampled to evenly spaced 50 m points. Even spacing matters: a
route with dense vertices downtown and sparse vertices on a freeway would
otherwise double-count the downtown heat. At each sample we know how long the
courier spends there (from the assumed speed) and how far above 90 °F it is,
and we integrate.

```
exposureIndex = Σ  max(0, T_sample − 90) × minutesPerSample
```

This makes a long mild route and a short brutal route comparable on one number,
which is exactly what a dispatcher ranking eight runs needs.

### Samples outside the measured tiles

The AOI is a set of ~10 mi tiles, not a continuous surface — the API caps one
request at roughly 50 mi² — so a run can leave measured ground. Two choices
were available and only one of them is honest.

Dropping off-tile samples from the sum would have been simpler, and it would
have systematically flattered the runs that wander furthest: a route 30%
outside coverage would have reported the exposure of the 70% that happened to
be measured. So every sample stays in, and an off-tile point takes the value of
the nearest tile edge (`HeatField.sampleClamped`).

That is an extrapolation, not a measurement, and the two must not look alike in
a product whose central claim is provenance. `scoreRoute` therefore returns
`coveredFraction` and `offCoverageM` alongside the index, and any route below
full coverage renders a line in both the Worker and Dispatcher views naming the
percentage. Fully covered routes render nothing, so the note carries
information rather than being decoration.

The demo trips in both regions were moved to endpoints inside the tiles for
this reason. The Phoenix demo previously started at 33.4197, below
`downtown-core`'s southern edge, which let the router escape onto a freeway and
put **83%** of the headline Worker route on extrapolated ground. Both demos are
now at 0%. Among the fleet runs, `r2-warehouse-civic` and
`r3-buckeye-industrial` still clip the tile edges at about 28%, and
`y6-utility-south` at 22% — those are real properties of the AOI limit, left
in place and disclosed rather than tuned away.

### Movement assumptions

| Parameter | Value | Basis |
|---|---|---|
| Effective courier speed | 18 km/h | A last-mile van route averages far below free-flow speed once drops are counted. Our figure — `illustrative` |
| Sample spacing | 50 m | Resolution choice, half the 100 m grid cell |
| Walk to relief | 400 m | ≈ the 5-minute walk radius used in cooling-centre access studies |

### Risk bands

Anchored on time spent at 110 °F — 20 degrees over the comfort threshold, and
an ordinary Phoenix summer afternoon:

| Band | exposureIndex | Equivalent |
|---|---|---|
| Low | < 400 | — |
| Moderate | ≥ 400 | ~20 min at 110 °F |
| High | ≥ 800 | ~40 min at 110 °F |
| Extreme | ≥ 1200 | ~60 min at 110 °F |

**These are calibrated for a desert summer, deliberately.** Cut points tuned
for a temperate city saturate here — every single route in the focus area comes
back "extreme" at 3 PM, which is arguably true and operationally useless,
because a dispatcher told to pull all eight runs will pull none. The bands have
to separate the worst run from the merely bad ones on the day they are used.

Observed effect of the calibration on the committed snapshot:

| Window | Extreme | High | Moderate | Headline |
|---|---|---|---|---|
| 15:00 | 1 | 2 | 5 | "3 of 8 active routes are in high-exposure zones" |
| 18:00 | 0 | 1 | 6 | "1 of 8 active routes are in high-exposure zones" |

### Cell risk classification (FR1, FR4)

Every cell carries a discrete band, computed at ingest and stored in the cache
alongside its temperature, with the cut points recorded in the grid so the data
stays self-describing.

| Band | Range |
|---|---|
| Below caution | < 90 °F |
| Caution | 90–100 °F |
| High | 100–108 °F |
| Extreme | 108–114 °F |
| **Severe** | **114 °F +** |

**Five bands, not four, and the top one was added for a measured reason.** With
a 108 °F ceiling, Yuma classified as 100% extreme at 3 PM — 8,680 of 8,680
cells in a single band. That is true and useless: the layer becomes a solid
rectangle and a planner cannot tell the worst blocks from the merely terrible
ones. Splitting at 114 °F restores discrimination in exactly the cities that
need it. Measured on the committed baselines: Phoenix 310 high / 6,343 extreme
/ 123 severe; Yuma 6,466 extreme / 2,214 severe.

This is deliberately **not** the same thing as a route's risk band. A route band
integrates exposure over time along a path; this classifies one cell by
instantaneous temperature. A merely warm cell crossed for an hour is worse than
an extreme cell crossed in ten seconds, and only the route band can say so.

---

## 2b. Opening hours

Both publishers give per-day opening hours, and using them is a correctness
requirement rather than a feature. Coverage that counts a hydration station
which shut at 3 PM overstates the network at 4 PM — precisely when the field is
hottest, so the error runs in the worst possible direction.

The rule: **a site counts as relief at time T only if it is open at T, or if the
publisher told us nothing about its hours.** The second clause matters. Treating
unknown hours as closed would silently delete real sites over a blank field in
someone else's database, so unknown is treated as available and counted
separately — Phoenix publishes usable hours for 251 of 253 sites, Yuma for only
2 of 21, and the UI reports that split rather than hiding it.

Sites shut at the modelled hour are drawn hollow on the map. They stay visible,
because hiding them would misrepresent the network, but they visibly do not
count.

---

## 3. Intervention coefficients

| Intervention | Assumed effect | Radius | Confidence | Unit cost |
|---|---|---|---|---|
| Cooling / hydration station | **0 °F** (coverage only) | 400 m | `directional` | $45k per station, first-year capital + seasonal staffing |
| Tree canopy / shade corridor | **−2.5 °F** at centre | 250 m | `directional` | $380k per treated corridor-km |
| Cool pavement | **−0.6 °F** at centre | 200 m | `measured` | $220k per treated lane-km |
| Misting station | **−8 °F** at centre | **30 m** | `directional` | $18k per station, install + seasonal water |
| Shade sail / structure | **−1.8 °F** at centre | 60 m | `directional` | $65k per structure, fabricated and installed |
| Bus-shelter retrofit | **0 °F** (coverage only) | 400 m | `directional` | $12k per shelter, shade + water point |

Stations are points. **Canopy and cool pavement are corridors** — an ordered
line of vertices with `radiusM` as the treated half-width — because that is how
shade and resurfacing are specified, tendered and built. Cooling falls off from
the perpendicular distance to the nearest segment, so a shade corridor cools
the street it runs along rather than a circle centred on its midpoint. Export
buffers the line into a polygon.

Effect decays **linearly** to zero at the radius. A Gaussian would look
prettier but would imply a calibrated dispersion we do not have; linear falloff
is the honest shape for an illustrative coefficient and is trivial for a
reviewer to reason about. Stacked cooling from overlapping interventions is
**capped at 6 °F per cell**.

### Why misting has the biggest number and the smallest radius

−8 °F is the largest coefficient in the palette and 30 m is the smallest radius
by an order of magnitude. Both are deliberate, and they belong together.

Evaporative cooling in dry air is genuinely powerful — published figures for
outdoor misting in arid climates routinely report 10–20 °F at the nozzle, and we
model the conservative end of that. But it acts on the air a person is standing
in, and it stops almost immediately beyond the spray. A misting line modelled
with a canopy-sized radius would show a district cooling by degrees, which is a
fiction that would be easy to produce and hard to defend.

**What this model does not represent:** effectiveness collapses as humidity
rises. In a Phoenix monsoon week the real figure is far lower than −8 °F, and
nothing here adjusts for that. The coefficient is a dry-afternoon figure.

### Why the bus-shelter retrofit exists at all

It came out of a data-quality bug, which is worth recording because the bug and
the intervention point in opposite directions.

The OpenStreetMap relief adapter initially counted `amenity=shelter` as relief
infrastructure. In Tucson that returned 427 of 472 "relief sites" — almost all
bus shelters, carrying stop names like *Grant/1st Avenue*. Coverage came out an
order of magnitude better than Phoenix's agency network, which inverted the
finding this product exists to make. They were excluded: a bare shelter has no
water, no cooling and nobody responsible for you.

But the *structures* are already standing, on exactly the corridors the demand
layer flags. Retrofitting one with shade cloth, seating and a water point turns
existing street furniture into real relief at roughly a quarter of a new
station's cost. It is modelled identically to a station — zero degrees, 400 m
access radius — because functionally that is what it becomes.

Whether a given shelter can physically take the retrofit is a site question this
model does not answer.

### Why a station cools nothing

A cooling station does not change street temperature, so modelling it with a
temperature delta would be fiction. Its entire modelled benefit flows through
**coverage**: it is added to the relief-site set, which shortens the longest
stretch of a route with no relief within a 400 m walk. That is why a scenario
of four stations moves *relief coverage* and *worst relief gap* while leaving
*mean field temperature* untouched — correct behaviour, not a bug.

### Why temperature is reported twice

The Planner shows *mean temperature inside treated areas* and *mean temperature
across the whole focus area* as two separate rows, and they usually disagree
dramatically.

That is deliberate. One 250 m canopy corridor covers roughly 19 of the focus
area's 6,776 cells, so it shifts the district average by about 0.003 °F — which
rounds to "no change" and makes a working tool look broken. The treated-area
figure answers the question the planner asked (what did this do where I put
it?); the district figure answers the one they should also hear (how far does
this go towards fixing a district?). Measured on the committed snapshot, two
canopy corridors move the treated band by roughly **−1.26 °F** and the district by
nothing — which is about 1/3 of the −2.5 °F peak, exactly what linear decay
averaged over a disc should give.

Reporting only the flattering number would have been easy. Reporting only the
district number would have made the canopy tool look inert.

### Why cool pavement is the smallest number

The City of Phoenix / ASU Cool Pavement Pilot measured large **surface**
temperature reductions but only a fraction of a degree of daytime **ambient**
air-temperature difference at roughly 6 ft, alongside slightly warmer
night-time surfaces. We model the conservative daytime ambient figure and do
not model the night-time penalty. It is the only `measured` label in the table
and it is deliberately the least impressive number in it.

### Why canopy is directional

Direction and rough scale follow Phoenix / ASU urban-canopy work reporting
roughly 2–4 °F of daytime air-temperature reduction under mature canopy.
Canopy reduces **radiant** (mean radiant) temperature far more than it reduces
air temperature; this model represents only the air-temperature term and does
not claim the larger radiant benefit — which means it **understates** what
canopy does for a person standing under it.

---

## 3b. Shade headroom, from measured segmentation

`/v1/streetview` returns a semantic segmentation of the frame at a point: the
share that is tree, sky, building, road, sidewalk, car. `canopyHeadroom()` in
`assumptions.ts` interprets it, and the boundary it draws is the important part.

**Measured:** the composition of the frame at that point, on the date the
imagery was captured.

**Not measured, and not derived:** how many degrees planting would buy. A
photograph contains no temperature. Establishing a °F effect would need paired
shaded and unshaded observations at the same hour and location, which this
project does not have — so `tree_canopy.deltaF` remains the labelled assumption
described above, and the panel says so on screen.

**What it does add** is whether a site has room for more canopy at all. The
bands below are ours, and they are working bands rather than a standard; the cut
points sit where the answer changes rather than at round numbers.

| Measured tree cover | Band | Headroom |
|---|---|---|
| under 5% | Effectively bare | high |
| 5–15% | Sparse canopy | high |
| 15–25% | Partial canopy | moderate |
| over 25% | Already shaded | low |

**One failure mode, guarded explicitly.** Street View has interior coverage in
some places — shopping centres, transit halls, and notably Las Vegas casino
floors, where the nearest panorama to a point on the Strip is a hotel lobby. An
interior frame reports no sky and near-zero tree cover, which would read as
"effectively bare, room to plant" for an atrium. Frames with no sky and a
meaningful share of interior classes (`ceiling`, `floor`, `door`, `wall`) are
detected and reported as interior views rather than given a canopy verdict.

## 3c. The scenario solvers

Two questions the siting ranking could not answer:

- **Budget** — "I have $500k, what is the best mix?"
- **Target** — "How many sites to reach 25% coverage, and what does it cost?"

Both are handled by `solveCoverage()` in `src/lib/solve.ts`, which walks a pool
of up to 40 candidate sites and picks **greedily by marginal coverage per
dollar**, re-evaluating every remaining candidate after each pick because
placements overlap — two stations 300 m apart cover much of the same ground.

**Why greedy, stated plainly:** maximising coverage under a budget is a variant
of maximum coverage, which is NP-hard. The objective is submodular, so greedy is
provably within a constant factor of optimal. That is the theoretical
justification; the practical one matters more here. A greedy pick is
*followable* — "it bought this first because it covered the most uncovered
ground per dollar" is defensible in a council meeting. An optimum reached by
branch and bound, landing on a different set for reasons nobody can reconstruct,
is not. The UI claims greedy rather than implying an optimum.

**Only access interventions are placed.** Coverage is the objective, and a
canopy corridor cools a street without giving anyone somewhere to stop. Mixing a
temperature effect into a coverage objective would be comparing two different
things and calling the result a plan.

**When the target is unreachable** the solver stops and says where, rather than
returning its best effort as though it had succeeded.

## 4. Exposure demand layer (base PRD FR7)

FR7 was flagged in the PRD's own change log as previously "left undefined".
Defined:

```
demand = 0.45 × normalised heat above 90 °F
       + 0.25 × normalised OSM drivable road length in the cell
       + 0.30 × normalised courier-route density through the cell
```

- **Heat** — from the active heat field.
- **Road density** — OSM drivable ways rasterised at 20 m steps and weighted by
  class (motorway 3.0 → living_street 0.8), because a six-lane arterial is far
  more radiating asphalt than a residential street. Normalised against the
  **95th percentile**, so one freeway cell does not flatten every other cell to
  near zero. `highway=service` is excluded — it times the Overpass query out on
  this bbox and carries the lowest weight anyway.
- **Route density** — samples of the eight generated courier runs, smoothed
  into a 1-cell neighbourhood so a route lights up the block it runs along
  rather than a single-cell hairline.

The third term is what stops the layer from simply re-drawing the heat map: the
hottest cell in a rail yard nobody delivers to should not outrank a merely hot
cell that eight routes cross every afternoon.

**These are a documented proxy for where outdoor work happens, not a measured
count of workers.**

### Coverage gap

```
gap = clamp01( (distanceToNearestRelief − 400 m) / (600 m − 400 m) )
```

0 at the walk radius, 1 at 600 m and beyond.

---

## 5. Station siting (base PRD FR8)

Greedy: rank candidate cells by `demand × (0.35 + 0.65 × gap)`, take the best,
suppress everything within 700 m, repeat. Candidates must clear `gap > 0.15`
and `demand > 0.2`.

Greedy rather than clustered **on purpose**. A planner can follow "the highest
uncovered-demand cell, then the next one at least 700 m away" and check it by
eye. A k-means centroid is harder to argue in front of a council.

---

## 6. The modelled stand-in (`coolroute-uhi-v1`)

Used **only** when `FORTYGUARD_API_KEY` is absent. Output is stamped
`source: "synthetic"` and the manifest `liveApiUsed: false`; the app banners it.

```
T(cell) = regional base for the hour
        + 4.6 °F × built-surface fraction     (UHI, road density as proxy)
        − 3.4 °F × vegetation/water fraction
        + deterministic texture, ±0.7 °F
```

Historic fields are damped to 82% of the anomaly spread, because averaging many
days flattens extremes relative to a single forecast snapshot.

Regional base by local hour, following the shape of a typical Phoenix summer
diurnal curve: 06:00 → 91 °F, 09:00 → 99, 12:00 → 106, 15:00 → 110, 18:00 →
106, 21:00 → 98. Interpolated linearly between anchors.

Deterministic — same tile, same hour, same seed, same output — so a committed
snapshot is reproducible and a diff means something.

**The values are physically plausible. They are not measurements.** The purpose
of this model is that a reviewer can clone the repo with no credentials and see
the product work end to end, not that these are Phoenix's actual temperatures
on a given afternoon.

---

## 7. Route generation

Per region: eight depot → delivery-zone runs in Phoenix and seven
packing-shed/field-block and municipal runs in Yuma, each defined by **real named
locations**
inside the focus tiles — air-cargo apron, the South 7th warehouse strip, the
Central Ave office spine, the midtown drop grid, the Buckeye industrial run,
the Sky Harbor perimeter. Multi-stop runs are resolved leg by leg and stitched
(both routers drop alternatives once there is a via point, and leg stitching
keeps one slow leg from failing a whole run).

The worker demo trip is deliberately two points only, because that is the shape
both routers need to return genuine alternatives — which is the point of it:
one visibly cooler path against one faster path.

Personas across the fleet cover parcel courier (van), bike courier, postal
carrier, utility/meter crew, municipal crew, and rideshare-delivery hybrid.
Same engine, one dataset.

---

## 8. Alternative-route recommendation

A cooler path is recommended only when it saves **more than 12% of the primary
route's exposure** *and* costs **less than 6 extra minutes**. Stated here
rather than hidden, because it is a value judgement about the worker's time,
not a fact about the weather.

When the alternative is *hotter*, the UI says so explicitly, with the
magnitude — it does not clamp a negative saving to "saves only 0".

---

## 9. Export format

RFC 7946 GeoJSON FeatureCollection, EPSG:4326. Points for stations, 32-segment
polygons for area treatments. Per-feature properties:

| Property | Contents |
|---|---|
| `coolroute:kind` | `cooling_station` \| `tree_canopy` \| `cool_pavement` |
| `coolroute:deltaF` | assumed air-temperature effect at centre |
| `coolroute:radiusM` | radius of influence |
| `coolroute:confidence` | `measured` \| `directional` \| `illustrative` |
| `coolroute:assumption` | the sentence the UI showed when it was placed |
| `coolroute:basis` | where the coefficient came from |
| `coolroute:unitCostUsd`, `coolroute:costUnit` | costing |
| `forma:category` | `building` / `vegetation` / `ground-surface` |
| `forma:height` | 3.5 m for stations, 0 for ground treatments |

Collection metadata carries the before/after outcome, the heat-data source and
`filter_type`, and the caveat that effects are modelling assumptions.

Standard GeoJSON, importable into Autodesk Forma as site context and into any
GIS. **Not a certified Forma integration.**


---

## 10. Hourly profiles (`env_params`)

`npm run data:hourly` queries `POST /v1/env_params` and commits the answers to
`data/<region>/hourly.json`.

**This endpoint is not what its name suggests.** It does not return the
temperature at a point. It takes a dry-bulb temperature as *input* — the value
we already hold from the heatmap grid — and returns a derived environmental
profile for that location as **24 hourly series**: apparent temperature, heat
index, wet-bulb temperature, relative humidity, cloud cover and air quality.

That makes it the only hour-of-day resolution the API exposes, since
`/v1/heatmap` has no hour parameter at all. It is per-point rather than
per-grid, which is the right shape for FR17: "should this run go at 6 AM or
3 PM" is a question about one route.

Measured on the snapshot day in downtown Phoenix: apparent temperature runs
93.7 °F at 06:00, peaks at 114.4 °F at 13:00, and eases to 103.8 °F by 20:00.
Wet bulb stays between 71 and 76 °F. Air quality index roughly doubles in the
evening (55 → 86), which is a second reason not to schedule a late run.

The sample set is deliberately small — each tile centroid plus the demo route's
endpoints — because this samples the diurnal shape rather than rebuilding the
field.

**There is no modelled fallback for this file, on purpose.** Its whole value is
being more accurate than the grid; a synthetic version would be less accurate
than the grid while looking more precise, which is the worst combination
available. Without a key the script exits and the app falls back to grid
sampling, which is honest about what it is.

---

## 11. Multi-region

A region is a name, a set of AOI tiles, and a relief-data source
(`src/lib/regions.ts`). Everything downstream takes a `Region`.

The two publishers expose different schemas — MAG carries free-text hours,
services and pet flags; AZDHS carries cooling/hydration type flags and sparse
hours — and both map to one `ReliefSite` shape in
`scripts/fetch-heat-relief.ts`. That mapping is where "multi-city" is either
honoured or quietly broken, since a product that only works where one agency
publishes one schema is not multi-city.

The modelled stand-in applies a per-region temperature offset
(`syntheticOffsetF`): Phoenix 0, Yuma +2.5 °F. Ignored entirely when live data
is present. Giving two cities 300 km apart an identical diurnal curve would be
a more obvious fiction than the model already is.
