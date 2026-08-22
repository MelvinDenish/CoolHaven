'use client';

/**
 * The map.
 *
 * The one interesting decision in here is how the heat field is drawn. At
 * 100 m granularity a region is 6,000-9,000 cells per timestamp, and drawing
 * that many Leaflet rectangles makes panning unusable and re-rendering a
 * scenario take seconds. Instead each tile is painted to an offscreen canvas
 * exactly cols x rows pixels and stretched over its bbox as an image overlay.
 * The browser's own scaling does the smoothing for free, a scenario re-render
 * is a handful of small canvas writes, and the whole thing stays comfortably
 * inside the <3 s interaction budget (base PRD section 7).
 *
 * Note on orientation: HeatGrid row 0 is the SOUTH edge, canvas row 0 is the
 * TOP. Every write flips y. Getting this backwards produces a map that looks
 * plausible and is vertically mirrored, which is a genuinely hard bug to spot.
 */
import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { tempColor } from '@/lib/grid';
import { INTERVENTIONS, MOVEMENT, THRESHOLDS } from '@/lib/assumptions';
import { CELL_RISK_BANDS } from '@/lib/config';
import { hoursSummary } from '@/lib/relief';
import type {
  DemandCell,
  HeatGrid,
  Intervention,
  InterventionKind,
  ReliefSite,
  RouteFeature,
  RouteScore,
} from '@/lib/types';

export interface MapLayers {
  heat: boolean;
  risk: boolean;
  demand: boolean;
  context: boolean;
  relief: boolean;
  routes: boolean;
  interventions: boolean;
}

interface Props {
  grids: HeatGrid[];
  sites: ReliefSite[];
  /** Sites shut at the hour being modelled - drawn hollow, excluded from scoring. */
  closedSiteIds: Set<string>;
  /** Weekday index the hours are evaluated against, for popup text. */
  dayIndex: number;
  routes: RouteFeature[];
  demand: DemandCell[] | null;
  contextGeoJson: unknown | null;
  interventions: Intervention[];
  layers: MapLayers;
  selectedRouteId: string | null;
  selectedScore: RouteScore | null;
  /** Extra route drawn for comparison (the Worker view's alternative path). */
  compareRoute: { route: RouteFeature; label: string } | null;
  placing: InterventionKind | null;
  onPlace: (lon: number, lat: number) => void;
  onSelectRoute: (id: string) => void;
  focusBounds: [[number, number], [number, number]];
  /** Changes when the region changes, so the map refits instead of drifting. */
  fitKey: string;
}

