/**
 * Synthetic but realistically-shaped test data: a small coastal city with a
 * street grid, buildings (tagged heights, levels, untagged, a courtyard
 * multipolygon), a river assembled from two ways with an island, a lake, a
 * park and a coastline split across two ways. Used by unit and e2e tests so
 * they run without network access.
 */
import type { BBox, Dem } from '../../src/core/types';
import type { OsmElement, OsmJson } from '../../src/core/osm';
import { demTileRange, latToPixel, lonToPixel } from '../../src/core/projection';

export const FIXTURE_BBOX: BBox = { west: 115.85, south: -31.965, east: 115.875, north: -31.945 };

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Elevation in metres: rolling hills, a river valley, sea in the east. */
export function fixtureElevation(lon: number, lat: number, b: BBox = FIXTURE_BBOX): number {
  const u = (lon - b.west) / (b.east - b.west);
  const v = (lat - b.south) / (b.north - b.south);
  let h = 12 + 9 * Math.sin(u * 5.1) * Math.cos(v * 4.3) + 14 * v;
  // river valley around v = 0.25
  h -= 10 * Math.exp(-(((v - 0.25) / 0.07) ** 2));
  // sea to the east of u ≈ 0.86: bathymetry
  if (u > 0.86) h = -6 - 20 * (u - 0.86);
  return h;
}

let nextId = 1;
const node = (lon: number, lat: number) => ({ lon, lat });

function way(tags: Record<string, string>, pts: { lon: number; lat: number }[], nodes?: number[]): OsmElement {
  const id = nextId++;
  return {
    type: 'way',
    id,
    tags,
    nodes: nodes ?? pts.map(() => nextId++),
    geometry: pts.map((p) => ({ lat: p.lat, lon: p.lon })),
  };
}

function closedWay(tags: Record<string, string>, pts: { lon: number; lat: number }[]): OsmElement {
  const ids = pts.map(() => nextId++);
  return way(tags, [...pts, pts[0]], [...ids, ids[0]]);
}

function rect(lon0: number, lat0: number, lon1: number, lat1: number) {
  return [node(lon0, lat0), node(lon1, lat0), node(lon1, lat1), node(lon0, lat1)];
}

