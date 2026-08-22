# CoolRoute — User Manual & Test Walkthrough

Every feature in the product, in an order you can follow start to finish
without missing anything. Each step says **what to do**, **what you should
see**, and **why it is there**.

Allow ~25 minutes for the full pass. Steps marked **[KEY]** need
`FORTYGUARD_API_KEY`; it is already in your `.env`.

```bash
npm install
npm run build && npm start        # http://localhost:3000
```

> **Exact numbers in this guide will drift.** The scheduled refresh re-pulls
> live data every 30 minutes and relief sites open and close through the
> season, so expect small differences. The *shapes* - which route is worst,
> which hour is coolest, which rows move - are what to check.

Use `npm run dev` if you want to edit while testing. A wide window (≥1400 px)
is expected — this is a desktop tool and the mobile layout is deliberately not
built yet.

---

## 0 · Before the app: prove the data is real

This is the part a judge will care most about, and it happens in the terminal.

### 0.1 The snapshot is live FortyGuard data

```bash
node -e "const m=require('./data/phoenix/cache/manifest.json');console.log(m.liveApiUsed, m.sources, m.notes)"
```

**Expect:** `true`, `[ 'fortyguard' ]`, and a notes array recording the live
ingest plus the two API limitations.

```bash
node -e "const g=require('./data/phoenix/cache/downtown-core__ft3__2026-08-21.json');console.log(g.source, g.provenance.activityId, g.provenance.note)"
```

**Expect:** `fortyguard`, a real UUID `activity_id`, and a note naming the
endpoint and cell count. **Every grid carries the ID of the API call that
produced it** — that is what makes "we used the API" checkable rather than
claimed.

### 0.2 The headline number is independently re-derived

```bash
npm run verify:coverage
```

**Expect:** both regions, and the shape stated at the bottom of the output.
Phoenix's `r3-buckeye-industrial` shows **100% / 0 sites in reach**; the
downtown postal loop shows ~32% with several sites in reach. Yuma's
`y6-utility-south` also shows **100% / 0**.

**Why:** if the coverage logic were broken, the dense downtown loop would show
a huge gap too. It doesn't, in either city, from two different agencies' data.

### 0.3 The AOI guard actually guards

Open `src/lib/regions.ts`, make any tile bbox much larger (e.g. change
`-112.045` to `-111.8` on `downtown-core`), then:

```bash
npm run data:ingest -- --region=phoenix
```

**Expect:** it refuses before any network call — `Tile "downtown-core" is
NN.N mi2, over the 20 mi2 target`. **Revert the change.**

**Why:** Addendum A3's AOI limit is enforced in code, not prose, so a careless
edit fails loudly instead of burning credits.

### 0.4 Credit probe **[KEY]**

```bash
npm run data:credit-probe
```

**Expect:** one submit, polling lines, an `activity_id`, and a note that the API
does not report credit consumption in its payload — so read your dashboard
delta around this single call. Writes `docs/credit-probe.json`.

### 0.5 Re-ingest is idempotent **[KEY]**

```bash
npm run data:ingest
```

**Expect:** every line says `cached`, no network calls. An (area, date) pair is
never re-requested. `npm run data:ingest -- --force` overrides it.

---

## 1 · Planner — the default view

Open http://localhost:3000. You land in **Planner / Phoenix**.

### 1.1 The provenance bar (top strip)

**Look at:** the strip under the nav.

**Expect:** a green pulsing dot and **`FORTYGUARD CACHED SNAPSHOT`**, then
`FILTER_TYPE 3 (forecast)` · `READING Day average` · `VALID AUG 21, 3:00 PM MST`
· `RELIEF LAYER MAG Heat Relief Network` · `OPEN NOW 43/60 sites in focus` ·
`ROUTING OSRM`.

**Why:** provenance is a component, not a footnote. If the snapshot were
modelled this bar turns **amber** and reads "Modelled stand-in — not FortyGuard
data". You can prove that: move `.env` aside, delete one cache file, re-run
`npm run data:ingest`, reload — the bar changes. Then restore and re-ingest.

### 1.2 Exposure demand

**Expect:** `RELIEF COVERAGE 16.0%`, `UNCOVERED HOT CELLS ~5,229`, and an amber
note that **17 sites are shut at this hour and excluded from coverage**.

**Why this is the interesting number:** counting closed sites would have said
20.8%. A hydration station that shut at 3 PM does not help a crew at 4 PM, and
the error ran in the worst possible direction — inflating coverage exactly when
heat peaks.

