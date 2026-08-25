# CoolRoute Network Planner — Impact Summary

**Heat intelligence for the outdoor mobile workforce.** Phoenix and Yuma, AZ.
FortyGuard Hackathon '26 · Resilient Cities & Infrastructure

---

## The problem

About **32 million people work outdoors in the United States**. Extreme heat is
the country's leading cause of weather-related death — roughly **2,000 deaths a
year**, ahead of hurricanes and floods. High temperatures drove an estimated
**28,000 additional workplace injuries in 2023**, and extreme heat cost the US
economy around **$162 billion in 2024**, with worker-productivity loss a major
component.

Nobody has connected real hyperlocal air temperature to the three people who
can actually act on it:

- the **worker**, mid-shift, deciding whether to take this road now;
- the **dispatcher**, at 2 PM, deciding which crews to pull;
- the **planner**, deciding where the next cooling station goes.

They need the same data and completely different answers from it.

---

## What we built

Cached 2 m temperature fields over two Arizona regions, one scoring function,
three views.

| Region | Area | Relief sites | Workforce |
|---|---|---|---|
| **Phoenix** | 26.3 mi² | 253 (MAG Heat Relief Network) | Couriers, postal, utility, municipal |
| **Yuma** | 33.2 mi² | 21 (AZDHS Heat Preparedness Network) | Agricultural crews, municipal, utility |

Yuma is the proof the engine is not overfitted to one city: different agency,
different schema, different workforce, a tenth of the relief density — and the
same code path, selected from a dropdown.

**Planner** — an exposure-demand layer (heat × where work actually happens),
ranked siting recommendations, and a Forma-style scenario studio with three
comparable options, before/after performance deltas, and a GeoJSON export.

**Dispatcher** — the same scoring run across every active run in the region
(8 in Phoenix, 7 in Yuma), ranked worst first, with a shift-window switch
across three forecast snapshots.

**Worker** — one number, one band, one instruction, plus the nearest real
cooling site, a genuinely different alternative road, and a leave-earlier
comparison.

---

## What it shows, on the committed snapshot

*(Figures produced by the app from **live FortyGuard data** — every grid
`source: "fortyguard"`, each carrying its own `activity_id`. Snapshot of
**2026-08-24**; the scheduled refresh re-pulls the field and the relief
networks, so expect these to move by a point or two.
`npm run verify:data` prints the current ones.)*

| | |
|---|---|
| Phoenix focus area within a 400 m walk of an OPEN relief site | **17.6%** |
| Grid cells that are hot, heavily worked, **and** beyond that walk | **5,071** |
| Longest stretch of an average route with no relief in reach | **6.1 km** |

### Yuma: the same product, a starker picture

| | Phoenix | Yuma |
|---|---|---|
| Relief coverage of focus area (3 PM, open sites only) | 17.6% | **6.3%** |
| Sites publishing usable opening hours | 252 of 254 | **2 of 21** |

### The finding underneath that average

The gap is not spread evenly — it lands almost entirely on the corridors where
outdoor work actually happens. Verified per route (`npm run verify:coverage`):

| Route | Length | Longest stretch with no relief | Sites within a 400 m walk |
|---|---|---|---|
| Buckeye Road industrial run | 16.8 km | **16.8 km — the entire route** | **0** |
| Air cargo to downtown core | 12.7 km | 10.4 km (82%) | 3 |
| Sky Harbor perimeter service run | 10.1 km | 7.0 km (70%) | 4 |
| … | | | |
| Downtown postal relief loop | 7.7 km | 2.5 km (32%) | 12 |
| Central Avenue office spine | 6.4 km | 1.7 km (27%) | 9 |

**A utility crew can work the entire 16.8 km Buckeye Road industrial run
without passing within a 400 m walk of a single cooling centre, hydration
station or respite site.** The nearest one to that route is 942 m away.

**And it reproduces in Yuma, from a different agency's data.** The south-county
utility circuit runs 9.2 km with zero relief sites within a 400 m walk of any
point; the 4th Avenue commercial strip runs 92% of its length uncovered. Two
cities, two publishers, one structural pattern.

