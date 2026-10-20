/**
 * Network access: terrain tiles (AWS Open Data, Terrarium encoding),
 * OpenStreetMap features (Overpass API) and place search (Nominatim).
 */
import { chooseDemZoom, decodeTerrarium, demTileRange } from './core/projection';
import type { BBox, Dem } from './core/types';
import type { OsmJson } from './core/osm';

export const TERRAIN_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

// Public instances listed on the OSM wiki (overpass.kumi.systems is now private.coffee).
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
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

const tileCache = new Map<string, Float32Array>();

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
        let tile = tileCache.get(url);
        if (!tile) {
          const res = await fetch(url, { signal, mode: 'cors' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          tile = await decodeTile(await res.blob());
          if (tileCache.size > 400) tileCache.clear();
          tileCache.set(url, tile);
        }
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

const ROAD_KINDS =
  'motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|' +
  'unclassified|residential|living_street|pedestrian|service|road|busway';
const PATH_KINDS = 'footway|path|cycleway|bridleway|steps|track';

/**
 * One Overpass request for everything the model needs, kept light:
 * only the highway types that get printed, and for land-cover relations only
 * the relation records plus the member ways that touch the window (giant
 * rivers and forests are never downloaded whole).
 */
export interface OsmLayers {
  buildings: boolean;
  roads: boolean;
  paths: boolean;
  /** Water, coastline and parks. */
  landcover: boolean;
}

export function overpassQuery(b: BBox, layers: OsmLayers): string {
  const bb = `${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)}`;
  const parts: string[] = ['[out:json][timeout:90];'];
  if (layers.buildings) {
    parts.push(`(
  way["building"](${bb});
  relation["building"]["type"="multipolygon"](${bb});
);
out geom qt;`);
  }
  if (layers.roads) {
    const roads = layers.paths ? `${ROAD_KINDS}|${PATH_KINDS}` : ROAD_KINDS;
    parts.push(`way["highway"~"^(${roads})$"](${bb});
out geom qt;`);
  }
  if (layers.landcover) {
    parts.push(`(
  way["natural"~"^(water|coastline|wood|scrub|grassland|heath)$"](${bb});
  way["waterway"~"^(riverbank|dock|river|canal)$"](${bb});
  way["landuse"~"^(reservoir|basin|grass|forest|meadow|recreation_ground|cemetery|village_green|allotments|orchard|vineyard)$"](${bb});
  way["leisure"~"^(park|garden|golf_course|nature_reserve|pitch|common|dog_park)$"](${bb});
);
out geom qt;
(
  relation["natural"~"^(water|wood|scrub|grassland|heath)$"]["type"="multipolygon"](${bb});
  relation["waterway"="riverbank"]["type"="multipolygon"](${bb});
  relation["landuse"~"^(reservoir|basin|grass|forest|meadow|recreation_ground|cemetery)$"]["type"="multipolygon"](${bb});
  relation["leisure"~"^(park|garden|golf_course|nature_reserve|common)$"]["type"="multipolygon"](${bb});
)->.lc;
.lc out body qt;
way(r.lc)(${bb});
out geom qt;`);
  }
  return parts.join('\n');
}

const RETRYABLE = new Set([429, 502, 503, 504]);
const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

/** POST a query, trying each public instance in turn (one polite retry each on overload). */
async function overpass(query: string, onStatus: (msg: string) => void, signal?: AbortSignal): Promise<OsmJson> {
  const body = 'data=' + encodeURIComponent(query);
  const errors: string[] = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const host = new URL(endpoint).host;
    for (let attempt = 0; attempt < 2; attempt++) {
      onStatus(attempt ? `OpenStreetMap server busy, retrying (${host})` : `Querying OpenStreetMap (${host})`);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 100_000);
      const onAbort = () => ctl.abort();
      signal?.addEventListener('abort', onAbort);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          signal: ctl.signal,
        });
        if (!res.ok) {
          errors.push(`${host}: HTTP ${res.status}`);
          if (RETRYABLE.has(res.status) && attempt === 0) {
            await wait(res.status === 429 ? 8000 : 4000, signal);
            continue;
          }
          break;
        }
        const json = (await res.json()) as OsmJson & { remark?: string };
        if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) {
          errors.push(`${host}: ${json.remark.trim().slice(0, 120)}`);
          break;
        }
        return json;
      } catch (e) {
        if (signal?.aborted) throw e;
        errors.push(`${host}: ${ctl.signal.aborted ? 'timed out' : (e as Error).message}`);
        break;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  }
  throw new Error(
    `The OpenStreetMap servers didn't return data (${errors.join('; ')}). They are shared and often busy: wait a minute and press Generate again, or select a smaller area.`,
  );
}

const osmCache = new Map<string, OsmJson>();

export async function fetchOsm(
  bbox: BBox,
  layers: OsmLayers,
  onStatus: (msg: string) => void,
  signal?: AbortSignal,
): Promise<OsmJson> {
  const query = overpassQuery(bbox, layers);
  const cached = osmCache.get(query);
  if (cached) return cached;
  const json = await overpass(query, onStatus, signal);

  // Land-cover relations cut by the window: fetch the small ones whole so they
  // fill exactly; giant ones (big rivers, forests) stay partial and are
  // resolved locally.
  const wayIds = new Set(json.elements.filter((e) => e.type === 'way').map((e) => e.id));
  const small = json.elements
    .filter(
      (e) =>
        e.type === 'relation' &&
        e.members &&
        !e.members.some((m) => m.geometry) &&
        e.members.some((m) => m.type === 'way' && !wayIds.has(m.ref)) &&
        e.members.length <= 40,
    )
    .map((e) => e.id)
    .slice(0, 60);
  if (small.length) {
    try {
      const full = await overpass(`[out:json][timeout:60];rel(id:${small.join(',')});out geom qt;`, onStatus, signal);
      const byId = new Map(full.elements.filter((e) => e.type === 'relation').map((e) => [e.id, e]));
      json.elements = json.elements.map((e) => (e.type === 'relation' && byId.has(e.id) ? byId.get(e.id)! : e));
    } catch (e) {
      if (signal?.aborted) throw e;
      // keep the partial versions
    }
  }
  if (osmCache.size > 8) osmCache.clear();
  osmCache.set(query, json);
  return json;
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
