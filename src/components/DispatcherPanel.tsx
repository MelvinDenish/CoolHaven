'use client';

/**
 * Dispatcher view (base PRD section 6.4).
 *
 * This panel contains no scoring logic at all. It calls `rankRoutes` and
 * `summarizeFleet` over the scores the shell already computed with the same
 * `scoreRoute` the Worker view uses. That was the PRD's explicit bet - "the
 * same math run across many routes instead of one" - and it is why this view
 * is a list and a sort rather than a second engine.
 *
 * It reads forecast data (filter_type 3), because the question is "what should
 * happen in the next few hours". The time selector below is the operational
 * lever: the same eight runs at noon, 3 PM and 6 PM are three different risk
 * pictures.
 */
import { useMemo } from 'react';
import { BAND_META, rankRoutes, summarizeFleet } from '@/lib/scoring';
import { THRESHOLDS } from '@/lib/assumptions';
import { DAY_PARTS, type DayPart } from '@/lib/config';
import type { RouteFeature, RouteScore } from '@/lib/types';
import type { Bootstrap } from './AppShell';
import { BandPill, Chip, CoverageNote, Metric, SectionLabel, fmtMinutes } from './ui';

export default function DispatcherPanel({
  boot,
  routes,
  scores,
  sliceKey,
  onSliceChange,
  dayPart,
  onDayPartChange,
  hasDayRange,
  selectedRouteId,
  onSelectRoute,
}: {
  boot: Bootstrap;
  routes: RouteFeature[];
  scores: RouteScore[];
  sliceKey: string;
  onSliceChange: (k: string) => void;
  dayPart: DayPart;
  onDayPartChange: (p: DayPart) => void;
  hasDayRange: boolean;
  selectedRouteId: string | null;
  onSelectRoute: (id: string) => void;
}) {
  const ranked = useMemo(() => rankRoutes(scores), [scores]);
  const summary = useMemo(() => summarizeFleet(scores), [scores]);
  const byId = useMemo(() => new Map(routes.map((r) => [r.id, r] as const)), [routes]);

  const forecastSlices = boot.timeSlices;

  return (
    <div className="rise">
      {/* ------------------------------------------------- aggregate (FR13) */}
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel right={<Chip tone="ember">forecast</Chip>}>
          Fleet status
        </SectionLabel>

        <div
          className="p-3.5 mb-4 border"
          style={{
            borderColor:
              summary.highOrWorse > 0 ? 'var(--color-ember)' : 'var(--color-hairline)',
            background:
              summary.highOrWorse > 0
                ? 'color-mix(in oklab, var(--color-ember) 10%, var(--color-surface-2))'
                : 'var(--color-surface-2)',
          }}
        >
          <div className="headline text-[19px] leading-tight">
            <span className="num text-[var(--color-ember)]">{summary.highOrWorse}</span>
            <span className="text-[var(--color-muted)]"> of </span>
            <span className="num">{summary.routeCount}</span>
            <span className="text-[var(--color-muted)]"> active routes</span>
          </div>
          <div className="text-[11.5px] text-[var(--color-muted)] mt-1.5 leading-snug">
            are in high-exposure zones right now.
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Metric
            label={`Crew-min above ${THRESHOLDS.extremeF} °F`}
            value={fmtMinutes(summary.totalMinutesInExtreme)}
            unit="min"
            tone={summary.totalMinutesInExtreme > 45 ? 'bad' : 'default'}
            hint="summed across every active run in this window"
          />
          <Metric
            label="Mean exposure index"
            value={summary.meanExposure}
            hint="degree-minutes above 90 °F per run"
          />
        </div>
      </section>

      {/* ------------------------------------------------------ time window */}
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel>Part of day</SectionLabel>
        <div className="grid grid-cols-3 gap-1">
          {DAY_PARTS.map((p) => (
            <button
              key={p.key}
              onClick={() => onDayPartChange(p.key)}
              aria-pressed={dayPart === p.key}
              disabled={!hasDayRange && p.key !== 'avg'}
              className="btn"
              title={p.blurb}
              style={{
                borderColor:
                  dayPart === p.key ? 'var(--color-ember)' : 'var(--color-hairline)',
                color: dayPart === p.key ? 'var(--color-ember)' : 'var(--color-muted)',
                background:
                  dayPart === p.key
                    ? 'var(--color-surface-3)'
                    : 'var(--color-surface-2)',
              }}
            >
              {p.label.replace('Day ', '')}
            </button>
          ))}
        </div>
        <p className="text-[10.5px] text-[var(--color-faint)] mt-2.5 leading-relaxed">
          {hasDayRange
            ? 'The API returns a min, average and max per cell for the day. That range is the only real intra-day signal it exposes - there is no hour parameter - so this is a genuine re-scoring, not an interpolation.'
            : 'The API returned no intra-day range for this day (min equals max), so only the average is available. Switch to the snapshot day to compare parts of the day.'}
        </p>

        <div className="rule my-3" />

        <SectionLabel>Forecast day</SectionLabel>
        <div className="grid grid-cols-2 gap-1">
          {forecastSlices.map((s) => (
            <button
              key={s.key}
              onClick={() => onSliceChange(s.key)}
              aria-pressed={sliceKey === s.key}
              className="btn"
              style={{
                borderColor:
                  sliceKey === s.key ? 'var(--color-ember)' : 'var(--color-hairline)',
                color: sliceKey === s.key ? 'var(--color-ember)' : 'var(--color-muted)',
                background:
                  sliceKey === s.key
                    ? 'var(--color-surface-3)'
                    : 'var(--color-surface-2)',
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="text-[10.5px] text-[var(--color-faint)] mt-2.5 leading-relaxed">
          Re-timing a run is usually cheaper than rerouting it. The usable forecast
          horizon on this key is about one day - submitting +2 days returns HTTP 500.
        </p>
      </section>

      {/* ----------------------------------------------- ranked list (FR12) */}
      <section className="p-4">
        <SectionLabel right={<span className="label">worst first</span>}>
          Riskiest routes right now
        </SectionLabel>

        <ol className="flex flex-col gap-1.5">
          {ranked.map((score, i) => {
            const route = byId.get(score.routeId);
            if (!route) return null;
            const selected = score.routeId === selectedRouteId;
            const meta = BAND_META[score.band];

            return (
              <li key={score.routeId}>
                <button
                  onClick={() => onSelectRoute(score.routeId)}
                  className="w-full text-left px-3 py-2.5 border transition-colors"
                  style={{
                    borderColor: selected
                      ? 'var(--color-ember)'
                      : 'var(--color-hairline)',
                    background: selected
                      ? 'var(--color-surface-3)'
                      : 'var(--color-surface-2)',
                    borderLeftWidth: '3px',
                    borderLeftColor: meta.color,
                  }}
                >
                  <div className="flex items-baseline justify-between gap-2 mb-1">
                    <span className="flex items-baseline gap-2 min-w-0">
                      <span className="num text-[10px] text-[var(--color-faint)]">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span className="text-[12.5px] font-semibold truncate">
                        {route.name}
                      </span>
                    </span>
                    <BandPill band={score.band} />
                  </div>

                  <div className="text-[10px] text-[var(--color-faint)] mb-2">
                    {route.persona}
                  </div>

                  <div className="grid grid-cols-3 gap-2 num text-[11px]">
                    <span>
                      <span className="label block text-[8.5px] mb-0.5">Exposure</span>
                      <span className="text-[var(--color-ember)]">
                        {score.exposureIndex}
                      </span>
                    </span>
                    <span>
                      <span className="label block text-[8.5px] mb-0.5">Peak</span>
                      {score.peakTempF.toFixed(1)}
                      <span className="text-[9px] text-[var(--color-faint)]"> °F</span>
                    </span>
                    <span>
                      <span className="label block text-[8.5px] mb-0.5">Extreme</span>
                      {fmtMinutes(score.minutesInExtreme)}
                      <span className="text-[9px] text-[var(--color-faint)]"> min</span>
                    </span>
                  </div>

                  {selected ? (
                    <div className="mt-2.5 pt-2.5 border-t border-[var(--color-hairline)]">
                      <div
                        className="text-[11px] leading-snug mb-2"
                        style={{ color: meta.color }}
                      >
                        {meta.action}
                      </div>
                      {score.peakSegment ? (
                        <div className="text-[10.5px] text-[var(--color-muted)] leading-snug">
                          Worst stretch: {score.peakSegment.lengthM} m averaging{' '}
                          <span className="num">
                            {score.peakSegment.meanTempF.toFixed(1)} °F
                          </span>
                          , highlighted on the map.
                        </div>
                      ) : null}
                      {score.nearestRelief ? (
                        <div className="text-[10.5px] text-[var(--color-relief)] leading-snug mt-1">
                          Nearest relief: {score.nearestRelief.name} (
                          <span className="num">{score.nearestRelief.distanceM} m</span>)
                        </div>
                      ) : null}
                      <div className="text-[10.5px] text-[var(--color-faint)] leading-snug mt-1">
                        Longest stretch with no relief within reach:{' '}
                        <span className="num">{score.worstReliefGapM} m</span>
                      </div>
                      <CoverageNote score={score} className="mt-1" />
                    </div>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ol>

        <p className="text-[10.5px] text-[var(--color-faint)] mt-3 leading-relaxed">
          Scored with the same function as the Worker view, run across every active run
          instead of one. Ranking is by exposure index, not peak temperature - a long
          moderate run can outrank a short brutal one, which is usually the right call.
        </p>
      </section>
    </div>
  );
}
