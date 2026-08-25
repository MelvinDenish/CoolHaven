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
import { tempColor, densifyPath, HeatField } from '@/lib/grid';
import {
  BASEMAPS,
  type BasemapId,
  type StreetCollection,
  type StreetFeature,
} from '@/lib/basemaps';
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
  /** Which tile provider paints the ground. */
  basemap: BasemapId;
  /**
   * Road centrelines for the street probe, or null until /api/streets loads.
   * Absent is a normal state, not an error - the probe simply stays off.
   */
  streets: StreetCollection | null;
  /** The field the probe samples. Carries the active day part. */
  probeField: HeatField | null;
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
  basemap,
  streets,
  probeField,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const baseLayerRef = useRef<L.TileLayer | null>(null);
  const groups = useRef<Record<string, L.LayerGroup>>({});
  // Callbacks live in a ref so the map is built exactly once; putting them in
  // the effect's dependency list tears down and rebuilds Leaflet on every
  // parent render, which loses the user's pan and zoom mid-interaction.
  const handlers = useRef({ onPlace, onSelectRoute });
  handlers.current = { onPlace, onSelectRoute };
  const boundsRef = useRef(focusBounds);
  boundsRef.current = focusBounds;

  /*
   * Street probe state, held in a ref for the same reason the callbacks are:
   * the map is built once, and its click handler has to see current values
   * without the map being torn down and rebuilt on every parent render.
   */
  const probe = useRef<{
    placing: InterventionKind | null;
    streets: StreetCollection | null;
    field: HeatField | null;
  }>({ placing, streets, field: probeField });
  probe.current = { placing, streets, field: probeField };

  /**
   * "How hot is this street?"
   *
   * Finds the nearest centreline to the click, samples the ACTIVE field along
   * its whole length, and reports mean, peak and the hottest 100 m. The
   * sampling is the same densify-and-sample the route scorer uses, so a street
   * and a route that share tarmac report the same temperature.
   *
   * The tolerance scales with zoom: 60 m of slack when zoomed out to the whole
   * district, tightening to a few metres up close, so a click near a junction
   * picks the street you were pointing at rather than the nearest one to the
   * pixel.
   */
  const probeStreetAt = (lon: number, lat: number) => {
    const map = mapRef.current;
    const group = groups.current.probe;
    const { streets: fc, field } = probe.current;
    if (!map || !group || !fc || !field) return;

    group.clearLayers();

    const toleranceM = Math.max(6, 1200 / Math.pow(2, map.getZoom() - 12));
    let best: { feature: StreetFeature; distM: number } | null = null;

    for (const f of fc.features) {
      const coords = f.geometry.coordinates;
      for (let i = 1; i < coords.length; i++) {
        const d = pointToSegmentM([lon, lat], coords[i - 1], coords[i]);
        if (d < (best?.distM ?? Infinity)) best = { feature: f, distM: d };
      }
    }

    if (!best || best.distM > toleranceM) return;

    const coords = best.feature.geometry.coordinates;
    const samples = densifyPath(coords, 25);
    let sum = 0;
    let peak = -Infinity;
    let low = Infinity;
    let covered = 0;
    for (const p of samples) {
      const { tempF, inCoverage } = field.sampleClamped(p.lon, p.lat);
      if (inCoverage) covered++;
      sum += tempF;
      if (tempF > peak) peak = tempF;
      if (tempF < low) low = tempF;
    }
    const mean = samples.length ? sum / samples.length : NaN;
    const lengthM = samples.length ? samples[samples.length - 1].distanceM : 0;
    const outside = samples.length - covered;

    L.polyline(
      coords.map(([x, y]) => [y, x] as [number, number]),
      { color: '#ffffff', weight: 6, opacity: 0.95, interactive: false },
    ).addTo(group);
    L.polyline(
      coords.map(([x, y]) => [y, x] as [number, number]),
      { color: tempColor(mean), weight: 3.5, opacity: 1, interactive: false },
    ).addTo(group);

    const name = best.feature.properties.name ?? 'Unnamed street';
    const cls = (best.feature.properties.highway ?? '').replace(/_/g, ' ');

    L.popup({ className: 'street-probe', maxWidth: 260 })
      .setLatLng([lat, lon])
      .setContent(
        `<div class="probe-title">${escapeHtml(name)}</div>` +
          `<div class="probe-sub">${escapeHtml(cls)} &middot; ${Math.round(lengthM)} m</div>` +
          `<div class="probe-row"><span>Mean</span><b>${mean.toFixed(1)} &deg;F</b></div>` +
          `<div class="probe-row"><span>Peak</span><b>${peak.toFixed(1)} &deg;F</b></div>` +
          `<div class="probe-row"><span>Coolest</span><b>${low.toFixed(1)} &deg;F</b></div>` +
          (outside > 0
            ? `<div class="probe-note">${Math.round(
                (outside / samples.length) * 100,
              )}% of this street is outside the measured tiles - those samples take the nearest tile-edge value.</div>`
            : '') +
          `<div class="probe-note">Sampled from the field currently on screen, at the selected day and part of day.</div>`,
      )
      .openOn(map);
  };

  /* ---------------------------------------------------------------- setup */
  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;

    const map = L.map(hostRef.current, {
      zoomControl: true,
      attributionControl: true,
      preferCanvas: true,
      minZoom: 9,
      // 19, not 17: the street probe is only useful if you can get close enough
      // to tell one street from the next, and satellite imagery carries detail
      // well past the old ceiling.
      maxZoom: 19,
    });
    map.fitBounds(boundsRef.current, { padding: [24, 24] });

    // Order matters: later groups draw on top.
    for (const key of [
      'context',
      'heat',
      'risk',
      'demand',
      'routes',
      'relief',
      'interventions',
      // Above everything: a probed street has to stay visible over the field.
      'probe',
    ]) {
      groups.current[key] = L.layerGroup().addTo(map);
    }

    map.on('click', (e: L.LeafletMouseEvent) => {
      // A placement tool owns the click while it is armed; probing is what a
      // click means the rest of the time.
      if (probe.current.placing) {
        handlers.current.onPlace(e.latlng.lng, e.latlng.lat);
        return;
      }
      probeStreetAt(e.latlng.lng, e.latlng.lat);
    });

    mapRef.current = map;
    // Leaflet mis-measures its container when it initialises inside a grid
    // that is still settling; one deferred invalidate fixes the grey band.
    setTimeout(() => map.invalidateSize(), 60);

    // And it mis-measures again every time the container is hidden and shown -
    // which is exactly what the narrow-screen Map/Panel switch does. Watching
    // the element covers that, orientation changes and window resizes in one
    // mechanism, instead of threading a "visible" prop through the tree.
    const ro = new ResizeObserver(() => {
      if (hostRef.current && hostRef.current.clientWidth > 0) map.invalidateSize();
    });
    ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  /** Refit when the region changes - not on every bounds identity change. */
  useEffect(() => {
    mapRef.current?.fitBounds(boundsRef.current, { padding: [24, 24] });
  }, [fitKey]);

  /* ---------------------------------------------------------------- basemap */
  /**
   * Swap the ground layer in place rather than rebuilding the map, so the
   * user's pan and zoom survive the switch.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const spec = BASEMAPS[basemap];
    const layer = L.tileLayer(spec.url, {
      attribution: spec.attribution,
      // The class carries the provider, because the dark-theme treatment is not
      // the same for both: inverting a street raster makes a dark map, but
      // inverting a photograph makes a negative.
      className: `basemap-tiles basemap-${basemap}`,
      maxZoom: spec.maxZoom,
    });
    layer.addTo(map);
    layer.bringToBack();

    const previous = baseLayerRef.current;
    baseLayerRef.current = layer;
    // Remove the old layer only once the new one has tiles up, otherwise the
    // map flashes the empty background between providers.
    if (previous) {
      layer.once('load', () => previous.remove());
      // A cached provider may never fire `load`; this is the backstop.
      setTimeout(() => previous.remove(), 1200);
    }
  }, [basemap]);

  /* Cursor feedback while a placement tool is armed. */
  useEffect(() => {
    if (!hostRef.current) return;
    hostRef.current.style.cursor = placing ? 'crosshair' : '';
  }, [placing]);

  /*
   * Drop a probe result when the ground under it changes.
   *
   * The highlighted street and its popup describe one field at one day part.
   * Leaving them on screen after the user switches region, day or day part
   * would leave a stale temperature sitting on the map looking current.
   */
  useEffect(() => {
    groups.current.probe?.clearLayers();
    mapRef.current?.closePopup();
  }, [fitKey, probeField]);

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
          fillOpacity: INTERVENTIONS[iv.kind].geometry === 'point' ? 0.06 : 0.16,
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

/**
 * Distance from a point to a line segment, in metres.
 *
 * Distance to the nearest ENDPOINT would be wrong here: on a long straight
 * arterial digitised with two vertices a kilometre apart, a click in the middle
 * of the block is a kilometre from both ends and the street would never be
 * picked. The projection onto the segment is what makes the probe feel like it
 * is selecting the road under the cursor.
 */
function pointToSegmentM(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const latScale = Math.cos((p[1] * Math.PI) / 180);
  const px = (p[0] - a[0]) * latScale * 111_320;
  const py = (p[1] - a[1]) * 110_574;
  const bx = (b[0] - a[0]) * latScale * 111_320;
  const by = (b[1] - a[1]) * 110_574;

  const lenSq = bx * bx + by * by;
  if (lenSq === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / lenSq));
  return Math.hypot(px - t * bx, py - t * by);
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
