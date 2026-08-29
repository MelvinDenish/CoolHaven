'use client';

/**
 * The printed deliverable. Screen-hidden, print-only.
 *
 * Print used to be `window.print()` against a fifteen-line stylesheet that hid
 * the header and widened the sidebar. Everything else went to paper: a
 * half-rendered Leaflet canvas, the legend overlay on top of it, the tool
 * palette, file-picker buttons, budget sliders, the import panels. Six pages of
 * an application, in which the actual findings were scattered between controls
 * that do nothing on paper.
 *
 * A report is a different document from an instrument, so it is a different
 * component rather than a filtered view of the same one. What a planner takes
 * into a budget meeting is: what was measured, when and from where; what the
 * network looks like now; what this option changes; what it costs; and what the
 * reader is not entitled to conclude from it. That is this file, in that order,
 * and nothing else.
 *
 * Every number arrives as a prop already computed by the panel, so the report
 * cannot disagree with the screen it was printed from.
 */
import type { ReactNode } from 'react';
import {
  ASSUMPTION_NOTES,
  INTERVENTIONS,
  MOVEMENT,
  THRESHOLDS,
} from '@/lib/assumptions';
import { DAY_PARTS, type DayPart } from '@/lib/config';
import { formatValidDay, fmtUsd } from './ui';
import type { Recommendation } from '@/lib/recommend';
import type { Intervention, InterventionKind, SnapshotManifest } from '@/lib/types';

export interface ReportSummary {
  meanExposure: number;
  highRoutes: number;
  meanGapM: number;
  meanTempF: number;
  coverage: number;
}

