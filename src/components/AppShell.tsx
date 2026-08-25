'use client';

/**
 * Application shell - state, data loading, region switching, and the
 * three-view switch.
 *
 * Architecture note worth stating plainly, because it is what makes the
 * latency NFR honest: all scoring, what-if and demand computation happens IN
 * THE BROWSER, against the cached snapshot fetched once per region. There is
 * no server round trip when a slider moves. The only endpoints touched at
 * interaction time are /api/route-plan (ad-hoc trips) and
 * /api/admin/refresh-tile (an explicit button press).
 *
 * Base PRD section 6.2 (FR5): one dataset, one scoring function, three lenses.
 * Planner is bound to filter_type 1 (historic) and Dispatcher/Worker to
 * filter_type 3 (forecast), per Addendum A2 - the switch below enforces that
 * rather than trusting each panel to remember.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { HeatField } from '@/lib/grid';
import { INTERVENTIONS } from '@/lib/assumptions';
import { applyInterventions, effectiveReliefSites } from '@/lib/whatif';
import { scoreRoute } from '@/lib/scoring';
import { buildDemandLayer } from '@/lib/recommend';
import { filterOpenAt, localDayIndex } from '@/lib/relief';
import { DAY_PARTS, addDays, type DayPart } from '@/lib/config';
import { decodeScenario, encodeScenario } from '@/lib/share';
import type { RoadDensity } from '@/lib/recommend';
import { ProvenanceBar } from './ui';
import PlannerPanel from './PlannerPanel';
import type { GroundFile } from './GroundPanel';
import Onboarding, { type HeadlineFacts } from './Onboarding';
import DispatcherPanel from './DispatcherPanel';
import WorkerPanel from './WorkerPanel';
import Legend from './Legend';
import type { MapLayers } from './MapCanvas';
import type { BasemapId, StreetCollection } from '@/lib/basemaps';
import type {
  HeatGrid,
  Intervention,
  InterventionKind,
  LonLat,
  ReliefSite,
  RouteFeature,
  Scenario,
  SnapshotManifest,
  Tile,
} from '@/lib/types';

const MapCanvas = dynamic(() => import('./MapCanvas'), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-[var(--color-void)]" />,
});

export type ViewKey = 'planner' | 'dispatcher' | 'worker';

export interface RegionSummary {
  id: string;
  name: string;
  subtitle: string;
  blurb: string;
  workforce: string;
  tileCount: number;
  areaMi2: number;
}

export interface Bootstrap {
  regions: RegionSummary[];
  region: {
    id: string;
    name: string;
    subtitle: string;
    blurb: string;
    workforce: string;
    center: [number, number];
    bbox: [number, number, number, number];
    snapshotDate: string;
  };
  granularityM: number;
  cellRiskBands: ReadonlyArray<{
    index: number;
    id: string;
    label: string;
    minF: number;
    color: string;
  }>;
  tiles: Array<Tile & { areaMi2: number }>;
  timeSlices: Array<{
    key: string;
    dayOffset: number;
    filterType: 1 | 3;
    label: string;
  }>;
  manifest: SnapshotManifest;
  relief: {
    source: string;
    sourceLabel: string;
    endpoint: string;
    attribution: string;
    fetchedAt: string;
    totalCount: number;
    focusCount: number;
    withKnownHours: number;
    sites: ReliefSite[];
  };
  routes: {
    provider: string;
    generatedAt: string;
    note: string;
    list: RouteFeature[];
    workerDemo: { primary: RouteFeature; alternative: RouteFeature | null };
  };
  hourly: HourlyFile | null;
  roadDensity: RoadDensity | null;
}

/** Real 24-hour profiles from /v1/env_params. See scripts/fetch-hourly.ts. */
export interface HourlyFile {
  date: string;
  filterType: number;
  fetchedAt: string;
  points: Array<{
    id: string;
    label: string;
    lat: number;
    lon: number;
    timestamps: string[];
    apparentTempF: number[];
    heatIndexF: number[];
    wetBulbF: number[];
    humidityPct: number[];
    airQualityIdx: number[];
  }>;
}

const VIEWS: Array<{ key: ViewKey; label: string; sub: string }> = [
  { key: 'planner', label: 'Planner', sub: 'Where to build' },
  { key: 'dispatcher', label: 'Dispatcher', sub: 'What to do today' },
  { key: 'worker', label: 'Worker', sub: 'This run, right now' },
];

