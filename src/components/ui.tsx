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
import type { ReactNode } from 'react';
import type { RiskBand, SnapshotManifest } from '@/lib/types';
import { BAND_META } from '@/lib/scoring';

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
  dayPart: string;
}) {
  const live = manifest.liveApiUsed || liveTiles > 0;
  const stamp = new Date(validAt).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Phoenix',
  });

  return (
    <div
      className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2 border-b"
      style={{
        borderColor: live ? 'var(--color-hairline)' : 'var(--color-warn)',
        background: live
          ? 'var(--color-surface)'
          : 'color-mix(in oklab, var(--color-warn) 11%, var(--color-surface))',
      }}
    >
      <span className="flex items-center gap-2">
        <span
          className="live-dot inline-block w-[7px] h-[7px]"
          style={{ background: live ? 'var(--color-good)' : 'var(--color-warn)' }}
        />
        <span
          className="label"
          style={{ color: live ? undefined : 'var(--color-warn)' }}
        >
          {manifest.liveApiUsed
            ? 'FortyGuard cached snapshot'
            : liveTiles > 0
              ? `Modelled snapshot + ${liveTiles} tile${liveTiles === 1 ? '' : 's'} refreshed live`
              : 'Modelled stand-in - not FortyGuard data'}
        </span>
      </span>

      <span className="label">
        filter_type{' '}
        <span className="num text-[var(--color-bone)] text-[11px]">{filterType}</span>
        <span className="ml-1 normal-case tracking-normal">
          {filterType === 1 ? '(historic)' : '(forecast)'}
        </span>
      </span>

      <span className="label">
        reading{' '}
        <span className="text-[var(--color-ember)] normal-case tracking-normal">
          {dayPart}
        </span>
      </span>

      <span className="label">
        valid{' '}
        <span className="num text-[var(--color-bone)] text-[11px]">{stamp} MST</span>
      </span>

      <span className="label">
        relief layer{' '}
        <span className="text-[var(--color-relief)] normal-case tracking-normal">
          {reliefSource}
        </span>
      </span>

      {/* Coverage that ignores opening hours overstates the network exactly
          when the heat is worst, so the split is stated on the status bar
          rather than buried in a methodology note. */}
      <span className="label">
        open now{' '}
        <span
          className="num text-[11px]"
          style={{
            color: openCount < totalCount ? 'var(--color-warn)' : 'var(--color-bone)',
          }}
        >
          {openCount}/{totalCount}
        </span>
        <span className="ml-1 normal-case tracking-normal">sites in focus</span>
      </span>

      <span className="label">
        routing{' '}
        <span className="text-[var(--color-bone)] normal-case tracking-normal">
          {routeProvider === 'ors'
            ? 'OpenRouteService'
            : routeProvider === 'osrm'
              ? 'OSRM'
              : routeProvider}
        </span>
      </span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="border border-dashed border-[var(--color-hairline)] px-3 py-6 text-center text-[11.5px] text-[var(--color-faint)] leading-relaxed">
      {children}
    </div>
  );
}

export function fmtMinutes(m: number): string {
  if (m < 1) return '<1';
  if (m < 60) return `${Math.round(m)}`;
  return `${Math.floor(m / 60)}h ${Math.round(m % 60)}`;
}

export function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${n}`;
}
