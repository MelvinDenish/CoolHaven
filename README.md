# CoolRoute Network Planner

**Heat intelligence for the outdoor mobile workforce.**
FortyGuard Hackathon '26 · Resilient Cities & Infrastructure

**Live: [coolroute-network-planner.vercel.app](https://coolroute-network-planner.vercel.app)**

Four US regions. Three audiences. One cached dataset, one scoring function.

```bash
npm install
npm run dev        # http://localhost:3000 — the snapshot is committed, this just works
```

---

## What this is

About **32 million people work outdoors in the United States**. Extreme heat is
the country's leading cause of weather-related death — roughly **2,000 a year**,
ahead of hurricanes and floods — and drove an estimated **28,000 additional
workplace injuries in 2023**. The total cost to the US economy was around
**$162 billion in 2024**, with lost worker productivity a major component.

The framing is deliberately US-only rather than global. FortyGuard's coverage is
US-only today, so a single-country pitch backed by four sourced figures is
stronger than a vaguer multi-country one — see *Scope and future work* below.

Three different people can act on that, and they need different answers from
the same data:

| View | The question | What it gives you |
|---|---|---|
| **Planner** | Where should cooling infrastructure go? | Exposure-demand layer, ranked siting, measured ground truth per site, budget and target solvers, a six-tool scenario studio, GeoJSON in and out |
| **Dispatcher** | Which crews do I pull today? | Every active run scored and ranked worst-first, by part of day |
| **Worker** | Is this run safe, and should I go another way or at another time? | One number, one band, one instruction, nearest open relief |

All three are lenses over the same snapshot and the same
[`scoreRoute`](src/lib/scoring.ts). There is no second engine anywhere — that
was the base PRD's explicit bet, and it is why the Dispatcher view cost about
an hour rather than a day.

---

## Provenance: what is real

Every cached tile carries a `source` field and the app renders it in a
permanent status bar. This is the first thing to check and the first thing a
judge will ask about.

| Layer | Status |
|---|---|
| **Heat field** | **Real.** Every grid `source: "fortyguard"`, each carrying its own `activity_id`, and the snapshot date rolls to today on every ingest. `npm run verify:data` checks both. |
| **Relief layers** | **Real, at two different grades.** Phoenix and Yuma read published agency networks with hours, ADA and pet flags. Las Vegas and Tucson read community-mapped OSM amenities — real places, weaker guarantees, flagged `osm-derived` everywhere they surface. |
| **Ground segmentation** | **Real, and measured.** Street-level and overhead imagery with per-class frame composition, from `/v1/streetview` and `/v1/satellite`. |
| **Roads and land cover** | **Real.** OpenStreetMap via Overpass, per region. |
| **Work routes** | **Real geometry.** Sample runs per region plus a demo trip each, resolved on the actual road network by **OpenRouteService** where a key was available and **public OSRM** otherwise — each region's `routes.json` records which, and the provenance bar reads it from there rather than asserting one. Endpoints are real named locations inside the measured tiles; the runs are representative, not a carrier's manifest. |
| **Intervention effects** | **Assumptions.** Every one is labelled in the UI at the moment you use it — including after the ground segmentation arrived, because a photograph measures cover, not degrees. See [Methodology](docs/METHODOLOGY.md). |

Delete a cache file and re-run `npm run data:ingest` and it comes back from the
live API. Remove the key and it comes back as a modelled stand-in stamped
`source: "synthetic"` with an amber banner. The app never guesses which it has.

---

## The FortyGuard integration

`scripts/ingest-fortyguard.ts` + [`src/lib/fortyguard.ts`](src/lib/fortyguard.ts).
**Nothing in the running app imports the client** except one deliberate,
manual, button-triggered endpoint (below).

### The real contract

The handbook was not enough to build against; this was established by probing
the live API, and every deviation from the initial guess is documented in the
client's header comment.

```
Auth     api-key: <key>            NOT Authorization: Bearer, NOT x-api-key
Submit   POST /v1/heatmap
         { "polygon_aoi": <GeoJSON Polygon>,
           "date_time": { "start_date": "YYYY-MM-DD", "filter_type": 3 } }
         -> { data: { activity_id } }
Poll     GET /v1/status/{activity_id}
         -> { data: { status: "Processing" | "Completed",
                      result: { map_data, stats_data } } }
Result   map_data = FeatureCollection of POLYGON cells
         properties: tile_id, average_temperature, min/max_temperature
         Temperatures are CELSIUS — converted to Fahrenheit at the boundary.
```

Three things worth knowing, all measured rather than assumed:

- **`filter_type` lives inside `date_time`**, not at the top level.
- **Unknown fields are silently ignored.** A wrong parameter name fails
  quietly, which is exactly why the client only sends fields verified to do
  something.
- **Only `filter_type: 3` works on this key.** 1, 2 and 4 pass validation and
  then return HTTP 500 for every date range tried, so Addendum A2's
  Planner→historic mapping cannot be honoured. The separation is still enforced
  in code — `HeatField` throws on mixed `filterType`, and `/api/field` demands
  both parameters — so it starts working the moment historic is served. Until
  then the status bar says `filter_type 3 (forecast)` on every view.

### The endpoints, and what each is for

Addendum A2's plan, and what actually happened to each.

| Endpoint | Role here | Priority | Status |
|---|---|---|---|
| `POST /v1/heatmap` | Core engine. One call per tile per timestamp, on district-scale polygons. | Highest | **Used.** One grid per tile per available day |
| `GET /v1/status/{activity_id}` | Async polling with exponential backoff. Not optional — every submit requires it. | Required | **Used.** 1 s → 15 s ceiling |
| `POST /v1/env_params` | Point queries at tile centroids and route endpoints. Hourly heat index, wet bulb, humidity, air quality. | High | **Used.** The only hour-of-day resolution in the API |
| `POST /v1/streetview` | Eye-level imagery with semantic segmentation at sampled points. | Low / optional | **Used.** Drives the Ground truth panel |
| `POST /v1/satellite` | Overhead imagery with land-cover segmentation. | Low / optional | **Used.** Same panel, the view from above |
| `POST /v1/heat_intelligence` | Richer multi-dimensional reports to strengthen the Planner narrative. | Medium (bonus) | **Available, not shipped.** Completes and returns a generated PDF; a PDF is not something this UI can do anything useful with |

### The two segmentation endpoints

These are the ones Addendum A2 filed under "Premium / optional", and the reason
they took a while to land is that the failure mode is misleading: a wrong body
returns **422 naming a missing field but not its nesting**, which reads like
"you are not entitled to this" rather than "you have the shape wrong".

```
POST /v1/streetview
  { latitude, longitude, vertical_angle, horizontal_angle, back_view }
  -> front / back, each: original_image, segmented_image, segments{}, image_date

POST /v1/satellite
  { latitude, longitude,
    sat:       { latitude, longitude },          <- nested, and repeats the pair
    date_time: { start_date, filter_type } }
  -> original_image, image_year, segmentation{ segments{}, image_content }
```

Both complete in about six seconds — two orders of magnitude faster than a
heatmap tile. `segments` is the payload that matters: the share of the frame
that is tree, sky, building, road, sidewalk, car. Street-level imagery is Google
Street View served through FortyGuard and arrives with its own attribution.

### Two limits that shaped the product

**`/v1/heatmap` has no hour-of-day parameter.** `hour` and `start_time` are
accepted and ignored — two submissions differing only by `hour` returned
byte-identical statistics. So the hour slider an earlier build had was removed
rather than faked, which is what base PRD FR17 demands.

Two things replaced it, both real:

- **`/v1/env_params` returns 24 hourly values per point.** This endpoint is not
  a temperature lookup — it takes a dry-bulb temperature as *input* and returns
  a derived hourly profile: apparent temperature, heat index, wet bulb,
  humidity, cloud cover, air quality. It is the only hour-of-day resolution in
  the API, and it is per-point, which is exactly the shape FR17 needs. The
  Worker view charts it: Phoenix apparent temperature runs **94 °F at 06:00 to
  114 °F at 13:00** — a 21 °F decision.
- **Every heatmap cell carries min / average / max for the day.** That range
  re-scores the *whole route and field* (93 → 100 → 107.5 °F in Phoenix), which
  the point profile cannot do.

The Worker view shows both and says which is which: one is a chart at a point,
the other moves every number on screen.

**`/v1/heat_intelligence` works, and is still not shipped.** The contract is
`{latitude, longitude, temperature, date, analysis:[...]}` where `analysis`
accepts `geographic`, `environmental`, `urban`, `events`, `anthropogenic`. It
submits, polls to `Completed`, and returns a signed link to a generated **PDF**.
That is a document for a person to read, not data this UI can compute against,
and rendering someone else's PDF inside a planning tool adds a dependency
without adding a number. The client method is not written; the finding is
recorded here so the next person does not re-derive it.

**The forecast horizon has closed to the snapshot day.** Day +1 currently
completes and returns **zero cells** for every tile; day +2 previously returned
HTTP 500. So the committed snapshot carries one day, and the day selector only
offers what the manifest actually holds. Days the service cannot serve are
dropped rather than filled with a modelled stand-in, and a (tile, date) pair
found empty is remembered so the next scheduled run does not spend three and a
half minutes re-discovering it.

### Discipline

- **AOI limit enforced in code.** `assertTilesWithinAoiLimit()` throws before a
  request goes out. Every tile is under the 20 mi² target.
- **An (area, date) pair is never re-requested** without `--force`.
- **Backoff** doubles from 1 s to a 15 s ceiling on every status check.
- **`npm run data:credit-probe`** implements Addendum A4's empirical check and
  refuses to run without a real key, because a guessed number is worse than no
  number. *(The API does not report credit consumption in its response, so read
  the dashboard delta around a single call.)*

### Watch it happen

The Planner has a **"Fetch this tile from the API now"** button that streams the
submit → poll → complete lifecycle on screen — every poll attempt, the backoff,
the `activity_id`.

The base PRD excludes "live FortyGuard calls triggered by user interaction" and
is right to. This is deliberately not that: manual, bounded to one tile and one
date, and off the judged path entirely. Without a key it returns an honest 503
rather than a simulated progress bar.

---

## Regions

A region is one entry in [`src/lib/regions.ts`](src/lib/regions.ts). Everything
downstream takes a `Region`. Adding a third city is a config entry plus
`npm run data:all -- --region=<id>`.

| Region | Tiles | Area | Relief source | Quality | Workforce |
|---|---|---|---|---|---|
| **Phoenix, AZ** | 3 | 26.3 mi² | MAG Heat Relief Network | agency | Couriers, postal, utility, municipal |
| **Yuma, AZ** | 2 | 33.2 mi² | AZDHS Heat Preparedness Network | agency | Agricultural crews, municipal, utility |
| **Las Vegas, NV** | 2 | ~18 mi² | OpenStreetMap amenities | osm-derived | Hospitality, couriers, warehouse, municipal |
| **Tucson, AZ** | 2 | ~19 mi² | OpenStreetMap amenities | osm-derived | Couriers, university, utility, landscaping |

Yuma is a stress test, not decoration: different agency, **different schema**,
agricultural rather than courier workforce, a tenth of the relief density. If
the engine works there it is not quietly overfitted to Phoenix.

Las Vegas and Tucson test a harder claim — that a city with **no agency feed at
all** still works. They read community-mapped OSM amenities instead: drinking
fountains, libraries, community centres. Real places, but nobody has undertaken
to be a relief site, and OSM rarely carries opening hours.

**So their coverage figures are not comparable with Phoenix's**, and the app
never puts them in the same table. Each region carries a `dataQuality` flag,
the provenance bar names the source, and `npm run verify:data` reports
`osm-derived` as a **WARN** rather than a PASS.

Adding a region is a `REGIONS` entry plus `npm run data:all -- --region=<id>` —
**and** a hand-authored route set in `scripts/generate-routes.ts`, because
sample runs have to start and end at real places inside the measured tiles.
That last part is the one bit of adding a city that is not automatic, and the
earlier claim that it was "one config entry" was overstated.

---

## The three additions

### 1 · Forma-inspired what-if UI, narrative and export

- **Options, not edits** — three variants (A/B/C) compared side by side on
  coverage gained, capital cost and **cost per coverage point**.
- **Performance readout** — base and scenario as a bar pair with the delta, and
  the improvement direction declared per metric.
- **The assumption travels with the tool** — every placement tool renders its
  own coefficient and confidence inline (FR9).
- **Right geometry** — stations are points; canopy and cool pavement are drawn
  as **corridors along streets**, because that is how they are specified and
  tendered. Export buffers them into polygons.
- **Export and share** — GeoJSON, CSV, print/PDF, and a link that encodes the
  whole scenario in the URL fragment (~130 chars, no account, no server state).

RFC 7946 GeoJSON, EPSG:4326, each feature carrying `coolroute:deltaF`,
`coolroute:confidence`, `coolroute:assumption`, `coolroute:unitCostUsd` and a
`forma:category` hint. **Forma-compatible standard GeoJSON — not a certified
Forma integration**, and the app never claims otherwise.

### 2 · Real routing engine

[`src/lib/routing.ts`](src/lib/routing.ts): **OpenRouteService** when
`ORS_API_KEY` is set, **public OSRM** as a keyless fallback, then a clearly
labelled straight line. Both real providers return genuine **alternative
paths**, scored with the same function and compared on exposure saved versus
minutes lost — and when the alternative is *hotter*, the UI says so with the
magnitude rather than reporting a saving of zero.

Ad-hoc trips accept an **optional waypoint** (FR14); supplying one disables the
alternative comparison, because both engines stop returning alternatives once a
trip has a via point.

The judged path never depends on live routing: all runs are resolved at build
time and committed.

### 1b · From locating to planning

Three additions that move the Planner from annotating a map to producing a plan.

**Solve for a budget.** *"I have $500k — what is the best mix?"* The solver
walks a deep pool of candidate sites and picks greedily by **new ground covered
per dollar**, re-evaluating after each pick because placements overlap.

**Solve for a target.** *"How many sites to reach 25% coverage, and what does it
cost?"* Same engine, different stopping condition — and when the target is not
reachable from the viable candidates, it says so and reports where it stopped
rather than quietly returning its best effort.

Maximum coverage is NP-hard and the objective is submodular, so greedy is not
optimal — it is provably within a constant factor, and, more usefully here,
**followable**: "it bought this one first because it covered the most uncovered
ground per dollar" survives a council meeting in a way a branch-and-bound
optimum does not. The panel says greedy rather than implying an optimum.

**A six-tool palette.** Stations and canopy and cool pavement, plus **misting**
(large effect, deliberately tiny radius — evaporative cooling works on the
person standing in it), **shade sails** (smaller than canopy, available the day
it is installed) and **bus-shelter retrofit**. That last one exists because of a
bug: the OSM relief pull initially counted bus shelters as relief sites, which
was wrong — but the *structures* are already standing on exactly the corridors
workers use, and converting one is a fraction of a new station's cost.

### 2 · The Forma round trip

**Out:** GeoJSON carrying `coolroute:deltaF`, confidence, assumption and unit
cost, so the coefficient travels with the geometry.

**In:** [`forma-import.ts`](src/lib/forma-import.ts) reads a design back and
turns it into scored scenario elements. Points become facilities, lines become
corridors, polygons become footprints sized from their own extent. A file this
app exported round-trips exactly, because it carries `coolroute:kind`; a foreign
file is mapped from geometry and any Forma category hints.

The failure it catches by name is the one that actually happens: Forma exports
in the project's local coordinate system by default, and a file in metres would
otherwise be scored somewhere in the Gulf of Guinea. Coordinates outside the
legal lon/lat range are rejected with a message naming the CRS as the problem.

**This is a file reader, not an Autodesk integration** — no account, no SDK, no
extension, and the panel says so where you use it.

### 2b · Street level, two ways

**Click any street.** Road centrelines are pulled from Overpass at build time
and committed (4,207 streets in Phoenix), and clicking one reports its **mean,
peak and coolest** temperature along its whole length, sampled from the field
currently on screen. Apply a canopy corridor over it and probe again — the
numbers move, because it samples the active scenario field rather than a value
baked in at build time.

The honest limit: `/v1/heatmap` has **no granularity parameter**, so the server
picks the cell size (~100 m). The readout is street-level; the data underneath
is 100 m-level, and the two are not the same claim.

**Ground truth.** `/v1/streetview` and `/v1/satellite` return imagery *plus a
semantic segmentation* — the share of the frame that is tree, sky, building,
road, sidewalk, car. That is a measurement at eye level, and it is the only one
in the product that speaks to whether a canopy intervention is possible at a
site at all: planting on a block already at 40% tree cover is a different
proposition from planting at 2%.

What it deliberately does **not** do is set the canopy coefficient.
`canopyHeadroom()` in [assumptions.ts](src/lib/assumptions.ts) draws that line
in code — a photograph contains no temperature, so `tree_canopy.deltaF` stays
the labelled assumption it always was, and the panel says so on screen.

### 3 · Real cooling infrastructure

Two publishers, two schemas, one mapping in
[`scripts/fetch-heat-relief.ts`](scripts/fetch-heat-relief.ts) — a "multi-city"
product that only works where one agency publishes one schema is not multi-city.

**Opening hours are used, not just displayed.** This began as a correctness
bug: coverage that counts a hydration station which shut at 3 PM overstates the
network at 4 PM — precisely when the field is hottest, so the error ran in the
worst possible direction. Fixing it cut the reported Phoenix coverage by about
**a fifth** — the exact pair of figures moves with every refresh, but the
direction and rough size do not. Sites shut at the modelled hour are excluded
and drawn hollow. Sites
whose publisher gave no hours are counted as available and reported separately,
because deleting real sites over a blank field in someone else's database would
be its own kind of wrong.

---

## What it shows

Phoenix, snapshot day, day average, live data:

> **Figures drift.** The scheduled refresh re-pulls the relief networks and the
> heat field every 30 minutes, and both genuinely change - sites open and close
> through the season. Numbers quoted here are from one snapshot; expect the
> live app to differ by a site or two. `npm run verify:coverage` always prints
> the current ones.

| | |
|---|---|
| Focus area within a 400 m walk of an **open** relief site | **17.6%** |
| Relief sites open at this hour | **213 of 254** |
| Cells that are hot, heavily worked **and** beyond that walk | **5,071** |
| Longest stretch of an average route with no relief in reach | **6.1 km** |

**The gap is not spread evenly.** Verified per route with
`npm run verify:coverage`:

- Phoenix **Buckeye Road industrial run**: 16.7 km, **100% of it** with zero
  relief sites within a 400 m walk.
- Yuma **south-county utility circuit**: 9.2 km, **also 100%**.
- Tucson **south rail-industrial circuit**: **96%**; the airport approach, 94%.
- Dense downtown and civic loops, in every city: **27–35%**.

Four cities, three kinds of data source, one structural pattern. These networks are
distributed where *residents* are — libraries, community centres, churches —
which is correct for their purpose and leaves the freight, industrial and
agricultural corridors effectively unserved. Nobody built them wrong. Nobody
was looking at them through the workforce lens.

Apply the four top-ranked recommendations:

| Metric | Base | Scenario | Change |
|---|---|---|---|
| Relief coverage | 17.6% | 20.3% | **+2.7 pts (+15.3%)** |
| Worst relief gap, averaged over routes | 6,067 m | 3,868 m | **−2,199 m (−36.2%)** |
| Capital cost | — | $180k | ≈ $67k per coverage point |

---

## Commands

```bash
npm run dev                    # the committed snapshot — no keys needed
npm run build && npm start

npm run data:stations          # relief layers, every region         (no key)
npm run data:osm               # Overpass: roads, streets, land use  (no key)
npm run data:routes            # OpenRouteService, OSRM if unkeyed   (ORS key)
npm run data:ingest            # FortyGuard — the real integration   (key)
npm run data:credit-probe      # Addendum A4 empirical check         (KEY REQUIRED)
npm run data:hourly            # env_params 24h profiles             (KEY REQUIRED)
npm run data:ground            # streetview + satellite segmentation (KEY REQUIRED)
npm run data:all               # stations + osm + routes + ingest

npm run verify                 # typecheck + verify:data + verify:coverage
npm run verify:data            # freshness, provenance and integrity of the snapshot
npm run verify:coverage        # independently re-derives the relief-gap headline
npm run typecheck

# every data script takes a region filter
npm run data:ingest -- --region=yuma
npm run data:ingest -- --force        # re-request cached (area, date) pairs
```

Every data script **preserves the previous snapshot on failure**. A
demo-morning network blip cannot wipe a working dataset — not theoretical:
Overpass returned 500/502/504 from both primary mirrors during development.

### Environment

```bash
cp .env.example .env.local     # or use .env — both are gitignored
FORTYGUARD_API_KEY=...         # required only by scripts/, never by the app
ORS_API_KEY=...                # preferred router; OSRM is the keyless fallback
```

### Scheduled refresh (FR2)

[`.github/workflows/refresh-snapshot.yml`](.github/workflows/refresh-snapshot.yml)
runs every 30 minutes in Arizona daylight hours, refreshes, verifies and
**commits** the snapshot. A Vercel cron was the obvious choice and the wrong
one: it runs on a read-only filesystem and could only refresh an ephemeral
copy, which satisfies the word "schedule" and misses a requirement that says
*committed*. Needs `FORTYGUARD_API_KEY` as a repo secret.

Add `VERCEL_TOKEN`, `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` as secrets too and
the workflow pushes each verified refresh to the live site; without them the
deploy step skips and the deployment keeps whatever snapshot it was last given
by hand. A commit on its own does **not** redeploy — see below.

### Deployment

Deployed to Vercel at
**[coolroute-network-planner.vercel.app](https://coolroute-network-planner.vercel.app)**.

```bash
vercel link --yes --project coolroute-network-planner
vercel deploy --prod
```

Two things make this work and are easy to get wrong:

- **The committed data has to reach the serverless bundle.** The API routes
  read `data/<region>/...` from disk at request time, and the paths are built
  from `regionId` at runtime, so Next's file tracer cannot see them.
  [`next.config.mjs`](next.config.mjs) pins them with
  `outputFileTracingIncludes: { '/api/**/*': ['./data/**/*'] }`. Without it the
  deploy builds cleanly and then 503s on every request.
- **Four environment variables**, set on the project rather than committed:
  `FORTYGUARD_API_KEY` and `FORTYGUARD_BASE_URL` (used only by
  `/api/admin/refresh-tile`, the on-demand single-tile refresh),
  `ORS_API_KEY` (used only by `/api/route-plan`) and `OSRM_BASE_URL` (its
  keyless fallback). Nothing else in the app touches the network, which is
  what makes FR3 checkable.

Git-push deploys are not wired up: linking the GitHub repo needs a login
connection on the Vercel account, which is an account setting rather than
something the CLI can do. `vercel deploy --prod` from the working tree is the
current path.

---

## Architecture

```
scripts/          build-time only — the FortyGuard integration lives here
  ingest-fortyguard.ts   submit -> poll -> rasterise -> classify -> cache
  credit-probe.ts        Addendum A4 empirical credit check
  fetch-heat-relief.ts   three sources, three schemas, one output shape
  fetch-osm.ts           Overpass -> road density + street lines + context
  fetch-hourly.ts        env_params -> real 24-hour profiles per point
  fetch-ground.ts        streetview + satellite -> frame composition per point
  generate-routes.ts     ORS/OSRM -> data/<region>/routes.json (committed)
  verify-coverage.ts     independently re-derives the headline, per region
  verify-data.ts         freshness, provenance, drift - fails the build on FAIL

src/lib/          isomorphic domain logic — no framework, no I/O
  regions.ts        THE multi-city layer. A city is an entry here + a route set.
  basemaps.ts       ground layers and street types, kept free of Leaflet
  assumptions.ts    EVERY tunable coefficient, with its provenance
                    — including canopyHeadroom(), the one thing the ground
                      segmentation does and does not license us to say
  config.ts         AOI guard, forecast days, day parts, cell risk bands
  fortyguard.ts     the API client + the documented real contract
  grid.ts           geometry, HeatField sampler, day-part selection
  scoring.ts        THE scoring function. Worker = Dispatcher = what-if.
  whatif.ts         interventions (points and corridors) -> modified field
  recommend.ts      demand layer (FR7) + station siting (FR8)
  relief.ts         opening-hours reasoning
  share.ts          scenario <-> URL fragment
  solve.ts          budget and target solvers - greedy, and says so
  forma-export.ts   GeoJSON / CSV export
  forma-import.ts   a design read back in and scored (the return leg)
  synthetic.ts      modelled stand-in, used only when the live call is absent

src/components/   the three views, plus
  Onboarding.tsx    the opening screen: one derived number, then four steps
  GroundPanel.tsx   street-level segmentation and shade headroom
  MapCanvas.tsx     heat canvas, basemap switch, street probe

src/app/api/      bootstrap · field · context · streets · ground · route-plan
                  · export/forma · admin/refresh-tile
data/<region>/    the committed snapshot — this is what the app reads
```

**Where computation happens:** scoring, what-if, coverage and the demand layer
all run **in the browser** against the snapshot fetched once per region. Moving
a scenario control makes zero server requests.

**Why the heat field is a canvas, not polygons:** 6,776 cells (Phoenix) and
8,680 (Yuma) per reading drawn as Leaflet rectangles makes panning unusable.
Each tile is painted to an offscreen canvas exactly `cols × rows` pixels and
stretched over its bbox.

---

## Honest notes

- **The live average field is almost flat** — about 0.3 °F across 26 mi² of
  Phoenix. The map looks uniform because the data is uniform, and the Planner
  says so on screen rather than letting you assume the renderer is broken.
  Siting here is driven by where work happens and where relief is missing, not
  by hot spots. Yuma has more spatial contrast (2–4 °F), and the day-part
  selector moves the whole field by ~14 °F.
- **A cooling station is modelled with zero temperature effect.** Its benefit
  is access — somewhere to stop within a 400 m walk — and inventing a degree
  figure would have been easy and wrong.
- **Temperature is reported twice and the two rows usually disagree.** A canopy
  corridor moves the treated band by about −1.3 °F and the whole district by
  nothing. Both are true.
- **The risk classification has five bands, not four.** At a 108 °F ceiling,
  Yuma's modelled snapshot classified as 100% extreme — 8,680 of 8,680 cells in
  one band, true and useless. Splitting at 114 °F restored discrimination.
- **Exposure bands are calibrated for a desert summer** and anchored on minutes
  at 110 °F. They were not re-tuned after the live data arrived, which would
  have been fitting the scale to make a headline look better.
- **`highway=service` is excluded** from the road-density pull: it times the
  Overpass query out and carries the lowest weight anyway.
- **Two items were promoted off the base PRD's cut list** (§6.6): export and
  cool pavement are now core, per the additions brief.
- **No regulatory-compliance claims.** Thresholds are working bands for an
  employer's internal planning, not tied to any named standard.

---

## Scope and future work

**FortyGuard's coverage is US-only.** That is a property of the data source,
not of the design, and it is the reason the pitch above is framed around US
figures rather than global ones. Four regions across two states were chosen
because the problem is sharpest there, not because the approach is
Arizona-shaped — and two of them deliberately have no agency relief feed at all,
which is the harder test.

**International scaling is deferred, not abandoned.** Architecturally it is the
same move that adding Yuma was: a region is a bounding box, a set of tiles, and
a local relief-network source. [`src/lib/regions.ts`](src/lib/regions.ts) already
carries all three per region, and `ReliefSource` already abstracts over two
different agency schemas with different field names. A non-US city needs a
fourth thing the repo cannot supply: FortyGuard serving that geography. When it
does, the work is a new entry in `REGIONS` plus a relief-source adapter —
additive, not a redesign.

**Other explicit future work**, in the order it would be worth doing:

- **Historic baselines** once `filter_type` 1 is served on this key. The
  Planner-uses-historic / operations-uses-forecast split that Addendum A2 asks
  for is already enforced in code and is simply waiting on the API.
- **A longer forecast horizon** if the service starts serving day +1 again. The
  ingest already attempts it, drops it cleanly when it comes back empty, and
  remembers not to keep asking.
- **Ground segmentation at every recommended site**, rather than at a fixed set
  of sample points. The call is fast (~6 s) and cheap; what makes it a build
  rather than a config change is that recommendations are computed in the
  browser, so the points to sample are not known until someone moves a slider.
- **`heat_intelligence` as a Planner attachment.** It works and returns a
  generated PDF; making that useful means deciding what a planning tool does
  with someone else's document.
- **Worker-facing mobile app.** The responsive layout works on a phone, but a
  worker mid-shift wants a notification, not a browser tab.

---

## Non-functional requirements, measured

Base PRD §7 states two requirements that are claims about the running app
rather than about its code, so both were measured. The first measurement
attempt was wrong and is worth recording, because it is the kind of wrong that
usually ships.

**Performance: <3 s for any in-app interaction.**

The obvious method — click a control, wait two animation frames, read the
clock — reported ~1,300 ms for the heaviest interaction. That looked plausible
and was an artifact: the browser tab was backgrounded, so `requestAnimationFrame`
was throttled to about one callback per second. The control that proved it was
**Hide legend**, a pure CSS class toggle, which reported **1,028 ms** through
the same harness. Any figure near that floor was measuring Chrome, not CoolRoute.

Measured instead where the work actually is — in Node, against the committed
snapshot, median of 9 warm runs. On the snapshot those figures were taken from,
scoring every Phoenix route came to **103 ms**, and applying four stations and
rescoring everything to **151 ms** — the heaviest recompute in the product, against
a 3,000 ms budget.

Those absolute numbers move with the data: the relief networks change size on
every refresh, and coverage is a nested loop over sites per route sample, so
Phoenix cost roughly 20× Yuma despite Yuma having *more* grid cells. That loop
is the hot path if this ever needs optimising, and it does not.

What holds regardless of the snapshot is the structure: the work is bounded by
routes × sites × samples, it runs in the browser, and nothing on the interactive
path calls FortyGuard.

**What that figure is, and is not.** It is the computation an interaction
triggers, measured directly. It is *not* end-to-end click-to-paint: React
commits the click in under 1 ms and schedules the recompute, and the canvas
redraw sits on top of it. Two attempts to measure the full round trip in an
automated browser produced artifacts rather than numbers — the
`requestAnimationFrame` method hit background-tab throttling, and `longtask`
entries turned out not to be attributed through the automation harness at all
(it missed a deliberately injected 150 ms block, which is how that was caught).
So the honest position: the dominant cost is measured and is 5% of budget; the
remaining paint cost is not measured. To close it, run
[USER_MANUAL §9.1](docs/USER_MANUAL.md) in a **foreground** tab, where rAF is
trustworthy. It takes about a minute.

Whatever that last number proves to be, it holds for a structural reason:
nothing on the interactive path calls FortyGuard. That is the point of the
caching layer.

**Demo reliability: runs from the committed snapshot, no live API dependency.**

Stated precisely, because there are two exceptions and both are deliberate. On
the **judged path** — load, switch views, move any scenario control, score,
rank, export — the only hosts contacted are this app's own origin and the
basemap tile server. Two features off that path do reach further, and each says
so in the UI at the moment you use it: the **ad-hoc trip planner** calls
OpenRouteService or OSRM, and the **live tile refresh** calls FortyGuard.
Selecting the satellite basemap adds Esri's tile host for as long as it is
selected.

Enumerating every network request the production app issues gives two hosts and
no others:

```
coolroute-network-planner.vercel.app   17   app bundle + /api/bootstrap + /api/field
tile.openstreetmap.org                 71   basemap tiles
```

No FortyGuard, no OpenRouteService, no Overpass at runtime — which is exactly
what FR3 asks for. The same-origin requests are the app serving its own
committed snapshot, so the accurate claim is *no third-party dependency beyond
basemap tiles*, not *no network at all*.

**One addition since that was measured.** Switching the ground layer to
**Satellite** adds a third host, `server.arcgisonline.com`, for as long as it is
selected. It is off by default and it is imagery only — every score, ranking,
scenario and export is unaffected by losing it, exactly as with OpenStreetMap.
The street-level readout and the Ground truth panel add no hosts at all: both
are served from the committed snapshot by `/api/streets` and `/api/ground`.

Hiding the basemap pane on a loaded map leaves the heat field, the relief sites
and the routes all still drawn, and every score, ranking, scenario and export
still working. Strictly that demonstrates the data layers are independent of
the basemap layer rather than simulating a cold offline start — but it is the
same conclusion for the failure that matters: lose OpenStreetMap and you lose
street names and landmarks, not function.

No offline basemap is bundled. That would be megabytes of tile assets to guard
against a failure that leaves the tool usable anyway. Better to say what breaks.

---

## Risks and how they are mitigated

Addendum A5 asks for these two by name. Both are mitigated in code rather than
in prose, so each row points at the thing that enforces it.

| Risk | Mitigation | Where |
|---|---|---|
| **AOI limit exceeded** — a request over ~50 mi² / 130 km² is rejected, and Phoenix as a whole is far over it | Tiles are declared per region and validated *before* any request goes out; the build fails rather than the API. Phoenix is 3 tiles / 26.3 mi², Yuma 2 / 33.2 mi² | `assertTilesWithinAoiLimit()` in [config.ts](src/lib/config.ts) |
| **Credit budget unknown** — no per-call cost is documented, so blind estimation could exhaust the 2,000,000 allotment | Empirical probe run against a real key before the caching layer was built, per A4; the script refuses to run without one. An (area, date) pair is never re-requested without `--force` | [credit-probe.ts](scripts/credit-probe.ts), [ingest-fortyguard.ts](scripts/ingest-fortyguard.ts) |
| **Demo-time network failure** | Nothing on the judged path touches the network except basemap tiles; the snapshot is committed | [snapshot.ts](src/lib/server/snapshot.ts) has no network call at all |
| **Upstream data source down** | Every data script preserves the previous snapshot on failure — not theoretical, Overpass returned 500/502/504 during development | all of `scripts/` |

---

## Docs

- **[USER_MANUAL.md](docs/USER_MANUAL.md)** — click-by-click walkthrough of every feature
- [METHODOLOGY.md](docs/METHODOLOGY.md) — every coefficient and where it came from
- [IMPACT_ONEPAGER.md](docs/IMPACT_ONEPAGER.md) — the one-page summary
- [DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) — 3:25 demo run sheet, paced for a 3-minute cap
- [source/](docs/source/) — the PRD and Addendum this was built against

## Attribution

Heat Relief Network locations © Maricopa Association of Governments · Heat
Preparedness Network locations © Arizona Department of Health Services · Road
network and land cover © OpenStreetMap contributors, ODbL · Routing by
OpenRouteService / OSRM · 2 m temperature data by FortyGuard.
