/**
 * Turn FortyGuard's returned cells into one of our HeatGrids.
 *
 * The API returns its own polygon cells at its own resolution, close to but not
 * identical with ours. Cells are averaged into whichever of our cells they fall
 * in, and any of our cells left empty are filled from the nearest ring that has
 * data - which happens at tile edges where the returned coverage stops just
 * short of the requested bbox.
 *
 * This was inlined in src/app/api/admin/refresh-tile/route.ts. It moved here so
 * the draft-region field endpoint produces grids identical in shape to the ones
 * the live refresh produces, rather than a second implementation that drifts.
 * scripts/ingest-fortyguard.ts keeps its own variant, which takes pre-computed
 * dimensions and reports missing cells for the manifest; the two are
 * deliberately kept in step.
 */
import {
  GRANULARITY_M,
  cellRiskThresholds,
  classifyCell,
  gridDimsFor,
} from './config';
import type { HeatmapCell } from './fortyguard';
import type { FilterType, HeatGrid, Tile } from './types';

export function rasteriseHeatGrid(
  regionId: string,
  tile: Tile,
  cells: HeatmapCell[],
  filterType: FilterType,
  validAt: string,
  date: string,
): HeatGrid {
  const { cols, rows } = gridDimsFor(tile.bbox, GRANULARITY_M);
  const n = cols * rows;
  const sum = new Float64Array(n);
  const sumMin = new Float64Array(n);
  const sumMax = new Float64Array(n);
  const count = new Int32Array(n);

  const dLon = (tile.bbox[2] - tile.bbox[0]) / cols;
  const dLat = (tile.bbox[3] - tile.bbox[1]) / rows;

  for (const c of cells) {
    const cx = Math.floor((c.lon - tile.bbox[0]) / dLon);
    const ry = Math.floor((c.lat - tile.bbox[1]) / dLat);
    if (cx < 0 || ry < 0 || cx >= cols || ry >= rows) continue;
    const i = ry * cols + cx;
    sum[i] += c.tempF;
    sumMin[i] += c.minTempF;
    sumMax[i] += c.maxTempF;
    count[i] += 1;
  }

  const tempsF = new Array<number>(n);
  const tempsMinF = new Array<number>(n);
  const tempsMaxF = new Array<number>(n);
  const missing: number[] = [];

  for (let i = 0; i < n; i++) {
    if (count[i] > 0) {
      tempsF[i] = Math.round((sum[i] / count[i]) * 10) / 10;
      tempsMinF[i] = Math.round((sumMin[i] / count[i]) * 10) / 10;
      tempsMaxF[i] = Math.round((sumMax[i] / count[i]) * 10) / 10;
    } else {
      missing.push(i);
    }
  }

  for (const idx of missing) {
    const r0 = Math.floor(idx / cols);
    const c0 = idx % cols;
    let filled = false;
    for (let radius = 1; radius < Math.max(cols, rows) && !filled; radius++) {
      let a = 0;
      let mn = 0;
      let mx = 0;
      let k = 0;
      for (let r = r0 - radius; r <= r0 + radius; r++) {
        for (let c = c0 - radius; c <= c0 + radius; c++) {
          if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
          const j = r * cols + c;
          if (count[j] > 0) {
            a += sum[j] / count[j];
            mn += sumMin[j] / count[j];
            mx += sumMax[j] / count[j];
            k++;
          }
        }
      }
      if (k > 0) {
        tempsF[idx] = Math.round((a / k) * 10) / 10;
        tempsMinF[idx] = Math.round((mn / k) * 10) / 10;
        tempsMaxF[idx] = Math.round((mx / k) * 10) / 10;
        filled = true;
      }
    }
  }

  return {
    schema: 'coolroute.heatgrid.v3',
    regionId,
    tileId: tile.id,
    filterType,
    validAt,
    date,
    granularityM: GRANULARITY_M,
    bbox: tile.bbox,
    cols,
    rows,
    unit: 'F',
    source: 'fortyguard',
    fetchedAt: new Date().toISOString(),
    provenance: { note: 'set by caller' },
    tempsF,
    tempsMinF,
    tempsMaxF,
    riskBands: tempsF.map(classifyCell),
    riskThresholds: cellRiskThresholds(),
  };
}
