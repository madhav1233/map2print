/**
 * Geometry for route keepsakes: model footprints (octagon, hexagon, circle),
 * the GPX route as a raised ridge or a slot-in insert with its groove, and a
 * chamfered plinth with raised labels. Uses Manifold (WASM) for exact,
 * always-manifold booleans.
 */
import type { CrossSection, Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import type { MeshData } from './mesh';
import type { Pt } from './osm';
import { metersPerDegree } from './projection';
import type { BBox, Shape } from './types';

// ---------------------------------------------------------------- shapes

/** Unit footprint inside the square [-1, 1]², counter-clockwise. */
export function unitShape(shape: Shape): Pt[] {
  if (shape === 'rectangle') return [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  if (shape === 'circle') return Array.from({ length: 96 }, (_, k) => polar(1, (k / 96) * 2 * Math.PI));
  if (shape === 'octagon') {
    const R = 1 / Math.cos(Math.PI / 8); // flat-to-flat = 2
    return Array.from({ length: 8 }, (_, k) => polar(R, Math.PI / 8 + (k * Math.PI) / 4));
  }
  // hexagon with flat top and bottom (a flat face looks at the viewer)
  return Array.from({ length: 6 }, (_, k) => polar(1, (k * Math.PI) / 3));
}

const polar = (r: number, a: number): Pt => [r * Math.cos(a), r * Math.sin(a)];

/** Footprint polygon in model millimetres for a W×H model. */
export function shapePolygon(shape: Shape, W: number, H: number): Pt[] {
  const cx = W / 2;
  const cy = H / 2;
  if (shape === 'rectangle') return [[0, 0], [W, 0], [W, H], [0, H]];
  const h = Math.min(W, H) / 2;
  return unitShape(shape).map(([x, y]) => [cx + x * h, cy + y * h]);
}

/** Smallest scale of the unit shape (centred at the origin) that contains p. */
function supportScale(shape: Shape, unit: Pt[], p: Pt): number {
  if (shape === 'circle') return Math.hypot(p[0], p[1]);
  let s = 0;
  for (let k = 0; k < unit.length; k++) {
    const a = unit[k];
    const b = unit[(k + 1) % unit.length];
    const nx = b[1] - a[1];
    const ny = a[0] - b[0];
    const d = nx * a[0] + ny * a[1];
    s = Math.max(s, (nx * p[0] + ny * p[1]) / d);
  }
  return s;
}

/**
 * Selection box that frames a route: for a rectangle the route's extent plus a
 * margin; for other shapes the square whose inscribed shape holds the route.
 */
export function fitRouteBox(pts: { lon: number; lat: number }[], shape: Shape, margin = 0.1, minSideM = 600): BBox {
  let w = Infinity;
  let e = -Infinity;
  let s = Infinity;
  let n = -Infinity;
  for (const p of pts) {
    w = Math.min(w, p.lon);
    e = Math.max(e, p.lon);
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
  }
  const c = { lon: (w + e) / 2, lat: (s + n) / 2 };
  const mpd = metersPerDegree(c.lat);
  let hx: number;
  let hy: number;
  if (shape === 'rectangle') {
    hx = Math.max(minSideM / 2, ((e - w) / 2) * mpd.lon * (1 + 2 * margin));
    hy = Math.max(minSideM / 2, ((n - s) / 2) * mpd.lat * (1 + 2 * margin));
  } else {
    const unit = unitShape(shape);
    let k = 0;
    for (const p of pts) k = Math.max(k, supportScale(shape, unit, [(p.lon - c.lon) * mpd.lon, (p.lat - c.lat) * mpd.lat]));
    hx = hy = Math.max(minSideM / 2, k * (1 + margin));
  }
  return { west: c.lon - hx / mpd.lon, east: c.lon + hx / mpd.lon, south: c.lat - hy / mpd.lat, north: c.lat + hy / mpd.lat };
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Douglas–Peucker simplification (iterative). */
export function simplifyLine(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1e-12;
    let worst = -1;
    let worstD = tol2;
    for (let i = a + 1; i < b; i++) {
      const t = Math.max(0, Math.min(1, ((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / len2));
      const ex = ax + dx * t - pts[i][0];
      const ey = ay + dy * t - pts[i][1];
      const d = ex * ex + ey * ey;
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------- Manifold helpers

type Deletable = { delete(): void };

/** Thin wrapper that converts meshes and frees every WASM object it made. */
export class Geo {
  private made: Deletable[] = [];
  constructor(readonly M: ManifoldToplevel) {}

  own<T extends Deletable>(x: T): T {
    this.made.push(x);
    return x;
  }

  dispose(): void {
    for (const x of this.made) {
      try {
        x.delete();
      } catch {
        /* already gone */
      }
    }
    this.made = [];
  }

  solid(d: MeshData): Manifold {
    const mesh = new this.M.Mesh({ numProp: 3, vertProperties: d.positions, triVerts: d.indices });
    mesh.merge();
    return this.own(new this.M.Manifold(mesh));
  }

  mesh(m: Manifold): MeshData {
    const g = m.getMesh();
    const np = g.numProp;
    const n = g.vertProperties.length / np;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = g.vertProperties[i * np];
      positions[i * 3 + 1] = g.vertProperties[i * np + 1];
      positions[i * 3 + 2] = g.vertProperties[i * np + 2];
    }
    return { positions, indices: Uint32Array.from(g.triVerts) };
  }

  section(polys: Pt[][], fill: 'Positive' | 'NonZero' | 'EvenOdd' = 'Positive'): CrossSection {
    return this.own(new this.M.CrossSection(polys as [number, number][][], fill));
  }

  /** Vertical prism over a 2D section, from z0 to z1. */
  prism(cs: CrossSection, z0: number, z1: number): Manifold {
    const e = this.own(cs.extrude(z1 - z0));
    return this.own(e.translate([0, 0, z0]));
  }

  and(a: Manifold, b: Manifold): Manifold {
    return this.own(a.intersect(b));
  }

  minus(a: Manifold, b: Manifold): Manifold {
    return this.own(a.subtract(b));
  }
}

/** Union of capsules (stadium shapes) along polylines: a buffered route. */
export function corridor(geo: Geo, lines: Pt[][], r: number): CrossSection {
  const polys: Pt[][] = [];
  const n = 6; // segments per half circle
  for (const line of lines) {
    for (let k = 0; k + 1 < line.length; k++) {
      const [ax, ay] = line[k];
      const [bx, by] = line[k + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-6) continue;
      const th = Math.atan2(by - ay, bx - ax);
      const poly: Pt[] = [];
      for (let i = 0; i <= n; i++) {
        const a = th - Math.PI / 2 + (i / n) * Math.PI;
        poly.push([bx + r * Math.cos(a), by + r * Math.sin(a)]);
      }
      for (let i = 0; i <= n; i++) {
        const a = th + Math.PI / 2 + (i / n) * Math.PI;
        poly.push([ax + r * Math.cos(a), ay + r * Math.sin(a)]);
      }
      polys.push(poly);
    }
  }
  return geo.section(polys, 'Positive');
}

// ---------------------------------------------------------------- plinth & labels

export interface Glyphs {
  /** Contours of `text` at font size 1, y up, as returned by textContours. */
  contours(text: string): { contours: Pt[][]; x0: number; y0: number; x1: number; y1: number };
}

/** Adapter for an opentype.js Font. */
export function glyphsFromFont(font: { getPath(text: string, x: number, y: number, size: number): any }): Glyphs {
  return {
    contours(text: string) {
      const path = font.getPath(text, 0, 0, 1);
      const contours: Pt[][] = [];
      let cur: Pt[] = [];
      let last: Pt = [0, 0];
      const push = (x: number, y: number) => {
        last = [x, -y];
        cur.push(last);
      };
      for (const c of path.commands) {
        if (c.type === 'M') {
          if (cur.length > 2) contours.push(cur);
          cur = [];
          push(c.x, c.y);
        } else if (c.type === 'L') push(c.x, c.y);
        else if (c.type === 'Q') {
          const [x0, y0] = [last[0], -last[1]];
          for (let i = 1; i <= 4; i++) {
            const t = i / 4;
            const u = 1 - t;
            push(u * u * x0 + 2 * u * t * c.x1 + t * t * c.x, u * u * y0 + 2 * u * t * c.y1 + t * t * c.y);
          }
        } else if (c.type === 'C') {
          const [x0, y0] = [last[0], -last[1]];
          for (let i = 1; i <= 6; i++) {
            const t = i / 6;
            const u = 1 - t;
            push(
              u * u * u * x0 + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
              u * u * u * y0 + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y,
            );
          }
        } else if (c.type === 'Z') {
          if (cur.length > 2) contours.push(cur);
          cur = [];
        }
      }
      if (cur.length > 2) contours.push(cur);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const ring of contours) for (const [x, y] of ring) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      return { contours, x0, y0, x1, y1 };
    },
  };
}

export interface PlateResult {
  base: MeshData;
  labels: MeshData | null;
  labelCount: number;
  warnings: string[];
}

/**
 * Flat base plate under the model: the footprint grown by a rim of `rimMm`
 * on every side, `plateMm` thick, straight-sided. Labels lie flat on the rim
 * in front of the front face and the faces either side of it, raised a few
 * layers, with the tops of the letters towards the model so they read from
 * outside. Everything is parallel to the print bed: no supports, few layers,
 * and the second colour only on the top layers.
 */
export function buildPlate(
  geo: Geo,
  shape: Shape,
  footprint: Pt[],
  W: number,
  H: number,
  plateMm: number,
  rimMm: number,
  texts: { title: string; left: string; right: string } | null,
  glyphs: Glyphs | null,
): PlateResult {
  const warnings: string[] = [];
  const cx = W / 2;
  const cy = H / 2;
  const R = rimMm;
  const local = footprint.map(([x, y]) => [x - cx, y - cy] as Pt);
  // inradius per axis, so the rim is R wide measured square to every face
  let rx: number;
  let ry: number;
  if (shape === 'rectangle') {
    rx = W / 2;
    ry = H / 2;
  } else {
    const h = Math.min(W, H) / 2;
    rx = ry = shape === 'hexagon' ? (h * Math.sqrt(3)) / 2 : h;
  }
  const outline = local.map(([x, y]) => [x * ((rx + R) / rx), y * ((ry + R) / ry)] as Pt);
  const slab = geo.own(geo.section([outline]).extrude(plateMm));
  const base = geo.own(slab.translate([cx, cy, 0]));

  let labels: MeshData | null = null;
  let labelCount = 0;
  const wanted = texts && (texts.title.trim() || texts.left.trim() || texts.right.trim());
  if (wanted && glyphs && R >= 4) {
    // anchors: outward direction n, inner edge distance r, usable width along the rim
    type Anchor = { n: Pt; r: number; width: number; curved: boolean };
    const anchors: Anchor[] = [];
    if (shape === 'circle') {
      const r = rx;
      for (const deg of [-90, -140, -40]) {
        const a = (deg * Math.PI) / 180;
        anchors.push({ n: [Math.cos(a), Math.sin(a)], r, width: Infinity, curved: true });
      }
    } else {
      const n = local.length;
      const faces = local.map((p, k) => {
        const q = local[(k + 1) % n];
        const ex = q[0] - p[0];
        const ey = q[1] - p[1];
        const l = Math.hypot(ex, ey);
        const nx = ey / l;
        const ny = -ex / l;
        return { n: [nx, ny] as Pt, r: nx * p[0] + ny * p[1], width: l };
      });
      let front = 0;
      for (let k = 1; k < n; k++) if (faces[k].n[1] < faces[front].n[1]) front = k;
      for (const k of [front, (front - 1 + n) % n, (front + 1) % n]) anchors.push({ ...faces[k], curved: false });
    }
    const plan: [Anchor, string][] = [
      [anchors[0], texts.title],
      [anchors[1], texts.left],
      [anchors[2], texts.right],
    ];
    const pieces: Manifold[] = [];
    const raise = 0.6; // three 0.2 mm layers
    const embed = 0.4;
    const margin = Math.min(1, R * 0.1);
    for (const [a, raw] of plan) {
      const text = raw.trim();
      if (!text) continue;
      const g = glyphs.contours(text);
      if (!g.contours.length) continue;
      const gw = g.x1 - g.x0;
      const gh = g.y1 - g.y0;
      const d = a.r + R / 2; // centre line of the rim
      let size = Math.min(Math.min(R * 0.6, 10) / gh, (a.width * 0.88) / gw);
      if (a.curved) {
        // straight text on a curved rim: keep the outer corners on the plate
        const outer = a.r + R - margin;
        for (let i = 0; i < 60; i++) {
          const hw = (size * gw) / 2;
          const hh = (size * gh) / 2;
          if (hw * hw + (d + hh) ** 2 <= outer * outer) break;
          size *= 0.95;
        }
      }
      if (size * gh < 2.5) {
        warnings.push(`"${text}" doesn't fit on the rim at a printable size; shorten it or widen the rim.`);
        continue;
      }
      const ox = (g.x0 + g.x1) / 2;
      const oy = (g.y0 + g.y1) / 2;
      const polys = g.contours.map((ring) => ring.map(([x, y]) => [(x - ox) * size, (y - oy) * size] as Pt));
      const cs = geo.section(polys, 'NonZero');
      const piece = geo.own(geo.own(cs.extrude(raise + embed)).translate([0, 0, -embed]));
      // x along the rim (reads left to right from outside), y towards the model, z up
      const e: Pt = [-a.n[1], a.n[0]];
      const o: Pt = [cx + a.n[0] * d, cy + a.n[1] * d];
      const m: Mat4 = [e[0], e[1], 0, 0, -a.n[0], -a.n[1], 0, 0, 0, 0, 1, 0, o[0], o[1], plateMm, 1];
      pieces.push(geo.own(piece.transform(m)));
      labelCount++;
    }
    if (pieces.length) labels = geo.mesh(geo.own(geo.M.Manifold.union(pieces)));
  } else if (wanted && glyphs) {
    warnings.push('The rim is too narrow for labels; make it at least 4 mm wide.');
  }
  return { base: geo.mesh(base), labels, labelCount, warnings };
}
