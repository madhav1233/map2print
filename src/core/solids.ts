/**
 * Closed-solid builders. Every function here returns a watertight,
 * consistently wound (outward normals) shell by construction.
 */
import earcut from 'earcut';
import { MeshBuilder, type MeshData } from './mesh';
import type { Grid } from './grid';
import type { Pt, Ring } from './osm';

/**
 * Wall quad between two vertical edges a and b, outward normal on the right
 * of travel a→b when viewed from above.
 */
function wall(m: MeshBuilder, aBot: number, bBot: number, bTop: number, aTop: number): void {
  m.addTri(aBot, bBot, bTop);
  m.addTri(aBot, bTop, aTop);
}

/**
 * Heightfield solid: top surface from `z` (per grid vertex), vertical side
 * walls and a flat bottom at z = 0.
 */
export function terrainSolid(g: Grid, z: Float64Array): MeshData {
  const m = new MeshBuilder();
  const { nx, ny, dx, dy } = g;
  const sx = nx + 1;
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) m.addVertex(i * dx, j * dy, z[j * sx + i]);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const v00 = j * sx + i;
      const v10 = v00 + 1;
      const v01 = v00 + sx;
      const v11 = v01 + 1;
      // split along the shorter-height diagonal for a smoother surface
      if (Math.abs(z[v00] - z[v11]) <= Math.abs(z[v10] - z[v01])) {
        m.addTri(v00, v10, v11);
        m.addTri(v00, v11, v01);
      } else {
        m.addTri(v00, v10, v01);
        m.addTri(v10, v11, v01);
      }
    }
  }
  // perimeter, counter-clockwise from above
  const perim: number[] = [];
  for (let i = 0; i < nx; i++) perim.push(i);
  for (let j = 0; j < ny; j++) perim.push(j * sx + nx);
  for (let i = nx; i > 0; i--) perim.push(ny * sx + i);
  for (let j = ny; j > 0; j--) perim.push(j * sx);
  const pos = m.pos;
  const bottom = perim.map((t) => m.addVertex(pos[t * 3], pos[t * 3 + 1], 0));
  const center = m.addVertex(g.W / 2, g.H / 2, 0);
  const n = perim.length;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    wall(m, bottom[k], bottom[k2], perim[k2], perim[k]);
    m.addTri(center, bottom[k2], bottom[k]);
  }
  return m.toData();
}

/**
 * Thin slab draped over the grid for the cells in `mask`, from zBot to zTop
 * (per grid vertex). Vertices at diagonal pinch points are duplicated so
 * every edge stays shared by exactly two triangles.
 */
