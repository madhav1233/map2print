/**
 * Network access: terrain tiles (AWS Open Data, Terrarium encoding),
 * OpenStreetMap features (Overpass API) and place search (Nominatim).
 */
import { chooseDemZoom, decodeTerrarium, demTileRange } from './core/projection';
import type { BBox, Dem } from './core/types';
import type { OsmJson } from './core/osm';

export const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

async function decodeTile(blob: Blob): Promise<Float32Array> {
  const bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const rgba = ctx.getImageData(0, 0, 256, 256).data;
  const out = new Float32Array(256 * 256);
  decodeTerrarium(rgba, out);
  return out;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

export async function fetchDem(
  bbox: BBox,
  targetResolutionM: number,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Dem> {
  const zoom = chooseDemZoom(bbox, targetResolutionM);
  const t = demTileRange(bbox, zoom);
  const cols = t.x1 - t.x0 + 1;
  const rows = t.y1 - t.y0 + 1;
  const width = cols * 256;
  const height = rows * 256;
  const data = new Float32Array(width * height);
  const tiles: [number, number][] = [];
  for (let y = t.y0; y <= t.y1; y++) for (let x = t.x0; x <= t.x1; x++) tiles.push([x, y]);
  let done = 0;
  await pool(tiles, 6, async ([x, y]) => {
    const url = TERRAIN_URL.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y));
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { signal, mode: 'cors' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const tile = await decodeTile(await res.blob());
        const ox = (x - t.x0) * 256;
        const oy = (y - t.y0) * 256;
        for (let r = 0; r < 256; r++) data.set(tile.subarray(r * 256, r * 256 + 256), (oy + r) * width + ox);
        onProgress(++done, tiles.length);
        return;
      } catch (e) {
        if (signal?.aborted) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
    throw new Error(`Elevation tile ${zoom}/${x}/${y} could not be downloaded (${String(lastErr)}).`);
  });
  return { zoom, x0: t.x0 * 256, y0: t.y0 * 256, width, height, data };
}

export function overpassQuery(b: BBox): string {
  const bb = `${b.south.toFixed(7)},${b.west.toFixed(7)},${b.north.toFixed(7)},${b.east.toFixed(7)}`;
  return `[out:json][timeout:150][maxsize:1073741824];
(
  way["building"](${bb});
  relation["building"]["type"="multipolygon"](${bb});
  way["highway"](${bb});
  way["natural"~"^(water|coastline|wood|scrub|grassland|heath)$"](${bb});
  relation["natural"~"^(water|wood|scrub|grassland|heath)$"]["type"="multipolygon"](${bb});
  way["waterway"~"^(riverbank|dock|river|canal)$"](${bb});
  relation["waterway"="riverbank"](${bb});
  way["landuse"~"^(reservoir|basin|grass|forest|meadow|recreation_ground|cemetery|village_green|allotments|orchard|vineyard)$"](${bb});
  relation["landuse"~"^(reservoir|basin|grass|forest|meadow|recreation_ground|cemetery)$"]["type"="multipolygon"](${bb});
  way["leisure"~"^(park|garden|golf_course|nature_reserve|pitch|common|dog_park)$"](${bb});
  relation["leisure"~"^(park|garden|golf_course|nature_reserve|common)$"]["type"="multipolygon"](${bb});
);
out geom;`;
}

export async function fetchOsm(bbox: BBox, onStatus: (msg: string) => void, signal?: AbortSignal): Promise<OsmJson> {
  const body = 'data=' + encodeURIComponent(overpassQuery(bbox));
  const errors: string[] = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const host = new URL(endpoint).host;
    onStatus(`Querying OpenStreetMap (${host})`);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) {
        errors.push(`${host}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json()) as OsmJson & { remark?: string };
      if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) {
        errors.push(`${host}: ${json.remark}`);
        continue;
      }
      return json;
    } catch (e) {
      if (signal?.aborted) throw e;
      errors.push(`${host}: ${(e as Error).message}`);
    }
  }
  throw new Error(
    `OpenStreetMap servers didn't return data (${errors.join('; ')}). Wait a minute and generate again, or select a smaller area.`,
  );
}

export interface Place {
  name: string;
  lat: number;
  lon: number;
  bbox?: BBox;
}

export async function searchPlaces(q: string, signal?: AbortSignal): Promise<Place[]> {
  const url = `${NOMINATIM_URL}?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status}).`);
  const rows = (await res.json()) as { display_name: string; lat: string; lon: string; boundingbox?: string[] }[];
  return rows.map((r) => ({
    name: r.display_name,
    lat: parseFloat(r.lat),
    lon: parseFloat(r.lon),
    bbox: r.boundingbox
      ? {
          south: parseFloat(r.boundingbox[0]),
          north: parseFloat(r.boundingbox[1]),
          west: parseFloat(r.boundingbox[2]),
          east: parseFloat(r.boundingbox[3]),
        }
      : undefined,
  }));
}
