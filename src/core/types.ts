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

export type PartId = 'terrain' | 'buildings' | 'roads' | 'water' | 'parks' | 'marker';

export const PART_ORDER: PartId[] = ['terrain', 'buildings', 'roads', 'water', 'parks', 'marker'];

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
    marker: boolean;
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
  include: { buildings: true, roads: true, paths: false, water: true, parks: true, marker: false },
  slots: { terrain: 1, buildings: 2, roads: 3, water: 4, parks: 5, marker: 6 },
  colors: {
    terrain: '#e9e4d8',
    buildings: '#f7f6f2',
    roads: '#5b5f66',
    water: '#4a86b8',
    parks: '#7aa35a',
    marker: '#d23a3a',
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
  realSizeM: [number, number];
  demZoom: number;
  warnings: string[];
}

export interface ModelResult {
  parts: PartResult[];
  report: Report;
}
