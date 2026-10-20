/**
 * Regular terrain grid: vertex heights, cell masks, rasterisation and water
 * levelling.
 */
import type { Pt, Ring } from './osm';

export interface Grid {
  nx: number; // cells in x
  ny: number; // cells in y
  dx: number; // cell size, mm
  dy: number;
  W: number;
  H: number;
}

export function makeGrid(W: number, H: number, cellMm: number, maxCells = 640): Grid {
  const nx = Math.max(8, Math.min(maxCells, Math.round(W / cellMm)));
  const ny = Math.max(8, Math.min(maxCells, Math.round(H / cellMm)));
  return { nx, ny, dx: W / nx, dy: H / ny, W, H };
}

export const vIndex = (g: Grid, i: number, j: number) => j * (g.nx + 1) + i;

/** Bilinear sample of a vertex field at model position (x, y). */
export function sampleField(g: Grid, f: Float64Array, x: number, y: number): number {
  const fx = Math.max(0, Math.min(g.nx - 1e-9, x / g.dx));
  const fy = Math.max(0, Math.min(g.ny - 1e-9, y / g.dy));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const s = g.nx + 1;
  const a = f[j * s + i];
  const b = f[j * s + i + 1];
  const c = f[(j + 1) * s + i];
  const d = f[(j + 1) * s + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

/** Min / max of a vertex field over the grid vertices inside a box, plus extra sample points. */
export function fieldRange(
  g: Grid,
  f: Float64Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  const i0 = Math.max(0, Math.floor(x0 / g.dx));
  const i1 = Math.min(g.nx, Math.ceil(x1 / g.dx));
  const j0 = Math.max(0, Math.floor(y0 / g.dy));
  const j1 = Math.min(g.ny, Math.ceil(y1 / g.dy));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const v = f[j * (g.nx + 1) + i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return [lo, hi];
}

/**
 * Even-odd scanline fill of cell centres covered by a set of rings.
 * Writes `value` into `mask` for covered cells where `mask` is currently 0
 * (unless `overwrite`).
 */
export function rasterizeRings(g: Grid, rings: Ring[], mask: Uint8Array, value: number, overwrite = false): number {
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const r of rings) for (const p of r) {
    if (p[1] < ymin) ymin = p[1];
    if (p[1] > ymax) ymax = p[1];
  }
  const jStart = Math.max(0, Math.ceil(ymin / g.dy - 0.5));
  const jEnd = Math.min(g.ny - 1, Math.ceil(ymax / g.dy - 0.5) - 1);
  if (jEnd < jStart) return 0;
  const rows: number[][] = [];
  for (let j = jStart; j <= jEnd; j++) rows.push([]);
  for (const r of rings) {
    const n = r.length;
    for (let k = 0; k < n; k++) {
      const a = r[k];
      const b = r[(k + 1) % n];
      if (a[1] === b[1]) continue;
      const lo = Math.min(a[1], b[1]);
      const hi = Math.max(a[1], b[1]);
      const j0 = Math.max(jStart, Math.ceil(lo / g.dy - 0.5));
      const j1 = Math.min(jEnd, Math.ceil(hi / g.dy - 0.5) - 1);
      for (let j = j0; j <= j1; j++) {
        const yc = (j + 0.5) * g.dy;
        rows[j - jStart].push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
    }
  }
  let count = 0;
  for (let j = jStart; j <= jEnd; j++) {
    const xs = rows[j - jStart];
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] / g.dx - 0.5));
      const i1 = Math.min(g.nx - 1, Math.ceil(xs[k + 1] / g.dx - 0.5) - 1);
      for (let i = i0; i <= i1; i++) {
        const c = j * g.nx + i;
        if (overwrite || mask[c] === 0) {
          mask[c] = value;
          count++;
        }
      }
    }
  }
  return count;
}

/** Mark cells whose centre lies within `halfWidth` of the polyline. */
export function rasterizeLine(g: Grid, pts: Pt[], halfWidth: number, mask: Uint8Array, value: number): void {
  const r = Math.max(halfWidth, 0.5 * Math.max(g.dx, g.dy));
  const r2 = r * r;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r) / g.dx));
    const i1 = Math.min(g.nx - 1, Math.floor((Math.max(ax, bx) + r) / g.dx));
    const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r) / g.dy));
    const j1 = Math.min(g.ny - 1, Math.floor((Math.max(ay, by) + r) / g.dy));
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy || 1e-12;
    for (let j = j0; j <= j1; j++) {
      const cy = (j + 0.5) * g.dy;
      for (let i = i0; i <= i1; i++) {
        const cx = (i + 0.5) * g.dx;
        const t = Math.max(0, Math.min(1, ((cx - ax) * vx + (cy - ay) * vy) / len2));
        const ex = ax + vx * t - cx;
        const ey = ay + vy * t - cy;
        if (ex * ex + ey * ey <= r2) mask[j * g.nx + i] = value;
      }
    }
  }
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)));
  return s[idx];
}