export function maskSlab(
  g: Grid,
  mask: Uint8Array,
  value: number,
  zTop: (v: number) => number,
  zBot: (v: number) => number,
): { mesh: MeshData; cells: number } {
  const m = new MeshBuilder();
  const { nx, ny, dx, dy } = g;
  const sx = nx + 1;
  const inMask = (i: number, j: number) => i >= 0 && j >= 0 && i < nx && j < ny && mask[j * nx + i] === value;
  const top = new Map<number, number>();
  const bot = new Map<number, number>();

  // slot for cell (ci,cj) at vertex (i,j): 0 unless the vertex is a diagonal pinch
  const slot = (i: number, j: number, ci: number, cj: number): number => {
    const sw = inMask(i - 1, j - 1);
    const se = inMask(i, j - 1);
    const nw = inMask(i - 1, j);
    const ne = inMask(i, j);
    const diag = (sw && ne && !se && !nw) || (se && nw && !sw && !ne);
    if (!diag) return 0;
    return cj < j ? 1 : 2;
  };
  const vert = (i: number, j: number, ci: number, cj: number, upper: boolean): number => {
    const v = j * sx + i;
    const k = v * 3 + slot(i, j, ci, cj);
    const map = upper ? top : bot;
    let id = map.get(k);
    if (id === undefined) {
      id = m.addVertex(i * dx, j * dy, upper ? zTop(v) : zBot(v));
      map.set(k, id);
    }
    return id;
  };

  let cells = 0;
  for (let cj = 0; cj < ny; cj++) {
    for (let ci = 0; ci < nx; ci++) {
      if (!inMask(ci, cj)) continue;
      cells++;
      const corners: [number, number][] = [
        [ci, cj],
        [ci + 1, cj],
        [ci + 1, cj + 1],
        [ci, cj + 1],
      ]; // CCW
      const T = corners.map(([i, j]) => vert(i, j, ci, cj, true));
      const B = corners.map(([i, j]) => vert(i, j, ci, cj, false));
      // same diagonal rule as terrainSolid so the slab stays parallel to the ground
      const z = corners.map(([i, j]) => zTop(j * sx + i));
      if (Math.abs(z[0] - z[2]) <= Math.abs(z[1] - z[3])) {
        m.addTri(T[0], T[1], T[2]);
        m.addTri(T[0], T[2], T[3]);
        m.addTri(B[0], B[2], B[1]);
        m.addTri(B[0], B[3], B[2]);
      } else {
        m.addTri(T[0], T[1], T[3]);
        m.addTri(T[1], T[2], T[3]);
        m.addTri(B[0], B[3], B[1]);
        m.addTri(B[1], B[3], B[2]);
      }
      const nb: [number, number][] = [
        [ci, cj - 1],
        [ci + 1, cj],
        [ci, cj + 1],
        [ci - 1, cj],
      ];
      for (let e = 0; e < 4; e++) {
        if (inMask(nb[e][0], nb[e][1])) continue;
        const a = e;
        const b = (e + 1) % 4;
        wall(m, B[a], B[b], T[b], T[a]);
      }
    }
  }
  return { mesh: m.toData(), cells };
}

function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
}

/** Drop closing duplicate, repeated and collinear points. Returns removed count. */
export function cleanRing(r: Ring, eps = 1e-4): { ring: Ring; removed: number } {
  let pts = r.slice();
  let removed = 0;
  if (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps) pts.pop();
  }
  let changed = true;
  while (changed && pts.length >= 3) {
    changed = false;
    const out: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[(i - 1 + pts.length) % pts.length];
      const c = pts[i];
      const n = pts[(i + 1) % pts.length];
      const dup = Math.abs(c[0] - p[0]) < eps && Math.abs(c[1] - p[1]) < eps;
      const cross = (c[0] - p[0]) * (n[1] - c[1]) - (c[1] - p[1]) * (n[0] - c[0]);
      const lenP = Math.hypot(c[0] - p[0], c[1] - p[1]);
      const lenN = Math.hypot(n[0] - c[0], n[1] - c[1]);
      if (dup || Math.abs(cross) < 1e-9 * Math.max(1, lenP * lenN) || lenN * lenP === 0) {
        removed++;
        changed = true;
        continue;
      }
      out.push(c);
    }
    pts = out;
  }
  return { ring: pts, removed };
}

/**
 * Extrude a polygon with holes between zBot and zTop. `rings[0]` is the
 * outer ring, the rest are holes. Returns null when the polygon is too
 * degenerate to triangulate.
 */
export function extrudePolygon(rings: Ring[], zBot: number, zTop: number): MeshData | null {
  if (!rings.length || rings[0].length < 3) return null;
  // enforce orientation: outer CCW, holes CW
  const oriented = rings.map((r, k) => {
    const a = ringArea(r);
    const ccw = a > 0;
    return k === 0 ? (ccw ? r : r.slice().reverse()) : ccw ? r.slice().reverse() : r;
  });
  const flat: number[] = [];
  const holes: number[] = [];
  for (let k = 0; k < oriented.length; k++) {
    if (k > 0) holes.push(flat.length / 2);
    for (const p of oriented[k]) flat.push(p[0], p[1]);
  }
  const tris = earcut(flat, holes.length ? holes : undefined, 2);
  if (tris.length < 3) return null;
  const n = flat.length / 2;
  const m = new MeshBuilder();
  for (let i = 0; i < n; i++) m.addVertex(flat[i * 2], flat[i * 2 + 1], zBot);
  for (let i = 0; i < n; i++) m.addVertex(flat[i * 2], flat[i * 2 + 1], zTop);
  for (let t = 0; t < tris.length; t += 3) {
    let a = tris[t];
    let b = tris[t + 1];
    const c = tris[t + 2];
    const cross =
      (flat[b * 2] - flat[a * 2]) * (flat[c * 2 + 1] - flat[a * 2 + 1]) -
      (flat[b * 2 + 1] - flat[a * 2 + 1]) * (flat[c * 2] - flat[a * 2]);
    if (cross < 0) [a, b] = [b, a];
    m.addTri(n + a, n + b, n + c); // top, CCW
    m.addTri(a, c, b); // bottom, CW
  }
  let start = 0;
  for (const r of oriented) {
    const len = r.length;
    for (let k = 0; k < len; k++) {
      const a = start + k;
      const b = start + ((k + 1) % len);
      wall(m, a, b, n + b, n + a);
    }
    start += len;
  }
  return m.toData();
}

