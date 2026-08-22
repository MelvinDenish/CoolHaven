# CoolRoute Network Planner

**Heat intelligence for the outdoor mobile workforce.**
FortyGuard Hackathon '26 · Resilient Cities & Infrastructure

Two Arizona regions. Three audiences. One cached dataset, one scoring function.

```bash
npm install
npm run dev        # http://localhost:3000 — the snapshot is committed, this just works
```

---

## What this is

About **32 million people work outdoors in the United States**. Extreme heat is
the country's leading cause of weather-related death — roughly **2,000 a year**,
ahead of hurricanes and floods — and drove an estimated **28,000 additional
workplace injuries in 2023**.

Three different people can act on that, and they need different answers from
the same data:

| View | The question | What it gives you |
|---|---|---|
| **Planner** | Where should cooling infrastructure go? | Exposure-demand layer, ranked siting, a Forma-style scenario studio, GeoJSON export |
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
| **Heat field** | **Real.** 10 grids, all `source: "fortyguard"`, each carrying its own `activity_id`. `liveApiUsed: true` in both regions. |
| **Relief networks** | **Real.** 253 MAG Heat Relief Network sites (Phoenix) + 21 AZDHS Heat Preparedness Network sites (Yuma), with published hours, ADA and pet flags. |
| **Roads and land cover** | **Real.** OpenStreetMap via Overpass, per region. |
| **Work routes** | **Real geometry.** 8 Phoenix + 7 Yuma runs plus a demo trip each, resolved on the actual road network by OSRM. Endpoints are real named locations; the runs are representative, not a carrier's manifest. |
| **Intervention effects** | **Assumptions.** Every one is labelled in the UI at the moment you use it. See [Methodology](docs/METHODOLOGY.md). |

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

**The forecast horizon is about one day.** Snapshot-date + 2 returned HTTP 500
for every tile in both regions, so the snapshot carries two days, not three.

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

| Region | Tiles | Area | Relief sites | Publisher | Workforce |
|---|---|---|---|---|---|
| **Phoenix, AZ** | 3 | 26.3 mi² | 253 | MAG Heat Relief Network | Couriers, postal, utility, municipal |
| **Yuma, AZ** | 2 | 33.2 mi² | 21 | AZDHS Heat Preparedness Network | Agricultural crews, municipal, utility |

Yuma is a stress test, not decoration: different agency, **different schema**,
agricultural rather than courier workforce, a tenth of the relief density. If
the engine works there it is not quietly overfitted to Phoenix.

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

### 3 · Real cooling infrastructure

Two publishers, two schemas, one mapping in
[`scripts/fetch-heat-relief.ts`](scripts/fetch-heat-relief.ts) — a "multi-city"
product that only works where one agency publishes one schema is not multi-city.

**Opening hours are used, not just displayed.** This began as a correctness
bug: coverage that counts a hydration station which shut at 3 PM overstates the
network at 4 PM — precisely when the field is hottest, so the error ran in the
worst possible direction. Fixing it moved Phoenix coverage from 20.8% to
**16.0%**. Sites shut at the modelled hour are excluded and drawn hollow. Sites
whose publisher gave no hours are counted as available and reported separately,
because deleting real sites over a blank field in someone else's database would
be its own kind of wrong.

---

## What it shows

Phoenix, snapshot day, day average, live data:

| | |
|---|---|
| Focus area within a 400 m walk of an **open** relief site | **16.0%** |
| Relief sites open at this hour | **43 of 60** |
| Cells that are hot, heavily worked **and** beyond that walk | **5,229** |
| Longest stretch of an average route with no relief in reach | **6.9 km** |

**The gap is not spread evenly.** Verified per route with
`npm run verify:coverage`:

- Phoenix **Buckeye Road industrial run**: 16.8 km, **100% of it** with zero
  relief sites within a 400 m walk. Nearest is 942 m away.
- Yuma **south-county utility circuit**: 9.2 km, **also 100%**.
- Dense downtown loops: 27–32%.

