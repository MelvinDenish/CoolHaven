'use client';

/**
 * Worker view (base PRD section 6.5).
 *
 * FR18 sets the constraint that shaped this whole panel: it has to be usable
 * in a two-second glance, by someone standing next to a van in 112 degF heat,
 * not sitting at a desk. So the top of it is one number, one band, one
 * instruction - and everything analytical is below that, in the order a worker
 * would actually want it: what do I do, where do I stop, should I go a
 * different way, should I go at a different time.
 *
 * Two features here answer additions to the plan:
 *   - Alternative path (Addition 2): the router returns a genuinely different
 *     second route, we score BOTH with the same function, and recommend on
 *     exposure saved versus minutes lost.
 *   - Leave earlier / later (FR17): real, because the ingest captures three
 *     forecast timestamps. If only one had been captured this would be a
 *     static note instead - the PRD is explicit about not faking it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BAND_META, compareRoutes, scoreRoute } from '@/lib/scoring';
import { HeatField } from '@/lib/grid';
import { MOVEMENT, THRESHOLDS } from '@/lib/assumptions';
import { DAY_PARTS, type DayPart } from '@/lib/config';
import { tempColor, valuesFor } from '@/lib/grid';
import type { HeatGrid, ReliefSite, RouteFeature, RouteScore } from '@/lib/types';
import type { Bootstrap } from './AppShell';
import { BandPill, Chip, Empty, Metric, SectionLabel, fmtMinutes } from './ui';

export default function WorkerPanel({
  boot,
  regionId,
  field,
  sites,
  sliceKey,
  onSliceChange,
  dayPart,
  onDayPartChange,
  hasDayRange,
  onSelectRoute,
  onCompareRoute,
  onAdHocRoutes,
}: {
  boot: Bootstrap;
  regionId: string;
  field: HeatField;
  sites: ReliefSite[];
  sliceKey: string;
  onSliceChange: (k: string) => void;
  dayPart: DayPart;
  onDayPartChange: (p: DayPart) => void;
  hasDayRange: boolean;
  onSelectRoute: (id: string | null) => void;
  onCompareRoute: (v: { route: RouteFeature; label: string } | null) => void;
  onAdHocRoutes: (routes: RouteFeature[]) => void;
}) {
  const demo = boot.routes.workerDemo;
  const [showAlt, setShowAlt] = useState(false);
  const [adHoc, setAdHoc] = useState({ from: '', via: '', to: '' });
  const [adHocState, setAdHocState] = useState<{ busy: boolean; note: string | null }>({
    busy: false,
    note: null,
  });

  /* The demo route is the one selected on the map when this view opens. */
  useEffect(() => {
    onSelectRoute(demo.primary.id);
    return () => onCompareRoute(null);
  }, [demo.primary.id, onSelectRoute, onCompareRoute]);

  useEffect(() => {
    onCompareRoute(
      showAlt && demo.alternative
        ? { route: demo.alternative, label: 'Alternative path' }
        : null,
    );
  }, [showAlt, demo.alternative, onCompareRoute]);

  /* -------------------------------------------------------------- scoring */
  const primaryScore = useMemo(
    () => scoreRoute(demo.primary, field, sites),
    [demo.primary, field, sites],
  );

  const altScore = useMemo(
    () => (demo.alternative ? scoreRoute(demo.alternative, field, sites) : null),
    [demo.alternative, field, sites],
  );

  const comparison = useMemo(
    () =>
      compareRoutes(
        { route: demo.primary, score: primaryScore },
        demo.alternative && altScore
          ? { route: demo.alternative, score: altScore }
          : null,
      ),
    [demo, primaryScore, altScore],
  );

  const meta = BAND_META[primaryScore.band];

  /* ---------------------------------- real hourly profile (FR17, best form) */

  /**
   * The strongest answer to "leave earlier or later" in the whole product.
   *
   * /v1/heatmap has no hour parameter, but /v1/env_params returns 24 hourly
   * values per point - apparent temperature, wet bulb, air quality. So the
   * hour-by-hour question gets a real hour-by-hour answer, taken from the
   * point nearest the run's start.
   */
  const hourly = useMemo(() => {
    const pts = boot.hourly?.points ?? [];
    if (pts.length === 0) return null;
    const start = demo.primary.coords[0];
    let best = pts[0];
    let bestD = Infinity;
    for (const p of pts) {
      const d = Math.hypot(p.lon - start[0], p.lat - start[1]);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    const app = best.apparentTempF;
    if (!app?.length) return null;
    // Working hours only: nobody schedules a delivery round for 3 AM.
    const WORK_START = 5;
    const WORK_END = 20;
    const window = app
      .map((v, h) => ({ h, v }))
      .filter((x) => x.h >= WORK_START && x.h <= WORK_END);
    const coolest = window.reduce((a, b) => (b.v < a.v ? b : a));
    const hottest = window.reduce((a, b) => (b.v > a.v ? b : a));
    return { point: best, app, window, coolest, hottest };
  }, [boot.hourly, demo.primary]);

  /* ------------------------------------------ when to go (FR17), for real */

  /**
   * FR17 asks for a "leave earlier / later" comparison and is explicit that it
   * must be cut rather than faked if the snapshots are not there. The API has
   * no hour parameter, so hourly slices genuinely are not there - but every
   * cell carries a min, an average and a max for the day, and on the snapshot
   * day that is a real ~14 degF swing. So the run is re-scored against each of
   * those three arrays. Same route, same scoring function, three real fields.
   */
  const partOptions = useMemo(() => {
    return DAY_PARTS.map((p) => {
      const swapped = new HeatField(
        field.grids.map((g) => ({ ...g, tempsF: valuesFor(g, p.key) })),
        'avg',
      );
      return { part: p, score: scoreRoute(demo.primary, swapped, sites) };
    });
  }, [field, demo.primary, sites]);

  const bestPart = useMemo(() => {
    if (!hasDayRange) return null;
    return partOptions.reduce((best, o) =>
      o.score.exposureIndex < best.score.exposureIndex ? o : best,
    );
  }, [partOptions, hasDayRange]);

  /* ---------------------------------------------------------- ad-hoc trip */
  async function planAdHoc(e: React.FormEvent) {
    e.preventDefault();
    const from = parsePoint(adHoc.from);
    const to = parsePoint(adHoc.to);
    if (!from || !to) {
      setAdHocState({ busy: false, note: 'Enter both points as "lat, lon".' });
      return;
    }
    // FR14 allows an optional waypoint. A blank field means "no waypoint";
    // a field with something unparseable in it is a typo the user should hear
    // about rather than have silently dropped from their route.
    const via = adHoc.via.trim() ? parsePoint(adHoc.via) : null;
    if (adHoc.via.trim() && !via) {
      setAdHocState({ busy: false, note: 'Waypoint must be "lat, lon", or left blank.' });
      return;
    }
    setAdHocState({ busy: true, note: null });
    try {
      const res = await fetch('/api/route-plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          start: from,
          end: to,
          ...(via ? { via } : {}),
          // Both routers drop alternatives once a via point is present, so
          // asking for them through a waypoint would promise something the
          // upstream API cannot deliver.
          wantAlternatives: !via,
        }),
      });
      const json = (await res.json()) as {
        routes?: RouteFeature[];
        provider?: string;
        degradedReason?: string;
        error?: string;
      };
      if (!res.ok || !json.routes?.length) {
        throw new Error(json.error ?? 'No route returned.');
      }
      const named = json.routes.map((r, i) => ({
        ...r,
        id: `adhoc-${i}`,
        name: i === 0 ? 'Your trip' : `Your trip - alternative ${i}`,
      }));
      onAdHocRoutes(named);
      onSelectRoute(named[0].id);
      onCompareRoute(named[1] ? { route: named[1], label: 'Your alternative' } : null);
      setAdHocState({
        busy: false,
        note:
          json.degradedReason ??
          `Routed via ${json.provider === 'ors' ? 'OpenRouteService' : 'OSRM'}. Scored against the cached field.`,
      });
    } catch (err) {
      setAdHocState({
        busy: false,
        note: err instanceof Error ? err.message : 'Routing failed.',
      });
    }
  }

  /* --------------------------------------------------------------- render */
  return (
    <div className="rise">
      {/* ------------------------------------------------ THE GLANCE (FR18) */}
      <section
        className="p-5 border-b"
        style={{
          borderColor: meta.color,
          background: `color-mix(in oklab, ${meta.color} 13%, var(--color-surface))`,
        }}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <span className="label label-bright">Your run</span>
          <BandPill band={primaryScore.band} big />
        </div>

        <div className="flex items-end gap-3 mb-1">
          <span className="num text-[58px] leading-[0.85]" style={{ color: meta.color }}>
            {primaryScore.peakTempF.toFixed(0)}
          </span>
          <span className="pb-2">
            <span className="num text-[15px] text-[var(--color-muted)]">degF peak</span>
            <span className="block num text-[12px] text-[var(--color-faint)]">
              {primaryScore.meanTempF.toFixed(0)} average
            </span>
          </span>
        </div>

        <div
          className="text-[15px] font-semibold leading-snug mt-4"
          style={{ color: meta.color }}
        >
          {meta.action}
        </div>

        {primaryScore.nearestRelief ? (
          <div className="mt-4 pt-3.5 border-t border-[var(--color-hairline)]">
            <div className="label mb-1">Closest relief on this run</div>
            <div className="text-[14px] font-semibold leading-tight">
              {primaryScore.nearestRelief.name}
            </div>
            <div className="num text-[12px] text-[var(--color-relief)] mt-1">
              {primaryScore.nearestRelief.distanceM} m off route
            </div>
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------------------- the detail */}
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel right={<Chip tone="ember">forecast</Chip>}>
          {demo.primary.name}
        </SectionLabel>

        <div className="grid grid-cols-3 gap-3 num text-[15px]">
          <span>
            <span className="label block mb-1">Distance</span>
            {(demo.primary.distanceM / 1000).toFixed(1)}
            <span className="text-[10px] text-[var(--color-faint)]"> km</span>
          </span>
          <span>
            <span className="label block mb-1">Exposed</span>
            {fmtMinutes(primaryScore.minutesExposed)}
            <span className="text-[10px] text-[var(--color-faint)]"> min</span>
          </span>
          <span>
            <span className="label block mb-1">Over {THRESHOLDS.extremeF}</span>
            <span
              style={{
                color:
                  primaryScore.minutesInExtreme > 0
                    ? 'var(--color-bad)'
                    : 'var(--color-bone)',
              }}
            >
              {fmtMinutes(primaryScore.minutesInExtreme)}
            </span>
            <span className="text-[10px] text-[var(--color-faint)]"> min</span>
          </span>
        </div>

        {primaryScore.peakSegment ? (
          <p className="text-[11px] text-[var(--color-muted)] leading-relaxed mt-3">
            The worst {primaryScore.peakSegment.lengthM} m of this run averages{' '}
            <span className="num text-[var(--color-ember)]">
              {primaryScore.peakSegment.meanTempF.toFixed(1)} degF
            </span>
            . It is picked out in white on the map.
          </p>
        ) : null}

        <p className="text-[10.5px] text-[var(--color-faint)] leading-relaxed mt-2">
          Longest stretch with no relief site within {MOVEMENT.walkToReliefM} m:{' '}
          <span className="num">{primaryScore.worstReliefGapM} m</span>.
        </p>
      </section>

      {/* ------------------------------------------ alternative (Addition 2) */}
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel
          right={
            demo.alternative ? (
              <button
                onClick={() => setShowAlt((s) => !s)}
                className="label hover:text-[var(--color-bone)]"
                style={{ color: showAlt ? 'var(--color-relief)' : undefined }}
              >
                {showAlt ? 'hide on map' : 'show on map'}
              </button>
            ) : undefined
          }
        >
          Cooler way round?
        </SectionLabel>

        {!demo.alternative || !altScore ? (
          <Empty>
            The router returned only one viable path for this trip. Nothing to compare.
          </Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-px bg-[var(--color-hairline)] border border-[var(--color-hairline)] mb-3">
              {[
                { label: 'Fastest', score: primaryScore, route: demo.primary },
                { label: 'Alternative', score: altScore, route: demo.alternative },
              ].map((col) => (
                <div key={col.label} className="bg-[var(--color-surface-2)] p-3">
                  <div className="label mb-2">{col.label}</div>
                  <div className="num text-[21px] leading-none mb-2">
                    {col.score.exposureIndex}
                  </div>
                  <div className="label text-[8.5px] mb-2.5">exposure index</div>
                  <div className="num text-[11px] text-[var(--color-muted)]">
                    {(col.route.distanceM / 1000).toFixed(1)} km
                  </div>
                  <div className="num text-[11px] text-[var(--color-muted)]">
                    {Math.round(col.route.durationS / 60)} min drive
                  </div>
                  <div className="mt-2">
                    <BandPill band={col.score.band} />
                  </div>
                </div>
              ))}
            </div>

            <div
              className="px-3 py-2.5 border"
              style={{
                borderColor:
                  comparison.recommendation === 'take-alternative'
                    ? 'var(--color-relief)'
                    : 'var(--color-hairline)',
                background:
                  comparison.recommendation === 'take-alternative'
                    ? 'color-mix(in oklab, var(--color-relief) 11%, var(--color-surface-2))'
                    : 'var(--color-surface-2)',
              }}
            >
              <div
                className="text-[11px] font-semibold uppercase tracking-[0.1em] mb-1.5"
                style={{
                  color:
                    comparison.recommendation === 'take-alternative'
                      ? 'var(--color-relief)'
                      : 'var(--color-muted)',
                }}
              >
                {comparison.recommendation === 'take-alternative'
                  ? 'Take the alternative'
                  : 'Stay on the fastest path'}
              </div>
              <p className="text-[11px] leading-relaxed text-[var(--color-muted)]">
                {comparison.rationale}
              </p>
            </div>

            <p className="text-[10.5px] text-[var(--color-faint)] leading-relaxed mt-2.5">
              Both paths come from a real routing engine (
              {boot.routes.provider === 'ors' ? 'OpenRouteService' : 'OSRM'}) and are
              scored with the same function - this compares two real roads, not a line
              drawn on a map.
            </p>
          </>
        )}
      </section>

      {/* -------------------------------- real hourly profile from env_params */}
      {hourly ? (
        <section className="p-4 border-b border-[var(--color-hairline)]">
          <SectionLabel right={<Chip tone="relief">hourly</Chip>}>
            What it feels like, hour by hour
          </SectionLabel>

          <div className="flex items-end gap-[2px] h-[86px] mb-1">
            {hourly.window.map(({ h, v }) => {
              const lo = hourly.coolest.v;
              const hi = hourly.hottest.v;
              const frac = hi > lo ? (v - lo) / (hi - lo) : 0.5;
              const isCoolest = h === hourly.coolest.h;
              const isHottest = h === hourly.hottest.h;
              return (
                <span
                  key={h}
                  className="flex-1 relative group"
                  title={`${String(h).padStart(2, '0')}:00 — feels like ${v.toFixed(0)} degF`}
                >
                  <span
                    className="block w-full"
                    style={{
                      height: `${18 + frac * 62}px`,
                      background: tempColor(v),
                      outline: isCoolest
                        ? '1.5px solid var(--color-relief)'
                        : isHottest
                          ? '1.5px solid var(--color-bad)'
                          : 'none',
                    }}
                  />
                </span>
              );
            })}
          </div>
          <div className="flex justify-between num text-[9px] text-[var(--color-faint)] mb-3">
            <span>05:00</span>
            <span>12:00</span>
            <span>20:00</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Metric
              label="Coolest working hour"
              value={`${String(hourly.coolest.h).padStart(2, '0')}:00`}
              tone="relief"
              size="sm"
              hint={`feels like ${hourly.coolest.v.toFixed(0)} degF`}
            />
            <Metric
              label="Worst hour"
              value={`${String(hourly.hottest.h).padStart(2, '0')}:00`}
              tone="bad"
              size="sm"
              hint={`feels like ${hourly.hottest.v.toFixed(0)} degF`}
            />
          </div>

          <p className="text-[11px] text-[var(--color-relief)] leading-relaxed mt-3">
            Running this at {String(hourly.coolest.h).padStart(2, '0')}:00 instead of{' '}
            {String(hourly.hottest.h).padStart(2, '0')}:00 is{' '}
            <span className="num">
              {(hourly.hottest.v - hourly.coolest.v).toFixed(0)} degF
            </span>{' '}
            less apparent heat.
          </p>

          <p className="text-[10.5px] text-[var(--color-faint)] leading-relaxed mt-2">
            Real hourly data from <span className="num">POST /v1/env_params</span> at the
            point nearest this run&apos;s start ({hourly.point.label}). This is
            <em> apparent</em> temperature - what a body experiences - not the dry-bulb
            grid value. It is the only hour-of-day resolution the API exposes; the
            heatmap endpoint has no hour parameter at all.
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------- when to go (FR17) */}
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel>Re-score the whole run</SectionLabel>
        <p className="text-[10.5px] text-[var(--color-faint)] leading-relaxed mb-2.5">
          The chart above is one point. This re-scores the <em>entire route</em> against
          the min, average and max field the API returns per cell - so the map and every
          number move with it.
        </p>

        <div className="flex flex-col gap-1.5">
          {partOptions.map(({ part, score }) => {
            const isBest = bestPart?.part.key === part.key;
            const isCurrent = part.key === dayPart;
            return (
              <button
                key={part.key}
                onClick={() => onDayPartChange(part.key)}
                aria-pressed={isCurrent}
                disabled={!hasDayRange && part.key !== 'avg'}
                className="flex items-center gap-3 px-3 py-2.5 border text-left transition-colors disabled:opacity-40"
                style={{
                  borderColor: isCurrent
                    ? 'var(--color-ember)'
                    : isBest
                      ? 'var(--color-relief-dim)'
                      : 'var(--color-hairline)',
                  background: isCurrent
                    ? 'var(--color-surface-3)'
                    : 'var(--color-surface-2)',
                }}
              >
                <span className="w-[74px] shrink-0">
                  <span className="text-[12px] font-semibold block leading-tight capitalize">
                    {part.label.replace('Day ', '')}
                  </span>
                </span>
                <span className="flex-1">
                  <span className="num text-[12px] text-[var(--color-ember)]">
                    {score.exposureIndex}
                  </span>
                  <span className="text-[10px] text-[var(--color-faint)]"> exposure</span>
                  <span className="block num text-[10.5px] text-[var(--color-faint)]">
                    peak {score.peakTempF.toFixed(0)} degF &middot;{' '}
                    {fmtMinutes(score.minutesInExtreme)} min extreme
                  </span>
                </span>
                <BandPill band={score.band} />
              </button>
            );
          })}
        </div>

        {bestPart && bestPart.part.key !== dayPart ? (
          <p className="text-[11px] text-[var(--color-relief)] leading-relaxed mt-2.5">
            Lowest exposure for this run is the {bestPart.part.label.toLowerCase()} -{' '}
            {partOptions.find((o) => o.part.key === dayPart)!.score.exposureIndex -
              bestPart.score.exposureIndex}{' '}
            degree-minutes below what you are looking at.
          </p>
        ) : null}

        <p className="text-[10.5px] text-[var(--color-faint)] leading-relaxed mt-2">
          {hasDayRange
            ? 'Real, not interpolated: FortyGuard returns a min, average and max per cell for the day, and the run is re-scored against each. The API has no hour-of-day parameter, so this is the honest form of "leave earlier or later".'
            : 'The API returned no intra-day range for this forecast day, so only the average is available.'}
        </p>

        <div className="rule my-3" />

        <SectionLabel>Or go on a different day</SectionLabel>
        <div className="grid grid-cols-2 gap-1">
          {boot.timeSlices.map((sl) => (
            <button
              key={sl.key}
              onClick={() => onSliceChange(sl.key)}
              aria-pressed={sliceKey === sl.key}
              className="btn"
              style={{
                borderColor:
                  sliceKey === sl.key ? 'var(--color-ember)' : 'var(--color-hairline)',
                color: sliceKey === sl.key ? 'var(--color-ember)' : 'var(--color-muted)',
              }}
            >
              {sl.label}
            </button>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------------- ad-hoc */}
      <section className="p-4">
        <SectionLabel>Score a different trip</SectionLabel>
        <form onSubmit={planAdHoc} className="flex flex-col gap-2">
          <label className="block">
            <span className="label block mb-1">From (lat, lon)</span>
            <input
              type="text"
              value={adHoc.from}
              placeholder="33.4197, -112.0664"
              onChange={(e) => setAdHoc((p) => ({ ...p, from: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="label block mb-1">
              Waypoint (lat, lon) <span className="normal-case">- optional</span>
            </span>
            <input
              type="text"
              value={adHoc.via}
              placeholder="leave blank for a direct run"
              onChange={(e) => setAdHoc((p) => ({ ...p, via: e.target.value }))}
            />
          </label>
          <label className="block">
            <span className="label block mb-1">To (lat, lon)</span>
            <input
              type="text"
              value={adHoc.to}
              placeholder="33.5090, -112.0691"
              onChange={(e) => setAdHoc((p) => ({ ...p, to: e.target.value }))}
            />
          </label>
          <button className="btn btn-primary" disabled={adHocState.busy}>
            {adHocState.busy ? 'Routing...' : 'Route and score'}
          </button>
        </form>

        {adHocState.note ? (
          <p className="text-[10.5px] text-[var(--color-muted)] leading-relaxed mt-2.5">
            {adHocState.note}
          </p>
        ) : null}

        <p className="text-[10.5px] text-[var(--color-faint)] leading-relaxed mt-2.5">
          This is the only feature that touches the network at request time. Everything
          else on this screen runs from the committed snapshot, so the demo works with the
          network unplugged.
        </p>
      </section>
    </div>
  );
}

/** Accepts "33.44, -112.07" and returns [lon, lat] for the routing API. */
function parsePoint(raw: string): [number, number] | null {
  const parts = raw.split(',').map((s) => Number(s.trim()));
  if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) return null;
  const [lat, lon] = parts;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return [lon, lat];
}
