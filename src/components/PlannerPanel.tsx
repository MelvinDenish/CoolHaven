'use client';

/**
 * Planner view: demand layer, station siting, and the scenario studio.
 *
 * The scenario studio is the Forma-inspired half of Addition 1. What it
 * borrows from early-stage AEC tools specifically:
 *
 *   - Options, not edits. Three variants (A/B/C) live side by side and are
 *     compared on the same metrics, because the planner's question is "which
 *     of these" rather than "is this better than nothing".
 *   - Performance readout, not a verdict. Every metric shows base and scenario
 *     as a pair with the delta between them, and the direction that counts as
 *     improvement is declared per metric.
 *   - The assumption travels with the tool. Each placement tool renders its
 *     own coefficient and confidence level inline (base PRD FR9).
 *   - It exports, and it shares.
 */
import { useMemo, useState } from 'react';
import {
  ASSUMPTION_NOTES,
  INTERVENTIONS,
  INTERVENTION_KINDS,
  MOVEMENT,
} from '@/lib/assumptions';
import {
  applyInterventions,
  coverageShare,
  effectiveReliefSites,
  scenarioCost,
  treatedAreaMeanF,
} from '@/lib/whatif';
import { recommendStations } from '@/lib/recommend';
import { encodeScenario } from '@/lib/share';
import type { HeatField } from '@/lib/grid';
import type {
  DemandCell,
  HeatGrid,
  Intervention,
  InterventionKind,
  ReliefSite,
  RouteFeature,
  RouteScore,
  Scenario,
} from '@/lib/types';
import type { Bootstrap } from './AppShell';
import { FleetImport, RefreshPanel } from './PlannerTools';
import { Chip, DeltaRow, Empty, Metric, SectionLabel, fmtUsd } from './ui';

interface Props {
  boot: Bootstrap;
  regionId: string;
  baseField: HeatField;
  scenarioField: HeatField;
  /** Relief sites open at the hour being modelled - already filtered. */
  openSites: ReliefSite[];
  closedCount: number;
  unknownHours: number;
  scenarioSites: ReliefSite[];
  demandBase: DemandCell[] | null;
  demandScenario: DemandCell[] | null;
  baseScores: RouteScore[];
  scenarioScores: RouteScore[];
  variants: Scenario[];
  activeVariant: number;
  onSelectVariant: (i: number) => void;
  interventions: Intervention[];
  onChangeInterventions: (next: Intervention[]) => void;
  placing: InterventionKind | null;
  onPlacing: (k: InterventionKind | null) => void;
  validAt: string;
  filterType: number;
  onShowDemand: () => void;
  onLiveGrid: (grid: HeatGrid) => void;
  onAdHocRoutes: (routes: RouteFeature[]) => void;
}