export default function MapCanvas({
  grids,
  sites,
  closedSiteIds,
  dayIndex,
  routes,
  demand,
  contextGeoJson,
  interventions,
  layers,
  selectedRouteId,
  selectedScore,
  compareRoute,
  placing,
  onPlace,
  onSelectRoute,
  focusBounds,
  fitKey,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const groups = useRef<Record<string, L.LayerGroup>>({});
  // Callbacks live in a ref so the map is built exactly once; putting them in
  // the effect's dependency list tears down and rebuilds Leaflet on every
  // parent render, which loses the user's pan and zoom mid-interaction.
  const handlers = useRef({ onPlace, onSelectRoute });
  handlers.current = { onPlace, onSelectRoute };
  const boundsRef = useRef(focusBounds);
  boundsRef.current = focusBounds;

  /* ---------------------------------------------------------------- setup */
  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;

    const map = L.map(hostRef.current, {
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true,
      minZoom: 9,
      maxZoom: 17,
    });
    map.fitBounds(boundsRef.current, { padding: [24, 24] });

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      className: 'basemap-tiles',
      maxZoom: 19,
    }).addTo(map);

    // Order matters: later groups draw on top.
    for (const key of [
      'context',
      'heat',
      'risk',
      'demand',
      'routes',
      'relief',
      'interventions',
    ]) {
      groups.current[key] = L.layerGroup().addTo(map);
    }

    map.on('click', (e: L.LeafletMouseEvent) => {
      handlers.current.onPlace(e.latlng.lng, e.latlng.lat);
    });

    mapRef.current = map;
    // Leaflet mis-measures its container when it initialises inside a grid
    // that is still settling; one deferred invalidate fixes the grey band.
    setTimeout(() => map.invalidateSize(), 60);

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /** Refit when the region changes - not on every bounds identity change. */
  useEffect(() => {
    mapRef.current?.fitBounds(boundsRef.current, { padding: [24, 24] });
  }, [fitKey]);

  /* Cursor feedback while a placement tool is armed. */
  useEffect(() => {
    if (!hostRef.current) return;
    hostRef.current.style.cursor = placing ? 'crosshair' : '';
  }, [placing]);

  /* ------------------------------------------------------------ heat field */
  const heatOverlays = useMemo(() => grids.map((g) => paintTemp(g)), [grids]);
  const riskOverlays = useMemo(() => grids.map((g) => paintRisk(g)), [grids]);

  useEffect(() => {
    const group = groups.current.heat;
    if (!group) return;
    group.clearLayers();
    if (!layers.heat) return;

    heatOverlays.forEach((url, i) => {
      L.imageOverlay(url, boundsOf(grids[i]), {
        opacity: 0.72,
        interactive: false,
      }).addTo(group);
    });
  }, [heatOverlays, grids, layers.heat]);

  /* ------------------------------------- risk classification layer (FR4) */
  useEffect(() => {
    const group = groups.current.risk;
    if (!group) return;
    group.clearLayers();
    if (!layers.risk) return;

    riskOverlays.forEach((url, i) => {
      // Higher opacity than the continuous field: this layer exists to be read
      // as four discrete categories, and blending it softly defeats that.
      L.imageOverlay(url, boundsOf(grids[i]), {
        opacity: 0.82,
        interactive: false,
      }).addTo(group);
    });
  }, [riskOverlays, grids, layers.risk]);

  /* ---------------------------------------------------------- demand layer */
  useEffect(() => {
    const group = groups.current.demand;
    if (!group) return;
    group.clearLayers();
    if (!layers.demand || !demand) return;

    for (const item of paintDemand(demand, grids)) {
      L.imageOverlay(item.dataUrl, item.bounds, {
        opacity: 0.8,
        interactive: false,
      }).addTo(group);
    }
  }, [demand, grids, layers.demand]);

  /* ------------------------------------------------- parks / water context */
  useEffect(() => {
    const group = groups.current.context;
    if (!group) return;
    group.clearLayers();
    if (!layers.context || !contextGeoJson) return;

    L.geoJSON(contextGeoJson as never, {
      interactive: false,
      style: (feature) => {
        const water = feature?.properties?.kind === 'water';
        return {
          color: water ? '#2563eb' : '#15803d',
          weight: 0.6,
          opacity: 0.55,
          fillColor: water ? '#1d4ed8' : '#166534',
          fillOpacity: 0.3,
        };
      },
    }).addTo(group);
  }, [contextGeoJson, layers.context]);

  /* ---------------------------------------------------------- relief sites */
  useEffect(() => {
    const group = groups.current.relief;
    if (!group) return;
    group.clearLayers();
    if (!layers.relief) return;

    for (const s of sites) {
      const closed = closedSiteIds.has(s.id);
      const color = s.proposed
        ? '#ff6b1a'
        : s.kind === 'cooling_center'
          ? '#45c8e6'
          : s.kind === 'respite_center'
            ? '#9ae6f5'
            : '#2f9fbb';

      L.circleMarker([s.lat, s.lon], {
        radius: s.proposed ? 7 : 4.5,
        color,
        weight: s.proposed ? 2 : 1.5,
        fillColor: color,
        // A shut site is drawn hollow and faint. It stays on the map - hiding
        // it would misrepresent the network - but it visibly does not count,
        // which is exactly how the coverage maths treats it.
        fillOpacity: closed ? 0 : s.proposed ? 0.35 : 0.75,
        opacity: closed ? 0.45 : 1,
        dashArray: s.proposed || closed ? '3 3' : undefined,
      })
        .bindPopup(sitePopup(s, dayIndex, closed))
        .addTo(group);

      // Walk-radius ring on proposals, so "covered" is something you can see
      // rather than a number you have to trust.
      if (s.proposed) {
        L.circle([s.lat, s.lon], {
          radius: MOVEMENT.walkToReliefM,
          color: '#ff6b1a',
          weight: 1,
          opacity: 0.5,
          fill: false,
          dashArray: '2 5',
          interactive: false,
        }).addTo(group);
      }
    }
  }, [sites, closedSiteIds, dayIndex, layers.relief]);

  /* --------------------------------------------------------------- routes */
  useEffect(() => {
    const group = groups.current.routes;
    if (!group) return;
    group.clearLayers();
    if (!layers.routes) return;

    for (const r of routes) {
      const selected = r.id === selectedRouteId;
      const latlngs = r.coords.map((c) => [c[1], c[0]] as [number, number]);

      if (selected && selectedScore) {
        // Dark casing first. Without it the heat-coloured line sits on a
        // heat-coloured field in almost exactly the same hue and disappears -
        // the route has to read as a route before it reads as a temperature.
        L.polyline(latlngs, {
          color: '#0b0a09',
          weight: 11,
          opacity: 0.85,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false,
        }).addTo(group);

        // Then segment by segment, coloured by the temperature at each sample.
        // This is the most persuasive thing on screen: the same trip is cyan at
        // one end and blood-red in the middle, and nobody needs the exposure
        // number explained after they have seen it.
        const s = selectedScore.samples;
        for (let i = 1; i < s.length; i++) {
          L.polyline(
            [
              [s[i - 1].lat, s[i - 1].lon],
              [s[i].lat, s[i].lon],
            ],
            {
              color: tempColor(s[i].tempF),
              weight: 6,
              opacity: 0.95,
              lineCap: 'butt',
              interactive: false,
            },
          ).addTo(group);
        }
        if (selectedScore.peakSegment) {
          const seg = s.slice(
            selectedScore.peakSegment.startIdx,
            selectedScore.peakSegment.endIdx + 1,
          );
          L.polyline(
            seg.map((p) => [p.lat, p.lon] as [number, number]),
            { color: '#ffffff', weight: 12, opacity: 0.22, interactive: false },
          ).addTo(group);
        }
      } else {
        L.polyline(latlngs, { color: '#6d6459', weight: 2.5, opacity: 0.75 })
          .on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            handlers.current.onSelectRoute(r.id);
          })
          .bindTooltip(r.name, { sticky: true })
          .addTo(group);
      }
    }

    if (compareRoute) {
      L.polyline(
        compareRoute.route.coords.map((c) => [c[1], c[0]] as [number, number]),
        {
          color: '#45c8e6',
          weight: 3.5,
          opacity: 0.9,
          dashArray: '7 6',
          interactive: false,
        },
      )
        .bindTooltip(compareRoute.label, { sticky: true })
        .addTo(group);
    }
  }, [routes, selectedRouteId, selectedScore, compareRoute, layers.routes]);

  /* -------------------------------------------------------- interventions */
  useEffect(() => {
    const group = groups.current.interventions;
    if (!group) return;
    group.clearLayers();
    if (!layers.interventions) return;

    for (const iv of interventions) {
      const spec = INTERVENTIONS[iv.kind];

      if (iv.corridor && iv.corridor.length >= 2) {
        // Corridor treatments are drawn as the band they actually are: a line
        // with the treated width, not a disc. Canopy and pavement are specified
        // and tendered per corridor-km, so a circle was always the wrong shape.
        L.polyline(
          iv.corridor.map((c) => [c[1], c[0]] as [number, number]),
          { color: spec.color, weight: 3, opacity: 0.95, interactive: false },
        ).addTo(group);
        for (const pt of iv.corridor) {
          L.circle([pt[1], pt[0]], {
            radius: iv.radiusM,
            color: spec.color,
            weight: 0,
            fillColor: spec.color,
            fillOpacity: 0.13,
            interactive: false,
          }).addTo(group);
        }
      } else {
        L.circle([iv.lat, iv.lon], {
          radius: iv.radiusM,
          color: spec.color,
          weight: 1.5,
          opacity: 0.9,
          fillColor: spec.color,
          fillOpacity: iv.kind === 'cooling_station' ? 0.06 : 0.16,
        }).addTo(group);
      }

      L.circleMarker([iv.lat, iv.lon], {
        radius: 3.5,
        color: spec.color,
        fillColor: spec.color,
        fillOpacity: 1,
        weight: 0,
      })
        .bindPopup(
          `<div style="font-size:11px">
             <strong style="font-size:12px">${escapeHtml(iv.label)}</strong><br/>
             ${escapeHtml(spec.label)}<br/>
             assumed ${iv.deltaF} degF at centre, ${iv.radiusM} m radius<br/>
             <span style="color:#a2978a">${escapeHtml(spec.confidence)} confidence</span>
             ${iv.note ? `<br/><span style="color:#a2978a">${escapeHtml(iv.note)}</span>` : ''}
           </div>`,
        )
        .addTo(group);
    }
  }, [interventions, layers.interventions]);

  return <div ref={hostRef} className="absolute inset-0" />;
}

