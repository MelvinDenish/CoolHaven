# Demo script (3–5 minutes)

Follows base PRD section 9. Timings are targets, not a straitjacket.

**Before you start:** `npm run build && npm start`, load the page once so the
basemap tiles are cached, and leave the Planner view open at its default state.

---

## 0:00–0:30 — Open with the data layer, not the map

> "FortyGuard's temperature API isn't a point lookup. It takes a polygon, it's
> asynchronous, and it has an area limit that Phoenix blows straight past. So
> the first thing we built wasn't a map — it was this."

Show [`scripts/ingest-fortyguard.ts`](../scripts/ingest-fortyguard.ts) briefly.
Three things to point at:

1. Submit → poll `/v1/status/{activity_id}` with exponential backoff.
2. `assertTilesWithinAoiLimit()` — the AOI limit is enforced in code, before a
   request goes out, so a bad bbox fails loudly instead of burning credits.
3. The cache check — an (area, time) pair is never requested twice.

> "The app never calls FortyGuard. It reads what this writes. That's why every
> interaction is instant, and why this demo works with the network unplugged."

**Then point at the provenance bar.** Green dot, top of the screen, reading
`FORTYGUARD CACHED SNAPSHOT` — and next to it, today's date.

> "This is live FortyGuard data, pulled today. Every grid carries the
> `activity_id` of the call that produced it, so 'we used the API' is checkable
> rather than claimed. And the date matters: the snapshot rolls forward every
> run. Take the key away and the same pipeline writes a modelled stand-in
> instead, stamps every tile `source: synthetic`, and this bar turns amber. The
> app never guesses which it has."

*(Optional, 10 seconds, and it lands well with technical judges:*
`npm run verify:data` *— freshness, provenance, and drift checks, all PASS.)*

---

## 0:30–1:00 — Frame the problem

> "This isn't 'urban heat' in the abstract. It's the 32 million people in the
> US whose job is moving outdoors on a schedule. Heat kills about 2,000
> Americans a year — more than hurricanes or floods — and drove an estimated
> 28,000 extra workplace injuries in 2023. Today we're showing Phoenix delivery
> couriers. The engine doesn't care: postal, utility and municipal crews are
> the same shape of problem."

---

## 1:00–2:00 — Planner: the gap is real

Point at the cyan dots.

> "These aren't hypothetical. That's the actual Maricopa Heat Relief Network —
> 253 live sites, cooling centres, hydration stations, respite centres, with
> their real published hours. We pull it from the county's own feature service."

Click **Show demand layer on map**.

> "This is where outdoor work actually happens: heat, weighted by road density
> and by courier routes we generated on the real street network. The brightest
> cells are hot, busy, *and* more than a walk from any relief."

Read the two numbers on screen — **relief coverage** and **uncovered hot
cells** — and the amber note underneath. *(Both move with each refresh; read
what the panel says rather than a memorised figure.)*

> "And notice this: a chunk of the sites in the focus area are shut at 3 PM, so
> they don't count. Coverage that included them would look better and be
> wrong, in the direction that matters most - the hour the network is least
> available is the hour the heat is worst."

Then switch to Dispatcher for one beat, click **Buckeye Road industrial run**,
and point at the relief-gap line.

> "And here's the finding. That's a 16.8 km utility run, and the longest
> stretch with no relief within a walk is… 16.8 km. The whole route. Nearest
> cooling site to any point on it is 942 metres.
>
> The Heat Relief Network isn't built wrong — it's distributed where residents
> are, libraries and community centres. It's just that nobody was looking at it
> through the workforce lens, and the freight corridors fall straight through
> the gap."

Switch back to Planner.

---

## 2:00–3:00 — The what-if, and the export

Click **Add all to Option A**. Let the before/after table animate.

> "Four stations. Relief coverage 16.0 to 18.7. The worst stretch with no
> relief in reach drops from 6.9 km to 4.6 — down a third."

Point at *Mean field temperature: no change*.

> "And notice this one didn't move. A cooling station doesn't cool the street.
> We model it as zero degrees, on purpose — its benefit is access, not
> temperature. Making up a number there would have been easy and wrong."

Scroll up one section to **Ground truth** and click through a point or two.

> "And before we place a single tree, here's what's actually on that street.
> This is FortyGuard's street-view segmentation — the share of the frame that's
> tree, sky, building, road. Two and a half percent canopy, a third of the frame
> open sky. That's not a model, that's a measurement at eye level.
>
> It answers the question the map can't: is there even room to plant here?
> Recommending canopy on a block already at forty percent cover is a different
> proposition from this.
>
> What it deliberately does *not* do is set the temperature number. A photograph
> contains no degrees. So the canopy tool's minus-two-point-five stays labelled
> an assumption — the segmentation tells you where planting is possible, not
> what it buys you."

Pick up the **canopy** tool so its assumption text is on screen.