**Also expect** a grey note explaining the map looks flat because FortyGuard
reports only a **0.3 °F spread** across the whole focus area for this reading.
That is the data, not a rendering fault.

### 1.3 The demand layer

**Do:** click **Show demand layer on map**. Tick/untick `Exposure demand` in the
bottom-left legend.

**Expect:** an ember wash; the brightest cells are hot **and** heavily worked
**and** beyond a walk of relief.

**Why:** heat alone would just redraw the temperature map. The formula is
printed under the button — 0.45 heat + 0.25 OSM road length + 0.30 courier-route
density (FR7, which the PRD flagged as previously undefined).

### 1.4 Station recommendations

**Do:** try the `3 / 4 / 6` toggle.

**Expect:** ranked candidates with coordinates, demand score, temperature and
gap %. Recommendations respect a 700 m minimum separation.

### 1.5 Scenario studio — placing things

**Do:**
1. Click **Cooling / hydration station**, then click the map 2–3 times.
2. Click **Tree canopy / shade corridor**, then click **along a street** 3–4
   times, then **Finish corridor** in the top banner.
3. Same for **Cool pavement treatment**.
4. Press **Esc** mid-draw to cancel.

**Expect:** stations are points with a dashed 400 m walk ring; canopy and
pavement are **corridors following the street**, not circles. Each tool shows
its own assumption, confidence chip and unit cost *before* you use it.

**Why corridors:** shade and resurfacing are specified and tendered per
corridor-km. A disc was always the wrong shape.

### 1.6 Before / after

**Do:** click **Add all to Option A**.

**Expect:**

| Row | What happens | Why |
|---|---|---|
| Mean route exposure | **no change** | A station has `deltaF: 0` on purpose — it changes *access*, not street temperature |
| Relief coverage | **16.0 → 18.7 (+2.7 pts)** | This is what a station actually buys |
| Mean temp inside treated areas | drops (once you add canopy) | The local effect |
| Mean temp, whole focus area | **no change** | The honest district-scale figure |
| Worst relief gap | **6,919 → 4,625 m (−33%)** | The headline improvement |

**The two temperature rows disagreeing is the point.** A canopy corridor is a
real improvement for the blocks it covers and a rounding error for a district.

### 1.7 Compare options A / B / C

**Do:** switch to **Option B**, add a couple of different stations, then click
**compare all three**.

**Expect:** a table of moves, coverage gained, cost and **$/pt**, with the best
cost-per-point marked `best`. Clicking a row switches to that option.

**Why:** an early-stage planning tool answers "which of these", not "is this
better than nothing".

### 1.8 Export — the Forma deliverable

**Do:** click **GeoJSON**, then **CSV list**.

**Expect:** `coolroute-phoenix-a.geojson` downloads. Open it:

```bash
node -e "const p=process.env.USERPROFILE+'/Downloads/coolroute-phoenix-a.geojson';const g=JSON.parse(require('fs').readFileSync(p,'utf8'));console.log(g.metadata.crs, g.features.length, g.features.map(f=>f.geometry.type).join(','));console.log(g.features[0].properties)"
```

**Expect:** `EPSG:4326`, stations as `Point`, corridors as buffered `Polygon`,
and every feature carrying `coolroute:deltaF`, `coolroute:confidence`,
`coolroute:assumption`, `coolroute:unitCostUsd`, `forma:category`.

**Why:** the coefficient travels with the geometry, so whoever opens it in Forma
sees "−2.5 °F assumed, directional confidence" attached to the polygon rather
than a bare shape. It is standard GeoJSON that Forma imports as site context —
**not** a certified Forma integration, and the panel says so.

### 1.9 Share a scenario

**Do:** click **Copy link**. Open it in a new tab.

**Expect:** a ~130-character URL; the new tab restores your interventions and
region. No account, no server state — it is encoded in the URL fragment, which
never reaches the server.

### 1.10 Print / PDF

**Do:** click **Print / PDF**.

**Expect:** the browser print dialog for a council-paper style output.

### 1.11 Live tile refresh **[KEY — the async contract, visible]**

**Do:** pick a tile, click **Fetch this tile from the API now**.

**Expect a streamed log**, roughly:

```
> downtown-core - 8.4 mi2 at 100 m, filter_type 3
> POST /v1/heatmap for downtown-core
  activity_id 17c28c72-… (412 ms)
  poll 1 -> processing (1489 ms)
  poll 2 -> completed  (4021 ms)
  complete: 2161 points in 4103 ms
  Written to data/phoenix/cache/…
```