/* ========================================================================== */

function boundsOf(g: HeatGrid): [[number, number], [number, number]] {
  return [
    [g.bbox[1], g.bbox[0]],
    [g.bbox[3], g.bbox[2]],
  ];
}

/** Paint one tile's temperatures into a data-URL image. */
function paintTemp(g: HeatGrid): string {
  return paintCells(g, (i) => {
    const t = g.tempsF[i];
    return {
      rgb: hexToRgb(tempColor(t)),
      // Cells below the comfort threshold fade out so the eye goes straight
      // to the places that are actually a problem.
      alpha: t < THRESHOLDS.comfortF ? 110 : 235,
    };
  });
}

/**
 * Paint the stored per-cell risk classification (FR1 / FR4).
 *
 * This reads `riskBands` from the cache rather than re-deriving it from
 * temperature. That is the point of storing it: the layer shows the
 * classification the data was ingested with, not one recomputed under
 * whatever thresholds happen to be current.
 */
function paintRisk(g: HeatGrid): string {
  return paintCells(g, (i) => {
    const band = g.riskBands?.[i] ?? 0;
    return {
      rgb: hexToRgb(CELL_RISK_BANDS[band]?.color ?? '#1d4ed8'),
      alpha: band === 0 ? 90 : 200,
    };
  });
}