export function syntheticOsm(b: BBox = FIXTURE_BBOX): OsmJson {
  nextId = 1;
  const els: OsmElement[] = [];
  const X = (u: number) => lerp(b.west, b.east, u);
  const Y = (v: number) => lerp(b.south, b.north, v);

  // street grid (extends past the bbox to exercise clipping)
  for (let k = 0; k <= 8; k++) {
    const u = 0.04 + k * 0.1;
    els.push(way({ highway: k % 4 === 0 ? 'primary' : 'residential', name: `Street ${k}` }, [node(X(u), Y(-0.1)), node(X(u), Y(0.5)), node(X(u + 0.01), Y(1.1))]));
  }
  for (let k = 0; k <= 7; k++) {
    const v = 0.35 + k * 0.09;
    els.push(way({ highway: k === 3 ? 'secondary' : 'tertiary' }, [node(X(-0.1), Y(v)), node(X(0.5), Y(v + 0.005)), node(X(1.1), Y(v))]));
  }
  // a bridge over the river and a tunnel that must be skipped
  els.push(way({ highway: 'primary', bridge: 'yes' }, [node(X(0.45), Y(0.12)), node(X(0.45), Y(0.38))]));
  els.push(way({ highway: 'primary', tunnel: 'yes' }, [node(X(0.2), Y(0.1)), node(X(0.2), Y(0.4))]));
  els.push(way({ highway: 'footway' }, [node(X(0.1), Y(0.6)), node(X(0.3), Y(0.62))]));

  // buildings inside blocks
  let n = 0;
  for (let bx = 0; bx < 8; bx++) {
    for (let by = 0; by < 7; by++) {
      const u0 = 0.04 + bx * 0.1 + 0.012;
      const v0 = 0.35 + by * 0.09 + 0.012;
      for (let sub = 0; sub < 4; sub++) {
        const su = u0 + (sub % 2) * 0.038;
        const sv = v0 + Math.floor(sub / 2) * 0.034;
        const tags: Record<string, string> = { building: 'yes' };
        const kind = n++ % 5;
        if (kind === 0) tags.height = String(15 + ((bx * 7 + by * 13 + sub * 3) % 9) * 12);
        else if (kind === 1) tags['building:levels'] = String(2 + ((bx + by + sub) % 6));
        else if (kind === 2) tags.building = 'house';
        else if (kind === 3) tags.height = '40 ft';
        els.push(closedWay(tags, rect(X(su), Y(sv), X(su + 0.03), Y(sv + 0.026))));
      }
    }
  }
  // tiny shed that should be dropped as unprintable
  els.push(closedWay({ building: 'shed' }, rect(X(0.3), Y(0.335), X(0.3008), Y(0.3358))));
  // a tower crossing the east edge of the window (clipped)
  els.push(closedWay({ building: 'yes', height: '210' }, rect(X(0.97), Y(0.9), X(1.03), Y(0.95))));

  // courtyard building as a multipolygon relation
  {
    const outer = way({}, [...rect(X(0.6), Y(0.05), X(0.7), Y(0.12)), node(X(0.6), Y(0.05))]);
    const inner = way({}, [...rect(X(0.63), Y(0.07), X(0.67), Y(0.1)), node(X(0.63), Y(0.07))]);
    els.push({
      type: 'relation',
      id: nextId++,
      tags: { type: 'multipolygon', building: 'yes', 'building:levels': '6' },
      members: [
        { type: 'way', ref: outer.id, role: 'outer', geometry: outer.geometry },
        { type: 'way', ref: inner.id, role: 'inner', geometry: inner.geometry },
      ],
    });
  }

  // river: multipolygon whose outer ring is split into two ways, with an island
  {
    const northBank = [node(X(-0.2), Y(0.3)), node(X(0.3), Y(0.29)), node(X(0.6), Y(0.31)), node(X(1.2), Y(0.3))];
    const southBank = [node(X(1.2), Y(0.2)), node(X(0.6), Y(0.2)), node(X(0.3), Y(0.21)), node(X(-0.2), Y(0.2))];
    const w1 = way({}, [northBank[0], ...northBank.slice(1), southBank[0]]);
    const w2 = way({}, [southBank[0], ...southBank.slice(1), northBank[0]].reverse()); // reversed on purpose
    const island = way({}, [...rect(X(0.3), Y(0.235), X(0.36), Y(0.265)), node(X(0.3), Y(0.235))]);
    els.push({
      type: 'relation',
      id: nextId++,
      tags: { type: 'multipolygon', natural: 'water', water: 'river', name: 'Test River' },
      members: [
        { type: 'way', ref: w1.id, role: 'outer', geometry: w1.geometry },
        { type: 'way', ref: w2.id, role: 'outer', geometry: w2.geometry },
        { type: 'way', ref: island.id, role: 'inner', geometry: island.geometry },
      ],
    });
  }

  // lake and park
  els.push(closedWay({ natural: 'water', water: 'lake' }, [node(X(0.08), Y(0.05)), node(X(0.2), Y(0.04)), node(X(0.22), Y(0.13)), node(X(0.1), Y(0.15))]));
  els.push(closedWay({ leisure: 'park', name: 'Test Park' }, rect(X(0.02), Y(0.88), X(0.25), Y(0.99))));

  // coastline, sea to the east: runs south→north (land on the left), split in two ways
  {
    const mid = nextId++;
    const a = [node(X(0.87), Y(-0.2)), node(X(0.86), Y(0.3)), node(X(0.875), Y(0.55))];
    const c = [node(X(0.875), Y(0.55)), node(X(0.86), Y(0.8)), node(X(0.87), Y(1.2))];
    els.push(way({ natural: 'coastline' }, a, [nextId++, nextId++, mid]));
    els.push(way({ natural: 'coastline' }, c, [mid, nextId++, nextId++]));
  }
  return { elements: els };
}

/** DEM mosaic at `zoom` covering the bbox, from fixtureElevation. */
export function syntheticDem(b: BBox = FIXTURE_BBOX, zoom = 15): Dem {
  const t = demTileRange(b, zoom);
  const width = (t.x1 - t.x0 + 1) * 256;
  const height = (t.y1 - t.y0 + 1) * 256;
  const data = new Float32Array(width * height);
  const x0 = t.x0 * 256;
  const y0 = t.y0 * 256;
  const scale = 256 * 2 ** zoom;
  for (let y = 0; y < height; y++) {
    const py = (y0 + y + 0.5) / scale;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * py))) * 180) / Math.PI;
    for (let x = 0; x < width; x++) {
      const lon = ((x0 + x + 0.5) / scale) * 360 - 180;
      data[y * width + x] = fixtureElevation(lon, lat, b);
    }
  }
  void lonToPixel;
  void latToPixel;
  return { zoom, x0, y0, width, height, data };
}

/** Terrarium-encoded RGBA pixels for one 256×256 tile. */
export function terrariumTileRgba(z: number, x: number, y: number, b: BBox = FIXTURE_BBOX): Uint8Array {
  const out = new Uint8Array(256 * 256 * 4);
  const scale = 256 * 2 ** z;
  for (let py = 0; py < 256; py++) {
    const gy = (y * 256 + py + 0.5) / scale;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * gy))) * 180) / Math.PI;
    for (let px = 0; px < 256; px++) {
      const lon = ((x * 256 + px + 0.5) / scale) * 360 - 180;
      const v = fixtureElevation(lon, lat, b) + 32768;
      const i = (py * 256 + px) * 4;
      out[i] = Math.floor(v / 256);
      out[i + 1] = Math.floor(v) % 256;
      out[i + 2] = Math.floor((v - Math.floor(v)) * 256);
      out[i + 3] = 255;
    }
  }
  return out;
}
