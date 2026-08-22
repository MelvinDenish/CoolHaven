# CoolRoute Network Planner
### Heat Intelligence for the Outdoor Mobile Workforce
## Product Requirements Document — Version 3.0 (Niched, Stress-Tested, Hackathon-Ready)
FortyGuard Hackathon'26 · Track: Resilient Cities & Infrastructure
Date: August 17, 2026

---

### 0. What Changed From v1.0 (and why)

| v1.0 Assumption | Reality Found | Fix Applied in v2.0 |
|---|---|---|
| FortyGuard API is a fast point-lookup (`temperature_f`, `risk_level` per query) | Real API (`POST /v1/heatmap`) takes a **polygon AOI**, is **async** (submit → `activity_id` → poll), and has a **granularity** parameter | Added a pre-fetch/caching layer. App never calls FortyGuard live from the UI. |
| "<3 second" response for any interaction | Incompatible with async polling | NFR now applies to *our own cached layer*, not live FortyGuard calls |
| City Planner + Driver as two nearly-separate product flows | Doubles build scope for a 2-week sprint | Both are now views over one shared cached dataset, not separate engines |
| What-if adjustment factors implied as validated | No real source — invented numbers | Explicitly labeled "illustrative assumptions" in UI, with methodology note |
| Synthetic delivery routes / demand layer | Undefined — no generation method specified | Concrete method specified (§6.3) |
| Cooling station data "static GeoJSON" | Public sources exist but aren't API-ready | Manual one-time geocoding task added to Week 1 |
| Live Overpass queries for map layers | Can be slow/rate-limited mid-demo | Pre-fetched and cached at build time, same as FortyGuard data |
| Team size/effort unspecified | 14-day plan assumes near full-time 2–3 people | Stated explicitly as a planning assumption (§11) |
| Scope was "cities" in the abstract | Too broad to build or pitch convincingly in 2 weeks | Niched to a specific, high-need group: the outdoor mobile workforce (§1, §4) |
| Only an individual-worker view existed | No way to show organizational/employer value at scale | Added a Dispatcher/Fleet aggregate view (§6.4) — same data, new lens |

---

### 1. Vision & Overview

**CoolRoute Network Planner** uses FortyGuard's hyperlocal 2m Temperature API to protect the **outdoor mobile workforce** — anyone whose job is moving along routes or stops outdoors, on a schedule, in the heat — and to help the organizations that plan for them (cities, dispatchers, fleet operators) decide where cooling infrastructure and rest support matter most.

**Who this covers (one engine, many groups):**
- Delivery/courier riders and drivers (the flagship demo persona — most visual, most relatable)
- Postal carriers (highly regular routes — arguably the strongest "real client" fit)
- Rideshare/taxi drivers (route + idle/queue-wait exposure)
- Utility and meter-reading crews
- Municipal crews — sanitation, road maintenance, parks (here the city is both planner *and* employer, which ties the whole product back to the original government-planning angle)

The build only needs to demo one persona convincingly (delivery/courier in Phoenix). The pitch is that the same engine is workforce-agnostic — a single line in the deck turns a single-market prototype into a platform story, at no extra build cost.

**Core value proposition:** "One heat-intelligence layer, three audiences: where cities/employers should put cooling and rest support, how individual workers should move around the heat, and where a dispatcher should pull crews off the riskiest routes today."

---

### 2. Problem Statement

Extreme heat is an acute, daily operational risk for anyone whose job keeps them moving outdoors on a schedule — delivery riders, couriers, postal carriers, utility crews, municipal workers. It's also a planning and duty-of-care challenge for the employers and cities responsible for them. No practical tool connects real hyperlocal air-temperature data to all three: the individual worker in the moment, the dispatcher managing a crew today, and the planner deciding where to invest in cooling long-term.

---

### 3. Goals & Success Metrics (Hackathon)

**Primary Goals**
- Demonstrate real, correctly-architected use of the FortyGuard API (not a mocked stand-in).
- Ship a working, demoable prototype covering both audiences without either being half-built.
- Run at least one what-if scenario with a clearly labeled, defensible methodology.
- Submit a clean, judge-legible package by Aug 30.

