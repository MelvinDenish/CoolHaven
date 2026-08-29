'use client';

/**
 * Shared display primitives.
 *
 * Two rules run through this file and they are the reason it exists:
 *
 *   1. A number never appears without its unit and never without something
 *      saying what it is. In a tool whose whole claim is transparency, a bare
 *      figure floating in a panel is a small lie.
 *   2. Provenance is a component, not a comment. `ProvenanceBar` reads the
 *      snapshot manifest and says out loud whether the field on screen came
 *      from the FortyGuard API or from the local model.
 */
import { useState, type ReactNode } from 'react';
import type { RiskBand, SnapshotManifest } from '@/lib/types';
import { BAND_META } from '@/lib/scoring';
import { DAY_PARTS, type DayPart } from '@/lib/config';

export function SectionLabel({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 mb-2.5">
      <span className="label label-bright">{children}</span>
      {right}
    </div>
  );
}

export function Metric({
  label,
  value,
  unit,
  hint,
  tone = 'default',
  size = 'md',
}: {
  label: string;
  value: string | number;
  unit?: string;
  hint?: string;
  tone?: 'default' | 'ember' | 'relief' | 'good' | 'bad';
  size?: 'sm' | 'md' | 'lg';
}) {
  const toneClass = {
    default: 'text-[var(--color-bone)]',
    ember: 'text-[var(--color-ember)]',
    relief: 'text-[var(--color-relief)]',
    good: 'text-[var(--color-good)]',
    bad: 'text-[var(--color-bad)]',
  }[tone];
  const sizeClass = { sm: 'text-[17px]', md: 'text-[24px]', lg: 'text-[34px]' }[size];

  return (
    <div>
      <div className="label mb-1">{label}</div>
      <div className={`num ${sizeClass} ${toneClass} leading-none`}>
        {value}
        {unit ? (
          <span className="text-[11px] text-[var(--color-faint)] ml-1 tracking-normal">
            {unit}
          </span>
        ) : null}
      </div>
      {hint ? (
        <div className="text-[10.5px] text-[var(--color-faint)] mt-1.5 leading-snug">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One row of the before/after table.
 *
 * `betterWhen` exists because "lower is better" is not universal here:
 * exposure should fall, relief coverage should rise, and colouring both the
 * same direction would quietly mislead. The caller states the direction.
 */
export function DeltaRow({
  label,
  before,
  after,
  unit,
  betterWhen = 'lower',
  precision = 0,
}: {
  label: string;
  before: number;
  after: number;
  unit?: string;
  betterWhen?: 'lower' | 'higher';
  precision?: number;
}) {
  const delta = after - before;
  const improved = betterWhen === 'lower' ? delta < 0 : delta > 0;
  const changed = Math.abs(delta) > 1e-9;
  const pct = before !== 0 ? (delta / Math.abs(before)) * 100 : 0;

  const fmt = (n: number) =>
    n.toLocaleString(undefined, {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    });

  const tone = !changed
    ? 'text-[var(--color-faint)]'
    : improved
      ? 'text-[var(--color-good)]'
      : 'text-[var(--color-bad)]';

  // Bar width is relative to the larger of the two values, so the pair reads
  // as a direct visual comparison rather than two unrelated meters.
  const scale = Math.max(Math.abs(before), Math.abs(after)) || 1;

  return (
    <div className="py-2.5 border-b border-[var(--color-hairline)] last:border-b-0">
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <span className="text-[11.5px] text-[var(--color-muted)]">{label}</span>
        <span className={`num text-[11px] ${tone}`}>
          {changed ? (
            <>
              {delta > 0 ? '+' : ''}
              {fmt(delta)}
              {unit ? ` ${unit}` : ''}
              {Math.abs(pct) >= 0.05 ? (
                <span className="text-[var(--color-faint)]">
                  {' '}
                  ({pct > 0 ? '+' : ''}
                  {pct.toFixed(1)}%)
                </span>
              ) : null}
            </>
          ) : (
            'no change'
          )}
        </span>
      </div>

      <div className="grid grid-cols-[38px_1fr_58px] items-center gap-2 mb-1">
        <span className="label text-[9px]">Base</span>
        <Bar value={Math.abs(before) / scale} color="var(--color-hairline-bright)" />
        <span className="num text-[11.5px] text-right text-[var(--color-muted)]">
          {fmt(before)}
        </span>
      </div>
      <div className="grid grid-cols-[38px_1fr_58px] items-center gap-2">
        <span className="label text-[9px] text-[var(--color-ember)]">Scen</span>
        <Bar
          value={Math.abs(after) / scale}
          color={improved || !changed ? 'var(--color-relief)' : 'var(--color-ember)'}
        />
        <span className="num text-[11.5px] text-right text-[var(--color-bone)]">
          {fmt(after)}
        </span>
      </div>
    </div>
  );
}

export function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-[5px] bg-[var(--color-void)] border border-[var(--color-hairline)]">
      <div
        className="h-full bar-fill"
        style={{
          width: `${Math.max(0, Math.min(1, value)) * 100}%`,
          background: color,
        }}
      />
    </div>
  );
}

export function Chip({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'ember' | 'relief' | 'warn';
  title?: string;
}) {
  const map = {
    neutral: 'border-[var(--color-hairline-bright)] text-[var(--color-muted)]',
    ember: 'border-[var(--color-ember-dim)] text-[var(--color-ember)]',
    relief: 'border-[var(--color-relief-dim)] text-[var(--color-relief)]',
    warn: 'border-[var(--color-warn)] text-[var(--color-warn)]',
  }[tone];
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 border px-2 py-[3px] text-[9.5px] font-semibold uppercase tracking-[0.12em] ${map}`}
    >
      {children}
    </span>
  );
}

export function BandPill({ band, big = false }: { band: RiskBand; big?: boolean }) {
  const meta = BAND_META[band];
  return (
    <span
      className={`inline-block font-semibold uppercase tracking-[0.12em] ${
        big ? 'text-[13px] px-3 py-1.5' : 'text-[9.5px] px-2 py-[3px]'
      }`}
      style={{ background: meta.color, color: '#0b0a09' }}
    >
      {meta.label}
    </span>
  );
}

/**
 * The day-part control, in one place because it now appears in three.
 *
 * It used to live only inside DispatcherPanel and WorkerPanel, which meant the
 * Planner - the view most people open first - displayed "reading: Day average"
 * on the status bar with no way to change it. The reading was a label that
 * looked exactly like a control, so the honest fix is to make it one
 * everywhere rather than to restyle it into looking inert.
 */
export function DayPartSwitch({
  value,
  onChange,
  hasDayRange,
  size = 'md',
}: {
  value: DayPart;
  onChange: (p: DayPart) => void;
  /** False when min == average == max, i.e. the API gave no intra-day range. */
  hasDayRange: boolean;
  size?: 'sm' | 'md';
}) {
  return (
    <span className="inline-flex items-center gap-1" role="group" aria-label="Day part">
      {DAY_PARTS.map((p) => {
        const active = value === p.key;
        const disabled = !hasDayRange && p.key !== 'avg';
        return (
          <button
            key={p.key}
            onClick={() => onChange(p.key)}
            aria-pressed={active}
            disabled={disabled}
            title={
              disabled
                ? 'This reading has no intra-day range - the API returned the same value for min, average and max.'
                : p.blurb
            }
            className={`border transition-colors ${
              size === 'sm' ? 'px-1.5 py-[1px] text-[9.5px]' : 'px-2 py-[3px] text-[10.5px]'
            } font-semibold uppercase tracking-[0.1em]`}
            style={{
              borderColor: active ? 'var(--color-ember)' : 'var(--color-hairline)',
              color: active
                ? 'var(--color-ember)'
                : disabled
                  ? 'var(--color-faint)'
                  : 'var(--color-muted)',
              background: active ? 'var(--color-surface-3)' : 'transparent',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.45 : 1,
            }}
          >
            {p.label.replace('Day ', '')}
          </button>
        );
      })}
    </span>
  );
}

/**
 * The date a field describes, WITHOUT a fabricated clock time.
 *
 * `validAt` carries a nominal 15:00 stamp that the ingest writes so the cache
 * key is a full instant (scripts/ingest-fortyguard.ts). The API's field is
 * daily - it returns a min, an average and a max for a calendar date and
 * exposes no hour parameter at all - so rendering that stamp as "3:00 PM"
 * asserted a precision the data does not have, and was read by users as the
 * app simply showing the wrong time.
 *
 * The date is real. The hour never was. Only the date is shown.
 */
export function formatValidDay(validAt: string): string {
  return new Date(validAt).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/Phoenix',
  });
}

/**
 * The provenance banner. Base PRD section 3 makes correct, non-mocked use of
 * the FortyGuard API the first success criterion, which cuts both ways: when
 * the committed snapshot was NOT fetched live, the app has to say so where
 * nobody can miss it.
 */
export function ProvenanceBar({
  manifest,
  filterType,
  validAt,
  reliefSource,
  routeProvider,
  openCount,
  totalCount,
  liveTiles,
  dayPart,
  onDayPartChange,
  hasDayRange,
}: {
  manifest: SnapshotManifest;
  filterType: number;
  validAt: string;
  reliefSource: string;
  routeProvider: string;
  /** Relief sites actually open at the hour being modelled. */
  openCount: number;
  totalCount: number;
  /** Tiles re-fetched live this session via the refresh button. */
  liveTiles: number;
  /** Which of the day's min / average / max is on screen. */
  dayPart: DayPart;
  onDayPartChange: (p: DayPart) => void;
  hasDayRange: boolean;
}) {
  const live = manifest.liveApiUsed || liveTiles > 0;
  const stamp = formatValidDay(validAt);
  const [showDetail, setShowDetail] = useState(false);

  /*
   * Three facts, not seven.
   *
   * This bar carried source, filter_type, reading, valid date, relief layer,
   * open count and routing, all at equal weight, as the very first thing on
   * screen. It was accurate and it read like a debug line - and being first,
   * it set the tone for everything under it.
   *
   * What a person needs at a glance is: can I trust this, what am I looking
   * at, and how much of the network is actually open. The rest is provenance
   * you go and check, so it moved one click away rather than off the page.
   */
  return (
    <div
      className="relative flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2 border-b"
      style={{
        borderColor: live ? 'var(--color-hairline)' : 'var(--color-warn)',
        background: live
          ? 'var(--color-surface)'
          : 'color-mix(in oklab, var(--color-warn) 11%, var(--color-surface))',
      }}
    >
      {/* 1 - can I trust this, and how fresh is it */}
      <button
        onClick={() => setShowDetail((s) => !s)}
        aria-expanded={showDetail}
        className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        title="Show the full provenance of what is on screen"
      >
        <span
          className="live-dot inline-block w-[7px] h-[7px]"
          style={{ background: live ? 'var(--color-good)' : 'var(--color-warn)' }}
        />
        <span
          className="label"
          style={{ color: live ? undefined : 'var(--color-warn)' }}
        >
          {/*
            The refreshed-tile count used to sit in the FALSE branch of
            `liveApiUsed`, which is the branch that never runs - every
            committed snapshot is FortyGuard data, so a successful 45-second
            live refresh changed nothing on screen and the button read as
            broken. The count now applies to whichever base label is true.
          */}
          {manifest.liveApiUsed ? 'FortyGuard data' : 'Modelled stand-in'}
          {liveTiles > 0 ? ` + ${liveTiles} tile${liveTiles === 1 ? '' : 's'} live` : ''}
          <span className="ml-1.5 normal-case tracking-normal text-[var(--color-faint)]">
            {stamp}
          </span>
        </span>
        <span className="label text-[var(--color-faint)]">{showDetail ? '-' : 'i'}</span>
      </button>

      {/* 2 - what am I looking at */}
      <span className="label flex items-center gap-2">
        reading
        <DayPartSwitch
          value={dayPart}
          onChange={onDayPartChange}
          hasDayRange={hasDayRange}
          size="sm"
        />
      </span>

      {/* 3 - how much of the network is actually usable at this reading */}
      <span className="label">
        <span
          className="num text-[11px]"
          style={{
            color: openCount < totalCount ? 'var(--color-warn)' : 'var(--color-bone)',
          }}
        >
          {openCount}/{totalCount}
        </span>
        <span className="ml-1 normal-case tracking-normal">relief sites open</span>
      </span>

      {showDetail ? (
        <div
          className="absolute left-3 top-full z-[1300] mt-1 panel px-3.5 py-3 w-[330px] bg-[var(--color-void)] rise"
          role="region"
          aria-label="Provenance detail"
        >
          <DetailRow k="Heat field">
            {manifest.liveApiUsed
              ? 'FortyGuard /v1/heatmap, cached'
              : 'Modelled stand-in - not FortyGuard data'}
            {liveTiles > 0
              ? `, plus ${liveTiles} tile${
                  liveTiles === 1 ? '' : 's'
                } refetched live this session`
              : ''}
          </DetailRow>
          <DetailRow k="filter_type">
            {filterType} {filterType === 1 ? '(historic)' : '(forecast)'}
          </DetailRow>
          {/*
            A date, not a clock time. The API's field is daily - it has no hour
            parameter and returns one min/average/max per calendar date - so
            the 15:00 in `validAt` is a cache-key artefact, not a measurement.
          */}
          <DetailRow k="Valid for">
            {stamp} - the whole day. The API returns one field per calendar date and
            exposes no hour, so the reading picks that day&apos;s minimum, average or
            maximum.
          </DetailRow>
          <DetailRow k="Relief network">{reliefSource}</DetailRow>
          <DetailRow k="Open sites">
            {openCount} of {totalCount} in the focus area are open at this reading.
            Coverage counts only those - a site that shut at 3 PM does not help a crew
            at 4 PM.
          </DetailRow>
          <DetailRow k="Routing">
            {routeProvider === 'ors'
              ? 'OpenRouteService'
              : routeProvider === 'osrm'
                ? 'OSRM'
                : routeProvider}
          </DetailRow>
        </div>
      ) : null}
    </div>
  );
}

function DetailRow({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="py-1.5 border-b border-[var(--color-hairline)] last:border-b-0">
      <div className="label mb-0.5">{k}</div>
      <div className="text-[11px] leading-relaxed text-[var(--color-muted)]">
        {children}
      </div>
    </div>
  );
}

/**
 * Says out loud when part of a scored route sits outside measured coverage.
 *
 * The AOI is a handful of tiles, not a continuous surface - the API's ~50 mi²
 * cap forces that - so a run leaving the tiles gets its temperature from the
 * nearest tile edge. `scoreRoute` deliberately keeps those samples in the
 * denominator, because dropping them would flatter exactly the runs that
 * wander furthest. But an extrapolated value is not a measured one, and this
 * component is that difference being stated rather than assumed.
 *
 * Renders nothing at full coverage, which is the normal case.
 */
export function CoverageNote({
  score,
  className = '',
}: {
  score: { coveredFraction: number; offCoverageM: number };
  className?: string;
}) {
  if (score.coveredFraction >= 0.999) return null;
  const pct = Math.round((1 - score.coveredFraction) * 100);
  const km = (score.offCoverageM / 1000).toFixed(1);
  return (
    <p
      className={`text-[11px] leading-relaxed text-[var(--color-faint)] ${className}`}
      title="Cells are measured only inside the AOI tiles. Outside them the nearest tile-edge value is used."
    >
      <span className="text-[var(--color-warn)] font-semibold">{pct}%</span> of this run
      (<span className="num">{km}</span> km) falls outside the measured tiles. Those
      samples still count toward the exposure index, but their temperature comes from
      the nearest tile edge rather than from a measured cell.
    </p>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="border border-dashed border-[var(--color-hairline)] px-3 py-6 text-center text-[11.5px] text-[var(--color-faint)] leading-relaxed">
      {children}
    </div>
  );
}

/*
 * Re-exported, not redefined.
 *
 * They now live in lib/format.ts because this module is 'use client' and a
 * server component (the methodology page) needs them. Keeping the names
 * available here means no consumer had to change its import.
 */
export { fmtMinutes, fmtUsd } from '@/lib/format';
