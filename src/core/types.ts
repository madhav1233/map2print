export interface BBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface LonLat {
  lon: number;
  lat: number;
}

/**
 * Elevation raster in Web Mercator pixel space. `x0`/`y0` are the global pixel
 * coordinates (256px tiles at `zoom`) of the top-left pixel in `data`.
 */
export interface Dem {
  zoom: number;
  x0: number;
  y0: number;
  width: number;
  height: number;
  data: Float32Array; // metres
}

export type PartId =
  | 'terrain'
  | 'buildings'
  | 'roads'
  | 'water'
  | 'parks'
  | 'forest'
  | 'rock'
  | 'snow'
  | 'marker'
  | 'route'
  | 'base'
  | 'labels';

export const PART_ORDER: PartId[] = ['terrain', 'buildings', 'roads', 'water', 'parks', 'forest', 'rock', 'snow', 'marker', 'route', 'base', 'labels'];

export type Shape = 'rectangle' | 'octagon' | 'hexagon' | 'circle';
export type RouteStyle = 'raised' | 'insert';

export interface Settings {
  /** Length of the longest side of the model, mm. */
  sizeMm: number;
  /** Flat base thickness under the lowest point, mm. */
  baseMm: number;
  /** Terrain grid resolution, mm. */
  cellMm: number;
  terrainExaggeration: number;
  buildingScale: number;
  include: {
    buildings: boolean;
    roads: boolean;
    paths: boolean;
    water: boolean;
    parks: boolean;
    forest: boolean;
    rock: boolean;
    snow: boolean;
    marker: boolean;
    route: boolean;
    base: boolean;
    labels: boolean;
  };
  /** Rock: ground steeper than this (degrees, real-world slope) plus mapped bare rock and scree. */
  rock: { slopeDeg: number };
  /** Snow: ground above this altitude (metres; null = automatic) plus mapped glaciers. */
  snow: { altitudeM: number | null };
  /** Footprint of the model. Non-rectangular shapes are inscribed in the selection. */
  shape: Shape;
  route: {
    /** Raised ridge printed in place, or a separate wall that slots into a groove. */
    style: RouteStyle;
    widthMm: number;
    /** Height of the route above the ground. */
    raiseMm: number;
    /** Gap on each side between the insert and its groove. */
    clearanceMm: number;
  };
  base: {
    /** Thickness of the flat plate under the model. */
    plateMm: number;
    /** How far the plate reaches beyond the model on every side (room for labels). */
    rimMm: number;
    /** Text lying flat on the rim: in front of the model and either side. */
    title: string;
    left: string;
    right: string;
  };
  /** Filament / AMS slot (1-based) per part. */
  slots: Record<PartId, number>;
  colors: Record<PartId, string>;
  /** Minimum printable building height above ground, mm. */
  minBuildingMm: number;
  /** Footprints smaller than this (mm²) are dropped as unprintable. */
  minFootprintMm2: number;
  /** Minimum printed road width, mm. */
  minRoadMm: number;
  roadWidthScale: number;
  markerSizeMm: number;
}

export const DEFAULT_SETTINGS: Settings = {
  sizeMm: 180,
  baseMm: 4,
  cellMm: 0.5,
  terrainExaggeration: 1.5,
  buildingScale: 1,
  include: {
    buildings: true,
    roads: true,
    paths: false,
    water: true,
    parks: true,
    forest: true,
    rock: false,
    snow: false,
    marker: false,
    route: true,
    base: false,
    labels: false,
  },
  rock: { slopeDeg: 35 },
  snow: { altitudeM: null },
  shape: 'rectangle',
  route: { style: 'raised', widthMm: 1.2, raiseMm: 1.2, clearanceMm: 0.15 },
  base: { plateMm: 3, rimMm: 12, title: '', left: '', right: '' },
  slots: { terrain: 1, buildings: 2, roads: 3, water: 4, parks: 5, forest: 6, rock: 7, snow: 8, marker: 9, route: 10, base: 11, labels: 12 },
  colors: {
    terrain: '#e9e4d8',
    buildings: '#f7f6f2',
    roads: '#5b5f66',
    water: '#4a86b8',
    parks: '#7aa35a',
    forest: '#3f5c2e',
    rock: '#8b8780',
    snow: '#f6f7f5',
    marker: '#d23a3a',
    route: '#d8322b',
    base: '#2b2f33',
    labels: '#f4f4f0',
  },
  minBuildingMm: 0.6,
  minFootprintMm2: 0.5,
  minRoadMm: 0.6,
  roadWidthScale: 1,
  markerSizeMm: 8,
};

/** Fixed modelling constants (mm). */
export const GEOM = {
  /** Water surface is recessed this far below the shoreline. */
  waterDepressMm: 0.8,
  /** Water slab thickness above the recessed terrain (3MF tint). */
  waterRaiseMm: 0.4,
  /** Park slab sits this far above the terrain (one layer). */
  parkRaiseMm: 0.2,
  /** Roads stand this far above the terrain. */
  roadRaiseMm: 0.4,
  /** Overlay parts are sunk this far into the terrain so they bond. */
  embedMm: 0.4,
  /** Buildings are sunk this far below the lowest ground point under them. */
  buildingEmbedMm: 0.6,
};

export interface PartResult {
  id: PartId;
  name: string;
  slot: number;
  color: string;
  /** Included in the single-colour STL. */
  inStl: boolean;
  positions: Float32Array;
  indices: Uint32Array;
  shells: number;
}

export interface Report {
  sizeMm: [number, number, number];
  scale: number; // 1 : scale
  triangles: number;
  buildings: number;
  buildingsDropped: number;
  roadSegments: number;
  elevationRange: [number, number];
  welded: number;
  degenerate: number;
  flippedShells: number;
  shellsChecked: number;
  shellsFailed: number;
  terrainWatertight: boolean;
  baseMm: number;
  minBuildingMm: number;
  waterBodies: number;
  waterAreaPct: number;
  parkAreaPct: number;
  forestAreaPct: number;
  rockAreaPct: number;
  snowAreaPct: number;
  /** Snow line actually used (metres) and its height on the print (mm above the bed). */
  snowLine: null | { altitudeM: number; zMm: number; auto: boolean; glaciers: boolean };
  realSizeM: [number, number];
  demZoom: number;
  warnings: string[];
  shape: Shape;
  route: null | {
    style: RouteStyle;
    lengthMm: number;
    widthMm: number;
    clearanceMm: number;
    grooveDepthMm: number;
    stages: number;
  };
  base: null | { plateMm: number; rimMm: number; labels: number };
}

export interface ModelResult {
  parts: PartResult[];
  report: Report;
}
