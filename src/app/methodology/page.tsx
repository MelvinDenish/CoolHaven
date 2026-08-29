/**
 * /methodology - the assumptions, out of the sidebar and onto their own page.
 *
 * This used to be a collapsed disclosure at the bottom of the Planner panel,
 * below the import tools, in 10.5px grey. Everything the product claims about
 * its own honesty was in the one place nobody scrolls to, and it also meant a
 * printout carried either all of it or none of it.
 *
 * It is a page now, for the reason a terms page is a page: reference material,
 * read deliberately and rarely, linked from everywhere and in the way nowhere.
 * Rendered on the server from the same modules the engine uses - assumptions.ts
 * for coefficients, the committed manifests for provenance - so it cannot drift
 * from what actually ran.
 */
import Link from 'next/link';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import {
  ASSUMPTION_NOTES,
  CANOPY_BANDS,
  COVERAGE_GAP_M,
  DEMAND_WEIGHTS,
  EXPOSURE_BANDS,
  INTERVENTIONS,
  INTERVENTION_KINDS,
  MAX_STACKED_COOLING_F,
  MOVEMENT,
  RECOMMENDATION_SPACING_M,
  THRESHOLDS,
} from '@/lib/assumptions';
import { CELL_RISK_BANDS, DAY_PARTS, GRANULARITY_M } from '@/lib/config';
import { REGIONS } from '@/lib/regions';
import { loadManifest, loadReliefSites, loadRoutes } from '@/lib/server/snapshot';
import { fmtUsd } from '@/lib/format';

export const metadata: Metadata = {
  title: 'Methodology and assumptions - CoolRoute',
  description:
    'Every coefficient, threshold and data source behind the CoolRoute Network Planner, with its confidence level.',
};

export const dynamic = 'force-dynamic';

/**
 * Per-region provenance, read from the committed snapshot rather than prose.
 *
 * `snapshotDate` is absent from manifests written before that field existed,
 * so the earliest grid date is the fallback - the same rule snapshotDateFor()
 * applies, kept identical here on purpose.
 */
function snapshotRows() {
  return REGIONS.map((r) => {
    try {
      const m = loadManifest(r.id);
      const sites = loadReliefSites(r.id);
      const routes = loadRoutes(r.id);
      const sources = [...new Set(m.grids.map((g) => g.source))];
      return {
        name: r.name,
        date: m.snapshotDate ?? m.grids[0]?.validAt.slice(0, 10) ?? '--',
        grids: m.grids.length,
        sources: sources.join(', ') || '--',
        live: m.liveApiUsed,
        sites: sites.focusCount,
        sitesTotal: sites.totalCount,
        routes: routes.routes.length,
      };
    } catch {
      /* A region configured for ingest but not yet built. Omitted, not faked. */
      return null;
    }
  }).filter((x): x is NonNullable<typeof x> => x !== null);
}