**Success Metrics**
- End-to-end demo works **offline from a cached snapshot** (no live-API dependency during judging).
- One what-if scenario visibly changes both the map and the recommendation text.
- README documents exactly how the FortyGuard API was called, how often, and why the caching layer exists — this doubles as evidence of understanding the API, which is a real judging strength.

---

### 4. Target Users

| User Type | Primary Needs | Key Actions |
|---|---|---|
| City Planner / Resilience Officer | Decide where to place cooling infrastructure for the outdoor workforce | View demand layer, run what-if, read impact summary |
| Dispatcher / Fleet Manager | Manage crew safety and coverage *today*, in real time | View aggregate crew exposure across active routes, flag which routes/shifts are riskiest right now |
| Individual Worker (courier, driver, carrier, crew member) | Avoid dangerous heat exposure on shift | Score a route, see nearest rest-stop, glance-and-go UI |

Planner and Dispatcher are both organizational lenses over the same cached dataset — Planner is long-horizon (where to build), Dispatcher is short-horizon (what to do today). The individual Worker view stays deliberately separate and minimal, since it's used in the field, not at a desk.

---

### 5. Scope

**In Scope (MVP)**
- Single focus city: **Phoenix, AZ**. Single flagship persona for the demo: **delivery/courier riders**, explicitly framed as one instance of the broader outdoor mobile workforce.
- A pre-fetched, cached temperature/risk grid (see §8) — this *is* the FortyGuard integration, not a live per-click call.
- Real cooling-station locations (manually sourced, §6.3).
- Planner view: demand layer + station recommendations + what-if scenarios.
- Dispatcher view: aggregate exposure across a small set of active sample routes/shifts, ranked by current risk.
- Worker view: route heat score + nearest rest spot, computed from the **same cached grid**, deliberately minimal UI (see §6.4).
- One clearly-labeled what-if engine (station placement + canopy/shade zones). Cool pavement is a stretch goal, not core — cut first if time runs short.
- Before/after comparison.
- One line in the pitch/deck positioning the engine as workforce-agnostic (applies to couriers, postal, utility, municipal crews) — narrative only, no extra build work.

**Out of Scope**
- Live FortyGuard calls triggered by user interaction.
- Real-time fleet GPS.
- Multi-city support.
- Authentication / user accounts.
- Native mobile apps.
- Export/download feature (moved to nice-to-have, §10).
- Full 3D digital twin.
- Any specific regulatory-compliance claims (framed generally as "supports an employer's internal heat safety planning," not tied to any named standard).

---

### 6. Functional Requirements

**6.1 Data Layer (new — this is the section that makes the API integration real)**
- FR1: A build-time/background script submits a grid of polygon AOIs covering the Phoenix focus area to `POST /v1/heatmap`, polls each `activity_id` to completion, and stores results (temp, risk classification, timestamp) as a static tileset (JSON/GeoJSON).
- FR2: Cache refresh runs on a schedule (e.g., every 15–30 min) or manually before a demo; a **timestamped fallback snapshot** is always committed to the repo so the app works with zero live network dependency during judging.
- FR3: All frontend map/scoring interactions read from the local cache, never call FortyGuard directly. This is what makes the <3s NFR achievable and honest.

**6.2 Shared Core**
- FR4: Interactive map centered on Phoenix with toggleable layers (temperature grid, risk level, cooling stations, demand layer).
- FR5: Clear switch between Planner, Dispatcher, and Worker views — same map, same data, different overlays/controls per audience.

**6.3 Planner View**
- FR6: Display real cooling stations/hydration points (manually geocoded from public Maricopa County sources — budget this as an explicit Week 1 task, not an assumption).
- FR7: Demand/exposure layer = cached risk grid weighted by a documented, simple heuristic (e.g., road density + a small set of realistic synthetic delivery routes generated from the OSM road network between plausible depot and delivery-zone points — **not left undefined**).
- FR8: Rank and recommend new station locations from grid cells with high exposure and low current coverage.
- FR9: What-if scenario engine: add N stations, expand shade/canopy in selected zones. Each scenario shows its assumption inline (e.g., "assumed effect: −X°F within Y meters, illustrative only — see methodology note").
- FR10: Before/after comparison of exposure scores.