**Why:** this is the whole architecture made watchable — submit, poll, backoff,
completion. It is manual, one tile, and off the demo path, which is why it does
not violate the PRD's "no live calls on user interaction" rule.

**Test the honest-failure path:** rename `.env` to `.env.bak`, restart, click
again. **Expect** a 503 explaining it deliberately does nothing without a key
rather than showing a simulated progress bar. Restore `.env`.

### 1.12 Import your own routes

**Do:** create `test-routes.csv`:

```csv
route_id,name,lon,lat
r1,My test run,-112.074,33.448
r1,My test run,-112.074,33.470
r1,My test run,-112.050,33.470
```

Click **Choose a GeoJSON or CSV file**, pick it.

**Expect:** "Imported 1 route". It appears on the map and is scored like any
other. GeoJSON `LineString` / `MultiLineString` also work.

**Why:** this is the honest 80% of "real-time fleet GPS" — an operator brings
the routes they already planned. Parsed entirely in the browser; no upload, no
tracking.

### 1.13 Methodology

**Do:** click **+ Methodology and assumptions**.

**Expect:** every coefficient with its basis and confidence level, the relief
attribution with fetch date and site counts, and the route note.

---

## 2 · Map layers

Bottom-left panel. Toggle each:

| Layer | Expect |
|---|---|
| **Heat field (continuous)** | Smooth temperature wash |
| **Risk classification** | Five discrete bands; legend swaps to the band list. Stored per cell at ingest, not derived on render |
| **Exposure demand** | Ember wash (Planner only) |
| **Parks and water** | Green/blue polygons from OSM |
| **Relief network** | Cyan dots. **Hollow dashed = closed at this hour** |
| **Routes** | Grey lines; the selected one is heat-coloured |
| **Scenario** | Your placed interventions |

**Do:** click any relief dot.

**Expect:** name, operator, address, phone, services, ADA/pets, and either its
opening hours or **"CLOSED at this hour — not counted as coverage"** in red.

**Keyboard:** every layer toggle is a real checkbox — Tab to it, Space to
toggle.

---

## 3 · Dispatcher

**Do:** click **Dispatcher**.

### 3.1 Fleet status

**Expect:** `N of 8 active routes` in high-exposure zones, crew-minutes above
108 °F, and mean exposure.

### 3.2 Part of day — the real intra-day axis

**Do:** click **low**, **average**, **peak** in turn.

**Expect the fleet headline to move.** On Phoenix day 0: `low` → 0 of 8;
`average` → 0 of 8; **`peak` → 1 of 8**, and Buckeye Road flips Moderate → HIGH.

**Why this and not an hour slider:** FortyGuard has **no hour parameter** — two
submissions differing only by `hour` return byte-identical data. But every cell
carries a min, average and max for the day, and that is a real ~14 °F swing. So
the run is genuinely re-scored against three real fields. The panel says so.

### 3.3 Forecast day

**Do:** switch **Snapshot day** ↔ **Next day**.

**Expect:** different numbers (day +1 is cooler), and the day-part buttons grey
out — the API returned no intra-day range for that day, and the note explains
it rather than showing three identical values.

### 3.4 Ranked list

**Do:** click the worst route.

**Expect:** it expands with the recommended action, the worst 600 m stretch with
its mean temperature, the nearest relief site, and the longest stretch with no
relief in reach. On the map it turns heat-coloured with the peak segment picked
out in white.

**Why:** ranking is by exposure index, not peak temperature — a long moderate
run can outrank a short brutal one, which is usually the right call.

---

## 4 · Worker

**Do:** click **Worker**.

> Note: this view is desktop-only for now. It is designed around a 2-second
> glance and really wants a phone layout; that rebuild is deliberately deferred.

### 4.1 The glance

**Expect:** one big peak temperature, a risk band, one instruction, and the
closest relief site with its distance off route.

### 4.2 Cooler way round? — Addition 2

**Expect:** two columns, **Fastest** vs **Alternative**, both from a real
routing engine, both scored with the same function, and a verdict.

**Look for the honest case:** when the alternative is *hotter*, it says "The
alternative is hotter, not cooler — N degree-minutes worse" rather than
reporting a saving of zero.

**Do:** click **show on map** — the alternative draws as a dashed cyan line.

### 4.3 What it feels like, hour by hour — FR17, real hours **[KEY]**

**Expect:** a 24-bar chart from 05:00 to 20:00, cool green rising to dark red
mid-afternoon, plus **Coolest working hour** and **Worst hour** tiles and a line
like *"Running this at 06:00 instead of 13:00 is 21 degF less apparent heat."*

