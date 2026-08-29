'use client';

/**
 * Two Planner-sidebar tools that sit outside the scenario engine.
 *
 * `RefreshPanel` - the visible half of the FortyGuard integration. Pressing it
 * re-fetches one tile live and streams the submit/poll/complete lifecycle on
 * screen. See the long note in src/app/api/admin/refresh-tile/route.ts for why
 * this is not the "live calls on user interaction" the base PRD excludes.
 *
 * `FleetImport` - the honest 80% of "real-time fleet GPS", which the PRD also
 * excludes. Rather than tracking anybody, an operator uploads the routes they
 * already planned. It answers "does this work with MY fleet" without any
 * tracking infrastructure, and without the worker-surveillance framing a
 * live-location product would carry.
 */
import { useEffect, useRef, useState } from 'react';
import { measureRoute } from '@/lib/scoring';
import { importFormaGeoJson, type ImportedDesign } from '@/lib/forma-import';
import { Chip, SectionLabel } from './ui';
import type { HeatGrid, Intervention, LonLat, RouteFeature, Tile } from '@/lib/types';

/* ========================================================================== */
/* Live tile refresh                                                          */
/* ========================================================================== */

interface RefreshEvent {
  event: string;
  [key: string]: unknown;
}

export function RefreshPanel({
  regionId,
  tiles,
  filterType,
  onGrid,
}: {
  regionId: string;
  tiles: Array<Tile & { areaMi2: number }>;
  filterType: number;
  onGrid: (grid: HeatGrid) => void;
}) {
  const [tileId, setTileId] = useState(tiles[0]?.id ?? '');
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  /**
   * Elapsed seconds, and the reason this exists.
   *
   * A real heatmap submission takes 40-50 seconds end to end (measured: 45 s
   * against production). The lifecycle log below streams correctly - time to
   * first byte on Vercel is under a second - but it sits under the fold, so
   * from the button's point of view the interaction was three quarters of a
   * minute of a disabled control saying the same word. That reads as a dead
   * button, and it is why this was reported as broken when the endpoint was
   * in fact returning real data every time.
   */
  const [elapsed, setElapsed] = useState(0);
  /** Set when a refresh finishes, so success is visible without reading NDJSON. */
  const [done, setDone] = useState<{ points: number; seconds: number } | null>(null);

  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed((Date.now() - started) / 1000), 250);
    return () => clearInterval(id);
  }, [busy]);

  async function refresh() {
    setBusy(true);
    setFailed(false);
    setDone(null);
    setLog([]);
    const append = (line: string) => setLog((prev) => [...prev, line]);

    try {
      const res = await fetch('/api/admin/refresh-tile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ region: regionId, tileId, filterType }),
      });

      if (!res.ok || !res.body) {
        const json = (await res.json().catch(() => null)) as {
          error?: string;
          detail?: string;
        } | null;
        setFailed(true);
        append(json?.error ?? `Request failed (${res.status})`);
        if (json?.detail) append(json.detail);
        return;
      }

      // NDJSON: one JSON object per line, flushed as the lifecycle progresses.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as RefreshEvent;
          append(describe(ev));
          if (ev.event === 'complete' && ev.grid) {
            onGrid(ev.grid as HeatGrid);
            setDone({
              points: Number(ev.pointsReturned ?? 0),
              seconds: Number(ev.elapsedMs ?? 0) / 1000,
            });
          }
          if (ev.event === 'error') setFailed(true);
        }
      }
    } catch (err) {
      setFailed(true);
      append(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="p-4 border-b border-[var(--color-hairline)]">
      <SectionLabel>Live tile refresh</SectionLabel>

      <label className="block mb-2">
        <span className="label block mb-1">Tile</span>
        <select value={tileId} onChange={(e) => setTileId(e.target.value)}>
          {tiles.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label} ({t.areaMi2} mi²)
            </option>
          ))}
        </select>
      </label>

      <button onClick={refresh} disabled={busy || !tileId} className="btn w-full">
        {busy
          ? `Fetching from FortyGuard... ${elapsed.toFixed(0)}s`
          : 'Fetch this tile from the API now'}
      </button>

      {/* Says up front what the button costs in time, so 45 seconds of polling
          reads as the async contract working rather than as a hung control. */}
      {busy ? (
        <p className="text-[10.5px] leading-relaxed text-[var(--color-muted)] mt-2">
          A heatmap submission is asynchronous and normally takes 40-50 seconds:
          submit, then poll until the activity completes. The lifecycle streams
          below as it happens.
        </p>
      ) : null}

      {done ? (
        <p
          className="text-[10.5px] leading-relaxed mt-2 px-2.5 py-2 border"
          style={{
            color: 'var(--color-relief)',
            borderColor: 'var(--color-relief-dim)',
            background: 'color-mix(in oklab, var(--color-relief) 8%, transparent)',
          }}
        >
          Live refresh complete - {done.points.toLocaleString()} cells in{' '}
          {done.seconds.toFixed(1)}s. This tile now shows API data fetched just now,
          and the status bar at the top of the app counts it.
        </p>
      ) : null}

      {log.length > 0 ? (
        <div
          className="mt-3 max-h-[190px] overflow-y-auto scroll-thin border border-[var(--color-hairline)] bg-[var(--color-void)] p-2.5"
          role="log"
          aria-live="polite"
        >
          {log.map((line, i) => (
            <div
              key={i}
              className="num text-[10.5px] leading-relaxed whitespace-pre-wrap"
              style={{
                color:
                  failed && i === log.length - 1
                    ? 'var(--color-bad)'
                    : 'var(--color-muted)',
              }}
            >
              {line}
            </div>
          ))}
        </div>
      ) : null}

      <p className="text-[10.5px] leading-relaxed text-[var(--color-faint)] mt-2.5">
        One tile, one timestamp, one <span className="num">POST /v1/heatmap</span> plus
        polling - triggered by this button and nothing else. The rest of the app never
        calls the API; it reads the committed snapshot. Requires a server-side FortyGuard key. With more than one configured this
        button uses the LAST in the pool, so a long ingest cannot drain the quota a
        demo depends on.
      </p>
    </section>
  );
}