export default function PlannerPanel({
  boot,
  regionId,
  baseField,
  scenarioField,
  openSites,
  closedCount,
  unknownHours,
  scenarioSites,
  demandBase,
  demandScenario,
  baseScores,
  scenarioScores,
  variants,
  activeVariant,
  onSelectVariant,
  interventions,
  onChangeInterventions,
  placing,
  onPlacing,
  validAt,
  filterType,
  onShowDemand,
  onLiveGrid,
  onAdHocRoutes,
}: Props) {
  const [recommendCount, setRecommendCount] = useState(4);
  const [showMethod, setShowMethod] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);

  /* -------------------------------------------------------- headline stats */
  const before = useMemo(
    () => summarise(baseField, openSites, baseScores),
    [baseField, openSites, baseScores],
  );
  const after = useMemo(
    () => summarise(scenarioField, scenarioSites, scenarioScores),
    [scenarioField, scenarioSites, scenarioScores],
  );

  const cost = useMemo(() => scenarioCost(interventions), [interventions]);

  /**
   * Treated-area temperature, reported alongside the district mean.
   *
   * A district-wide average barely moves for a handful of local interventions
   * - one canopy corridor shifts it by roughly 0.003 degF - so on its own it
   * reads as "the tool does nothing". Showing both keeps the honest district
   * figure while answering the question the planner actually asked: what did
   * this do where I put it?
   */
  const treated = useMemo(
    () => ({
      before: treatedAreaMeanF(baseField, interventions),
      after: treatedAreaMeanF(scenarioField, interventions),
    }),
    [baseField, scenarioField, interventions],
  );

  const recommendations = useMemo(
    () => (demandBase ? recommendStations(demandBase, recommendCount) : []),
    [demandBase, recommendCount],
  );

  /**
   * Cross-option comparison - the "comparable options" half of the brief.
   *
   * Scored lazily behind a toggle: every option means a fresh field and a
   * fresh coverage sweep, and paying for all three on every interaction would
   * blow the budget for a panel most sessions open once.
   */
  const comparison = useMemo(() => {
    if (!showCompare) return null;
    return variants.map((v) => {
      const field = applyInterventions(baseField, v.interventions);
      const sites = effectiveReliefSites(openSites, v.interventions);
      const c = scenarioCost(v.interventions);
      const coverage = coverageShare(field, sites);
      const gain = (coverage - before.coverage) * 100;
      return {
        id: v.id,
        count: v.interventions.length,
        usd: c.totalUsd,
        gain,
        costPerPoint: gain > 0 ? c.totalUsd / gain : null,
      };
    });
  }, [showCompare, variants, baseField, openSites, before.coverage]);

  const variantSummaries = useMemo(
    () =>
      variants.map((v) => ({
        id: v.id,
        count: v.interventions.length,
        usd: scenarioCost(v.interventions).totalUsd,
      })),
    [variants],
  );

  const uncovered = demandScenario
    ? demandScenario.filter((c) => c.gap > 0.5 && c.demand > 0.35).length
    : 0;

  const activeSliceHour = Number(validAt.slice(11, 13)) || 15;

  /**
   * How much the field actually varies across the focus area.
   *
   * The live forecast average spans about 0.3 degF across 26 mi2 of Phoenix,
   * which paints as one flat colour. That is the data, not a rendering fault -
   * but a viewer's first reaction to a uniform map is "this is broken", so the
   * panel says which it is rather than leaving them to guess.
   */
  const fieldSpread = useMemo(() => {
    const st = baseField.stats();
    return st.maxF - st.minF;
  }, [baseField]);

  async function doExport(format: 'geojson' | 'csv') {
    setExporting(true);
    setExportNote(null);
    try {
      const res = await fetch(`/api/export/forma?format=${format}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scenarioName: `${variants[activeVariant].name} - ${boot.region.name}`,
          interventions,
          context: {
            heatDataSource: boot.manifest.liveApiUsed
              ? 'FortyGuard /v1/heatmap (cached)'
              : 'coolroute-uhi-v1 modelled stand-in',
            heatValidAt: validAt,
            filterType,
            before: {
              exposureIndex: before.meanExposure,
              coverageShare: before.coverage,
              meanTempF: before.meanTempF,
            },
            after: {
              exposureIndex: after.meanExposure,
              coverageShare: after.coverage,
              meanTempF: after.meanTempF,
            },
          },
        }),
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? `export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `coolroute-${regionId}-${variants[activeVariant].id.toLowerCase()}.${
        format === 'csv' ? 'csv' : 'geojson'
      }`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportNote(
        format === 'geojson'
          ? 'GeoJSON downloaded. Import into Forma as site context, or into any GIS.'
          : 'CSV downloaded.',
      );
    } catch (e) {
      setExportNote(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  }

  async function copyLink() {
    const encoded = encodeScenario(regionId, 'planner', interventions);
    const url = `${window.location.origin}${window.location.pathname}#s=${encoded}`;
    try {
      await navigator.clipboard.writeText(url);
      setExportNote(`Link copied (${url.length} characters).`);
    } catch {
      setExportNote(url);
    }
  }

  return (
    <div className="rise">
      {/* -------------------------------------------------- where the gap is */}
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel right={<Chip tone="relief">{openSites.length} open in focus</Chip>}>
          Exposure demand
        </SectionLabel>

        <div className="grid grid-cols-2 gap-4 mb-3">
          <Metric
            label="Relief coverage"
            value={(before.coverage * 100).toFixed(1)}
            unit="%"
            tone="relief"
            hint={`of the focus area within a ${MOVEMENT.walkToReliefM} m walk of a site that is OPEN at this hour`}
          />
          <Metric
            label="Uncovered hot cells"
            value={uncovered}
            tone="ember"
            hint="hot, heavily worked, and beyond the walk radius"
          />
        </div>

        {closedCount > 0 ? (
          <p
            className="text-[10.5px] leading-relaxed mb-3 px-2.5 py-2 border"
            style={{
              color: 'var(--color-warn)',
              borderColor: 'var(--color-warn)',
              background: 'color-mix(in oklab, var(--color-warn) 8%, transparent)',
            }}
          >
            {closedCount} site{closedCount === 1 ? ' is' : 's are'} shut at this hour and
            excluded from coverage. A hydration station that closed at 3 PM does not help
            a crew at 4 PM.
            {unknownHours > 0
              ? ` ${unknownHours} more publish no hours and are counted as available.`
              : ''}
          </p>
        ) : null}

        {fieldSpread < 1 ? (
          <p className="text-[10.5px] leading-relaxed mb-3 px-2.5 py-2 border border-[var(--color-hairline-bright)] text-[var(--color-muted)]">
            The heat layer looks flat because it is: FortyGuard reports a{' '}
            <span className="num text-[var(--color-bone)]">
              {fieldSpread.toFixed(2)} degF
            </span>{' '}
            spread across this whole focus area for this reading. Switch the part of
            day, or the region, to see the field move. Siting here is driven by where
            work happens and where relief is missing, not by hot spots.
          </p>
        ) : null}

        <button onClick={onShowDemand} className="btn btn-ghost w-full">
          Show demand layer on map
        </button>

        <p className="text-[10.5px] leading-relaxed text-[var(--color-faint)] mt-3">
          {ASSUMPTION_NOTES.demand}
        </p>
      </section>

      {/* ------------------------------------------------------- recommender */}
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel
          right={
            <span className="flex items-center gap-1.5">
              {[3, 4, 6].map((n) => (
                <button
                  key={n}
                  onClick={() => setRecommendCount(n)}
                  aria-pressed={recommendCount === n}
                  className="num text-[10.5px] px-1.5 border transition-colors"
                  style={{
                    borderColor:
                      recommendCount === n
                        ? 'var(--color-ember)'
                        : 'var(--color-hairline)',
                    color:
                      recommendCount === n ? 'var(--color-ember)' : 'var(--color-faint)',
                  }}
                >
                  {n}
                </button>
              ))}
            </span>
          }
        >
          Recommended new stations
        </SectionLabel>

        {recommendations.length === 0 ? (
          <Empty>No candidate cells clear the demand and coverage-gap floor.</Empty>
        ) : (
          <ol className="flex flex-col gap-1.5 mb-3">
            {recommendations.map((r) => (
              <li
                key={r.id}
                className="flex items-start gap-2.5 px-2.5 py-2 bg-[var(--color-surface-2)] border border-[var(--color-hairline)]"
              >
                <span className="num text-[14px] text-[var(--color-ember)] leading-none pt-0.5">
                  {r.rank}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="num text-[10.5px] text-[var(--color-muted)] block">
                    {r.lat.toFixed(4)}, {r.lon.toFixed(4)}
                  </span>
                  <span className="block text-[10.5px] text-[var(--color-faint)] leading-snug mt-0.5">
                    demand {r.demand.toFixed(2)} &middot; {r.tempF.toFixed(1)} degF
                    &middot; gap {(r.gap * 100).toFixed(0)}%
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}

        <button
          className="btn w-full"
          disabled={recommendations.length === 0}
          onClick={() =>
            onChangeInterventions([
              ...interventions,
              ...recommendations
                .filter((r) => !interventions.some((i) => i.id === r.id))
                .map((r) => ({
                  id: r.id,
                  kind: r.kind,
                  label: r.label,
                  lon: r.lon,
                  lat: r.lat,
                  radiusM: r.radiusM,
                  deltaF: r.deltaF,
                  recommended: true,
                  note: r.note,
                })),
            ])
          }
        >
          Add all to {variants[activeVariant].name}
        </button>
      </section>

      {/* --------------------------------------------------- scenario studio */}
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel>Scenario studio</SectionLabel>

        <div className="grid grid-cols-3 gap-1 mb-3">
          {variantSummaries.map((v, i) => (
            <button
              key={v.id}
              onClick={() => onSelectVariant(i)}
              aria-pressed={activeVariant === i}
              className="px-2 py-2 border text-left transition-colors"
              style={{
                borderColor:
                  activeVariant === i ? 'var(--color-ember)' : 'var(--color-hairline)',
                background:
                  activeVariant === i
                    ? 'color-mix(in oklab, var(--color-ember) 10%, var(--color-surface-2))'
                    : 'var(--color-surface-2)',
              }}
            >
              <div
                className="text-[12px] font-semibold"
                style={{
                  color: activeVariant === i ? 'var(--color-bone)' : 'var(--color-muted)',
                }}
              >
                Option {v.id}
              </div>
              <div className="num text-[9.5px] text-[var(--color-faint)] mt-0.5">
                {v.count} moves
              </div>
              <div className="num text-[9.5px] text-[var(--color-faint)]">
                {v.usd ? fmtUsd(v.usd) : '--'}
              </div>
            </button>
          ))}
        </div>

        {/* Tool palette, each with its assumption inline (FR9) */}
        <div className="flex flex-col gap-1.5 mb-3">
          {INTERVENTION_KINDS.map((kind) => {
            const spec = INTERVENTIONS[kind];
            const active = placing === kind;
            return (
              <button
                key={kind}
                className="tool"
                data-active={active}
                aria-pressed={active}
                onClick={() => onPlacing(active ? null : kind)}
              >
                <span
                  className="w-[10px] h-[10px] mt-[3px] shrink-0"
                  style={{ background: spec.color }}
                />
                <span className="flex-1 min-w-0">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] font-semibold text-[var(--color-bone)]">
                      {spec.label}
                    </span>
                    <span className="num text-[10.5px] text-[var(--color-muted)]">
                      {spec.deltaF === 0 ? 'coverage' : `${spec.deltaF} degF`}
                    </span>
                  </span>
                  <span className="block text-[10px] leading-relaxed text-[var(--color-faint)] mt-1">
                    {spec.assumption}
                  </span>
                  <span className="flex items-center gap-2 mt-1.5">
                    <Chip tone={spec.confidence === 'measured' ? 'relief' : 'warn'}>
                      {spec.confidence}
                    </Chip>
                    <span className="num text-[9.5px] text-[var(--color-faint)]">
                      {fmtUsd(spec.unitCostUsd)}
                    </span>
                    <span className="text-[9.5px] text-[var(--color-faint)]">
                      {kind === 'cooling_station' ? 'click to place' : 'draw a corridor'}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {interventions.length === 0 ? (
          <Empty>
            Pick a tool above, then click the map.
            <br />
            Nothing is applied until you place something.
          </Empty>
        ) : (
          <div className="flex flex-col gap-1">
            {interventions.map((iv) => {
              const spec = INTERVENTIONS[iv.kind];
              return (
                <div
                  key={iv.id}
                  className="flex items-center gap-2 px-2.5 py-1.5 bg-[var(--color-surface-2)] border border-[var(--color-hairline)]"
                >
                  <span
                    className="w-[7px] h-[7px] shrink-0"
                    style={{ background: spec.color }}
                  />
                  <span className="flex-1 min-w-0 truncate text-[11px]">
                    {iv.label}
                    {iv.corridor ? (
                      <span className="text-[var(--color-faint)]">
                        {' '}
                        ({iv.corridor.length}-pt corridor)
                      </span>
                    ) : null}
                    {iv.recommended ? (
                      <span className="text-[var(--color-ember)]"> *</span>
                    ) : null}
                  </span>
                  <button
                    onClick={() =>
                      onChangeInterventions(interventions.filter((x) => x.id !== iv.id))
                    }
                    className="label hover:text-[var(--color-bad)] px-1"
                    aria-label={`Remove ${iv.label}`}
                  >
                    x
                  </button>
                </div>
              );
            })}
            <button
              onClick={() => onChangeInterventions([])}
              className="btn btn-ghost mt-1.5"
            >
              Clear option {variants[activeVariant].id}
            </button>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------ before/after */}
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel
          right={
            interventions.length ? (
              <Chip tone="ember">{interventions.length} moves</Chip>
            ) : undefined
          }
        >
          Performance: base vs {variants[activeVariant].name}
        </SectionLabel>

        <DeltaRow
          label="Mean route exposure (degree-min above 90 degF)"
          before={before.meanExposure}
          after={after.meanExposure}
          betterWhen="lower"
        />
        <DeltaRow
          label="Relief coverage of focus area (%)"
          before={before.coverage * 100}
          after={after.coverage * 100}
          unit="pts"
          betterWhen="higher"
          precision={1}
        />
        <DeltaRow
          label="Routes at high or extreme risk"
          before={before.highRoutes}
          after={after.highRoutes}
          betterWhen="lower"
        />
        {treated.before !== null && treated.after !== null ? (
          <DeltaRow
            label="Mean temperature inside treated areas (degF)"
            before={treated.before}
            after={treated.after}
            betterWhen="lower"
            precision={2}
          />
        ) : null}
        <DeltaRow
          label="Mean temperature, whole focus area (degF)"
          before={before.meanTempF}
          after={after.meanTempF}
          betterWhen="lower"
          precision={1}
        />
        <DeltaRow
          label="Worst relief gap, averaged over routes (m)"
          before={before.meanGapM}
          after={after.meanGapM}
          betterWhen="lower"
        />

        {interventions.length > 0 ? (
          <div className="grid grid-cols-2 gap-4 mt-4 pt-3 border-t border-[var(--color-hairline)]">
            <Metric
              label="Capital cost"
              value={fmtUsd(cost.totalUsd)}
              size="sm"
              hint="illustrative unit costs from assumptions.ts"
            />
            <Metric
              label="Cost per coverage point"
              value={
                after.coverage > before.coverage
                  ? fmtUsd(
                      Math.round(
                        cost.totalUsd / ((after.coverage - before.coverage) * 100),
                      ),
                    )
                  : 'n/a'
              }
              size="sm"
              tone={after.coverage > before.coverage ? 'relief' : 'default'}
              hint="the number a council actually argues about"
            />
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------------ compare A / B / C */}
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel
          right={
            <button
              onClick={() => setShowCompare((s) => !s)}
              aria-expanded={showCompare}
              className="label hover:text-[var(--color-bone)]"
              style={{ color: showCompare ? 'var(--color-ember)' : undefined }}
            >
              {showCompare ? 'hide' : 'compare all three'}
            </button>
          }
        >
          Options side by side
        </SectionLabel>

        {!showCompare ? (
          <p className="text-[10.5px] leading-relaxed text-[var(--color-faint)]">
            Scores every option against the same baseline. Computed on demand, because
            three full coverage sweeps is real work and most sessions never need it.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left">
                  <th className="label pb-2">Option</th>
                  <th className="label pb-2 text-right">Moves</th>
                  <th className="label pb-2 text-right">Cover +</th>
                  <th className="label pb-2 text-right">Cost</th>
                  <th className="label pb-2 text-right">$/pt</th>
                </tr>
              </thead>
              <tbody className="num">
                {comparison?.map((c, i) => {
                  const bestId = comparison
                    .filter((x) => x.costPerPoint !== null)
                    .sort((a, b) => a.costPerPoint! - b.costPerPoint!)[0]?.id;
                  return (
                    <tr
                      key={c.id}
                      className="border-t border-[var(--color-hairline)]"
                      style={{
                        background:
                          activeVariant === i ? 'var(--color-surface-2)' : undefined,
                      }}
                    >
                      <td className="py-2">
                        <button
                          onClick={() => onSelectVariant(i)}
                          className="hover:text-[var(--color-ember)]"
                        >
                          {c.id}
                          {bestId === c.id ? (
                            <span className="text-[var(--color-relief)]"> best</span>
                          ) : null}
                        </button>
                      </td>
                      <td className="py-2 text-right">{c.count}</td>
                      <td
                        className="py-2 text-right"
                        style={{
                          color: c.gain > 0 ? 'var(--color-good)' : 'var(--color-faint)',
                        }}
                      >
                        {c.gain > 0 ? '+' : ''}
                        {c.gain.toFixed(1)}
                      </td>
                      <td className="py-2 text-right">{c.usd ? fmtUsd(c.usd) : '--'}</td>
                      <td className="py-2 text-right">
                        {c.costPerPoint !== null
                          ? fmtUsd(Math.round(c.costPerPoint))
                          : '--'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-[10px] leading-relaxed text-[var(--color-faint)] mt-2">
              &quot;Cover +&quot; is percentage points of focus area brought within a{' '}
              {MOVEMENT.walkToReliefM} m walk of an OPEN relief site. &quot;$/pt&quot; is
              capital cost per point gained - the comparison a budget meeting runs on.
            </p>
          </div>
        )}
      </section>

      {/* ------------------------------------------------------------ export */}
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel>Export and share</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            className="btn btn-primary"
            disabled={interventions.length === 0 || exporting}
            onClick={() => doExport('geojson')}
          >
            GeoJSON
          </button>
          <button
            className="btn"
            disabled={interventions.length === 0 || exporting}
            onClick={() => doExport('csv')}
          >
            CSV list
          </button>
          <button className="btn" onClick={copyLink}>
            Copy link
          </button>
          <button className="btn" onClick={() => window.print()}>
            Print / PDF
          </button>
        </div>
        <p className="text-[10.5px] leading-relaxed text-[var(--color-faint)] mt-2.5">
          Standard RFC 7946 GeoJSON in EPSG:4326 - importable into Autodesk Forma as site
          context, and into any GIS or AEC tool that reads GeoJSON. Corridors export as
          buffered polygons, stations as points, each carrying its assumed effect,
          confidence level and unit cost. Forma-compatible, not a certified Forma
          integration. The share link encodes the whole scenario in the URL fragment - no
          account, no server-side state.
        </p>
        {exportNote ? (
          <p className="text-[10.5px] text-[var(--color-relief)] mt-2 break-all">
            {exportNote}
          </p>
        ) : null}
      </section>

      {/* ------------------------------------------------------------- tools */}
      <RefreshPanel
        regionId={regionId}
        tiles={boot.tiles}
        filterType={filterType}
        hourLocal={activeSliceHour}
        onGrid={onLiveGrid}
      />

      <FleetImport onRoutes={onAdHocRoutes} />

      {/* ------------------------------------------------------- methodology */}
      <section className="p-4">
        <button
          onClick={() => setShowMethod((s) => !s)}
          aria-expanded={showMethod}
          className="label label-bright hover:text-[var(--color-bone)]"
        >
          {showMethod ? '- ' : '+ '}Methodology and assumptions
        </button>
        {showMethod ? (
          <div className="mt-3 flex flex-col gap-2.5 text-[10.5px] leading-relaxed text-[var(--color-faint)]">
            <p style={{ color: 'var(--color-warn)' }}>{ASSUMPTION_NOTES.headline}</p>
            <p>{ASSUMPTION_NOTES.exposure}</p>
            <p>{ASSUMPTION_NOTES.coverage}</p>
            <p>{ASSUMPTION_NOTES.stacking}</p>
            <p>{ASSUMPTION_NOTES.provenanceRule}</p>
            <div className="rule my-1" />
            {INTERVENTION_KINDS.map((k) => (
              <p key={k}>
                <span className="text-[var(--color-muted)]">{INTERVENTIONS[k].label}:</span>{' '}
                {INTERVENTIONS[k].basis}
              </p>
            ))}
            <div className="rule my-1" />
            <p>
              <span className="text-[var(--color-muted)]">Region:</span>{' '}
              {boot.region.blurb} Workforce: {boot.region.workforce.toLowerCase()}.
            </p>
            <p>
              <span className="text-[var(--color-muted)]">Relief network:</span>{' '}
              {boot.relief.attribution} Fetched{' '}
              {new Date(boot.relief.fetchedAt).toLocaleDateString()}.{' '}
              {boot.relief.totalCount} sites published, {boot.relief.focusCount} inside
              the focus tiles, {boot.relief.withKnownHours} with usable opening hours.
            </p>
            <p>
              <span className="text-[var(--color-muted)]">Routes:</span> {boot.routes.note}
            </p>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function summarise(field: HeatField, sites: ReliefSite[], scores: RouteScore[]) {
  const meanExposure = scores.length
    ? Math.round(scores.reduce((a, s) => a + s.exposureIndex, 0) / scores.length)
    : 0;
  const highRoutes = scores.filter(
    (s) => s.band === 'high' || s.band === 'extreme',
  ).length;
  const meanGapM = scores.length
    ? Math.round(scores.reduce((a, s) => a + s.worstReliefGapM, 0) / scores.length)
    : 0;

  return {
    meanExposure,
    highRoutes,
    meanGapM,
    meanTempF: Math.round(field.stats().meanF * 10) / 10,
    coverage: coverageShare(field, sites),
  };
}