**And again in a third and fourth city, from a third kind of source.** Las Vegas
and Tucson have no agency relief feed at all, so they read community-mapped
OpenStreetMap amenities — a weaker grade of data, labelled as such throughout
and never averaged in with the agency regions. The pattern holds anyway: in
Tucson the civic and downtown runs sit around 30% uncovered while the
rail-industrial and airport-approach runs reach 96% and 94%.

This is what the demand layer exists to find. These networks are distributed
where *residents* are — libraries, community centres, churches — which is
correct for their purpose and leaves the industrial, freight and agricultural
corridors, where the outdoor mobile workforce spends its shift, effectively
unserved. Nobody built the networks wrong. Nobody was looking at them through
this lens.

Apply the four top-ranked station recommendations:

| Metric | Base | Scenario | Change |
|---|---|---|---|
| Relief coverage of focus area | 17.6% | 20.3% | **+2.7 pts (+15.3%)** |
| Worst relief gap, averaged over routes | 6,067 m | 3,868 m | **−2,199 m (−36.2%)** |
| Capital cost | — | $180k | ≈ $67k per coverage point |

Four stations, at roughly the cost of a single intersection rebuild, cut the
worst unserved stretch of a courier's day by more than a third.

Switch the shift window and the operational picture moves with it:

| Part of day | Routes in high-exposure zones | Worst run |
|---|---|---|
| Day average (~100 °F) | **0 of 8** | Buckeye Rd — Moderate |
| Day peak (~107.5 °F) | **1 of 8** | Buckeye Rd — **High** |

Re-timing a run is usually cheaper than rerouting it, and the tool makes that
trade visible rather than assumed. The day parts are real: FortyGuard returns a
min, average and max per cell, a ~14 °F swing on the snapshot day.

---

## Why it is credible

- **The relief layers are real.** 253 Phoenix sites — 94 cooling centres, 141
  hydration stations, 18 respite centres — from the Maricopa Association of
  Governments feature service, plus 21 Yuma sites from the Arizona Department
  of Health Services. Two agencies, two schemas, one mapping.
- **The routes are real.** Resolved on the actual road network by
  OpenRouteService / OSRM, including genuine alternative paths.
- **Every assumption is on screen.** Each intervention tool renders its own
  coefficient and confidence level at the moment you use it. A cooling station
  is modelled with *zero* temperature effect, because it does not cool the
  street — its benefit is access, and the model says so.
- **Opening hours are used, not just displayed.** A site that shut at 3 PM is
  excluded from 4 PM coverage and drawn hollow on the map. Counting it would
  have inflated every coverage number exactly when the heat is worst.
- **You can watch the API work.** A button in the Planner re-fetches one tile
  live and streams the submit / poll / complete lifecycle on screen — the async
  contract as something you see rather than something you take on trust.
- **Provenance is a data field, not a footnote.** Every cached tile carries its
  source. When the heat field is a modelled stand-in rather than live
  FortyGuard data, the app says so in a permanent banner.
- **The API is used correctly.** Async submit → poll with exponential backoff,
  AOI limits enforced in code, an (area, time) pair never requested twice, and
  an empirical credit-budget check that runs before any UI is built against the
  data.

---

## Who this is for beyond couriers

The engine is workforce-agnostic. Postal carriers, utility and meter-reading
crews, municipal sanitation and parks crews, rideshare drivers — anyone whose
job is moving outdoors on a schedule. The sample fleet already includes them.
For a city that closes the loop: the municipality is both the planner deciding
where cooling goes **and** the employer of the crews walking through it.

---

## What is illustrative, stated plainly

The heat field is **live FortyGuard data**. Two limits of the service shape what
the product can claim: only `filter_type: 3` (forecast) is served on this key -
1, 2 and 4 return HTTP 500 - and there is no hour-of-day parameter, so intra-day
comparison uses the min/average/max the API returns per cell rather than
invented hourly slices. Intervention effects remain modelling assumptions, not
measured outcomes for these specific sites. Costs are illustrative unit figures.
Nothing here is a regulatory-compliance claim.