function describe(ev: RefreshEvent): string {
  switch (ev.event) {
    case 'start':
      return `> ${ev.tileId} - ${ev.areaMi2} mi² at ${ev.granularityM} m, filter_type ${ev.filterType}`;
    case 'submit':
      return `> ${ev.message}`;
    case 'submitted':
      return `  activity_id ${ev.activityId} (${ev.elapsedMs} ms)`;
    case 'poll':
      return `  poll ${ev.attempt} -> ${ev.state} (${ev.elapsedMs} ms)`;
    case 'complete':
      return (
        `  complete: ${ev.pointsReturned} points in ${ev.elapsedMs} ms` +
        (ev.creditsReported != null ? `, ${ev.creditsReported} credits` : '') +
        `\n  ${ev.persistNote}`
      );
    case 'error':
      return `  ERROR: ${ev.message}`;
    default:
      return `  ${JSON.stringify(ev)}`;
  }
}

/* ========================================================================== */
/* Fleet route import                                                         */
/* ========================================================================== */

export function FleetImport({
  onRoutes,
}: {
  onRoutes: (routes: RouteFeature[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState(false);

  async function handleFile(file: File) {
    setNote(null);
    setError(false);
    try {
      const text = await file.text();
      const routes = file.name.toLowerCase().endsWith('.csv')
        ? parseCsvRoutes(text)
        : parseGeoJsonRoutes(text);

      if (routes.length === 0) {
        throw new Error('No usable LineString routes found in that file.');
      }
      onRoutes(routes);
      setNote(
        `Imported ${routes.length} route${routes.length === 1 ? '' : 's'}. ` +
          'Scored against the cached field like every other run.',
      );
    } catch (err) {
      setError(true);
      setNote(err instanceof Error ? err.message : 'Could not read that file.');
    }
  }

  return (
    <section className="p-4 border-b border-[var(--color-hairline)]">
      <SectionLabel>Import your own routes</SectionLabel>

      <input
        ref={inputRef}
        type="file"
        accept=".geojson,.json,.csv"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
      <button onClick={() => inputRef.current?.click()} className="btn w-full">
        Choose a GeoJSON or CSV file
      </button>

      {note ? (
        <p
          className="text-[10.5px] leading-relaxed mt-2.5"
          style={{ color: error ? 'var(--color-bad)' : 'var(--color-relief)' }}
        >
          {note}
        </p>
      ) : null}

      <p className="text-[10.5px] leading-relaxed text-[var(--color-faint)] mt-2.5">
        GeoJSON LineStrings, or CSV with{' '}
        <span className="num">route_id,name,lon,lat</span> one row per point. Everything
        is parsed in your browser - no upload, and no location data leaves this machine.
        This is the deliberate alternative to live fleet GPS: an operator brings the
        routes they already planned, rather than the product following anyone around.
      </p>
    </section>
  );
}

/* ========================================================================== */
/* Design import - the return leg of the Forma round trip                     */
/* ========================================================================== */

/**
 * Bring a design back in and score it.
 *
 * The export sends our analysis out as site context; this takes a design and
 * asks the question only this tool can answer about it - what is the heat
 * exposure where you have put these things, and does it close a relief gap.
 *
 * It is a file reader, not an Autodesk integration. There is no account, no
 * SDK and no extension; you export GeoJSON from Forma (or any GIS) and drop it
 * here. The panel says exactly that, because "Forma integration" would imply
 * something this is not.
 */
export function DesignImport({
  regionBbox,
  onImport,
}: {
  regionBbox: [number, number, number, number];
  onImport: (interventions: Intervention[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<ImportedDesign | null>(null);
  const [error, setError] = useState(false);

  async function handleFile(file: File) {
    setError(false);
    try {
      const parsed = importFormaGeoJson(await file.text(), regionBbox);
      setResult(parsed);
      if (parsed.interventions.length === 0) {
        setError(true);
        return;
      }
      onImport(parsed.interventions);
    } catch (err) {
      setError(true);
      setResult({
        interventions: [],
        footprints: [],
        warnings: [],
        note: err instanceof Error ? err.message : 'Could not read that file.',
      });
    }
  }

  return (
    <section className="p-4 border-b border-[var(--color-hairline)]">
      <SectionLabel right={<Chip tone="relief">round trip</Chip>}>
        Import a design
      </SectionLabel>

      <input
        ref={inputRef}
        type="file"
        accept=".geojson,.json"
        className="sr-only"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = '';
        }}
      />
      <button onClick={() => inputRef.current?.click()} className="btn w-full">
        Choose a GeoJSON design file
      </button>

      {result ? (
        <>
          <p
            className="text-[10.5px] leading-relaxed mt-2.5"
            style={{ color: error ? 'var(--color-bad)' : 'var(--color-relief)' }}
          >
            {result.note}
          </p>
          {result.warnings.map((w) => (
            <p
              key={w}
              className="text-[10.5px] leading-relaxed mt-1.5"
              style={{ color: 'var(--color-warn)' }}
            >
              {w}
            </p>
          ))}
        </>
      ) : null}

      <p className="text-[10.5px] leading-relaxed text-[var(--color-faint)] mt-2.5">
        Export your proposal from Autodesk Forma — or any GIS — as GeoJSON in{' '}
        <span className="num">EPSG:4326</span>, and it becomes scenario elements here:
        scored against the heat field, costed, and folded into the before/after. Points
        become facilities, lines become corridors, polygons become footprints. A file
        this app exported round-trips exactly, because it carries its own{' '}
        <span className="num">coolroute:kind</span>.
      </p>
      <p className="text-[10.5px] leading-relaxed text-[var(--color-faint)] mt-2">
        Parsed entirely in your browser. This reads a file you exported — it is{' '}
        <strong>not</strong> a certified Forma integration, and there is no Autodesk
        account involved.
      </p>
    </section>
  );
}

function parseGeoJsonRoutes(text: string): RouteFeature[] {
  const json = JSON.parse(text) as {
    features?: Array<{
      properties?: Record<string, unknown>;
      geometry?: { type?: string; coordinates?: unknown };
    }>;
  };
  const out: RouteFeature[] = [];

  (json.features ?? []).forEach((f, i) => {
    const g = f.geometry;
    if (!g) return;

    // Accept both LineString and the first line of a MultiLineString: real
    // exports from fleet tools contain both, and rejecting one would be
    // pedantry rather than validation.
    let coords: LonLat[] | null = null;
    if (g.type === 'LineString' && Array.isArray(g.coordinates)) {
      coords = g.coordinates as LonLat[];
    } else if (g.type === 'MultiLineString' && Array.isArray(g.coordinates)) {
      coords = (g.coordinates as LonLat[][])[0] ?? null;
    }
    if (!coords || coords.length < 2) return;

    const props = f.properties ?? {};
    out.push(
      makeRoute(String(props.name ?? props.id ?? `Imported route ${i + 1}`), coords, i),
    );
  });

  return out;
}

function parseCsvRoutes(text: string): RouteFeature[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const idx = {
    route: header.findIndex((h) => h === 'route_id' || h === 'route' || h === 'id'),
    name: header.indexOf('name'),
    lon: header.findIndex((h) => h === 'lon' || h === 'lng' || h === 'longitude'),
    lat: header.findIndex((h) => h === 'lat' || h === 'latitude'),
  };
  if (idx.lon < 0 || idx.lat < 0) {
    throw new Error('CSV needs lon and lat columns.');
  }

  const grouped = new Map<string, { name: string; coords: LonLat[] }>();
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const lon = Number(cells[idx.lon]);
    const lat = Number(cells[idx.lat]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

    const key = idx.route >= 0 ? (cells[idx.route]?.trim() ?? 'route') : 'route';
    const name = idx.name >= 0 ? (cells[idx.name]?.trim() ?? key) : key;
    const entry = grouped.get(key) ?? { name, coords: [] };
    entry.coords.push([lon, lat]);
    grouped.set(key, entry);
  }

  return [...grouped.values()]
    .filter((g) => g.coords.length >= 2)
    .map((g, i) => makeRoute(g.name, g.coords, i));
}

function makeRoute(name: string, coords: LonLat[], i: number): RouteFeature {
  const distanceM = measureRoute(coords);
  return {
    id: `imported-${i}`,
    name,
    persona: 'Imported route',
    coords,
    distanceM,
    // No timing in the file, so duration comes from the same assumed courier
    // speed the scoring model uses. Stated, not silently invented.
    durationS: Math.round((distanceM / 18_000) * 3600),
    provider: 'offline',
    fetchedAt: new Date().toISOString(),
  };
}