/**
 * Raised road ribbon along segment p0→p1, draped on the terrain. The ribbon
 * is subdivided every `step` mm so it follows the ground; its top follows
 * `surface + raise`, its bottom `ground - embed`. Corners are clamped to the
 * model rectangle.
 */
export function roadRibbon(
  p0: Pt,
  p1: Pt,
  halfWidth: number,
  extendStart: number,
  extendEnd: number,
  step: number,
  W: number,
  H: number,
  topAt: (x: number, y: number) => number,
  botAt: (x: number, y: number) => number,
): MeshData | null {
  const vx = p1[0] - p0[0];
  const vy = p1[1] - p0[1];
  const len = Math.hypot(vx, vy);
  if (len < 1e-6) return null;
  const ux = vx / len;
  const uy = vy / len;
  const nxv = -uy * halfWidth;
  const nyv = ux * halfWidth;
  const sx = p0[0] - ux * extendStart;
  const sy = p0[1] - uy * extendStart;
  const total = len + extendStart + extendEnd;
  const pieces = Math.max(1, Math.ceil(total / step));
  const clampX = (x: number) => Math.max(0, Math.min(W, x));
  const clampY = (y: number) => Math.max(0, Math.min(H, y));
  const m = new MeshBuilder();
  const LT: number[] = [];
  const RT: number[] = [];
  const LB: number[] = [];
  const RB: number[] = [];
  for (let k = 0; k <= pieces; k++) {
    const t = (total * k) / pieces;
    const cx = sx + ux * t;
    const cy = sy + uy * t;
    const lx = clampX(cx + nxv);
    const ly = clampY(cy + nyv);
    const rx = clampX(cx - nxv);
    const ry = clampY(cy - nyv);
    if (Math.hypot(lx - rx, ly - ry) < halfWidth * 0.2) return null;
    LT.push(m.addVertex(lx, ly, topAt(lx, ly)));
    RT.push(m.addVertex(rx, ry, topAt(rx, ry)));
    LB.push(m.addVertex(lx, ly, botAt(lx, ly)));
    RB.push(m.addVertex(rx, ry, botAt(rx, ry)));
  }
  for (let k = 0; k < pieces; k++) {
    m.addTri(RT[k], RT[k + 1], LT[k + 1]);
    m.addTri(RT[k], LT[k + 1], LT[k]);
    m.addTri(RB[k], LB[k + 1], RB[k + 1]);
    m.addTri(RB[k], LB[k], LB[k + 1]);
    wall(m, LB[k + 1], LB[k], LT[k], LT[k + 1]); // left side, outward = +normal
    wall(m, RB[k], RB[k + 1], RT[k + 1], RT[k]); // right side
  }
  wall(m, LB[0], RB[0], RT[0], LT[0]); // start cap
  wall(m, RB[pieces], LB[pieces], LT[pieces], RT[pieces]); // end cap
  return m.toData();
}

/** Heart outline centred on (cx, cy) with overall width `size`, CCW. */
export function heartRing(cx: number, cy: number, size: number, n = 64): Ring {
  const pts: Pt[] = [];
  for (let k = 0; k < n; k++) {
    const t = (k / n) * Math.PI * 2;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    pts.push([cx + (x / 34) * size, cy + ((y + 2) / 34) * size]);
  }
  return ringArea(pts) > 0 ? pts : pts.reverse();
}

export { ringArea };
