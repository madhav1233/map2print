import type { BBox, Dem } from './types';

/** Metres per degree of latitude / longitude at a given latitude (WGS84 series). */
export function metersPerDegree(latDeg: number): { lat: number; lon: number } {
  const p = (latDeg * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p) - 0.0023 * Math.cos(6 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p) + 0.118 * Math.cos(5 * p),
  };
}

export function bboxSizeMeters(b: BBox): { width: number; height: number } {
  const mpd = metersPerDegree((b.south + b.north) / 2);
  return { width: (b.east - b.west) * mpd.lon, height: (b.north - b.south) * mpd.lat };
}

/**
 * Local equirectangular projection from lon/lat to model millimetres, origin
 * at the south-west corner of the bbox. Accurate to well under 0.1% over the
 * few-kilometre areas this tool handles.
 */
export class Projector {
  readonly mPerLon: number;
  readonly mPerLat: number;
  /** Model millimetres per real-world metre. */
  readonly scale: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly widthM: number;
  readonly heightM: number;

  constructor(
    readonly bbox: BBox,
    sizeMm: number,
  ) {
    const mpd = metersPerDegree((bbox.south + bbox.north) / 2);
    this.mPerLon = mpd.lon;
    this.mPerLat = mpd.lat;
    this.widthM = (bbox.east - bbox.west) * mpd.lon;
    this.heightM = (bbox.north - bbox.south) * mpd.lat;
    this.scale = sizeMm / Math.max(this.widthM, this.heightM);
    this.widthMm = this.widthM * this.scale;
    this.heightMm = this.heightM * this.scale;
  }

  toModel(lon: number, lat: number): [number, number] {
    return [
      (lon - this.bbox.west) * this.mPerLon * this.scale,
      (lat - this.bbox.south) * this.mPerLat * this.scale,
    ];
  }

  toLonLat(x: number, y: number): [number, number] {
    return [
      this.bbox.west + x / this.scale / this.mPerLon,
      this.bbox.south + y / this.scale / this.mPerLat,
    ];
  }
}

// ---- Web Mercator helpers (256px tiles) ----

export function lonToPixel(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * 256 * 2 ** zoom;
}

export function latToPixel(lat: number, zoom: number): number {
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 256 * 2 ** zoom;
}

/** Bilinear elevation lookup (metres) in a DEM mosaic. */
export function sampleDem(dem: Dem, lon: number, lat: number): number {
  const fx = lonToPixel(lon, dem.zoom) - dem.x0 - 0.5;
  const fy = latToPixel(lat, dem.zoom) - dem.y0 - 0.5;
  const x = Math.max(0, Math.min(dem.width - 1.000001, fx));
  const y = Math.max(0, Math.min(dem.height - 1.000001, fy));
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const tx = x - ix;
  const ty = y - iy;
  const w = dem.width;
  const d = dem.data;
  const i00 = iy * w + ix;
  const a = d[i00];
  const b = d[i00 + 1];
  const c = d[i00 + w];
  const e = d[i00 + w + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
}

/** Choose a terrain-tile zoom whose pixel size roughly matches `targetM`, capped by tile count. */
export function chooseDemZoom(b: BBox, targetM: number, maxTiles = 64): number {
  const lat = (b.south + b.north) / 2;
  let z = Math.ceil(Math.log2((156543.03 * Math.cos((lat * Math.PI) / 180)) / Math.max(targetM, 1)));
  z = Math.max(8, Math.min(15, z));
  while (z > 8) {
    const t = demTileRange(b, z);
    const count = (t.x1 - t.x0 + 1) * (t.y1 - t.y0 + 1);
    if (count <= maxTiles) break;
    z--;
  }
  return z;
}

export function demTileRange(b: BBox, z: number): { x0: number; x1: number; y0: number; y1: number } {
  // one pixel of padding on each side so bilinear sampling at the edge is valid
  const px0 = lonToPixel(b.west, z) - 2;
  const px1 = lonToPixel(b.east, z) + 2;
  const py0 = latToPixel(b.north, z) - 2;
  const py1 = latToPixel(b.south, z) + 2;
  const max = 2 ** z - 1;
  return {
    x0: Math.max(0, Math.floor(px0 / 256)),
    x1: Math.min(max, Math.floor(px1 / 256)),
    y0: Math.max(0, Math.floor(py0 / 256)),
    y1: Math.min(max, Math.floor(py1 / 256)),
  };
}

/** Terrarium encoding: (R * 256 + G + B / 256) - 32768 metres. */
export function decodeTerrarium(rgba: Uint8ClampedArray | Uint8Array, out: Float32Array): void {
  for (let i = 0, j = 0; j < out.length; i += 4, j++) {
    out[j] = rgba[i] * 256 + rgba[i + 1] + rgba[i + 2] / 256 - 32768;
  }
}
