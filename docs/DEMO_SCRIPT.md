# Demo script (3:25 — hard cap 3:00, workable to 3:30)

Paced for a **3-minute** submission limit with a little headroom.

**~605 spoken words.** At 175 wpm that is **3:28**; at 180 wpm, **3:22**. This
is a talk-over-the-clicks script — the narration runs continuously, so word
count is effectively the runtime. Do not add ad-libs without cutting something.

**Cut order if you are running long.** Each is self-contained; drop in this
order:

| Drop | Saves | Lands at |
|---|---|---|
| 1. Ground truth (2:05) | −13s | 3:15 |
| 2. The Worker line (2:33) | −7s | 3:08 |
| 3. The Tucson / Las Vegas sentence (2:50) | −9s | **2:59** |

All three dropped puts you safely under the 3:00 cap.

**Before you record**

- `npm run build && npm start`, then load the page once so basemap tiles cache.
- Leave the opening card **dismissed** — this script assumes that. Clear
  `localStorage` key `coolroute.onboarded.v1` only if you want it back.
- Land on **Planner / Phoenix**, work-exposure layer, default reading.
- **Option A** empty.
- Open a second tab with Dispatcher's **Buckeye Road industrial run** already
  expanded, so section 1 is a tab switch rather than three clicks.
- Numbers drift with every refresh. **Read what is on screen.** Figures marked
  *(read live)* move.

---

## 0:00–0:18 — The problem, and the finding

Open on the Planner, work-exposure layer already painted.

> "Thirty-two million Americans work outdoors on a schedule. Heat kills about
> two thousand of them a year — more than hurricanes or floods. Phoenix has a
> real cooling network. It just isn't built for them."

Switch to the tab with **Buckeye Road industrial run** expanded.

> "Sixteen-point-eight kilometre utility run. Longest stretch with no relief
> within a walk: the entire route."

*(read live — route and figure come from the same scores every panel uses)*

---

## 0:18–0:40 — It is real API data

**Point at the provenance bar.** Green dot, `FORTYGUARD DATA`, today's date.

> "This is live FortyGuard data, pulled today. Every grid carries the
> `activity_id` of the call that produced it — so 'we used the API' is
> checkable, not claimed.
>
> It's asynchronous and caps area well below a city, so we built the ingest
> first. The app just reads the committed snapshot — which is why it's instant,
> and why it runs offline."

---

## 0:40–1:20 — Where the gap is

Point at the cyan dots, then the ember wash.

> "That's the actual Maricopa Heat Relief Network — real sites, real published
> hours, from the county's own feature service.
>
> And this layer is where outdoor work happens: heat, weighted by road density
> and by courier routes on the real street network. We open on this, not
> temperature — the field is nearly flat across a focus area."

Point at **relief coverage** and **uncovered hot cells**.

> "Coverage is about one in six *(read live)*. And sites shut at this reading
> don't count — counting them would look better and be wrong in the worst
> direction: the hour the network is least available is the hour heat is worst."

Scroll to **step 2, What to build**.

> "Recommendations come out as streets, not coordinates, with metres to the
> nearest open site."

---

## 1:20–2:05 — What you'd build, and what it costs

Click **Add all to Option A**.

> "Four stations. Coverage moves *(read live)*, and the longest walk to relief
> drops by about a third."

Point at *Mean temperature, whole focus area: **no change***.

> "That row didn't move, and that's the point. A station doesn't cool the
> street — we model it as zero degrees, on purpose. Its benefit is access. The
> panel says so itself, because four rows reading 'no change' looks broken and
> is actually accurate."

Click **Print report**.

> "This is what leaves the room. Not a screenshot — provenance, the network as
> it stands, what it costs, what it changes, the priority sites by name, and
> what the report does *not* establish."

Click **GeoJSON**.

> "Plus GeoJSON, every feature carrying its assumed effect, confidence and unit
> cost — straight into Forma as site context. Forma-*compatible*, not a Forma
> integration."

---

## 2:05–2:18 — Ground truth *(cut #1)*

Scroll to **Ground truth**.

> "Before we place a single tree — street-view segmentation. Two percent canopy,
> measured at eye level. It answers what the map can't: is there room to plant.
> It does not set the temperature — a photograph contains no degrees."

---

## 2:18–2:40 — Same data, three audiences

Switch to **Dispatcher**, click **peak** on the reading control.

> "Same scoring function, eight routes instead of one. Re-scored against the
> day's maximum, Buckeye Road flips to HIGH — a real fourteen-degree swing.
>
> There's no hour slider because there's no hour parameter — two submissions
> differing only by hour come back identical. Min, average and max are the only
> real intra-day signal. Inventing 3 PM versus 6 PM would have demoed better and
> been a lie."

Switch to **Worker**. *(cut #2)*

> "And the same engine for a courier beside a van: one number, one band, one
> instruction, and the nearest real cooling site."

---

## 2:40–3:05 — It reproduces

Change **Region** to **Yuma**, then **Tucson**.

> "Same code path, different city. Yuma's relief data comes from a different
> agency entirely — and its south-county circuit runs its whole length with zero
> relief within a walk.
>
> Tucson and Las Vegas have no agency feed at all, so those read OpenStreetMap
> amenities — flagged as a weaker grade of data rather than averaged in. *(cut
> #3 is this sentence)*
>
> Four cities, three data sources, one structural gap. Freight corridors fall
> through it everywhere, because relief networks are built where residents are."

---

## 3:05–3:25 — Close

> "One heat layer, three audiences — where to build, which crews to pull today,
> whether this run is safe now. One cached dataset, one scoring function.
>
> Measured: the temperature field, the relief networks, the roads, the routes,
> the segmentation. Assumed: every intervention effect — and each is labelled
> where you use it.
>
> The app tells you which is which without being asked. That's what we'd want a
> city to trust us on."

---

## Cut for time — keep for questions

None of this left the product; it left the *video*. If a judge asks, these are
the strongest follow-ups:

| Topic | Where it lives |
|---|---|
| The freeway-siting bug that naming the sites exposed | USER_MANUAL 1.4 — work exposure peaks on motorway, so those cells are excluded from siting while still shown on the map |
| Live tile refresh: submit → poll → complete, on screen | USER_MANUAL 1.11 — 40–50s, too slow for a 3-minute video |
| Every coefficient with its confidence level | The `/methodology` page, rendered from the same module the engine multiplies by |
| Hour-by-hour apparent temperature, wet bulb, air quality | Worker view — `/v1/env_params`, 24 real hourly values per point |
| Import a Forma design and score it | USER_MANUAL 1.4e — the return leg of the round trip |
| Drawing a canopy corridor along a street | Scenario studio — corridors, not discs, because shade is tendered per corridor-km |
| Why `filter_type` 1 (historic) is unavailable | HTTP 500 on this key; `npm run probe:keys` tests whether that is the key or the service |
| The AOI guard, cache idempotency, the verify suite | USER_MANUAL section 0 — `npm run verify` |
| Why there is no clock time on the bar | The field is daily; the `15:00` in `validAt` is a cache key, not a measurement |

---

## Fallbacks if something breaks

| If | Do |
|---|---|
| Basemap tiles don't load | Keep going — every layer that matters is local. Say so out loud. |
| Ad-hoc trip router fails | Skip it; it's the only live call in the app and the panel explains the degrade. |
| A panel looks wrong | Reload. All state is derived from the snapshot; there is nothing to lose. |
| You are over at 2:40 | Drop the Worker line and the Tucson / Las Vegas sentence, go straight to the close. |