> "Every tool carries its own assumption where you use it — minus 2.5 degrees,
> 250 metres, labelled *directional*, not measured. Cool pavement is the only
> *measured* one in here, and it's deliberately the smallest number, because
> cool pavement changes surface temperature far more than the air a worker
> breathes."

Pick the canopy tool and click twice along a street, then **Finish corridor**.
A new row appears.

> "Note it's a corridor, not a blob. Shade is specified and tendered per
> corridor-kilometre, because it's a street — so the tool draws a street."

> "Inside the treated corridors, 111.8 down to 110.5. And look at the row
> underneath — across the whole 26 square miles, no change at all. That's not
> the tool failing, that's the tool being honest: two canopy corridors are a
> real improvement for the blocks they cover and a rounding error for a
> district. If you want a district-scale number, you have to fund
> district-scale work, and this is the panel that tells a council that."

Click **GeoJSON**.

> "And it exports. Standard GeoJSON, EPSG:4326 — every feature carries its
> assumed effect, its confidence level and its unit cost, so the coefficient
> travels with the geometry. That drops straight into Autodesk Forma as site
> context, or into any GIS. It's Forma-compatible, not a Forma integration —
> worth being precise about."

---

## 3:00–4:00 — Dispatcher: what do I do this afternoon

Switch to **Dispatcher**.

> "Same data, same scoring function — literally the same function, run across
> eight runs instead of one. Three of eight are in high-exposure zones right
> now. Four and a half crew-hours above 108 degrees."

Click the **18:00** window.

> "Move the same eight runs three hours later: one of eight, and crew-time
> above 108 nearly halves. Re-timing is almost always cheaper than rerouting,
> and now that's a number instead of a hunch."

Click the top route to expand it.

> "And it tells the dispatcher what to do — not just that it's hot, but which
> 600 metres is the problem and where the nearest relief is."

---

## 4:00–4:40 — Worker: the two-second glance

Switch to **Worker**.

> "Same engine, but a courier standing next to a van in 112-degree heat doesn't
> get a dashboard. One number, one band, one instruction, and the nearest real
> cooling site — 44 metres off route."

Scroll to **Cooler way round?**

> "Both of these are real roads from a real routing engine, scored the same
> way. And here the honest answer is: don't. The alternative is 99
> degree-minutes *worse*. The tool says that rather than quietly reporting a
> saving of zero."

Scroll to **What it feels like, hour by hour**.

> "This is the hour-by-hour answer, and it's real. `/v1/heatmap` has no hour
> parameter at all — two submissions differing only by hour come back
> byte-identical, so we deleted the hour slider rather than fake it. But
> `/v1/env_params` returns 24 hourly values per point, and it's *apparent*
> temperature — what a body actually experiences. Six in the morning against one
> in the afternoon is a twenty-degree decision."

Scroll to **Re-score the whole run**.

> "And this one moves the whole field, not just a point. Every cell carries a
> min, an average and a max for the day, so the same run gets re-scored against
> three real fields. Two different mechanisms, both measured, and the panel says
> which is which."

---

## 4:40–4:55 — The other cities

Change the **Region** dropdown to **Yuma**, then to **Tucson**.

> "Same code path, different city. Yuma is one of the hottest places in the
> country, the workforce is agricultural rather than courier, and the relief
> data comes from a completely different agency with a different schema — state
> health services instead of the Maricopa council of governments. The
> south-county utility circuit runs its entire length with zero relief sites
> within a walk.
>
> Tucson and Las Vegas are a harder test: neither has an agency feed at all, so
> those read community-mapped OpenStreetMap amenities instead — and the app
> flags them as a weaker grade of data rather than averaging them in. Their
> coverage numbers are never put in the same table as Phoenix's.
>
> And the finding still reproduces. In Tucson the civic runs sit around thirty
> percent uncovered; the rail-industrial and airport-approach runs are at
> ninety-four and ninety-six. Four cities, three data sources, one structural
> gap — freight and industrial corridors fall through it everywhere, because
> relief networks are built where residents are."

*(If asked what adding a city costs: a config entry, one command, and a
hand-authored set of sample runs — the runs have to start and end at real
places inside the measured tiles.)*

---

## 4:55–5:10 — Close

> "One heat layer, three audiences. Where a city should build, which crews to
> pull today, and whether this run is safe right now — all from one cached
> dataset and one scoring function.
>
> What's measured here: the temperature field, the relief networks, the roads,
> the routes, and the ground segmentation. What's assumed: every intervention
> effect, and they're labelled at the moment you use them — including after the
> ground data arrived, because a photograph measures cover, not degrees.
>
> The app tells you which is which without being asked. That last part is the
> bit we'd want a city to trust us on."

---

## Fallbacks if something breaks

| If | Do |
|---|---|
| Basemap tiles don't load | Keep going — every layer that matters is local. Say so out loud. |
| Ad-hoc trip router fails | Skip it; it's the only live call in the app and the panel explains the degrade. |
| A panel looks wrong | Reload. All state is derived from the snapshot; there is nothing to lose. |