/**
 * Flatten each connected water body. Lakes, ponds, harbours and the sea get a
 * single level taken from a low percentile of their shoreline; long rivers
 * whose banks drop noticeably get a smooth surface interpolated from the
 * shoreline instead, so they still run downhill.
 *
 * Returns the levelled heights, the per-vertex water flag and the number of
 * water bodies.
 */
export function levelWater(
  g: Grid,
  h: Float64Array,
  water: Uint8Array,
): { heights: Float64Array; waterVertex: Uint8Array; bodies: number } {
  const { nx, ny } = g;
  const sx = nx + 1;
  const out = new Float64Array(h);
  const waterVertex = new Uint8Array((nx + 1) * (ny + 1));
  const comp = new Int32Array(nx * ny).fill(-1);
  let bodies = 0;
  const cellCorners = (c: number): number[] => {
    const i = c % nx;
    const j = (c - i) / nx;
    return [j * sx + i, j * sx + i + 1, (j + 1) * sx + i, (j + 1) * sx + i + 1];
  };
  // mark water vertices
  for (let c = 0; c < nx * ny; c++) if (water[c]) for (const v of cellCorners(c)) waterVertex[v] = 1;
  // is a vertex touching a land cell?
  const touchesLand = (v: number): boolean => {
    const i = v % sx;
    const j = (v - i) / sx;
    for (const [ci, cj] of [
      [i - 1, j - 1],
      [i, j - 1],
      [i - 1, j],
      [i, j],
    ]) {
      if (ci < 0 || cj < 0 || ci >= nx || cj >= ny) continue;
      if (!water[cj * nx + ci]) return true;
    }
    return false;
  };

  const stack: number[] = [];
  for (let seed = 0; seed < nx * ny; seed++) {
    if (!water[seed] || comp[seed] >= 0) continue;
    const id = bodies++;
    const cells: number[] = [];
    comp[seed] = id;
    stack.push(seed);
    while (stack.length) {
      const c = stack.pop()!;
      cells.push(c);
      const i = c % nx;
      const j = (c - i) / nx;
      const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1];
      for (const n of nb) {
        if (n >= 0 && water[n] && comp[n] < 0) {
          comp[n] = id;
          stack.push(n);
        }
      }
    }
    const verts = new Set<number>();
    for (const c of cells) for (const v of cellCorners(c)) verts.add(v);
    const shore: number[] = [];
    const shoreVals: number[] = [];
    for (const v of verts) {
      if (touchesLand(v)) {
        shore.push(v);
        shoreVals.push(h[v]);
      }
    }
    if (!shoreVals.length) {
      const all = [...verts].map((v) => h[v]);
      const level = percentile(all, 0.9);
      for (const v of verts) out[v] = level;
      continue;
    }
    const level = percentile(shoreVals, 0.2);
    const spread = percentile(shoreVals, 0.9) - percentile(shoreVals, 0.1);
    if (spread < 5 || shore.length < 40) {
      for (const v of verts) out[v] = level;
      continue;
    }
    // Sloping river: pin the shoreline (clamped to a robust band) and relax
    // the interior towards a harmonic surface.
    const lo = percentile(shoreVals, 0.05);
    const hi = percentile(shoreVals, 0.95);
    const isShore = new Set(shore);
    for (const v of shore) out[v] = Math.max(lo, Math.min(hi, h[v]));
    const interior = [...verts].filter((v) => !isShore.has(v));
    for (const v of interior) out[v] = level;
    for (let it = 0; it < 250; it++) {
      for (const v of interior) {
        const i = v % sx;
        const j = (v - i) / sx;
        let sum = 0;
        let n = 0;
        if (i > 0) { sum += out[v - 1]; n++; }
        if (i < nx) { sum += out[v + 1]; n++; }
        if (j > 0) { sum += out[v - sx]; n++; }
        if (j < ny) { sum += out[v + sx]; n++; }
        out[v] = out[v] + 1.7 * (sum / n - out[v]);
      }
    }
  }
  return { heights: out, waterVertex, bodies };
}
