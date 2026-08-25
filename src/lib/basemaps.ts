/**
 * Ground layers and street geometry types.
 *
 * These live here rather than in MapCanvas for a build reason worth recording:
 * MapCanvas imports Leaflet, which touches `window` at module scope, so it is
 * loaded with `ssr: false`. Anything that imports a VALUE from it - as opposed
 * to a type, which erases at compile time - drags Leaflet into the server
 * bundle and the page fails to prerender with "window is not defined".
 *
 * The Legend needs the basemap list to render its switch, so the list belongs
 * in a module with no browser dependency.
 */

export type BasemapId = 'streets' | 'satellite';

/**
 * The two ground layers, and why both are here.
 *
 * Streets is the default because names and block structure are what a planner
 * reads. Satellite earns its place for a different reason: it shows the
 * *cause*. Under imagery you can see that the hot band along a corridor is
 * unbroken asphalt and bare roof, and that the cool patch is a stand of mature
 * trees - which is the argument a canopy scenario is making, visible rather
 * than asserted.
 *
 * Both are keyless. Esri's World Imagery tiles are publicly served for use in
 * web maps with attribution, which is what the map control renders.
 */
export const BASEMAPS: Record<
  BasemapId,
  { label: string; url: string; attribution: string; maxZoom: number }
> = {
  streets: {
    label: 'Streets',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19,
  },
  satellite: {
    label: 'Satellite',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics',
    maxZoom: 19,
  },
};

/** One road centreline from data/<region>/streets.geojson. */
export interface StreetFeature {
  type: 'Feature';
  properties: { name: string | null; highway: string | null; osm: string };
  geometry: { type: 'LineString'; coordinates: Array<[number, number]> };
}

export interface StreetCollection {
  type: 'FeatureCollection';
  features: StreetFeature[];
}
