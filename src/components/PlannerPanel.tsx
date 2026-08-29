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
import type { DayPart } from '@/lib/config';
import type { StreetCollection } from '@/lib/basemaps';
import { buildStreetIndex, placeOrCoords, sitableCells } from '@/lib/street-names';
import type { Bootstrap } from './AppShell';
import Link from 'next/link';
import { DesignImport, FleetImport, RefreshPanel } from './PlannerTools';
import { Chip, DeltaRow, Empty, Metric, SectionLabel, fmtUsd } from './ui';
import ScenarioReport from './ScenarioReport';
import GroundPanel, { type GroundFile } from './GroundPanel';
import { solveForBudget, solveForTarget } from '@/lib/solve';

/** What the three confidence labels actually claim. Rendered in the chip title. */
const CONFIDENCE_MEANING: Record<string, string> = {
  measured: 'Measured: taken from a published measurement of this effect.',
  directional:
    'Directional: the direction and rough magnitude are supported by published work; the exact coefficient is ours.',
  illustrative:
    'Illustrative: our own working figure, held for demonstration only.',
};

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
  /** Which of the day's min / average / max the field on screen reads. */
  dayPart: DayPart;
  /** Tiles re-fetched live this session, so the report can say so. */
  liveTiles: number;
  /** Road centrelines, used to name a recommended site rather than number it. */
  streets: StreetCollection | null;
  /** Ground segmentation, or null until /api/ground resolves. */
  ground: GroundFile | null;
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
  dayPart,
  liveTiles,
  streets,
  ground,
  onShowDemand,
  onLiveGrid,
  onAdHocRoutes,
}: Props) {
  const [recommendCount, setRecommendCount] = useState(4);
  /* Scenario solver controls - see src/lib/solve.ts for the method. */
  const [solveMode, setSolveMode] = useState<'budget' | 'target'>('budget');
  const [budgetUsd, setBudgetUsd] = useState(500_000);
  const [targetPct, setTargetPct] = useState(25);
  const [showCompare, setShowCompare] = useState(false);
  const [showTools, setShowTools] = useState(false);
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
   * - one canopy corridor shifts it by roughly 0.003 °F - so on its own it
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

  /**
   * The street index, built once per region rather than per candidate.
   *
   * Also what decides siting eligibility below, so it is memoised on `streets`
   * alone - a scenario change must not rebuild 50,000 samples.
   */
  const streetIndex = useMemo(() => buildStreetIndex(streets), [streets]);

  /**
   * The pool a station may actually be placed in.
   *
   * Demand peaks on grade-separated highway, because the layer weights drivable
   * road length and courier-route density and both max out there. Before this
   * filter the top four Phoenix sites came back on the Maricopa and Papago
   * Freeways - which is a true statement about exposure and a useless one about
   * where to build, since nobody walks to a station on a freeway shoulder.
   *
   * Note this narrows CANDIDACY only. The demand layer the map paints is
   * untouched, because the exposure on those cells is real and hiding it would
   * be its own kind of dishonesty.
   */
  const sitableDemand = useMemo(
    () => (demandBase ? sitableCells(demandBase, streetIndex) : null),
    [demandBase, streetIndex],
  );

  /** How many candidate cells the motorway filter removed, for the UI note. */
  const excludedCells =
    demandBase && sitableDemand ? demandBase.length - sitableDemand.length : 0;

  const recommendations = useMemo(
    () => (sitableDemand ? recommendStations(sitableDemand, recommendCount) : []),
    [sitableDemand, recommendCount],
  );

  /*
   * A deeper candidate pool for the solvers.
   *
   * The ranked list above shows 3-6 sites because that is what a planner reads.
   * A solver working to a budget or a target needs somewhere to search, so it
   * gets a much longer list of viable, spaced sites - and the solver, not the
   * ranking, decides how many of them get bought.
   */
  /**
   * The same ranked sites, with a name a person can act on.
   *
   * "33.4264, -112.0295" is exportable and unusable in a meeting. The street
   * data is already in the browser for the temperature probe, so naming these
   * costs one pass over geometry we have and no request at all.
   */
  const namedRecommendations = useMemo(
    () =>
      recommendations.map((r) => ({
        ...r,
        place: placeOrCoords(r.lon, r.lat, streets),
      })),
    [recommendations, streets],
  );

  const solverCandidates = useMemo(
    () => (sitableDemand ? recommendStations(sitableDemand, 40) : []),
    [sitableDemand],
  );

  const solution = useMemo(() => {
    if (!demandBase || solverCandidates.length === 0) return null;
    return solveMode === 'budget'
      ? solveForBudget(solverCandidates, demandBase, budgetUsd)
      : solveForTarget(solverCandidates, demandBase, targetPct / 100);
  }, [demandBase, solverCandidates, solveMode, budgetUsd, targetPct]);

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
  /*
   * Denominators. "2,438 uncovered cells" and "17.2%" both floated free - a
   * reader had no way to tell either from good or bad. Every headline figure
   * now carries what it is a share OF.
   */
  const totalCells = demandScenario?.length ?? 0;
  const uncoveredShare = totalCells ? Math.round((uncovered / totalCells) * 100) : 0;
  const coveragePlain = plainShare(after.coverage);

  /**
   * How much the field actually varies across the focus area.
   *
   * The live forecast average spans about 0.3 °F across 26 mi² of Phoenix,
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
        <StepLabel n={1} title="Where the gap is" />
        <SectionLabel right={<Chip tone="relief">{openSites.length} open in focus</Chip>}>
          Work exposure
        </SectionLabel>

        <div className="grid grid-cols-2 gap-4 mb-3">
          {/*
            The SCENARIO figure, not the baseline.

            This read `before.coverage` regardless of what was placed, so the
            headline sat frozen at the base number while the before/after table
            further down reported the same metric moving. Two different values
            under one label is the kind of thing that makes a user distrust
            every other number on the page. The baseline is still shown - as
            the delta hint, which is where a changed number belongs.
          */}
          <Metric
            label="Relief coverage"
            value={(after.coverage * 100).toFixed(1)}
            unit="%"
            tone="relief"
            hint={
              interventions.length > 0
                ? `${coveragePlain} - up from ${(before.coverage * 100).toFixed(1)}% before this option. Within a ${MOVEMENT.walkToReliefM} m walk of a site OPEN at this reading.`
                : `${coveragePlain} of the focus area, within a ${MOVEMENT.walkToReliefM} m walk of a site that is OPEN at this reading`
            }
          />
          <Metric
            label="Uncovered hot cells"
            value={uncovered.toLocaleString()}
            tone="ember"
            hint={
              totalCells
                ? `of ${totalCells.toLocaleString()} cells (${uncoveredShare}%) - hot, heavily worked, and beyond the walk radius`
                : 'hot, heavily worked, and beyond the walk radius'
            }
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
              {fieldSpread.toFixed(2)} °F
            </span>{' '}
            spread across this whole focus area for this reading. Switch the reading
            (low / average / peak) on the status bar above, or change region, to see
            the field move - the day&apos;s range here is about 17 °F. Siting is
            driven by where work happens and where relief is missing, not by hot
            spots.
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
        <StepLabel n={2} title="What to build" />
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
            {namedRecommendations.map((r) => (
              <li
                key={r.id}
                className="flex items-start gap-2.5 px-2.5 py-2 bg-[var(--color-surface-2)] border border-[var(--color-hairline)]"
              >
                <span className="num text-[14px] text-[var(--color-ember)] leading-none pt-0.5">
                  {r.rank}
                </span>
                <span className="flex-1 min-w-0">
                  {/*
                    The street, not the coordinate. Nobody argues for a station
                    in decimal degrees; the numbers stay underneath for the GIS
                    export and for anyone checking the work.
                  */}
                  <span className="text-[11.5px] text-[var(--color-bone)] block leading-snug">
                    {r.place}
                  </span>
                  <span className="num text-[9.5px] text-[var(--color-faint)] block">
                    {r.lat.toFixed(4)}, {r.lon.toFixed(4)}
                  </span>
                  <span className="block text-[10.5px] text-[var(--color-faint)] leading-snug mt-1">
                    <span title="Composite index, 0-1, highest cell in this focus area = 1.">
                      exposure {r.demand.toFixed(2)}
                    </span>{' '}
                    &middot; {r.tempF.toFixed(1)} °F &middot;{' '}
                    <span
                      title={`Beyond the ${MOVEMENT.walkToReliefM} m walk radius, so this cell counts as uncovered.`}
                    >
                      {r.reliefDistanceM >= 1000
                        ? `${(r.reliefDistanceM / 1000).toFixed(1)} km`
                        : `${r.reliefDistanceM} m`}{' '}
                      to relief
                    </span>
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}

        {excludedCells > 0 ? (
          <p className="text-[10px] leading-relaxed text-[var(--color-faint)] mb-2.5">
            {excludedCells.toLocaleString()} cells sit closer to a freeway than to any
            other street and are excluded from siting - work exposure is real there, but
            nobody can walk to a station on a freeway shoulder. They still appear in the
            map layer.
          </p>
        ) : null}

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

      {/* ------------------------------------------------------------ solver */}
      <section className="p-4 border-b border-[var(--color-hairline)]">
        <SectionLabel right={<Chip tone="warn">greedy</Chip>}>Solve for a plan</SectionLabel>

        <div className="grid grid-cols-2 gap-1 mb-3">
          {(
            [
              ['budget', 'I have a budget'],
              ['target', 'I have a target'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setSolveMode(mode)}
              aria-pressed={solveMode === mode}
              className="btn py-1.5"
              style={{
                borderColor:
                  solveMode === mode ? 'var(--color-ember)' : 'var(--color-hairline)',
                color: solveMode === mode ? 'var(--color-ember)' : 'var(--color-muted)',
                background:
                  solveMode === mode ? 'var(--color-surface-3)' : 'var(--color-surface-2)',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {solveMode === 'budget' ? (
          <label className="block mb-3">
            <span className="label block mb-1.5">
              Budget{' '}
              <span className="num text-[var(--color-bone)] text-[11px]">
                {fmtUsd(budgetUsd)}
              </span>
            </span>
            <input
              type="range"
              min={50_000}
              max={3_000_000}
              step={50_000}
              value={budgetUsd}
              onChange={(e) => setBudgetUsd(Number(e.target.value))}
              className="w-full"
              aria-label="Capital budget in dollars"
            />
          </label>
        ) : (
          <label className="block mb-3">
            <span className="label block mb-1.5">
              Target coverage{' '}
              <span className="num text-[var(--color-bone)] text-[11px]">{targetPct}%</span>
            </span>
            <input
              type="range"
              min={5}
              max={60}
              step={1}
              value={targetPct}
              onChange={(e) => setTargetPct(Number(e.target.value))}
              className="w-full"
              aria-label="Target relief coverage percentage"
            />
          </label>
        )}

        {solution ? (
          <>
            <div className="grid grid-cols-3 gap-3 mb-3">
              <Metric label="Sites" value={solution.chosen.length} />
              <Metric
                label="Coverage"
                value={(solution.finalCoverage * 100).toFixed(1)}
                unit="%"
                tone="relief"
                hint={`from ${(solution.baseCoverage * 100).toFixed(1)}%`}
              />
              <Metric
                label="Capital"
                value={solution.totalUsd ? fmtUsd(solution.totalUsd) : '--'}
                hint={
                  solution.usdPerPoint
                    ? `${fmtUsd(solution.usdPerPoint)} per point`
                    : 'no coverage gained'
                }
              />
            </div>

            <p
              className="text-[10.5px] leading-relaxed mb-3 px-2.5 py-2 border"
              style={{
                borderColor: solution.exhausted
                  ? 'var(--color-warn)'
                  : 'var(--color-hairline-bright)',
                color: solution.exhausted
                  ? 'var(--color-warn)'
                  : 'var(--color-muted)',
                background: solution.exhausted
                  ? 'color-mix(in oklab, var(--color-warn) 8%, transparent)'
                  : 'var(--color-surface-2)',
              }}
            >
              {solution.note}
            </p>

            <button
              className="btn w-full"
              disabled={solution.chosen.length === 0}
              onClick={() => onChangeInterventions([...interventions, ...solution.chosen])}
            >
              Add {solution.chosen.length} to {variants[activeVariant].name}
            </button>
          </>
        ) : (
          <Empty>No candidate sites to solve over in this region.</Empty>
        )}

        <p className="text-[10.5px] leading-relaxed text-[var(--color-faint)] mt-3">
          Maximum coverage is NP-hard and placements overlap, so this picks
          greedily by new ground per dollar and says so rather than implying an
          optimum. Only access moves are placed — a canopy corridor cools
          a street but gives nobody somewhere to stop.
        </p>
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

        {/* Tool palette. Hover a confidence chip for the assumption in full. */}
        <p className="text-[10px] leading-relaxed text-[var(--color-faint)] mb-2">
          Hover a <span className="text-[var(--color-muted)]">confidence</span> chip for
          what that move is assumed to do. <em>Measured</em> comes from a published
          measurement; <em>directional</em> has the right direction and rough scale
          from published work but our coefficient; <em>illustrative</em> is our own
          working figure.
        </p>
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
                      {spec.deltaF === 0 ? 'coverage' : `${spec.deltaF} °F`}
                    </span>
                  </span>
                  {/*
                    The assumption used to print in full on every one of the six
                    buttons - four lines each, exactly where someone is trying
                    to click one thing. It is on the confidence chip now, and in
                    full on /methodology.
                  */}
                  <span className="flex items-center gap-2 mt-1.5">
                    <Chip
                      tone={spec.confidence === 'measured' ? 'relief' : 'warn'}
                      title={`${spec.assumption}

${CONFIDENCE_MEANING[spec.confidence]}`}
                    >
                      {spec.confidence}
                    </Chip>
                    <span className="num text-[9.5px] text-[var(--color-faint)]">
                      {fmtUsd(spec.unitCostUsd)}
                    </span>
                    <span className="text-[9.5px] text-[var(--color-faint)]">
                      {spec.geometry === 'point' ? 'click to place' : 'draw a corridor'}
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
        <StepLabel n={3} title="What it buys" />
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
          label="Mean route exposure (degree-min above 90 °F)"
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
            label="Mean temperature inside treated areas (°F)"
            before={treated.before}
            after={treated.after}
            betterWhen="lower"
            precision={2}
          />
        ) : null}
        <DeltaRow
          label="Mean temperature, whole focus area (°F)"
          before={before.meanTempF}
          after={after.meanTempF}
          betterWhen="lower"
          precision={1}
        />
        <DeltaRow
          label="Longest walk to relief, averaged over routes (m)"
          before={before.meanGapM}
          after={after.meanGapM}
          betterWhen="lower"
        />

        {/*
          Four rows reading "no change" looks like a broken tool. It is usually
          the honest answer, and saying so here - not only in the printed
          report - is the difference between a user trusting the table and
          quietly discarding it.
        */}
        {interventions.length > 0 ? (
          <p className="text-[10.5px] leading-relaxed text-[var(--color-faint)] mt-2.5">
            Rows that say <span className="text-[var(--color-muted)]">no change</span> are
            usually correct. A station changes relief <em>access</em>, not street
            temperature. A canopy or pavement corridor does the reverse, and shows up in
            the treated-area row rather than in a focus-wide average a few hundred metres
            of street cannot move.
          </p>
        ) : null}

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
            Print report
          </button>
        </div>
        <p className="text-[10.5px] leading-relaxed text-[var(--color-faint)] mt-2.5">
          Standard RFC 7946 GeoJSON in EPSG:4326 - importable into Autodesk Forma as site
          context, and into any GIS or AEC tool that reads GeoJSON. Corridors export as
          buffered polygons, stations as points, each carrying its assumed effect,
          confidence level and unit cost. Forma-compatible, not a certified Forma
          integration. The share link encodes the whole scenario in the URL fragment - no
          account, no server-side state. <strong>Print report</strong> produces a
          five-section assessment - provenance, the network as it stands, what this
          option proposes and changes, the priority sites, and the limits - not a
          screenshot of this tool.
        </p>
        {exportNote ? (
          <p className="text-[10.5px] text-[var(--color-relief)] mt-2 break-all">
            {exportNote}
          </p>
        ) : null}
      </section>

      {/*
        Ground truth sits after the three steps, not between them.

        It is a site INSPECTION - what does this corner actually look like -
        rather than part of the where/what/how-much sequence, and it used to
        interrupt that sequence between siting and scenario-building.
      */}
      <GroundPanel ground={ground} />

      {/* ------------------------------------------------------------- tools */}
      {/*
        Power tools, behind one door.

        Live tile refresh, design import and route import are each perfectly
        good, and each was a full-width section with equal billing to the three
        steps above - so the panel read as eleven things to do rather than
        three. They are tools you reach for deliberately, which is exactly what
        a disclosure is for.
      */}
      <section className="border-b border-[var(--color-hairline)] no-print">
        <button
          onClick={() => setShowTools((t) => !t)}
          aria-expanded={showTools}
          className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-[var(--color-surface-2)] transition-colors"
        >
          <span>
            <span className="label label-bright block">Tools</span>
            <span className="text-[10.5px] text-[var(--color-faint)] leading-snug">
              Fetch a tile live, import a design, bring your own routes
            </span>
          </span>
          <span className="num text-[15px] text-[var(--color-faint)]">
            {showTools ? '-' : '+'}
          </span>
        </button>

        {showTools ? (
          <div className="border-t border-[var(--color-hairline)]">
            <RefreshPanel
              regionId={regionId}
              tiles={boot.tiles}
              filterType={filterType}
              onGrid={onLiveGrid}
            />

            <DesignImport
              regionBbox={boot.region.bbox}
              onImport={(imported) =>
                onChangeInterventions([...interventions, ...imported])
              }
            />

            <FleetImport onRoutes={onAdHocRoutes} />
          </div>
        ) : null}
      </section>

      {/* ------------------------------------------------------- methodology */}
      {/*
        A link, not a disclosure.

        This was ~20 collapsed paragraphs at the bottom of the sidebar, under
        the file-import tools, in 10.5px grey - which is to say the product's
        entire honesty argument lived where nobody scrolls, and every printout
        inherited either all of it or none. It is /methodology now: reference
        material, deliberately visited, and reachable from the one place a
        reader is already asking "where do these numbers come from".
      */}
      <section className="p-4 no-print">
        <SectionLabel>Method and assumptions</SectionLabel>
        <p className="text-[10.5px] leading-relaxed text-[var(--color-faint)] mb-2.5">
          {ASSUMPTION_NOTES.headline} Every coefficient behind these figures, its
          confidence level, and the limits of each data source are set out in full.
        </p>
        <Link href="/methodology" className="btn w-full block text-center">
          Read the methodology
        </Link>
      </section>


      {/*
        The printed deliverable. Hidden on screen, and the only thing that
        reaches paper - see the @media print block in globals.css. Fed from the
        same computed values the panel displays, so the two cannot disagree.
      */}
      <ScenarioReport
        regionName={boot.region.name}
        optionName={variants[activeVariant].name}
        manifest={boot.manifest}
        validAt={validAt}
        filterType={filterType}
        dayPart={dayPart}
        liveTiles={liveTiles}
        tileCount={boot.tiles.length}
        areaMi2={boot.tiles.reduce((a, t) => a + t.areaMi2, 0)}
        reliefLabel={boot.relief.sourceLabel}
        routeProvider={boot.routes.provider}
        routeCount={baseScores.length}
        openSites={openSites.length}
        closedCount={closedCount}
        unknownHours={unknownHours}
        fieldMinF={baseField.stats().minF}
        fieldMaxF={baseField.stats().maxF}
        before={before}
        after={after}
        treatedBefore={treated.before}
        treatedAfter={treated.after}
        interventions={interventions}
        costUsd={cost.totalUsd}
        uncoveredCells={uncovered}
        recommendations={namedRecommendations}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The step marker.
 *
 * The panel was twelve peer sections in one scroll - demand, recommendations,
 * solver, ground truth, studio, performance, compare, export, refresh, two
 * imports, method - all at identical weight. A planner's actual question runs
 * in three: where is the gap, what do I build, what does it buy. Numbering
 * them turns a list into a sequence without hiding anything.
 */
function StepLabel({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span
        className="num text-[10px] w-[18px] h-[18px] grid place-items-center shrink-0"
        style={{ background: 'var(--color-ember)', color: 'var(--color-void)' }}
      >
        {n}
      </span>
      <span className="text-[12.5px] font-semibold text-[var(--color-bone)]">
        {title}
      </span>
    </div>
  );
}

/**
 * "about 1 in 6" for a share.
 *
 * A percentage is precise and, on its own, hard to feel. The fraction is the
 * sentence a person repeats afterwards, so it sits next to the number rather
 * than replacing it.
 */
function plainShare(fraction: number): string {
  if (fraction <= 0) return 'none of the focus area';
  if (fraction >= 0.995) return 'effectively all of it';
  const denom = Math.round(1 / fraction);
  if (denom <= 1) return 'nearly all of it';
  return `about 1 in ${denom} of the focus area`;
}

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