**6.4 Dispatcher View (new)**
- FR11: Shows a small set of sample active routes/shifts (5–10 is enough for a convincing demo) plotted on the map, each scored against the current cached grid.
- FR12: Simple ranked list: "riskiest routes right now" by exposure score, so a dispatcher can decide who to pull in, reroute, or send extra water/rest breaks to.
- FR13: One aggregate stat for the demo narrative (e.g., "3 of 8 active routes are currently in high-exposure zones").
- This view reuses the exact same scoring function as the Worker view (§6.5) — it's the same math run across many routes instead of one. No new engine required.

**6.5 Worker View**
- FR14: User selects/enters a route (start, end, optional waypoint) on real Phoenix roads.
- FR15: Route is scored by sampling the cached grid along the path — total exposure, time-in-extreme-risk, peak segment.
- FR16: Nearest real cooling/rest spot shown along or near the route.
- FR17: Simple "leave earlier/later" what-if using cached grid at different cached time slices (only if multiple time-of-day snapshots were captured — otherwise cut this to a single static note, don't fake it).
- FR18: UI constraint — this view must be usable in a 2-second glance (large icons, one score, one action). Do not reuse Planner-view information density here; a worker checking this mid-shift is not sitting at a desk.

**6.6 Cut from v2.0 (deprioritized)**
- Export/ranked-list download — nice-to-have only, build last if time remains.
- Cool pavement scenario — stretch goal.

---

### 7. Non-Functional Requirements

- **Performance:** <3s for any *in-app* interaction — this is now achievable because nothing in the interactive path calls FortyGuard live.
- **Demo reliability:** App must run entirely from the committed cache snapshot with no internet dependency as a fallback path, rehearsed explicitly.
- **Usability:** Planner understandable in <5 min; Dispatcher view scannable in <1 min; Worker view is a single glanceable screen.
- **Transparency:** Every what-if assumption is visible in the UI, not just the README.
- **Code quality:** Clean, commented, and the data-layer script is well-documented since it's the actual API-integration deliverable judges will look for.

---

### 8. Technical Architecture & Stack

**New component: Data Ingestion & Caching Service**
- A Node/TypeScript script (run locally or as a scheduled serverless function) that:
  1. Builds a grid of polygon AOIs over the Phoenix bounding box.
  2. Submits each to FortyGuard's async heatmap endpoint.
  3. Polls for completion, handles retries/backoff.
  4. Writes results to a static JSON/GeoJSON file checked into the repo (with timestamp).
- This script is the **actual FortyGuard integration** — call this out explicitly in the README and demo video, since "we understood and correctly handled the async API" is a stronger technical signal than "we called an endpoint."

**Frontend + Backend:** Next.js (App Router) + TypeScript + Tailwind
**Mapping:** Leaflet, using the pre-cached GeoJSON layers (roads/parks/stations also pre-fetched from Overpass once at build time, not live)
**State:** React Query/SWR against local API routes that serve the cached files (not FortyGuard directly)
**What-if logic:** Plain TypeScript functions, all coefficients defined in one clearly-commented `assumptions.ts` file
**Hosting:** Vercel free tier

---

### 9. End-to-End User Flows

**Planner Flow:** Map loads from cache → toggle demand layer → click "Recommend Stations" → open what-if panel, apply a scenario (assumption shown inline) → before/after updates instantly (cache-driven, so instant) → review impact summary.

**Dispatcher Flow:** Switch to Dispatcher view → see ranked list of active sample routes by current risk → click a route to see it on the map → aggregate stat shown ("3 of 8 routes in high-exposure zones").

**Worker Flow:** Switch to Worker view → select/enter route → see one score + highlighted risk segments + nearest real rest stop, in a glanceable layout.

**Demo Flow:**
1. Open with a 30-second explanation of *why* the data layer exists (submit → poll → cache) — this is your technical credibility moment.
2. Frame the problem: not just "cities," but the outdoor mobile workforce specifically — delivery riders today, same engine applies to postal, utility, municipal crews.
3. Planner view: show real heat + real stations + demand gap.
4. Run a what-if → visible before/after, assumption clearly labeled.
5. Dispatcher view: show ranked risky-routes-today list — this is the organizational "so what do I do this afternoon" moment.
6. Worker view: score a route → show rest recommendation, glanceable UI.
7. Close with impact narrative + the one-line workforce-agnostic pitch + acknowledge what's illustrative vs. measured.

---

### 10. Deliverables

**Must-have**
1. Deployed web app (Vercel).
2. GitHub repo including the committed cache snapshot (so it runs with zero external dependency).
3. README covering: API integration approach (async submit/poll), caching strategy, data sources, and all what-if assumptions.
4. 3–5 min demo video.
5. One-page impact summary.

**Nice-to-have**
- Export/download feature.
- Cool pavement what-if.
- Slide deck.

---

### 11. Planning Assumptions (state these explicitly to your team)

- Team effort: assumes **2–3 people at near full-time** for the sprint. If solo or part-time, cut Dispatcher view first (it's additive, not core), then reduce Worker view to a single static demo route and drop the "leave earlier/later" what-if.
- FortyGuard trial credits are finite and unknown in exact quantity — the whole architecture (§8) is built around minimizing live calls to a single batch pre-fetch, specifically to protect against running out mid-build.
- Real cooling-station data requires manual sourcing (Maricopa County public lists) — budget this as a concrete Day 1–2 task, not an assumption.

---

### 12. Two-Week Build Plan

**Week 1 (Aug 18–24)**
- Day 1: Set up Next.js + Leaflet + repo. Manually source and geocode ~20 real Phoenix cooling stations.
- Day 2: Build and test the Data Ingestion & Caching Service against the real FortyGuard API (small AOI first, confirm submit/poll/retrieve works end to end). Commit first cache snapshot.
- Day 3–4: Planner view — demand layer, station recommendation ranking, using cached data only.
- Day 5–6: Worker view — route input, scoring against cached grid, nearest rest-spot lookup. Build the scoring function generically so it can be reused per-route in bulk (this is what makes Dispatcher view nearly free next week).
- Day 7: First full end-to-end demo path (Planner + Worker) working offline from cache. Internal review.

**Week 2 (Aug 25–30)**
- Day 8: Dispatcher view — reuse the Worker scoring function across 5–10 sample routes, build the ranked list + aggregate stat. This should take well under a day since no new engine is needed.
- Day 9: What-if engine (stations + canopy), before/after comparison, assumptions surfaced in UI.
- Day 10: Polish, loading states, error handling, glanceable-UI pass on Worker view specifically.
- Day 11: Demo video + README (with explicit API/caching writeup) + one-pager.
- Day 12: Full offline dry-run of the demo (disconnect network, confirm it still works from cache).
- Day 13–14: Buffer, final polish, submit early.

---

### 13. Key Risks & Mitigations (updated)

| Risk | Mitigation |
|---|---|
| FortyGuard async API misunderstood/misused | Build and test the ingestion script on Day 2, in isolation, before any UI work |
| Trial credits exhausted mid-build | One batch pre-fetch strategy; never call live from UI; cache aggressively |
| Live demo network/API failure | Fully offline-capable from committed cache snapshot; rehearsed dry-run on Day 12 |
| Judges question what-if numbers | Label all assumptions inline in UI, not buried in README |
| Multi-view scope creep | All three views share one dataset and one scoring function; cut Dispatcher view first, then Worker's "leave earlier" feature, if behind schedule |
| Pitch reads as generic "cities" again despite the niche | Keep every planner-facing sentence anchored to the outdoor mobile workforce, not "urban heat" in the abstract |
| Real cooling-station data unavailable in clean form | Manual geocoding task scheduled Day 1, not left implicit |
| Overpass/map data slow or rate-limited live | Pre-fetched once at build time, same pattern as FortyGuard data |

---

### 14. Final Notes

Two changes define this version. First, architectural: **FortyGuard's real API is an async, polygon-based batch system, not a live point lookup** — the caching layer built around that fact is what makes the latency NFR, demo reliability, and credit budget all work. Second, strategic: **the product is no longer "heat tools for cities" in the abstract — it's heat intelligence for the outdoor mobile workforce**, demoed through one persona (Phoenix delivery riders) but explicitly positioned as workforce-agnostic. The Dispatcher view is the cheapest addition in this document — it's the same scoring function run across many routes instead of one — and it's what turns the pitch from "an app for one driver" into "operational infrastructure an employer would actually adopt." Build the caching layer first; build the scoring function generically from day one so Planner, Dispatcher, and Worker all reuse it.