export default function MethodologyPage() {
  const rows = snapshotRows();

  return (
    <main className="min-h-[100dvh] overflow-y-auto">
      <header className="sticky top-0 z-10 flex items-center justify-between gap-4 px-5 py-3 border-b border-[var(--color-hairline)] bg-[var(--color-surface)] no-print">
        <div>
          <div className="headline text-[15px] leading-none">
            CoolRoute<span className="text-[var(--color-ember)]">.</span>
          </div>
          <div className="label mt-1 text-[8.5px]">Methodology and assumptions</div>
        </div>
        <Link href="/" className="btn">
          Back to the planner
        </Link>
      </header>

      <div className="mx-auto max-w-[760px] px-5 py-8 pb-20">
        <h1 className="headline text-[30px] leading-tight mb-3">
          What every number here is, and is not
        </h1>

        <p
          className="text-[13px] leading-relaxed mb-6 px-3 py-2.5 border"
          style={{
            color: 'var(--color-warn)',
            borderColor: 'var(--color-warn)',
            background: 'color-mix(in oklab, var(--color-warn) 8%, transparent)',
          }}
        >
          {ASSUMPTION_NOTES.headline}
        </p>

        <P>
          Every coefficient below is read live from{' '}
          <Mono>src/lib/assumptions.ts</Mono>, the same module the scoring engine
          multiplies by, and every provenance figure from the committed snapshot
          manifests. Nothing on this page is transcribed by hand, so it cannot drift
          from what actually ran.
        </P>

        {/* ------------------------------------------------------ provenance */}
        <Section title="1. Where the heat field comes from">
          <P>
            <B>FortyGuard</B> <Mono>POST /v1/heatmap</Mono> at {GRANULARITY_M} m
            granularity, one submission per tile per date, polled to completion via{' '}
            <Mono>GET /v1/status/&#123;activity_id&#125;</Mono>. Temperatures arrive in
            Celsius and are converted to Fahrenheit at the client boundary. Every
            committed grid carries the <Mono>activity_id</Mono> of the call that
            produced it.
          </P>

          <Table
            head={['Region', 'Snapshot date', 'Grids', 'Source', 'Relief sites', 'Routes']}
            rows={rows.map((r) => [
              r.name,
              r.date,
              String(r.grids),
              r.live ? r.sources : `${r.sources} (modelled)`,
              `${r.sites} in focus / ${r.sitesTotal} published`,
              String(r.routes),
            ])}
          />

          <Callout tone="warn" title="Two limits of the live API, stated plainly">
            <P>
              <B>There is no hour parameter.</B> <Mono>hour</Mono> and{' '}
              <Mono>start_time</Mono> are accepted and silently ignored; two
              submissions differing only by hour return byte-identical statistics. One
              polygon and one date yield exactly one field. So the app never claims a
              clock time - a field is <B>valid for a calendar date</B>, and the
              intra-day axis is the minimum, average and maximum that every returned
              cell carries.
            </P>
            <P>
              <B>
                Only <Mono>filter_type 3</Mono> (forecast) is served on this key.
              </B>{' '}
              Types 1, 2 and 4 pass validation and then return HTTP 500 for every date
              range tried. The historic / forecast separation is still enforced
              throughout the code, so it starts working the moment historic is served,
              but this snapshot is forecast throughout and the status bar says so.
            </P>
          </Callout>

          <P>
            <B>The three readings.</B>{' '}
            {DAY_PARTS.map((d) => `${d.label} (${d.blurb.toLowerCase()})`).join(', ')}.
            On the Phoenix snapshot day that is a real span of roughly 17 °F - about
            89.5, 97.6 and 106.2 °F - and it is the honest replacement for the hour
            slider an earlier build had, because those hours were never available from
            the API and would have had to be invented.
          </P>
        </Section>

        {/* -------------------------------------------------------- exposure */}
        <Section title="2. Exposure and risk">
          <P>{ASSUMPTION_NOTES.exposure}</P>

          <Table
            head={['Quantity', 'Value', 'What it means']}
            rows={[
              [
                'Comfort floor',
                `${THRESHOLDS.comfortF} °F`,
                'Below this, exposure does not accumulate at all.',
              ],
              [
                'Caution',
                `${THRESHOLDS.cautionF} °F`,
                'Sustained outdoor work above this is where heat-illness risk climbs.',
              ],
              [
                'Extreme',
                `${THRESHOLDS.extremeF} °F`,
                'The band the Dispatcher view counts minutes against.',
              ],
              [
                'Courier speed',
                `${MOVEMENT.courierKph} km/h`,
                'Effective speed including stops; converts distance into exposure time.',
              ],
              [
                'Sample spacing',
                `${MOVEMENT.sampleSpacingM} m`,
                'Distance between samples when scoring a route.',
              ],
            ]}
          />

          <P>
            Route bands are cut on degree-minutes above {THRESHOLDS.comfortF} °F:
            moderate at {EXPOSURE_BANDS.moderate}, high at {EXPOSURE_BANDS.high},
            extreme at {EXPOSURE_BANDS.extreme} - roughly 20, 40 and 60 minutes at 110
            °F. These are calibrated for a desert summer deliberately. Cut points
            tuned for a temperate city saturate here: every route returns
            &quot;extreme&quot;, which is arguably true and operationally useless,
            because a dispatcher told to pull all eight runs will pull none.
          </P>

          <P>
            A <B>cell</B> risk band is not a <B>route</B> risk band. A cell is
            classified by instantaneous temperature (
            {CELL_RISK_BANDS.map((b) => b.label).join('; ')}). A route integrates
            exposure over time along a path. Conflating them would be a category error
            - a merely warm cell crossed for an hour is worse than an extreme cell
            crossed in ten seconds.
          </P>
        </Section>

        {/* -------------------------------------------------------- coverage */}
        <Section title="3. Relief coverage and the demand layer">
          <P>{ASSUMPTION_NOTES.coverage}</P>

          <P>
            Coverage counts only sites{' '}
            <B>actually open at the reading being modelled</B>. This is a correctness
            rule, not a nicety: counting a site that shut at 3 PM toward 4 PM coverage
            overstates the network exactly when heat is worst. Sites that publish no
            hours are counted as available, and the status bar reports how many those
            are.
          </P>

          <P>{ASSUMPTION_NOTES.demand}</P>

          <Table
            head={['Term', 'Weight', 'Source']}
            rows={[
              [
                `Heat above ${THRESHOLDS.comfortF} °F`,
                DEMAND_WEIGHTS.heat.toFixed(2),
                'FortyGuard heat field, normalised across the focus area',
              ],
              [
                'Drivable road length',
                DEMAND_WEIGHTS.roadDensity.toFixed(2),
                'OpenStreetMap, precomputed per cell',
              ],
              [
                'Courier-route density',
                DEMAND_WEIGHTS.routeDensity.toFixed(2),
                'Routes generated on the real road network',
              ],
            ]}
          />

          <Callout tone="warn" title="Why the ranked sites no longer show a percentage">
            <P>
              Station siting ranks candidates by work exposure against a coverage{' '}
              <Mono>gap</Mono> that ramps from 0 at the {MOVEMENT.walkToReliefM} m walk
              radius to 1 at {COVERAGE_GAP_M} m. That is a{' '}
              {COVERAGE_GAP_M - MOVEMENT.walkToReliefM} m window, so effectively every
              candidate worth recommending pins at 1.0 and the list read &quot;gap
              100%&quot; on every row - a number that discriminated between nothing.
              The list now reports the <B>distance to the nearest open relief site</B>,
              which across the top six Phoenix candidates spans 778 m to 3.5 km. The
              ranking itself is unchanged; only the figure reported to you is.
            </P>
          </Callout>

          <P>
            <B>Freeway cells cannot be sited on.</B> Work exposure weights drivable
            road length and courier-route density, and both peak on grade-separated
            highway - so before this rule the top-ranked Phoenix sites came back on the
            Maricopa and Papago Freeways. A cell whose nearest centreline is tagged{' '}
            <Mono>motorway</Mono> or <Mono>motorway_link</Mono> is removed from the
            candidate pool. Arterials stay eligible: a station on a six-lane arterial is
            unpleasant but reachable on foot. The exclusion narrows candidacy only - the
            demand layer on the map still shows those cells, because the exposure there
            is real.
          </P>
          <P>
            Recommendations are greedy: take the highest work-exposure-times-gap cell,
            suppress everything within {RECOMMENDATION_SPACING_M} m, repeat. Greedy
            rather than clustered on purpose - a planner can follow it and check it by
            eye. Maximum coverage is NP-hard and placements overlap, so the budget
            solver picks by new ground per dollar and says so rather than implying an
            optimum.
          </P>
        </Section>

        {/* --------------------------------------------------- interventions */}
        <Section title="4. What each move is assumed to do">
          <P>
            {ASSUMPTION_NOTES.stacking} Total ambient reduction on any single cell is
            capped at {MAX_STACKED_COOLING_F} °F.
          </P>

          {INTERVENTION_KINDS.map((k) => {
            const spec = INTERVENTIONS[k];
            return (
              <div
                key={k}
                className="border border-[var(--color-hairline)] bg-[var(--color-surface-2)] p-3 mb-2"
              >
                <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block w-[10px] h-[10px]"
                      style={{ background: spec.color }}
                    />
                    <B>{spec.label}</B>
                  </span>
                  <span className="num text-[11px] text-[var(--color-muted)]">
                    {spec.deltaF === 0 ? 'coverage only' : `${spec.deltaF} °F`}{' '}
                    &middot; {spec.radiusM} m
                  </span>
                </div>

                <span
                  className="inline-block border px-2 py-[2px] text-[9.5px] font-semibold uppercase tracking-[0.12em] mb-2"
                  style={{
                    borderColor:
                      spec.confidence === 'measured'
                        ? 'var(--color-relief-dim)'
                        : 'var(--color-warn)',
                    color:
                      spec.confidence === 'measured'
                        ? 'var(--color-relief)'
                        : 'var(--color-warn)',
                  }}
                >
                  {spec.confidence}
                </span>

                <p className="text-[12px] leading-relaxed text-[var(--color-muted)] mb-1.5">
                  {spec.assumption}
                </p>
                <p className="text-[12px] leading-relaxed text-[var(--color-faint)] mb-1.5">
                  {spec.basis}
                </p>
                <p className="text-[11px] leading-relaxed text-[var(--color-faint)]">
                  Costed {fmtUsd(spec.unitCostUsd)} {spec.costUnit}.
                </p>
              </div>
            );
          })}

          <Callout tone="neutral" title="Confidence vocabulary">
            <P>
              <B>measured</B> - taken from a published measurement of this effect.{' '}
              <B>directional</B> - direction and rough magnitude are supported by
              published work; the exact coefficient is ours. <B>illustrative</B> - our
              own working figure, held for demonstration only.
            </P>
          </Callout>
        </Section>

        {/* ---------------------------------------------------------- ground */}
        <Section title="5. Ground truth, and what a photograph cannot tell you">
          <P>
            Street-level frames come from <Mono>/v1/streetview</Mono> and overhead land
            cover from <Mono>/v1/satellite</Mono>. The percentages are measurements:
            the share of the frame that is tree, sky, building and road, on the date
            the imagery was captured.
          </P>

          <P>
            <B>No temperature is derived from them.</B> A photograph contains no
            temperature. Turning a canopy percentage into a °F figure would need
            paired shaded and unshaded observations at the same hour, which this
            project does not have - so the canopy coefficient stays the labelled
            assumption it has always been. What segmentation adds is <B>headroom</B>:
            whether a site has room for more canopy at all.
          </P>

          <Table
            head={['Band', 'Tree cover', 'Planting headroom']}
            rows={CANOPY_BANDS.map((b, i) => [
              b.label,
              i === 0
                ? `< ${b.maxTreePct}%`
                : b.maxTreePct > 100
                  ? `>= ${CANOPY_BANDS[i - 1].maxTreePct}%`
                  : `${CANOPY_BANDS[i - 1].maxTreePct}-${b.maxTreePct}%`,
              b.headroom,
            ])}
          />

          <P>
            Two absences are reported differently, because they mean different things.
            A point with <B>no street reading at all</B> has no Street View panorama
            nearby - normal for airfield aprons, rail yards and private freight land. A
            point with a reading but <B>no stored frame</B> simply had its image
            dropped at build time; imagery is retained for the first two points per
            region, because one segmented frame is larger than every heat grid in a
            region combined.
          </P>

          <P>
            Interior frames are detected and refused a canopy verdict. Street View has
            indoor coverage in shopping centres, transit halls and casino floors, and
            an interior frame reports about 0% tree cover - which would read as
            &quot;effectively bare, room to plant&quot; for a hotel lobby.
          </P>
        </Section>

        {/* ---------------------------------------------------------- limits */}
        <Section title="6. Limits worth knowing before you cite this">
          <Ul
            items={[
              'The focus area is a handful of tiles, not a city. The API caps a request at roughly 50 mi², so every coverage figure describes the focus area only. A route leaving the tiles takes its temperature from the nearest tile edge, and the route readout states what share of it that was.',
              'Road and route density are a documented proxy for where outdoor work happens. They are not a measured count of workers, and no worker is tracked by this product at any point.',
              'Relief sites, hours and services are as published by the source network. A site listed as open may not be; the app can only be as current as the feed it reads.',
              'Unit costs are illustrative working figures for comparing options against each other. They are not procurement estimates.',
              'Cooling coefficients model the AMBIENT air-temperature term only. Shade and canopy reduce radiant temperature far more than air temperature, so the real comfort benefit to a person standing there is larger than the number this tool moves - and modelling that larger figure honestly would need data this project does not have.',
              'A "no change" row in the before/after table is usually true, not a failure. A station changes relief access, not street temperature; a canopy corridor changes temperature over its own extent, which barely moves a district-wide mean. The treated-area row is the one that answers what a placement did where it was actually put.',
            ]}
          />
          <P>{ASSUMPTION_NOTES.provenanceRule}</P>
        </Section>

        <div className="rule my-8" />

        <p className="text-[12px] leading-relaxed text-[var(--color-faint)]">
          Source of truth for every coefficient on this page:{' '}
          <Mono>src/lib/assumptions.ts</Mono>. Longer form, with citations:{' '}
          <Mono>docs/METHODOLOGY.md</Mono> in the repository.
        </p>

        <Link href="/" className="btn btn-primary mt-6 inline-block no-print">
          Back to the planner
        </Link>
      </div>
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/* Local primitives - this page has a document's needs, not a panel's.        */
/* -------------------------------------------------------------------------- */

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="headline text-[19px] mb-3 pb-2 border-b border-[var(--color-hairline)]">
        {title}
      </h2>
      {children}
    </section>
  );
}