**Hover any bar** for its hour and apparent temperature.

**Why this is the strongest FR17 answer:** `/v1/heatmap` has no hour parameter,
but `/v1/env_params` returns **24 hourly values per point** — and it is
*apparent* temperature, what a body actually experiences, not the dry-bulb grid
value. Regenerate it any time with `npm run data:hourly`.

If `data/<region>/hourly.json` is absent the section simply does not render and
the day-part comparison below still works.

### 4.4 Re-score the whole run — the field-wide version

**Expect:** three rows (Low / Average / Peak) with exposure index, peak
temperature and band, and a line naming the lowest-exposure option. On the
snapshot day: Low **120**, Average **368**, Peak **625** (Moderate).

**Why both sections exist:** the chart above is *one point*. This re-scores the
**entire route** against the min/average/max field the API returns per cell —
so the map and every number move with it.

### 4.5 Score a different trip — FR14

**Do:** enter From `33.4197, -112.0664`, To `33.5090, -112.0691`, leave the
waypoint blank. Click **Route and score**.

**Expect:** a real OSRM route with an alternative, drawn and scored.

**Now add a waypoint:** `33.4392, -112.0954`. Re-run.

**Expect:** a visibly longer route (~18 km vs ~10.7 km) and **no alternative
comparison** — with the note explaining both engines stop returning alternatives
once a trip has a via point.

**Error paths to try:** garbage in a field → "Enter both points as lat, lon";
bad waypoint → "Waypoint must be lat, lon, or left blank".

---

## 5 · Multi-region

**Do:** change the **Region** dropdown to **Yuma, AZ**.

**Expect:**

| | Phoenix | Yuma |
|---|---|---|
| Relief coverage | 16.0% | **6.3%** |
| Relief layer | MAG Heat Relief Network | **AZDHS Heat Preparedness Network** |
| Tiles / area | 3 / 26.3 mi² | 2 / 33.2 mi² |
| Spatial spread | ~0.3 °F | **2–4 °F** (more visible structure) |

**Do:** run Dispatcher there too — `y6-utility-south` shows the same 100%
relief-gap pattern.

**Why it matters:** different agency, different schema, different workforce, a
tenth of the site density — and the same code path. The gap finding reproducing
in a second city from a second publisher is what makes it structural rather
than a Phoenix artefact.

---

## 6 · Robustness

### 6.1 Offline

**Do:** load the app, then switch off Wi-Fi and reload.

**Expect:** the basemap tiles go dark (they come from OpenStreetMap) but
**every layer that matters still renders and every number still computes** —
heat field, relief network, routes, scoring, scenarios, export. The only broken
feature is the ad-hoc router, which explains its own degrade.

**Why:** everything is computed in the browser from the committed snapshot.

### 6.2 Data-loss safety

**Do:** disconnect, then `npm run data:stations`.

**Expect:** it warns and **keeps the existing snapshot**. It never leaves you
with a half-written dataset.

### 6.3 Missing snapshot

**Do:** rename `data/phoenix/cache` to `cache-bak`, reload.

**Expect:** a clear "Snapshot unavailable" screen telling you to run
`npm run data:all` — not a stack trace. **Rename it back.**

---

## 7 · Quick API check

```bash
curl -s "http://localhost:3000/api/bootstrap?region=yuma" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log('tiles',j.tiles.length,'sites',j.relief.sites.length,'liveApiUsed',j.manifest.liveApiUsed)})"

curl -s -G "http://localhost:3000/api/field" --data-urlencode "region=phoenix" --data-urlencode "ft=3" --data-urlencode "validAt=2026-08-21T15:00:00-07:00" -o /dev/null -w "field %{http_code}\n"

# the guard: a request without both parameters must fail
curl -s "http://localhost:3000/api/field?ft=3" | head -c 120
```

**Expect** the last one to 400. Historic and forecast can never be blended
because you cannot even ask for a mixture.

---

## What is deliberately not built

- **Mobile / responsive layout** — the Worker view needs a phone-first rebuild;
  deferred by choice.
- **Historic data (`filter_type` 1)** — the API returns HTTP 500 on this key.
  The code path exists and is enforced; it activates when the service serves it.
- **Accounts, real-time GPS, 3D twin** — out of scope per the PRD, with the
  reasoning recorded in the README.

---

## One-line sanity check

```bash
npm run typecheck && npm run build && npm run verify:coverage
```

All three should pass clean.