Two cities, two publishers, one structural pattern. These networks are
distributed where *residents* are — libraries, community centres, churches —
which is correct for their purpose and leaves the freight, industrial and
agricultural corridors effectively unserved. Nobody built them wrong. Nobody
was looking at them through the workforce lens.

Apply the four top-ranked recommendations:

| Metric | Base | Scenario | Change |
|---|---|---|---|
| Relief coverage | 16.0% | 18.7% | **+2.7 pts (+16.8%)** |
| Worst relief gap, averaged over routes | 6,919 m | 4,625 m | **−2,294 m (−33.2%)** |
| Capital cost | — | $180k | ≈ $67k per coverage point |

---

## Commands

```bash
npm run dev                    # the committed snapshot — no keys needed
npm run build && npm start

npm run data:stations          # relief networks, both regions      (no key)
npm run data:osm               # OpenStreetMap via Overpass          (no key)
npm run data:routes            # OSRM, or ORS if keyed               (no key)
npm run data:ingest            # FortyGuard — the real integration   (key)
npm run data:credit-probe      # Addendum A4 empirical check         (KEY REQUIRED)
npm run data:hourly            # env_params 24h profiles             (KEY REQUIRED)
npm run data:all               # stations + osm + routes + ingest

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
ORS_API_KEY=                   # optional; OSRM is used when absent
```

### Scheduled refresh (FR2)

[`.github/workflows/refresh-snapshot.yml`](.github/workflows/refresh-snapshot.yml)
runs every 30 minutes in Arizona daylight hours, refreshes, verifies and
**commits** the snapshot. A Vercel cron was the obvious choice and the wrong
one: it runs on a read-only filesystem and could only refresh an ephemeral
copy, which satisfies the word "schedule" and misses a requirement that says
*committed*. Needs `FORTYGUARD_API_KEY` as a repo secret.

---

## Architecture

```
scripts/          build-time only — the FortyGuard integration lives here
  ingest-fortyguard.ts   submit -> poll -> rasterise -> classify -> cache
  credit-probe.ts        Addendum A4 empirical credit check
  fetch-heat-relief.ts   two publishers, two schemas, one output shape
  fetch-osm.ts           Overpass -> road density + vegetation + context
  fetch-hourly.ts        env_params -> real 24-hour profiles per point
  generate-routes.ts     ORS/OSRM -> data/<region>/routes.json (committed)
  verify-coverage.ts     independently re-derives the headline, per region

src/lib/          isomorphic domain logic — no framework, no I/O
  regions.ts        THE multi-city layer. Add a city here, nothing else.
  assumptions.ts    EVERY tunable coefficient, with its provenance
  config.ts         AOI guard, forecast days, day parts, cell risk bands
  fortyguard.ts     the API client + the documented real contract
  grid.ts           geometry, HeatField sampler, day-part selection
  scoring.ts        THE scoring function. Worker = Dispatcher = what-if.
  whatif.ts         interventions (points and corridors) -> modified field
  recommend.ts      demand layer (FR7) + station siting (FR8)
  relief.ts         opening-hours reasoning
  share.ts          scenario <-> URL fragment
  forma-export.ts   GeoJSON / CSV export
  synthetic.ts      modelled stand-in, used only when the live call is absent

src/app/api/      bootstrap · field · context · route-plan · export/forma
                  · admin/refresh-tile
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

## Docs

- **[USER_MANUAL.md](docs/USER_MANUAL.md)** — click-by-click walkthrough of every feature
- [METHODOLOGY.md](docs/METHODOLOGY.md) — every coefficient and where it came from
- [IMPACT_ONEPAGER.md](docs/IMPACT_ONEPAGER.md) — the one-page summary
- [DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) — 3–5 minute demo run sheet
- [source/](docs/source/) — the PRD and Addendum this was built against

## Attribution

Heat Relief Network locations © Maricopa Association of Governments · Heat
Preparedness Network locations © Arizona Department of Health Services · Road
network and land cover © OpenStreetMap contributors, ODbL · Routing by
OpenRouteService / OSRM · 2 m temperature data by FortyGuard.