const EMPTY_VARIANTS = (): Scenario[] => [
  { id: 'A', name: 'Option A', interventions: [] },
  { id: 'B', name: 'Option B', interventions: [] },
  { id: 'C', name: 'Option C', interventions: [] },
];

export default function AppShell() {
  const [regionId, setRegionId] = useState('phoenix');
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>('planner');

  const [fields, setFields] = useState<Record<string, HeatGrid[]>>({});
  const [liveGrids, setLiveGrids] = useState<Record<string, HeatGrid>>({});
  const [sliceKey, setSliceKey] = useState('d0');
  /**
   * Which of the API's per-cell min / average / max the whole app reads.
   *
   * This is the honest replacement for the hour slider the earlier build had.
   * FortyGuard exposes no hour parameter, but every cell carries a daily
   * min/average/max, and on the snapshot day that is a real ~14 degF swing.
   */
  const [dayPart, setDayPart] = useState<DayPart>('avg');
  const [contextGeoJson, setContextGeoJson] = useState<unknown | null>(null);

  /**
   * Street-level readout state.
   *
   * `basemap` is a view preference, not data. `streets` is fetched once per
   * region and kept, because the probe is the kind of thing a user does
   * repeatedly once they discover it, and re-downloading 800 KB per click
   * would make the second probe slower than the first.
   */
  const [basemap, setBasemap] = useState<BasemapId>('streets');
  const [streets, setStreets] = useState<StreetCollection | null>(null);
  const [ground, setGround] = useState<GroundFile | null>(null);

  const [variants, setVariants] = useState<Scenario[]>(EMPTY_VARIANTS);
  const [activeVariant, setActiveVariant] = useState(0);
  const [placing, setPlacing] = useState<InterventionKind | null>(null);
  const [corridorDraft, setCorridorDraft] = useState<LonLat[]>([]);

  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [compareRoute, setCompareRoute] = useState<{
    route: RouteFeature;
    label: string;
  } | null>(null);
  const [adHocRoutes, setAdHocRoutes] = useState<RouteFeature[]>([]);

  const [layers, setLayers] = useState<MapLayers>({
    heat: true,
    risk: false,
    demand: false,
    context: false,
    relief: true,
    routes: true,
    interventions: true,
  });

  /**
   * Narrow-screen handling.
   *
   * Below 900px the three-pane instrument becomes one column with an explicit
   * Map/Panel switch. A split view on a phone gives you two unusable halves;
   * every mapping app resolves this the same way, and FR18's "two-second
   * glance" screen is the panel, not the map.
   */
  const [isNarrow, setIsNarrow] = useState(false);
  const [mobileTab, setMobileTab] = useState<'map' | 'panel'>('panel');

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 899px)');
    const apply = () => setIsNarrow(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  const restored = useRef(false);

  /* ------------------------------------------------- restore a shared link */
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const hash = window.location.hash.replace(/^#/, '');
    const param = new URLSearchParams(hash).get('s');
    if (!param) return;
    const shared = decodeScenario(param);
    if (!shared) return;
    setRegionId(shared.regionId);
    if (['planner', 'dispatcher', 'worker'].includes(shared.view)) {
      setView(shared.view as ViewKey);
    }
    setVariants((prev) => {
      const next = prev.slice();
      next[0] = { ...next[0], interventions: shared.interventions };
      return next;
    });
  }, []);

  /* ------------------------------------------------------------ bootstrap */
  useEffect(() => {
    let cancelled = false;
    setBoot(null);
    setError(null);
    fetch(`/api/bootstrap?region=${encodeURIComponent(regionId)}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `bootstrap failed (${r.status})`);
        return json as Bootstrap;
      })
      .then((b) => {
        if (!cancelled) setBoot(b);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [regionId]);

  /**
   * Planner is historic, Dispatcher and Worker are forecast. Enforced here so
   * a panel cannot accidentally read the wrong field (Addendum A3).
   */
  const activeSlice = useMemo(() => {
    if (!boot) return null;
    // Planner is long-horizon and always reads the snapshot day. Dispatcher
    // and Worker choose. (Addendum A2 asked for historic here; the API returns
    // HTTP 500 for filter_type 1, so everything is forecast and the
    // provenance bar says so rather than mislabelling it.)
    if (view === 'planner') return boot.timeSlices[0];
    return boot.timeSlices.find((s) => s.key === sliceKey) ?? boot.timeSlices[0];
  }, [boot, view, sliceKey]);

  const validAt = useMemo(() => {
    if (!boot || !activeSlice) return null;
    const date = addDays(boot.region.snapshotDate, activeSlice.dayOffset);
    return (
      boot.manifest.grids.find(
        (g) => g.filterType === activeSlice.filterType && g.validAt.startsWith(date),
      )?.validAt ?? null
    );
  }, [boot, activeSlice]);

  const fieldKey =
    activeSlice && validAt
      ? `${regionId}|${activeSlice.filterType}|${validAt}|${dayPart}`
      : null;

  /* --------------------------------------------------------- field loading */
  useEffect(() => {
    if (!fieldKey || !activeSlice || !validAt || fields[fieldKey]) return;
    const params = new URLSearchParams({
      region: regionId,
      ft: String(activeSlice.filterType),
      validAt,
    });
    fetch(`/api/field?${params}`)
      .then(async (r) => {
        const json = await r.json();
        if (!r.ok) throw new Error(json.error ?? `field failed (${r.status})`);
        return json as { grids: HeatGrid[] };
      })
      .then((json) => setFields((prev) => ({ ...prev, [fieldKey]: json.grids })))
      .catch((e: Error) => setError(e.message));
  }, [fieldKey, activeSlice, validAt, fields, regionId, dayPart]);

  /* ------------------------------------------- park / water context, lazily */
  useEffect(() => {
    if (!layers.context) return;
    setContextGeoJson(null);
    fetch(`/api/context?region=${encodeURIComponent(regionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setContextGeoJson)
      .catch(() => undefined);
  }, [layers.context, regionId]);

  /* ------------------------------------------- street centrelines, lazily */
  /**
   * Loaded as soon as a region is chosen rather than on first click: the probe
   * has no affordance of its own - you discover it by clicking a street - so a
   * first click that silently did nothing while 800 KB downloaded would read as
   * a broken feature rather than a slow one.
   */
  useEffect(() => {
    let cancelled = false;
    setStreets(null);
    fetch(`/api/streets?region=${encodeURIComponent(regionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((fc) => {
        if (!cancelled) setStreets(fc as StreetCollection | null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [regionId]);

  /* -------------------------------------- ground segmentation, lazily */
  useEffect(() => {
    let cancelled = false;
    setGround(null);
    fetch(`/api/ground?region=${encodeURIComponent(regionId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((g) => {
        if (!cancelled) setGround(g as GroundFile | null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [regionId]);

  /**
   * Grids for the active field, with any live-refreshed tile substituted in.
   * A tile someone just re-fetched from the API should be what they see, even
   * on a read-only filesystem where it could not be written back to the cache.
   */
  const grids = useMemo(() => {
    if (!fieldKey) return null;
    const base = fields[fieldKey];
    if (!base) return null;
    return base.map(
      (g) =>
        liveGrids[`${g.regionId}|${g.tileId}|${g.filterType}|${g.validAt}`] ?? g,
    );
  }, [fieldKey, fields, liveGrids]);

  /* -------------------------------------------------------------- derived */
  const baseField = useMemo(
    () => (grids ? new HeatField(grids, dayPart) : null),
    [grids, dayPart],
  );

  const interventions = useMemo(
    () => variants[activeVariant]?.interventions ?? [],
    [variants, activeVariant],
  );

  const scenarioField = useMemo(
    () => (baseField ? applyInterventions(baseField, interventions) : null),
    [baseField, interventions],
  );

  /**
   * Scoring only needs sites near the focus area. Filtering here turns a
   * whole-county nearest-neighbour scan per route sample into a local one,
   * which is the difference between a scenario re-scoring in 30 ms and in
   * 300 ms. Coverage figures use the same filtered set, so the numbers stay
   * internally consistent.
   */
  const focusSites = useMemo(() => {
    if (!boot) return [];
    const b = boot.region.bbox;
    const margin = 0.02; // ~2 km
    return boot.relief.sites.filter(
      (s) =>
        s.lon >= b[0] - margin &&
        s.lon <= b[2] + margin &&
        s.lat >= b[1] - margin &&
        s.lat <= b[3] + margin,
    );
  }, [boot]);

  /**
   * Opening hours applied to the hour the field describes.
   *
   * This is a correctness fix, not a nicety: counting a site that shut at 3 PM
   * toward 4 PM coverage overstates the network exactly when heat is worst.
   */
  const dayIndex = useMemo(() => (validAt ? localDayIndex(validAt) : 1), [validAt]);

  /**
   * Opening hours need a clock time, and the API's day parts are not clock
   * times. These are the hours those parts correspond to in practice - the
   * daily minimum lands around dawn, the maximum mid-afternoon - and they are
   * used only to decide which relief sites are open, never presented as the
   * temperature's timestamp.
   */
  // 'avg' is 15:00 so it matches the hour stamped on validAt, which is what
  // scripts/verify-coverage.ts reads. If these drift, the verifier silently
  // checks a different number than the app shows.
  const hourForPart: Record<DayPart, number> = { low: 7, avg: 15, peak: 16 };

  const openState = useMemo(
    () => filterOpenAt(focusSites, dayIndex, hourForPart[dayPart]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [focusSites, dayIndex, dayPart],
  );

  const closedSiteIds = useMemo(
    () => new Set(openState.closed.map((s) => s.id)),
    [openState],
  );

  const scenarioSites = useMemo(
    () => effectiveReliefSites(openState.open, interventions),
    [openState, interventions],
  );

  const mapSites = useMemo(
    () => effectiveReliefSites(boot?.relief.sites ?? [], interventions),
    [boot, interventions],
  );

  const routes = useMemo(
    () => [...(boot?.routes.list ?? []), ...adHocRoutes],
    [boot, adHocRoutes],
  );

  const baseScores = useMemo(() => {
    if (!baseField) return [];
    return routes.map((r) => scoreRoute(r, baseField, openState.open));
  }, [routes, baseField, openState]);

  const scenarioScores = useMemo(() => {
    if (!scenarioField) return [];
    return routes.map((r) => scoreRoute(r, scenarioField, scenarioSites));
  }, [routes, scenarioField, scenarioSites]);

  /**
   * The single number the opening screen leads with.
   *
   * Derived from the same scores everything else uses rather than written into
   * the copy, so it cannot go stale when the data refreshes - and so it is true
   * of whichever region you happen to open. The worst route by uncovered
   * fraction is the honest headline: it is the finding, not an average that
   * hides it.
   */
  const headlineFacts = useMemo((): HeadlineFacts | null => {
    if (!boot || baseScores.length === 0) return null;
    const byId = new Map(routes.map((r) => [r.id, r] as const));
    let worst: { score: (typeof baseScores)[number]; share: number } | null = null;

    for (const s of baseScores) {
      const route = byId.get(s.routeId);
      if (!route || !route.distanceM) continue;
      const share = s.worstReliefGapM / route.distanceM;
      if (!worst || share > worst.share) worst = { score: s, share };
    }
    if (!worst) return null;

    const route = byId.get(worst.score.routeId)!;
    return {
      routeName: route.name,
      routeKm: route.distanceM / 1000,
      gapKm: worst.score.worstReliefGapM / 1000,
      uncoveredShare: Math.min(1, worst.share),
      regionName: boot.region.name.split(',')[0],
      reliefLabel: boot.relief.sourceLabel,
      sitesInFocus: boot.relief.focusCount,
    };
  }, [boot, baseScores, routes]);

  const demandBase = useMemo(() => {
    if (!baseField || view !== 'planner') return null;
    return buildDemandLayer(baseField, boot?.roadDensity ?? null, routes, openState.open);
  }, [baseField, boot, routes, openState, view]);

  const demandScenario = useMemo(() => {
    if (!scenarioField || view !== 'planner') return null;
    if (interventions.length === 0) return demandBase;
    return buildDemandLayer(
      scenarioField,
      boot?.roadDensity ?? null,
      routes,
      scenarioSites,
    );
  }, [scenarioField, boot, routes, scenarioSites, view, interventions.length, demandBase]);

  /**
   * What the MAP draws, which is not the same set the Dispatcher ranks.
   *
   * The Worker view's demo trip lives in `routes.workerDemo`, deliberately
   * separate from the fleet runs so it never lands in the dispatcher ranking
   * or in the route-density term of the demand layer. That separation means
   * the map has to be told about it explicitly.
   */
  const mapRoutes = useMemo(() => {
    if (view === 'worker') {
      const demo = boot?.routes.workerDemo;
      return [...(demo ? [demo.primary] : []), ...adHocRoutes];
    }
    return routes;
  }, [view, boot, adHocRoutes, routes]);

  const mapScores = useMemo(() => {
    if (!scenarioField) return [];
    return mapRoutes.map((r) => scoreRoute(r, scenarioField, scenarioSites));
  }, [mapRoutes, scenarioField, scenarioSites]);

  const selectedScore = useMemo(() => {
    if (!selectedRouteId) return null;
    return (
      mapScores.find((s) => s.routeId === selectedRouteId) ??
      scenarioScores.find((s) => s.routeId === selectedRouteId) ??
      null
    );
  }, [selectedRouteId, mapScores, scenarioScores]);

  /* ---------------------------------------------------- share-link syncing */
  useEffect(() => {
    if (!boot) return;
    const params = new URLSearchParams();
    params.set('s', encodeScenario(regionId, view, interventions));
    window.history.replaceState(null, '', `#${params.toString()}`);
  }, [boot, regionId, view, interventions]);

  /* -------------------------------------------------------------- actions */
  const addIntervention = useCallback(
    (iv: Intervention) => {
      setVariants((prev) => {
        const next = prev.slice();
        const target = next[activeVariant];
        next[activeVariant] = {
          ...target,
          interventions: [...target.interventions, iv],
        };
        return next;
      });
    },
    [activeVariant],
  );

  /**
   * Map clicks. A station is one click. A corridor is a click per vertex plus
   * an explicit finish, because a shade corridor follows a street and a street
   * is not a point.
   */
  const handlePlace = useCallback(
    (lon: number, lat: number) => {
      if (!placing) return;
      const spec = INTERVENTIONS[placing];

      if (INTERVENTIONS[placing].geometry === 'point') {
        const index = interventions.length + 1;
        addIntervention({
          id: `${placing}-${index}-${Math.round(lon * 1e5)}-${Math.round(lat * 1e5)}`,
          kind: placing,
          label: `${spec.short} ${index}`,
          lon,
          lat,
          radiusM: spec.radiusM,
          deltaF: spec.deltaF,
        });
        return;
      }

      setCorridorDraft((prev) => [...prev, [lon, lat]]);
    },
    [placing, interventions.length, addIntervention],
  );

  const finishCorridor = useCallback(() => {
    if (!placing || corridorDraft.length < 2) {
      setCorridorDraft([]);
      return;
    }
    const spec = INTERVENTIONS[placing];
    const index = interventions.length + 1;
    const mid = corridorDraft[Math.floor(corridorDraft.length / 2)];
    addIntervention({
      id: `${placing}-${index}-${Math.round(mid[0] * 1e5)}-${Math.round(mid[1] * 1e5)}`,
      kind: placing,
      label: `${spec.short} ${index}`,
      lon: mid[0],
      lat: mid[1],
      radiusM: spec.radiusM,
      deltaF: spec.deltaF,
      corridor: corridorDraft,
    });
    setCorridorDraft([]);
  }, [placing, corridorDraft, interventions.length, addIntervention]);

  const setInterventions = useCallback(
    (next: Intervention[]) => {
      setVariants((prev) => {
        const copy = prev.slice();
        copy[activeVariant] = { ...copy[activeVariant], interventions: next };
        return copy;
      });
    },
    [activeVariant],
  );

  const onLiveGrid = useCallback((grid: HeatGrid) => {
    setLiveGrids((prev) => ({
      ...prev,
      [`${grid.regionId}|${grid.tileId}|${grid.filterType}|${grid.validAt}`]: grid,
    }));
  }, []);

  const switchRegion = useCallback((id: string) => {
    setRegionId(id);
    setFields({});
    setLiveGrids({});
    setVariants(EMPTY_VARIANTS());
    setActiveVariant(0);
    setSelectedRouteId(null);
    setCompareRoute(null);
    setAdHocRoutes([]);
    setCorridorDraft([]);
    setPlacing(null);
    setContextGeoJson(null);
  }, []);

  /* Escape cancels a placement, which is what every drawing tool does. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPlacing(null);
      setCorridorDraft([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* --------------------------------------------------------------- render */
  if (error) {
    return (
      <main className="h-screen grid place-items-center p-8">
        <div className="panel max-w-lg p-7 rise">
          <div className="label mb-3" style={{ color: 'var(--color-bad)' }}>
            Snapshot unavailable
          </div>
          <p className="text-[13px] leading-relaxed text-[var(--color-muted)] mb-4">
            {error}
          </p>
          <p className="text-[11.5px] leading-relaxed text-[var(--color-faint)]">
            The app runs entirely from the committed cache. Build it with{' '}
            <span className="num text-[var(--color-bone)]">npm run data:all</span>.
          </p>
        </div>
      </main>
    );
  }

  if (!boot) {
    return (
      <main className="h-screen grid place-items-center">
        <div className="text-center">
          <div className="headline text-[26px] mb-2">
            CoolRoute<span className="text-[var(--color-ember)]">.</span>
          </div>
          <div className="label live-dot">Loading cached snapshot</div>
        </div>
      </main>
    );
  }

  const b = boot.region.bbox;
  const mapBounds: [[number, number], [number, number]] = [
    [b[1], b[0]],
    [b[3], b[2]],
  ];

  return (
    <main className="min-h-[100dvh] lg:h-screen flex flex-col">
      {/* ------------------------------------------------------------- top */}
      <Onboarding facts={headlineFacts} />

      <header className="flex items-stretch flex-wrap border-b border-[var(--color-hairline)] bg-[var(--color-surface)] shrink-0 no-print">
        <div className="px-4 py-2.5 border-r border-[var(--color-hairline)] flex items-center">
          <div>
            <div className="headline text-[15px] leading-none">
              CoolRoute<span className="text-[var(--color-ember)]">.</span>
            </div>
            <div className="label mt-1 text-[8.5px]">Network Planner</div>
          </div>
        </div>

        <nav className="flex" aria-label="Audience view">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              aria-current={view === v.key ? 'page' : undefined}
              className="px-4 py-2 text-left border-r border-[var(--color-hairline)] transition-colors"
              style={{
                background: view === v.key ? 'var(--color-surface-3)' : 'transparent',
                boxShadow: view === v.key ? 'inset 0 -2px 0 var(--color-ember)' : 'none',
              }}
            >
              <div
                className="text-[12.5px] font-semibold tracking-tight"
                style={{
                  color: view === v.key ? 'var(--color-bone)' : 'var(--color-muted)',
                }}
              >
                {v.label}
              </div>
              <div className="label text-[8.5px] mt-0.5">{v.sub}</div>
            </button>
          ))}
        </nav>

        <div className="flex-1 flex items-center justify-end gap-4 px-3 py-2 lg:py-0 min-w-[240px]">
          <label className="flex items-center gap-2">
            <span className="label">Region</span>
            <select
              value={regionId}
              onChange={(e) => switchRegion(e.target.value)}
              className="w-auto min-w-[190px]"
              aria-label="Focus region"
            >
              {boot.regions.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} - {r.subtitle}
                </option>
              ))}
            </select>
          </label>
          <div className="text-right hidden lg:block">
            <div className="label">Focus area</div>
            <div className="num text-[11px] text-[var(--color-muted)]">
              {boot.tiles.length} tiles &middot;{' '}
              {boot.tiles.reduce((a, t) => a + t.areaMi2, 0).toFixed(1)} mi2
            </div>
          </div>
        </div>
      </header>

      {activeSlice && validAt ? (
        <ProvenanceBar
          manifest={boot.manifest}
          filterType={activeSlice.filterType}
          validAt={validAt}
          reliefSource={boot.relief.sourceLabel}
          routeProvider={boot.routes.provider}
          openCount={openState.open.length}
          totalCount={focusSites.length}
          liveTiles={Object.keys(liveGrids).length}
          dayPart={DAY_PARTS.find((d) => d.key === dayPart)?.label ?? dayPart}
        />
      ) : null}

      {/* ------------------------------------------------------------ body */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0">
        <section
          className={`relative flex-1 min-w-0 map-pane h-[70dvh] lg:h-auto ${
            isNarrow && mobileTab !== 'map' ? 'hidden' : ''
          }`}
        >
          {grids ? (
            <MapCanvas
              grids={scenarioField?.grids ?? grids}
              sites={mapSites}
              closedSiteIds={closedSiteIds}
              dayIndex={dayIndex}
              routes={mapRoutes}
              demand={demandScenario}
              contextGeoJson={contextGeoJson}
              interventions={interventions}
              layers={layers}
              selectedRouteId={selectedRouteId}
              selectedScore={selectedScore}
              compareRoute={compareRoute}
              placing={placing}
              onPlace={handlePlace}
              onSelectRoute={setSelectedRouteId}
              focusBounds={mapBounds}
              fitKey={regionId}
              basemap={basemap}
              streets={streets}
              // The scenario field, so a probed street reflects any canopy or
              // pavement treatment currently applied rather than the baseline.
              probeField={scenarioField ?? baseField}
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center">
              <span className="label live-dot">Painting heat field</span>
            </div>
          )}

          <Legend
            layers={layers}
            onToggle={(k) => setLayers((p) => ({ ...p, [k]: !p[k] }))}
            showDemand={view === 'planner'}
            cellRiskBands={boot.cellRiskBands}
            basemap={basemap}
            onBasemapChange={setBasemap}
            streetsReady={streets !== null}
            placing={placing}
            corridorPoints={corridorDraft.length}
            onFinishCorridor={finishCorridor}
            onCancelPlacing={() => {
              setPlacing(null);
              setCorridorDraft([]);
            }}
          />
        </section>

        <aside
          className={`w-full lg:w-[404px] shrink-0 border-t lg:border-t-0 lg:border-l border-[var(--color-hairline)] bg-[var(--color-surface)] lg:overflow-y-auto scroll-thin ${
            isNarrow && mobileTab !== 'panel' ? 'hidden' : ''
          }`}
        >
          {view === 'planner' && baseField && scenarioField ? (
            <PlannerPanel
              boot={boot}
              regionId={regionId}
              baseField={baseField}
              scenarioField={scenarioField}
              openSites={openState.open}
              closedCount={openState.closed.length}
              unknownHours={openState.unknownHours}
              scenarioSites={scenarioSites}
              demandBase={demandBase}
              demandScenario={demandScenario}
              baseScores={baseScores}
              scenarioScores={scenarioScores}
              variants={variants}
              activeVariant={activeVariant}
              onSelectVariant={setActiveVariant}
              interventions={interventions}
              onChangeInterventions={setInterventions}
              placing={placing}
              onPlacing={(k) => {
                setPlacing(k);
                setCorridorDraft([]);
              }}
              validAt={validAt ?? ''}
              filterType={activeSlice?.filterType ?? 1}
              ground={ground}
              onShowDemand={() => setLayers((p) => ({ ...p, demand: true }))}
              onLiveGrid={onLiveGrid}
              onAdHocRoutes={setAdHocRoutes}
            />
          ) : null}

          {view === 'dispatcher' && baseField ? (
            <DispatcherPanel
              boot={boot}
              routes={routes}
              scores={scenarioScores}
              sliceKey={sliceKey}
              onSliceChange={setSliceKey}
              dayPart={dayPart}
              onDayPartChange={setDayPart}
              hasDayRange={baseField.hasDayRange}
              selectedRouteId={selectedRouteId}
              onSelectRoute={setSelectedRouteId}
            />
          ) : null}

          {view === 'worker' && baseField && scenarioField ? (
            <WorkerPanel
              boot={boot}
              regionId={regionId}
              field={scenarioField}
              sites={scenarioSites}
              sliceKey={sliceKey}
              onSliceChange={setSliceKey}
              dayPart={dayPart}
              onDayPartChange={setDayPart}
              hasDayRange={scenarioField.hasDayRange}
              onSelectRoute={setSelectedRouteId}
              onCompareRoute={setCompareRoute}
              onAdHocRoutes={setAdHocRoutes}
            />
          ) : null}
        </aside>
      </div>

      {/* Map / Panel switch - only exists on narrow screens. */}
      {isNarrow ? (
        <nav
          className="sticky bottom-0 z-[1200] flex border-t border-[var(--color-hairline)] bg-[var(--color-surface)] shrink-0 no-print"
          aria-label="Map or panel"
        >
          {(['panel', 'map'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setMobileTab(tab)}
              aria-pressed={mobileTab === tab}
              className="flex-1 py-3 text-[12px] font-semibold uppercase tracking-[0.12em]"
              style={{
                color: mobileTab === tab ? 'var(--color-ember)' : 'var(--color-muted)',
                background:
                  mobileTab === tab ? 'var(--color-surface-3)' : 'transparent',
                boxShadow:
                  mobileTab === tab ? 'inset 0 2px 0 var(--color-ember)' : 'none',
              }}
            >
              {tab === 'panel' ? 'Readout' : 'Map'}
            </button>
          ))}
        </nav>
      ) : null}
    </main>
  );
}
