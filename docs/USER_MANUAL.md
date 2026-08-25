# CoolRoute — User Manual & Test Walkthrough

Every feature in the product, in an order you can follow start to finish
without missing anything. Each step says **what to do**, **what you should
see**, and **why it is there**.

Allow ~40 minutes for the full pass across all four regions. Steps marked
**[KEY]** need `FORTYGUARD_API_KEY`.

```bash
npm install
npm run build && npm start        # http://localhost:3000
```

Or test the deployment directly:
**[coolroute-network-planner.vercel.app](https://coolroute-network-planner.vercel.app)**.
Everything in sections 1-8 works there, with one exception: section 0 is
terminal-only, and step 1.11's on-demand tile refresh writes the fetched tile
to disk, which a serverless filesystem will not keep. Run those two locally.
Section 9 measures the two NFRs and needs a browser console.

> **Exact numbers in this guide will drift.** The scheduled refresh re-pulls
> live data every 30 minutes and relief sites open and close through the
> season, so expect small differences. The *shapes* - which route is worst,
> which hour is coolest, which rows move - are what to check.

Use `npm run dev` if you want to edit while testing. Works from about 360 px
upward; below 900 px it switches to a single-column phone layout (section 8).

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
node -e "const m=require('./data/phoenix/cache/manifest.json');const g=require('./data/phoenix/cache/'+m.grids[0].file);console.log(g.source, g.provenance.activityId, g.provenance.note)"
```

**Expect:** `fortyguard`, a real UUID `activity_id`, and a note naming the
endpoint and cell count. **Every grid carries the ID of the API call that
produced it** — that is what makes "we used the API" checkable rather than
claimed.

*(The filename is read from the manifest rather than typed, because the
snapshot date rolls forward daily — see 0.2.)*

### 0.2 The snapshot is *current*, and internally consistent

```bash
npm run verify:data
```

**Expect** every line to read `PASS`, and in particular:

```
PASS snapshot freshness       day 0 is <today>, 0 day(s) behind today
PASS liveApiUsed matches grids
PASS risk bands match temps
PASS min <= average <= max
```

**Why this check exists.** The two ways this project can go quietly wrong are
both invisible from the UI. A snapshot that has stopped advancing still renders
perfectly — nothing on screen says the date it shows is three days old. And
drift (arrays that no longer line up, risk bands that no longer match the
temperatures they came from) degrades a number rather than throwing.

`WARN` on freshness means the snapshot is a day behind — legitimate if the
scheduled refresh has not run yet. `FAIL` exits non-zero, which is what the
refresh workflow gates on.

**Prove it can fail:** open `data/phoenix/cache/manifest.json` and change
`snapshotDate` to a date a week ago. Re-run — freshness turns `FAIL`. Change it
back.

### 0.3 The headline number is independently re-derived

```bash
npm run verify:coverage
```

**Expect:** all four regions, and the shape stated at the bottom of the output.
Phoenix's `r3-buckeye-industrial` shows **100% / 0 sites in reach**; the
downtown postal loop shows ~32% with several sites in reach. Yuma's
`y6-utility-south` also shows **100% / 0**, and Tucson's `t3-south-industrial`
**96%** against ~30% for its civic runs.

**Why:** if the coverage logic were broken, the dense downtown loops would show
huge gaps too. They don't — in four cities, across three different kinds of data
source. That is what makes the finding structural rather than an artefact of one
agency's publishing habits.

### 0.4 The AOI guard actually guards

Open `src/lib/regions.ts`, make any tile bbox much larger (e.g. change
`-112.045` to `-111.8` on `downtown-core`), then:

```bash
npm run data:ingest -- --region=phoenix
```

**Expect:** it refuses before any network call — `Tile "downtown-core" is
NN.N mi2, over the 20 mi2 target`. **Revert the change.**

**Why:** Addendum A3's AOI limit is enforced in code, not prose, so a careless
edit fails loudly instead of burning credits.

### 0.5 Credit probe **[KEY]**

```bash
npm run data:credit-probe
```

**Expect:** one submit, polling lines, an `activity_id`, and a note that the API
does not report credit consumption in its payload — so read your dashboard
delta around this single call. Writes `docs/credit-probe.json`.

### 0.6 Re-ingest is idempotent **[KEY]**

```bash
npm run data:ingest
```

**Expect:** every grid line says `cached`, and any forecast day the API had no
data for says `skip ... (no data on a previous run)`. **No network calls at
all.** An (area, date) pair is never re-requested, and a date already found
empty is not re-attempted — that check alone saves three submissions of ~3.5
minutes each per region, per run. `npm run data:ingest -- --force` overrides
both.

---

## 1 · Planner — the default view

Open http://localhost:3000.

### 1.0 The opening screen

**Expect, on a first visit only:** a panel leading with a single large
percentage — the share of the region's worst route with no relief site within a
400 m walk — followed by four short steps naming what each view answers.

**Do:** click through with **Next**, or **skip**. Reload.

**Expect** it not to reappear. It is remembered in `localStorage` under
`coolroute.onboarded.v1`; clear that key to see it again, which is worth doing
before recording a demo.

**Why it exists:** every panel in this app is dense and carefully labelled, and
they all carried the *same* visual weight — a note about a 0.3 °F spread sat at
the same size as the finding the whole tool exists to make. Someone opening it
cold had to assemble the argument themselves from four panels. This states it
once, larger than anything else, and gets out of the way.

**Check that it is derived, not written.** Switch region and clear the
localStorage key: the number, the route name and the relief-network label all
change, because they come from the same scores every other panel uses. Nothing
in that panel is hardcoded copy.

You land in **Planner / Phoenix**.

### 1.1 The provenance bar (top strip)

**Look at:** the strip under the nav.

**Expect:** a green pulsing dot and **`FORTYGUARD CACHED SNAPSHOT`**, then
`FILTER_TYPE 3 (forecast)` · `READING Day average` · `VALID <today>, 3:00 PM MST`
· `RELIEF LAYER MAG Heat Relief Network` · `OPEN NOW <n>/<total> sites in focus`
· `ROUTING <the router that resolved this region's runs>`.

Every one of those is read from the data, not written into the UI — switch to
Las Vegas and the relief layer reads *OpenStreetMap amenities* and the router
may read *OSRM*, because that is what those files record.

**Check the date.** It should be **today**, not a date from earlier in the week.
The snapshot date rolls with each ingest and the client reads it from the
manifest, so the two cannot drift apart.

**Why:** provenance is a component, not a footnote. If the snapshot were
modelled this bar turns **amber** and reads "Modelled stand-in — not FortyGuard
data". You can prove that: move `.env` aside, delete one cache file, re-run
`npm run data:ingest`, reload — the bar changes. Then restore and re-ingest.

### 1.2 Exposure demand

**Expect:** `RELIEF COVERAGE` in the mid-teens percent, a five-figure
`UNCOVERED HOT CELLS`, and an amber note naming how many sites are **shut at
this hour and excluded from coverage**.

Both figures move with every refresh as sites open and close, so check the
*shape*, not the digits: coverage is well under a fifth of the focus area, and a
meaningful minority of sites are excluded for being closed.

**Why this is the interesting number:** counting closed sites inflates coverage
by several points. A hydration station that shut at 3 PM does not help a crew at
4 PM, and the error ran in the worst possible direction — overstating the
network exactly when heat peaks. `npm run verify:coverage` prints the current
open/closed split.

**Also expect**, whenever the spread is under 1 °F, a grey note explaining that
the map looks flat because the data is flat — FortyGuard reports well under a
degree across the whole focus area for most Phoenix readings. That is the data,
not a rendering fault. The exact figure is printed in the note and moves with
each refresh; `npm run verify:data` prints the same number as `field spread`.

### 1.2b Remove a placement, and clear an option

**Do:** place two stations (see 1.5), then click the **×** on one row in the
scenario list. Then click **Clear option A**.

**Expect:** the single × removes just that intervention and every before/after
row recomputes; **Clear** empties the whole option. Both are instant — nothing
round-trips to the server, because the scenario is computed in the browser.

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

### 1.4c Solve for a plan — budget and target

Between the recommendations and Ground truth.

**Do:** with **I have a budget** selected, drag the slider to about $500k.

**Expect:** three numbers that move as you drag — **sites**, **coverage** (with
the base figure under it) and **capital** (with cost per coverage point) — plus a
sentence describing what the money bought. Then **Add N to Option A** to place
them.

**Do:** switch to **I have a target** and drag to 25%.

**Expect:** the same three numbers, now answering the inverse question — how many
sites and how much capital to reach that coverage.

**Push it until it fails:** drag the target to 55–60%.

**Expect** an amber note saying it ran out of viable sites short of the target,
naming where it stopped. That is the honest answer: the remaining gaps are below
the demand floor the siting engine will consider, and reaching them needs a
different intervention rather than more of this one.

**Why greedy, and why the panel says so:** maximum coverage is NP-hard, and
placements overlap — two stations 300 m apart cover much of the same ground — so
each pick is re-evaluated against what is already bought. Greedy is within a
constant factor of optimal, and it has a property that matters more here: a
planner can follow it. "It bought this one first because it covered the most
uncovered ground per dollar" is defensible in a meeting. The panel claims greedy
rather than implying an optimum.

**One deliberate restriction:** only *access* interventions are placed. A canopy
corridor cools a street but gives nobody somewhere to stop, so mixing it into a
coverage objective would be comparing two different things and calling the result
a plan.

### 1.4d The six-tool palette

**Do:** open the scenario studio tool list.

**Expect** six tools, each with its own coefficient, confidence chip and unit
cost inline:

| Tool | Effect | Shape | Note |
|---|---|---|---|
| Cooling / hydration station | access only | point | zero degrees, on purpose |
| Tree canopy | −2.5 °F / 250 m | corridor | directional |
| Cool pavement | −0.6 °F / 200 m | corridor | the only **measured** one |
| Misting station | −8 °F / **30 m** | point | big effect, tiny radius |
| Shade sail | −1.8 °F / 60 m | point | works the day it is installed |
| Bus-shelter retrofit | access only | point | cheapest move in the palette |

**Look at misting specifically.** −8 °F is the largest number in the palette and
its radius is the smallest by an order of magnitude. That is the point:
evaporative cooling works on the person standing in it, not on the block. A
misting line that appeared to cool a district would be a fiction.

**And the retrofit is here because of a bug.** The OSM relief pull initially
counted bus shelters as relief sites — 427 of Tucson's 472 — which was wrong and
made an OSM city look better served than Phoenix. They were excluded. But the
structures are already standing on the corridors workers use, so converting one
into real relief is the cheapest intervention available.

### 1.4e Import a design — the Forma round trip

**Do:** run the **GeoJSON** export (1.8), then use **Import a design** and choose
the file you just downloaded.

**Expect:** every element comes back with its original kind and radius intact —
a station is still a station, a canopy corridor still a corridor. The export
carries `coolroute:kind`, so a round trip is lossless.

**Now try a foreign file.** Create `design.geojson`:

```json
{"type":"FeatureCollection","features":[
 {"type":"Feature","properties":{"name":"Proposed depot canopy"},
  "geometry":{"type":"Polygon","coordinates":[[[-112.072,33.452],[-112.070,33.452],[-112.070,33.454],[-112.072,33.454],[-112.072,33.452]]]}},
 {"type":"Feature","properties":{"name":"New rest point"},
  "geometry":{"type":"Point","coordinates":[-112.065,33.448]}}]}
```

**Expect:** two elements imported — the polygon becomes a shade structure sized
from its own extent (~173 m rather than a palette default), the point becomes a
station. Both are now scored against the heat field and appear in the
before/after and the cost.

**Test the failure that actually happens:** change the point's coordinates to
`[412345.6, 3701234.8]` and re-import.

**Expect** a refusal naming the cause — coordinates outside the legal lon/lat
range, almost certainly a projected CRS — and instructions to re-export as
EPSG:4326. Forma exports in the project's local coordinate system by default, so
without this check a file in metres would be silently scored somewhere in the
Gulf of Guinea.

**Why this matters more than the export:** the export makes our analysis
available elsewhere. This makes *their design* answerable here — design in Forma,
validate against real heat data. It is a **file reader, not an Autodesk
integration**: no account, no SDK, no extension, and the panel says so.

### 1.4b Ground truth — what the street actually looks like

Scroll to **Ground truth**, between the recommendations and the scenario studio.

**Do:** click through the sampled points (tile centres, the demo run's two ends,
a route midpoint).

**Expect:** for the first two points, a **street-level photograph** with a
**show photo / show segmentation** toggle; for the rest, the measurements
without the picture. Under both, two stacked bars — *street frame composition*
and *land cover from above* — with the largest classes named and percentaged.

**Expect** a canopy verdict underneath, e.g. *Effectively bare · high headroom*,
with a sentence naming the measured tree, sky and built percentages.

**Why this is here, and where its limits are.** This is the only measurement in
the app taken at eye level. It comes from `POST /v1/streetview` and
`POST /v1/satellite`, which return imagery plus a semantic segmentation — the
share of the frame that is tree, sky, building, road, sidewalk, car.

It answers a question the rest of the tool cannot: *is there room to plant here
at all?* Recommending canopy on a block already at 40% tree cover is a different
proposition from the same recommendation at 2%.

**What it deliberately does not do** is set the canopy coefficient. A photograph
contains no temperature; deriving °F from a canopy percentage would need paired
shaded/unshaded readings at the same hour, which this project does not have. So
`tree_canopy.deltaF` remains the labelled assumption it always was, and the
panel says so in its last line. Read [METHODOLOGY.md](METHODOLOGY.md) alongside.

**Placement note:** this sits *above* the scenario studio on purpose — see what
is on the ground before choosing a treatment for it.

**If the section is missing or empty:** the region has no `ground.json`. Run
`npm run data:ground -- --region=<id>` with a key. Unlike the heat field, there
is no modelled fallback here — a fabricated photograph of a real street would be
a different order of dishonesty from a modelled temperature.

### 1.5 Scenario studio — placing things

**Do:**
1. Click **Cooling / hydration station**, then click the map 2–3 times.
2. Click **Tree canopy / shade corridor**, then click **along a street** 3–4
   times, then **Finish corridor** in the top banner.
3. Same for **Cool pavement treatment**.
4. Try **Misting station**, **Shade sail** and **Bus-shelter retrofit** — all
   three are points, so one click each.
5. Press **Esc** mid-draw to cancel.

**Expect:** the four point tools place with a single click and draw a dashed
radius ring; canopy and pavement are **corridors following the street**, not
circles. Each tool shows its own assumption, confidence chip and unit cost
*before* you use it, and the hint under each says "click to place" or "draw a
corridor" accordingly.

**Why corridors:** shade and resurfacing are specified and tendered per
corridor-km. A disc was always the wrong shape.

**Why the ring sizes differ so much:** a station and a retrofit both draw a
400 m walk radius (they buy *access*), a canopy corridor 250 m, and **misting
just 30 m** — the largest temperature effect in the palette with the smallest
reach, because evaporative cooling acts on the person standing in it. See
[1.4d](#14d-the-six-tool-palette).

### 1.6 Before / after

**Do:** click **Add all to Option A**.

**Expect:**

| Row | What happens | Why |
|---|---|---|
| Mean route exposure | **no change** | A station has `deltaF: 0` on purpose — it changes *access*, not street temperature |
| Relief coverage | **rises by ~2.7 pts** | This is what a station actually buys |
| Mean temp inside treated areas | drops (once you add canopy) | The local effect |
| Mean temp, whole focus area | **no change** | The honest district-scale figure |
| Worst relief gap | **drops by roughly a third** | The headline improvement |

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
  poll 2 -> processing (4021 ms)
  …
  poll 14 -> completed (207512 ms)
  complete: 2160 points in 207940 ms
  Written to data/phoenix/cache/…
```

**Be patient: this takes minutes, not seconds.** A measured heatmap tile
completed in **208 seconds over 14 polls**. That is the API's real latency, and
it is exactly why the whole architecture pre-fetches — a UI that called this on
interaction would be unusable. Watch the backoff widen between polls, from 1 s
toward the 15 s ceiling.

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

### 1.12b The focus-area block

**Look at:** the header, left of the region name.

**Expect:** the region's tiles listed with their individual areas, and the
total. Phoenix reads 3 tiles / 26.3 mi².

**Why it is on screen rather than in the README:** it is the visible form of
Addendum A3's tiling strategy. "Cover Phoenix" was never achievable in one call
— the AOI limit is ~50 mi² and the city is far larger — so the focus area is a
named handful of district-scale tiles, and the header says which.

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

### 2.1 Ground: streets or satellite

At the bottom of the legend, a **Streets / Satellite** switch.

**Do:** click **Satellite**, then zoom in to 18–19.

**Expect:** real aerial imagery under the heat field, dimmed so the data stays
the brightest thing on screen. Your pan and zoom survive the switch — the tile
layer is swapped in place rather than the map being rebuilt.

**Why both:** streets give you names and block structure; satellite gives you
the *cause*. Under imagery you can see that a hot band is unbroken asphalt and
bare roof, and that a cool patch is mature trees — which is the argument a
canopy scenario is making, shown rather than asserted.

**Note on the dark theme:** the street raster is inverted into the dark palette;
satellite is dimmed instead. Inverting a photograph produces a negative, so the
two providers get different treatment.

### 2.2 Street-level readout — click any street

**Do:** with no placement tool armed, click directly on a street.

**Expect:** the street highlights, and a popup gives its **name**, road class,
length, and **mean / peak / coolest** temperature along its whole length.

**Expect** a note if part of the street falls outside the measured tiles, and
always a line saying the reading came from the field currently on screen.

**Do:** change the part of day (Dispatcher/Worker) or apply a canopy corridor
over that street, then probe it again.

**Expect** the numbers to move. The probe samples the **active** field, not a
value baked in at build time — which is why a treated street reads cooler after
you treat it.

**Why it is not finer than this:** the API has **no granularity parameter**. The
server picks the cell size (~100 m), so a street's reading is the field along
it, not a per-metre measurement. The probe is street-level; the *data* is
100 m-level, and conflating the two would overclaim.

**If clicking does nothing:** the legend hint reads "Loading street centrelines"
until `/api/streets` resolves (~840 KB for Phoenix, fetched once per region).

**Zoom:** the map now goes to zoom 19, up from 17, because the probe is only
useful if you can tell one street from the next.

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

**Do:** look at the **Forecast day** buttons.

**Expect** to see only the days the snapshot actually holds. At the time of
writing that is **one** — the API's forecast horizon has closed to the snapshot
day: day +1 completes and returns **zero cells**, and day +2 previously returned
HTTP 500.

**Why there is no greyed-out "Next day" button:** the day list is derived from
the manifest, not from a static config, so the UI cannot offer a day that
`/api/field` would 404 on. If the horizon reopens, the button returns by itself
at the next ingest — no code change.

**Why the missing day is not modelled:** with a working key, a day the service
cannot serve is **dropped**, not filled with a synthetic stand-in. Mixing a
modelled field into a live snapshot is exactly what FR17 forbids, and it would
also have made `liveApiUsed` a lie. Check it:

```bash
node -e "const m=require('./data/phoenix/cache/manifest.json');console.log(m.unavailable, m.notes.filter(n=>n.includes('no data')))"
```

**Expect** the `(tile|date)` pairs the API had nothing for. They are remembered
so the next scheduled run does not spend three and a half minutes per tile
re-discovering it.

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

**Also in this section:** **Wet bulb at the worst hour** and **Air quality at
the worst hour**, both from the same call. Wet bulb is the one that actually
kills — above roughly 88 °F the body cannot shed heat by sweating at all, no
matter how much shade you provide, so it is the number that tells a planner
when shade has stopped being the answer. Phoenix reads 76 °F here, well clear.
Air quality is worth a glance too: ozone climbs through the afternoon, so the
hottest hour is often the dirtiest air as well.

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

**Do:** enter From `33.4438, -112.0736`, To `33.5090, -112.0691`, leave the
waypoint blank. Click **Route and score**.

**Expect:** a real routed path with a genuine alternative, drawn and scored -
roughly **8 km / 15 min** for the fastest and a little longer for the
alternative. Both ends sit inside the measured tiles, so no coverage caveat
appears.

The router is **OpenRouteService** when `ORS_API_KEY` is set and **public OSRM**
otherwise; the panel names which one answered. Distances differ slightly between
the two, so check the shape — a real road path with a plausible alternative —
rather than the exact kilometre.

**Now add a waypoint:** `33.4652, -112.0946`. Re-run.

**Expect:** a visibly longer route (**~11.4 km / 21 min**, against 8.0 km) and
**no alternative comparison** — with the note explaining both engines stop returning alternatives
once a trip has a via point.

**Error paths to try:** garbage in a field → "Enter both points as lat, lon";
bad waypoint → "Waypoint must be lat, lon, or left blank".

### 4.6 Prove the coverage caveat — measured vs extrapolated

The AOI is a handful of ~10 mi tiles rather than a continuous surface, because
the API caps a single request at about 50 mi². A run that leaves the tiles has
to get its temperature from somewhere, and the app is explicit about where.

**Do:** enter From `33.4197, -112.0664` — just south of `downtown-core`'s edge
— To `33.5090, -112.0691`. Click **Route and score**.

**Expect:** the route still scores normally, and a line appears beneath the
relief-gap figure reading *"N% of this run (X km) falls outside the measured
tiles."*

**Why this matters:** those off-tile samples stay in the exposure denominator.
Dropping them would have been easier and would have made every wandering run
look cooler than it is — a route 30% outside coverage would quietly report the
exposure of the 70% that happened to be measured. Instead each such sample
takes the nearest tile-edge value, which is a defensible estimate but is *not*
a measurement, and the note says so. Full-coverage routes render no note at
all, so its presence is information rather than boilerplate.

**Also visible in Dispatcher:** expand `r2-warehouse-civic` or
`r3-buckeye-industrial` in the fleet list. Both genuinely clip past the tile
edges (~28%) and carry the same line. `r4`, `r5`, `r6`, `r8` and both worker
demo paths are fully inside coverage and show nothing.

---

## 5 · Multi-region

**Do:** change the **Region** dropdown to **Yuma, AZ**.

**Expect:**

| | Phoenix | Yuma |
|---|---|---|
| Relief layer | MAG Heat Relief Network | **AZDHS Heat Preparedness Network** |
| Tiles / area | 3 / 26.3 mi² | 2 / 33.2 mi² |
| Spatial spread | well under 1 °F | **2–4 °F** (more visible structure) |
| Relief coverage | markedly higher | markedly lower |

**Do:** run Dispatcher there too — `y6-utility-south` shows the same 100%
relief-gap pattern.

**Why it matters:** different agency, different schema, different workforce, a
tenth of the site density — and the same code path. The gap finding reproducing
in a second city from a second publisher is what makes it structural rather
than a Phoenix artefact.

### 5.1 The two OSM-derived regions

**Do:** switch to **Las Vegas, NV** or **Tucson, AZ**.

**Expect** everything to work identically — heat field, routes, scoring,
scenarios, ground truth — with the relief layer labelled **OpenStreetMap
amenities** rather than an agency network.

**What is different, and it matters more than it looks.** Phoenix and Yuma read
from a *published heat-relief network*: places that have **agreed** to take
someone in, with staffed summer hours. Las Vegas and Tucson read from
community-mapped OSM amenities — drinking fountains, libraries, community
centres, social facilities. Real places, but nobody has undertaken to be a
relief site.

**So their coverage percentages are not comparable with Phoenix's**, and the
app never puts the two in the same table. Each region carries a
`dataQuality` flag (`agency` vs `osm-derived`) and `npm run verify:data` prints
it as a `WARN`, not a `PASS`:

```
WARN relief data quality    OSM-derived - coverage NOT comparable with agency regions
```

**Check the hours weakness too.** Run `npm run verify:data -- --region=las-vegas`
and look at `sites with usable hours` — a handful out of 150-odd, against
almost all of Phoenix's. OSM rarely carries `opening_hours`, and the adapter
only parses the unambiguous forms rather than guessing at the rest. Sites with
no parseable hours are counted as available and reported separately, exactly as
for an agency publisher that left the field blank.

**Why they are in the product:** adding a city was claimed to be additive.
Las Vegas is out of Arizona entirely, on a different time zone rule, with no
agency feed at all — which is a much better test of that claim than a third
Arizona city would be.

**One honest caveat about "additive".** A region needs a config entry **plus a
hand-authored route set** in `scripts/generate-routes.ts`, because sample runs
have to start and end at real places inside the measured tiles. That is the one
part of adding a city that is not automatic.

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

# the field, at whatever timestamp the manifest currently holds
VALID=$(node -e "const m=require('./data/phoenix/cache/manifest.json');console.log(m.grids[0].validAt)")
curl -s -G "http://localhost:3000/api/field" --data-urlencode "region=phoenix" --data-urlencode "ft=3" --data-urlencode "validAt=$VALID" -o /dev/null -w "field %{http_code}\n"

# the guard: a request without both parameters must fail
curl -s "http://localhost:3000/api/field?ft=3" | head -c 120

# the three lazy layers
curl -s -o /dev/null -w "context  %{http_code}  %{size_download} bytes\n" "http://localhost:3000/api/context?region=phoenix"
curl -s -o /dev/null -w "streets  %{http_code}  %{size_download} bytes\n" "http://localhost:3000/api/streets?region=phoenix"
curl -s -o /dev/null -w "ground   %{http_code}  %{size_download} bytes\n" "http://localhost:3000/api/ground?region=phoenix"

# an unknown region is a 404 with the known list, not a stack trace
curl -s "http://localhost:3000/api/bootstrap?region=atlantis" | head -c 160
```

**Expect** the `field?ft=3` call to **400**. Historic and forecast can never be
blended because you cannot even ask for a mixture.

**Expect** context/streets/ground to be **200** with sizes in the hundreds of
KB — they are separate endpoints precisely because none of that belongs on the
first-paint path.

**Expect** the unknown region to **404** and name the regions that do exist.

---

## 8 · Phone layout

**Do:** narrow the window below 900 px, or open DevTools device mode at 390×844.

**Expect:**

| | |
|---|---|
| Layout | One column. Header wraps, the focus-area block hides |
| Bottom bar | A sticky **READOUT / MAP** switch appears |
| Legend | A **Legend / Hide legend** button appears (desktop keeps it open) |
| Worker glance | The peak temperature jumps to 76 px — readable at arm's length |
| Legend | Collapses to a **Legend** button so it stops covering the map |
| Tap targets | Buttons and inputs go to a 44 px minimum |
| Inputs | 16 px font, so iOS does not zoom the page on focus |

**Do:** tap **MAP**, then **READOUT**, then **MAP** again.

**Expect:** the map renders correctly every time — no grey band, no half-drawn
tiles. Leaflet mis-measures itself whenever its container is hidden and shown,
so the map watches its own element with a `ResizeObserver` and re-measures.
That also covers rotating the phone.

**Why the switch rather than a split:** a stacked map-plus-panel on a phone
gives you two unusable halves. FR18's "two-second glance" screen is the
readout, so that is what opens first.

---

## 9 · The two non-functional requirements

Base PRD §7 asks for these as properties of the running app, so check them
rather than taking the README's numbers on trust.

### 9.1 Every interaction under 3 seconds

**Do not** measure this with `requestAnimationFrame` unless the tab is in the
foreground. A backgrounded tab throttles rAF to about one callback per second,
which makes every interaction look like it takes a second. The tell: time
**Hide legend**, a pure CSS toggle, with the same harness. If that also reports
~1,000 ms, you are measuring Chrome.

**Do:** with the window focused and in front, open DevTools → Console:

```js
const t0 = performance.now();
[...document.querySelectorAll('button')].find(b => b.textContent.includes('Add all to Option A')).click();
console.log('sync commit ms:', (performance.now() - t0).toFixed(1));
```

**Expect:** under ~2 ms, and Option A flips to "4 moves". React commits discrete
events synchronously, so this is the real cost of the click.

**The underlying recompute**, measured in Node against the committed snapshot
(median of 9 warm runs): on the snapshot those figures came from, scoring every
Phoenix route took **103 ms** and applying 4 stations and rescoring everything
took **151 ms** — the heaviest recompute in the product, against a 3,000 ms
budget.

Those absolute numbers move with the data, because the relief networks change
size on every refresh and coverage is a nested loop over sites per route sample.
Phoenix cost roughly 20× Yuma despite Yuma having *more* grid cells, purely
because it had an order of magnitude more relief sites to test against. Re-run
the measurement rather than trusting the digits; what holds is the structure —
bounded by routes × sites × samples, in the browser, with nothing on the path
calling FortyGuard.

**Why it holds:** nothing on the interactive path calls FortyGuard. Every number
on screen is derived in the browser from the committed snapshot.

### 9.2 No third-party dependency beyond the basemap

**Do:** in the Console, list every host the page has contacted:

```js
const h = {};
performance.getEntriesByType('resource').forEach(e => {
  const host = new URL(e.name).host; h[host] = (h[host] || 0) + 1;
});
console.table(h);
```

**Expect:** exactly two hosts — the app's own origin (the bundle plus
`/api/bootstrap` and `/api/field`, serving the committed snapshot) and
`tile.openstreetmap.org`. No FortyGuard, no OpenRouteService, no Overpass. That
is FR3 demonstrated rather than asserted.

**Now take the basemap away:**

```js
document.querySelector('.leaflet-tile-pane').style.display = 'none';
```

**Expect:** the heat field, the relief sites and the routes all stay drawn, and
every score, ranking, scenario and export keeps working. You lose street names
and landmarks — geographic context, not function.

This hides the basemap on an already-loaded map, so it shows the data layers are
independent of the tile layer rather than simulating a cold start with no
network. For the failure that matters on demo day — OpenStreetMap unreachable —
the conclusion is the same, and it is why no offline basemap is bundled:
megabytes of tile assets to guard against a failure that leaves the tool usable.

---

## What is deliberately not built

- **Historic data (`filter_type` 1)** — the API returns HTTP 500 on this key.
  The code path exists and is enforced; it activates when the service serves it.
- **`/v1/heat_intelligence`** — available and working: it submits, polls to
  `Completed`, and returns a signed link to a generated **PDF**. Not shipped
  because a PDF is a document for a person to read, not data this UI can compute
  against, and embedding someone else's PDF in a planning tool adds a dependency
  without adding a number.
- **Accounts, real-time GPS, 3D twin** — out of scope per the PRD, with the
  reasoning recorded in the README.

---

## One-line sanity check

```bash
npm run verify
```

That is `typecheck` + `verify:data` + `verify:coverage`. All three should pass
clean; `verify:data` exits non-zero on any `FAIL`, which is what the refresh
workflow gates on.

Add `npm run build` if you want to confirm the production bundle too.