export default function ScenarioReport({
  regionName,
  optionName,
  manifest,
  validAt,
  filterType,
  dayPart,
  liveTiles,
  tileCount,
  areaMi2,
  reliefLabel,
  routeProvider,
  routeCount,
  openSites,
  closedCount,
  unknownHours,
  fieldMinF,
  fieldMaxF,
  before,
  after,
  treatedBefore,
  treatedAfter,
  interventions,
  costUsd,
  uncoveredCells,
  recommendations,
}: {
  regionName: string;
  optionName: string;
  manifest: SnapshotManifest;
  validAt: string;
  filterType: number;
  dayPart: DayPart;
  liveTiles: number;
  tileCount: number;
  areaMi2: number;
  reliefLabel: string;
  routeProvider: string;
  routeCount: number;
  openSites: number;
  closedCount: number;
  unknownHours: number;
  fieldMinF: number;
  fieldMaxF: number;
  before: ReportSummary;
  after: ReportSummary;
  treatedBefore: number | null;
  treatedAfter: number | null;
  interventions: Intervention[];
  costUsd: number;
  uncoveredCells: number;
  recommendations: Array<Recommendation & { place?: string | null }>;
}) {
  const partLabel = DAY_PARTS.find((d) => d.key === dayPart)?.label ?? dayPart;
  const coverageGain = (after.coverage - before.coverage) * 100;
  const costPerPoint = coverageGain > 0 ? costUsd / coverageGain : null;
  const printedAt = new Date().toLocaleString('en-US', {
    dateStyle: 'long',
    timeStyle: 'short',
  });

  /* "Moves" is the word the whole UI uses for placed things; the prop keeps
     the engine's type name. Defined once so the two cannot drift. */
  const moveCount = interventions.length;

  /* Grouped by kind: a list of forty individual stations is not a finding. */
  const byKind = interventions.reduce<Partial<Record<InterventionKind, number>>>(
    (acc, iv) => {
      acc[iv.kind] = (acc[iv.kind] ?? 0) + 1;
      return acc;
    },
    {},
  );

  return (
    <div className="report">
      {/* ------------------------------------------------------ title block */}
      <header className="report-head">
        <div className="report-brand">
          CoolRoute<span>.</span> Network Planner
        </div>
        <h1>
          {regionName}
          <span className="report-sub"> &mdash; {optionName}</span>
        </h1>
        <p className="report-standfirst">
          Heat exposure and relief-access assessment for the outdoor mobile workforce.
          Field valid for {formatValidDay(validAt)}, read at the{' '}
          {partLabel.toLowerCase()}.
        </p>
        <dl className="report-meta">
          <Meta k="Focus area">
            {tileCount} tiles &middot; {areaMi2.toFixed(1)} mi&sup2;
          </Meta>
          <Meta k="Heat field">
            {manifest.liveApiUsed ? 'FortyGuard /v1/heatmap' : 'Modelled stand-in'}
            {liveTiles > 0 ? ` (+${liveTiles} refreshed live)` : ''} &middot; filter_type{' '}
            {filterType} {filterType === 1 ? '(historic)' : '(forecast)'}
          </Meta>
          <Meta k="Relief network">{reliefLabel}</Meta>
          <Meta k="Routing">
            {routeProvider === 'ors'
              ? 'OpenRouteService'
              : routeProvider === 'osrm'
                ? 'OSRM'
                : routeProvider}{' '}
            &middot; {routeCount} routes scored
          </Meta>
          <Meta k="Report generated">{printedAt}</Meta>
        </dl>
      </header>

      {/* ----------------------------------------------------- 1. the state */}
      <section className="report-section">
        <h2>1. The network as it stands</h2>

        <div className="report-figures">
          <Figure
            v={`${(before.coverage * 100).toFixed(1)}%`}
            k="Relief coverage"
            note={`of the focus area within a ${MOVEMENT.walkToReliefM} m walk of a site open at this reading`}
          />
          <Figure
            v={uncoveredCells.toLocaleString()}
            k="Uncovered hot cells"
            note="hot, heavily worked, and beyond the walk radius"
          />
          <Figure
            v={String(openSites)}
            k="Sites open at this reading"
            note={
              closedCount > 0
                ? `${closedCount} more are shut at this reading and excluded from coverage`
                : 'all sites in the focus area are open'
            }
          />
          <Figure
            v={`${before.meanGapM.toLocaleString()} m`}
            k="Longest walk to relief"
            note="averaged across scored routes - the longest stretch with nowhere to stop"
          />
        </div>

        <p className="report-body">
          Across the focus area the field runs {fieldMinF.toFixed(1)} to{' '}
          {fieldMaxF.toFixed(1)} °F at this reading, with a mean of{' '}
          {before.meanTempF.toFixed(1)} °F. Mean route exposure is{' '}
          {before.meanExposure.toLocaleString()} degree-minutes above{' '}
          {THRESHOLDS.comfortF} °F, and {before.highRoutes} of {routeCount} routes
          classify as high or extreme risk.
          {closedCount > 0
            ? ` Coverage counts only sites open at this reading: ${closedCount} site${
                closedCount === 1 ? ' is' : 's are'
              } shut and excluded, because a hydration station that closed at 3 PM does not help a crew at 4 PM.`
            : ''}
          {unknownHours > 0
            ? ` A further ${unknownHours} publish no opening hours and are counted as available.`
            : ''}
        </p>
      </section>

      {/* -------------------------------------------------- 2. the proposal */}
      <section className="report-section">
        <h2>2. What {optionName} proposes</h2>

        {moveCount === 0 ? (
          <p className="report-body report-empty">
            No moves are placed in this option. The figures above describe the
            existing network only, and there is nothing to compare against it.
          </p>
        ) : (
          <>
            <table className="report-table">
              <thead>
                <tr>
                  <th>Move</th>
                  <th className="r">Count</th>
                  <th className="r">Unit cost</th>
                  <th className="r">Subtotal</th>
                  <th>Assumed effect</th>
                  <th>Confidence</th>
                </tr>
              </thead>
              <tbody>
                {(Object.keys(byKind) as InterventionKind[]).map((kind) => {
                  const spec = INTERVENTIONS[kind];
                  const n = byKind[kind] ?? 0;
                  return (
                    <tr key={kind}>
                      <td>{spec.label}</td>
                      <td className="r">{n}</td>
                      <td className="r">{fmtUsd(spec.unitCostUsd)}</td>
                      <td className="r">{fmtUsd(spec.unitCostUsd * n)}</td>
                      <td>
                        {spec.deltaF === 0
                          ? `Relief access within ${spec.radiusM} m; no ambient cooling`
                          : `${spec.deltaF} °F at centre, to 0 at ${spec.radiusM} m`}
                      </td>
                      <td>{spec.confidence}</td>
                    </tr>
                  );
                })}
                <tr className="report-total">
                  <td>Total</td>
                  <td className="r">{moveCount}</td>
                  <td className="r" />
                  <td className="r">{fmtUsd(costUsd)}</td>
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>
            <p className="report-caption">
              Unit costs are illustrative working figures for comparing options against
              each other, not procurement estimates.
            </p>
          </>
        )}
      </section>

      {/* ---------------------------------------------------- 3. the effect */}
      {moveCount > 0 ? (
        <section className="report-section">
          <h2>3. What it changes</h2>

          <table className="report-table">
            <thead>
              <tr>
                <th>Measure</th>
                <th className="r">Base</th>
                <th className="r">{optionName}</th>
                <th className="r">Change</th>
              </tr>
            </thead>
            <tbody>
              <Row
                label="Relief coverage of focus area (%)"
                before={before.coverage * 100}
                after={after.coverage * 100}
                dp={1}
              />
              <Row
                label={`Mean route exposure (degree-min above ${THRESHOLDS.comfortF} °F)`}
                before={before.meanExposure}
                after={after.meanExposure}
                dp={0}
              />
              <Row
                label="Longest walk to relief, averaged over routes (m)"
                before={before.meanGapM}
                after={after.meanGapM}
                dp={0}
              />
              <Row
                label="Routes at high or extreme risk"
                before={before.highRoutes}
                after={after.highRoutes}
                dp={0}
              />
              {treatedBefore !== null && treatedAfter !== null ? (
                <Row
                  label="Mean temperature inside treated areas (°F)"
                  before={treatedBefore}
                  after={treatedAfter}
                  dp={2}
                />
              ) : null}
              <Row
                label="Mean temperature, whole focus area (°F)"
                before={before.meanTempF}
                after={after.meanTempF}
                dp={1}
              />
            </tbody>
          </table>

          <div className="report-figures report-figures-2">
            <Figure
              v={fmtUsd(costUsd)}
              k="Capital cost"
              note="illustrative unit costs"
            />
            <Figure
              v={costPerPoint !== null ? fmtUsd(Math.round(costPerPoint)) : 'n/a'}
              k="Cost per coverage point"
              note="the number a council actually argues about"
            />
          </div>

          <p className="report-body">
            <strong>Reading the &quot;no change&quot; rows.</strong> A station changes
            relief <em>access</em>, not street temperature, so it moves coverage and
            leaves the district mean alone. A canopy or pavement corridor does the
            reverse, and its effect appears in the treated-area row rather than in a
            focus-wide average that a few hundred metres of street cannot shift. Rows
            that do not move are usually telling the truth about what was placed.
          </p>
        </section>
      ) : null}

      {/* ------------------------------------------------ 4. where to build */}
      {recommendations.length > 0 ? (
        <section className="report-section">
          <h2>{moveCount > 0 ? '4' : '3'}. Highest-priority sites</h2>
          <table className="report-table">
            <thead>
              <tr>
                <th className="r">#</th>
                <th>Location</th>
                <th className="r">Exposure demand</th>
                <th className="r">Temperature</th>
                <th className="r">To nearest open relief</th>
              </tr>
            </thead>
            <tbody>
              {recommendations.map((r) => (
                <tr key={r.id}>
                  <td className="r">{r.rank}</td>
                  <td>
                    {r.place ? (
                      <>
                        {r.place}
                        <div className="report-coords">
                          {r.lat.toFixed(4)}, {r.lon.toFixed(4)}
                        </div>
                      </>
                    ) : (
                      <span className="mono">
                        {r.lat.toFixed(4)}, {r.lon.toFixed(4)}
                      </span>
                    )}
                  </td>
                  <td className="r">{r.demand.toFixed(2)}</td>
                  <td className="r">{r.tempF.toFixed(1)} °F</td>
                  <td className="r">
                    {r.reliefDistanceM >= 1000
                      ? `${(r.reliefDistanceM / 1000).toFixed(1)} km`
                      : `${r.reliefDistanceM} m`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="report-caption">
            Ranked by exposure demand against the coverage gap, each at least 700 m from
            the last. {ASSUMPTION_NOTES.demand}
          </p>
        </section>
      ) : null}

      {/* ---------------------------------------------------- 5. the caveat */}
      <section className="report-section report-caveat">
        <h2>What this report does not establish</h2>
        <p className="report-body">
          <strong>{ASSUMPTION_NOTES.headline}</strong> Cooling coefficients model the
          ambient air-temperature term only; shade and canopy reduce radiant temperature
          considerably more, so the comfort benefit to a person standing there is larger
          than any figure moved here. {ASSUMPTION_NOTES.coverage}{' '}
          {ASSUMPTION_NOTES.stacking}
        </p>
        <p className="report-body">
          The focus area is a set of tiles, not a city: the API caps a request at
          roughly 50 mi&sup2;, so every coverage figure above describes these{' '}
          {tileCount} tiles only. Road and route density are a documented proxy for
          where outdoor work happens, not a measured count of workers. Relief sites,
          hours and services are as published by {reliefLabel}.
        </p>
        <p className="report-body report-pointer">
          Full method, every coefficient with its confidence level, and the limits of
          each data source: <strong>/methodology</strong> in this application, or{' '}
          <strong>docs/METHODOLOGY.md</strong> in the repository.
        </p>
      </section>

      <footer className="report-foot">
        CoolRoute Network Planner &middot; {regionName} &middot; {optionName} &middot;
        field valid {formatValidDay(validAt)} ({partLabel.toLowerCase()}) &middot;
        generated {printedAt}
      </footer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Meta({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="report-meta-row">
      <dt>{k}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Figure({ v, k, note }: { v: string; k: string; note: string }) {
  return (
    <div className="report-figure">
      <div className="report-figure-v">{v}</div>
      <div className="report-figure-k">{k}</div>
      <div className="report-figure-n">{note}</div>
    </div>
  );
}

/**
 * One before/after row.
 *
 * Direction is not declared per metric here, unlike the on-screen DeltaRow,
 * because paper has no colour to carry it. The change column states the signed
 * difference and the label does the interpreting - which is what a printed
 * table has always done.
 */
function Row({
  label,
  before,
  after,
  dp,
}: {
  label: string;
  before: number;
  after: number;
  dp: number;
}) {
  const delta = after - before;
  const fmt = (n: number) =>
    n.toLocaleString(undefined, {
      minimumFractionDigits: dp,
      maximumFractionDigits: dp,
    });
  return (
    <tr>
      <td>{label}</td>
      <td className="r">{fmt(before)}</td>
      <td className="r">{fmt(after)}</td>
      <td className="r">
        {Math.abs(delta) < 10 ** -dp / 2 ? (
          <span className="report-nil">no change</span>
        ) : (
          `${delta > 0 ? '+' : ''}${fmt(delta)}`
        )}
      </td>
    </tr>
  );
}