function paintCells(
  g: HeatGrid,
  valueAt: (index: number) => { rgb: [number, number, number]; alpha: number },
): string {
  const canvas = document.createElement('canvas');
  canvas.width = g.cols;
  canvas.height = g.rows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(g.cols, g.rows);

  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const { rgb, alpha } = valueAt(r * g.cols + c);
      // flip y: grid row 0 is south, canvas row 0 is top
      const px = ((g.rows - 1 - r) * g.cols + c) * 4;
      img.data[px] = rgb[0];
      img.data[px + 1] = rgb[1];
      img.data[px + 2] = rgb[2];
      img.data[px + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
}

/** Paint the demand layer, one image per tile bbox. */
function paintDemand(cells: DemandCell[], grids: HeatGrid[]) {
  const out: Array<{
    dataUrl: string;
    bounds: [[number, number], [number, number]];
  }> = [];
  let cursor = 0;

  for (const g of grids) {
    const canvas = document.createElement('canvas');
    canvas.width = g.cols;
    canvas.height = g.rows;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(g.cols, g.rows);

    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const cell = cells[cursor++];
        if (!cell) continue;
        const px = ((g.rows - 1 - r) * g.cols + c) * 4;
        // Ember for demand; the uncovered share pushes it toward white, so a
        // hot, busy, UNSERVED cell is the brightest thing on the map.
        const gapLift = cell.gap * 90;
        img.data[px] = 255;
        img.data[px + 1] = Math.min(255, 90 + gapLift);
        img.data[px + 2] = Math.min(255, 26 + gapLift * 0.7);
        img.data[px + 3] = Math.round(Math.min(1, cell.demand * 1.35) * 210);
      }
    }
    ctx.putImageData(img, 0, 0);
    out.push({ dataUrl: canvas.toDataURL(), bounds: boundsOf(g) });
  }
  return out;
}

function sitePopup(s: ReliefSite, dayIndex: number, closed: boolean): string {
  const kind = s.kind.replace(/_/g, ' ');
  const rows: string[] = [];
  if (s.org) rows.push(escapeHtml(s.org));
  if (s.address) rows.push(escapeHtml(s.address));
  if (s.phone) rows.push(escapeHtml(s.phone));
  if (s.services) {
    rows.push(
      `<span style="color:#a2978a">${escapeHtml(s.services.slice(0, 140))}</span>`,
    );
  }

  const hoursLine = s.proposed
    ? 'Proposed in the current scenario'
    : escapeHtml(hoursSummary(s, dayIndex));

  const badges = [
    s.adaAccessible ? 'ADA' : null,
    s.pets ? 'pets ok' : null,
    s.proposed ? 'PROPOSED' : 'published',
  ]
    .filter(Boolean)
    .join(' &middot; ');

  return `<div style="font-size:12px;line-height:1.5">
    <strong style="font-size:12.5px">${escapeHtml(s.name)}</strong>
    <div style="color:#ff6b1a;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;margin:3px 0 6px">${escapeHtml(kind)}</div>
    ${rows.join('<br/>')}
    <div style="margin-top:6px;color:${closed ? '#f87171' : '#45c8e6'}">
      ${closed ? 'CLOSED at this hour - not counted as coverage' : hoursLine}
    </div>
    <div style="margin-top:7px;color:#6d6459;font-size:10px">${badges}</div>
  </div>`;
}

function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