function P({ children }: { children: ReactNode }) {
  return (
    <p className="text-[13px] leading-relaxed text-[var(--color-muted)] mb-3">
      {children}
    </p>
  );
}

function B({ children }: { children: ReactNode }) {
  return <strong className="text-[var(--color-bone)] font-semibold">{children}</strong>;
}

function Mono({ children }: { children: ReactNode }) {
  return <span className="num text-[var(--color-bone)]">{children}</span>;
}

function Ul({ items }: { items: string[] }) {
  return (
    <ul className="flex flex-col gap-2 mb-3">
      {items.map((t) => (
        <li
          key={t.slice(0, 40)}
          className="text-[13px] leading-relaxed text-[var(--color-muted)] pl-4 relative"
        >
          <span className="absolute left-0 text-[var(--color-ember)]">&middot;</span>
          {t}
        </li>
      ))}
    </ul>
  );
}

function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto mb-4">
      <table className="w-full text-[12px] border border-[var(--color-hairline)]">
        <thead>
          <tr className="bg-[var(--color-surface-2)]">
            {head.map((h) => (
              <th key={h} className="label text-left px-2.5 py-2 align-bottom">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.join('|')} className="border-t border-[var(--color-hairline)]">
              {r.map((c, i) => (
                <td
                  key={i}
                  className={`px-2.5 py-2 align-top ${
                    i === 0 ? 'text-[var(--color-bone)]' : 'text-[var(--color-muted)]'
                  }`}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Callout({
  tone,
  title,
  children,
}: {
  tone: 'warn' | 'neutral';
  title: string;
  children: ReactNode;
}) {
  const color = tone === 'warn' ? 'var(--color-warn)' : 'var(--color-hairline-bright)';
  return (
    <div
      className="border px-3 py-2.5 mb-4"
      style={{
        borderColor: color,
        background:
          tone === 'warn'
            ? 'color-mix(in oklab, var(--color-warn) 7%, transparent)'
            : 'var(--color-surface-2)',
      }}
    >
      <div
        className="text-[12px] font-semibold mb-1.5"
        style={{ color: tone === 'warn' ? 'var(--color-warn)' : 'var(--color-bone)' }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
