/**
 * Turn OSM coastline chains into sea polygons for a rectangular window.
 *
 * OSM convention: coastline ways run with land on the left and water on the
 * right. Each chain is clipped to the window; the resulting pieces enter and
 * leave through the window edge. Following each piece and then walking the
 * window edge clockwise to the next entry point traces the sea polygons.
 */
import polygonClipping from 'polygon-clipping';
import type { Pt, Ring } from './osm';

type MultiPolygon = Pt[][][];

interface Piece {
  pts: Pt[];
  startOnEdge: boolean;
  endOnEdge: boolean;
}

/** Liang–Barsky clip of segment a→b against [0,W]×[0,H]. */
function clipSegment(a: Pt, b: Pt, W: number, H: number): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0], W - a[0], a[1], H - a[1]];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return null;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [t0, t1];
}

const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function inside(p: Pt, W: number, H: number): boolean {
  return p[0] > 0 && p[0] < W && p[1] > 0 && p[1] < H;
}

/** Clip a polyline to the window; returns the pieces that lie inside. */
export function clipPolyline(pts: Pt[], W: number, H: number): Piece[] {
  const pieces: Piece[] = [];
  let cur: Piece | null = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const c = clipSegment(a, b, W, H);
    if (!c || c[1] - c[0] <= 1e-12) {
      if (cur) {
        cur.endOnEdge = true;
        pieces.push(cur);
        cur = null;
      }
      continue;
    }
    const [t0, t1] = c;
    if (!cur) {
      const startOnEdge = t0 > 0 || !inside(a, W, H);
      cur = { pts: [lerp(a, b, t0)], startOnEdge, endOnEdge: false };
    }
    cur.pts.push(lerp(a, b, t1));
    if (t1 < 1) {
      cur.endOnEdge = true;
      pieces.push(cur);
      cur = null;
    }
  }
  if (cur) {
    cur.endOnEdge = !inside(cur.pts[cur.pts.length - 1], W, H);
    pieces.push(cur);
  }
  return pieces;
}

function signedArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
}

export function coastlineWater(chains: { pts: Pt[]; closed: boolean }[], W: number, H: number): MultiPolygon {
  const L = 2 * (W + H);
  const eps = 1e-6 * Math.max(W, H);
  // Clockwise perimeter parameter (y up), starting at the top-left corner.
  const perim = (p: Pt): number => {
    const [x, y] = p;
    if (Math.abs(y - H) < eps) return x;
    if (Math.abs(x - W) < eps) return W + (H - y);
    if (Math.abs(y) < eps) return W + H + (W - x);
    return 2 * W + H + y;
  };
  const corners: { t: number; p: Pt }[] = [
    { t: 0, p: [0, H] },
    { t: W, p: [W, H] },
    { t: W + H, p: [W, 0] },
    { t: 2 * W + H, p: [0, 0] },
  ];

  const pieces: Piece[] = [];
  const islands: Ring[] = [];
  const lakes: Ring[] = [];

  for (const chain of chains) {
    let pts = chain.pts;
    if (pts.length < 2) continue;
    const anyOutside = pts.some((p) => !inside(p, W, H));
    if (chain.closed && !anyOutside) {
      // ring entirely within the window: island (CCW) or enclosed sea (CW)
      const area = signedArea(pts);
      if (area > 0) islands.push(pts);
      else lakes.push(pts);
      continue;
    }
    if (chain.closed) {
      // rotate so the ring starts outside the window, keeping pieces intact
      const k = pts.findIndex((p) => !inside(p, W, H));
      const body = pts.slice(0, -1);
      pts = [...body.slice(k), ...body.slice(0, k), body[k]];
    }
    for (const piece of clipPolyline(pts, W, H)) {
      if (piece.startOnEdge && piece.endOnEdge && piece.pts.length >= 2) pieces.push(piece);
    }
  }

  const water: Ring[] = [];
  const used = new Array(pieces.length).fill(false);
  for (let s = 0; s < pieces.length; s++) {
    if (used[s]) continue;
    used[s] = true;
    const ring: Pt[] = [...pieces[s].pts];
    let cur = s;
    let guard = 0;
    while (guard++ < pieces.length + 2) {
      const exitT = perim(pieces[cur].pts[pieces[cur].pts.length - 1]);
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < pieces.length; i++) {
        if (used[i] && i !== s) continue;
        const d = (perim(pieces[i].pts[0]) - exitT + L) % L;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best < 0) break;
      const passed = corners
        .map((c) => ({ c, d: (c.t - exitT + L) % L }))
        .filter((x) => x.d > eps && x.d < bestD - eps)
        .sort((a, b) => a.d - b.d);
      for (const x of passed) ring.push(x.c.p);
      if (best === s) break;
      used[best] = true;
      ring.push(...pieces[best].pts);
      cur = best;
    }
    if (ring.length >= 3) water.push(ring);
  }

  if (!pieces.length && !islands.length && !lakes.length) return [];

  let result: MultiPolygon = [];
  const close = (r: Ring): Ring => {
    const a = r[0];
    const b = r[r.length - 1];
    return a[0] === b[0] && a[1] === b[1] ? r : [...r, a];
  };
  try {
    let seas: MultiPolygon;
    if (water.length) {
      seas = polygonClipping.union(water.map((r) => [close(r)]) as any);
    } else if (islands.length) {
      // no coastline crosses the window, but islands sit inside it: the window is sea
      seas = [[close([[0, 0], [W, 0], [W, H], [0, H]])]];
    } else {
      seas = [];
    }
    if (lakes.length) seas = polygonClipping.union(seas as any, ...lakes.map((r) => [close(r)] as any));
    if (islands.length && seas.length) seas = polygonClipping.difference(seas as any, ...islands.map((r) => [close(r)] as any));
    result = seas;
  } catch {
    result = water.map((r) => [close(r)]);
  }
  return result;
}
