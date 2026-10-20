/**
 * Full pipeline: DEM + OSM features + settings → printable parts and a
 * print-readiness report. Pure computation; runs in a Web Worker in the app
 * and in Node for tests.
 */
import polygonClipping from 'polygon-clipping';
import { coastlineWater } from './coastline';
import { fieldRange, levelWater, makeGrid, parityMask, rasterizeLine, rasterizeRings, sampleField, type Grid } from './grid';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { buildPlinth, corridor, Geo, pointInPolygon, shapePolygon, simplifyLine, type Glyphs } from './memento';
import { analyzeShell, cleanShell, mergeMeshes, meshBounds, type MeshData } from './mesh';
import { parseOsm, type Features, type OsmJson, type Pt, type Ring } from './osm';
import { Projector, sampleDem } from './projection';
import { cleanRing, extrudePolygon, heartRing, maskSlab, ringArea, roadRibbon, terrainSolid } from './solids';
import {
  GEOM,
  type BBox,
  type Dem,
  type LonLat,
  type ModelResult,
  type PartId,
  type PartResult,
  type Report,
  type Settings,
} from './types';

export interface GenerateInput {
  bbox: BBox;
  dem: Dem;
  osm: OsmJson | null;
  settings: Settings;
  marker?: LonLat | null;
  /** GPX route: one polyline of [lon, lat] per stage. */
  route?: { stages: [number, number][][] } | null;
  /** No OSM land cover was fetched (area too large): treat ground at or below sea level as sea. */
  seaFromDem?: boolean;
}

/** Engines needed for shapes, routes and the plinth (loaded asynchronously by the caller). */
export interface Extras {
  wasm?: ManifoldToplevel;
  glyphs?: Glyphs;
}

/** Does this input need the Manifold geometry engine? */
export function needsGeometryEngine(input: Pick<GenerateInput, 'settings' | 'route'>): boolean {
  const s = input.settings;
  return s.shape !== 'rectangle' || s.include.base || (s.include.route && !!input.route?.stages.some((l) => l.length > 1));
}

export type ProgressFn = (stage: string, fraction?: number) => void;

const WATER = 1;
const PARK = 2;

interface Stats {
  welded: number;
  degenerate: number;
  flipped: number;
  shells: number;
  failed: number;
}

/** Clean a shell and fold its numbers into the running stats. Returns null if it is not watertight. */
function accept(mesh: MeshData, stats: Stats, weld = true): MeshData | null {
  const r = cleanShell(mesh, 1e-5, weld);
  stats.shells++;
  stats.welded += r.welded;
  stats.degenerate += r.degenerate;
  if (r.flipped) stats.flipped++;
  if (!r.analysis.watertight || r.analysis.volume <= 0) {
    stats.failed++;
    return null;
  }
  return r.mesh;
}

export function generateModel(input: GenerateInput, progress: ProgressFn = () => {}, ext: Extras = {}): ModelResult {
  let geo: Geo | null = null;
  if (needsGeometryEngine(input)) {
    if (!ext.wasm) throw new Error('The geometry engine is not loaded.');
    geo = new Geo(ext.wasm);
  }
  try {
    return generateInner(input, progress, ext, geo);
  } finally {
    geo?.dispose();
  }
}

function generateInner(input: GenerateInput, progress: ProgressFn, ext: Extras, geo: Geo | null): ModelResult {
  const { bbox, dem, settings: s } = input;
  const warnings: string[] = [];
  const proj = new Projector(bbox, s.sizeMm);
  const W = proj.widthMm;
  const H = proj.heightMm;
  const g = makeGrid(W, H, s.cellMm);
  const sx = g.nx + 1;
  const nV = (g.nx + 1) * (g.ny + 1);
  const stats: Stats = { welded: 0, degenerate: 0, flipped: 0, shells: 0, failed: 0 };

  progress('Sampling elevation', 0.05);
  const h0 = new Float64Array(nV);
  for (let j = 0; j <= g.ny; j++) {
    for (let i = 0; i <= g.nx; i++) {
      const [lon, lat] = proj.toLonLat(i * g.dx, j * g.dy);
      h0[j * sx + i] = sampleDem(dem, lon, lat);
    }
  }

  progress('Reading OpenStreetMap features', 0.15);
  const features: Features = input.osm
    ? parseOsm(input.osm, proj, { includePaths: s.include.paths })
    : { buildings: [], roads: [], waterAreas: [], waterPartials: [], waterLines: [], coastlines: [], parks: [], partialParksSkipped: 0 };
  if (features.partialParksSkipped) warnings.push(`${features.partialParksSkipped} very large park or forest areas crossing the edge were left untinted.`);

  // ---- land cover masks ----
  progress('Mapping water and parks', 0.25);
  const cover = new Uint8Array(g.nx * g.ny);
  if (s.include.water) {
    for (const rings of features.waterAreas) rasterizeRings(g, rings, cover, WATER, true);
    for (const l of features.waterLines) rasterizeLine(g, l.pts, (l.widthM * proj.scale) / 2, cover, WATER);
    // Giant water bodies delivered only near the window: the boundary fixes
    // the fill up to inversion; water is the side that sits lower in the DEM.
    const cellH = (c: number) => {
      const i = c % g.nx;
      const j = (c - i) / g.nx;
      const v = j * sx + i;
      return (h0[v] + h0[v + 1] + h0[v + sx] + h0[v + sx + 1]) / 4;
    };
    for (const lines of features.waterPartials) {
      const a = parityMask(g, lines);
      let nA = 0;
      let sumA = 0;
      let sumB = 0;
      for (let c = 0; c < a.length; c++) {
        const hc = cellH(c);
        if (a[c]) {
          nA++;
          sumA += hc;
        } else sumB += hc;
      }
      const nB = a.length - nA;
      if (nA === 0 || nB === 0) continue; // boundary never crosses the window: ambiguous, skip
      const meanA = sumA / nA;
      const meanB = sumB / nB;
      const invert = Math.abs(meanA - meanB) < 0.5 ? nA > nB : meanA > meanB;
      for (let c = 0; c < a.length; c++) if (a[c] !== (invert ? 1 : 0)) cover[c] = WATER;
    }
    if (features.coastlines.length) {
      try {
        const sea = coastlineWater(features.coastlines, W, H);
        for (const poly of sea) rasterizeRings(g, poly, cover, WATER, true);
      } catch (e) {
        warnings.push('Coastline could not be resolved; sea areas may be missing.');
      }
    }
  }
  if (s.include.water && !input.osm && input.seaFromDem) {
    for (let c = 0; c < cover.length; c++) {
      const i = c % g.nx;
      const j = (c - i) / g.nx;
      const v = j * sx + i;
      if (Math.max(h0[v], h0[v + 1], h0[v + sx], h0[v + sx + 1]) <= 0) cover[c] = WATER;
    }
  }
  if (s.include.parks) for (const rings of features.parks) rasterizeRings(g, rings, cover, PARK, false);

  let waterCells = 0;
  let parkCells = 0;
  for (let c = 0; c < cover.length; c++) {
    if (cover[c] === WATER) waterCells++;
    else if (cover[c] === PARK) parkCells++;
  }

  // ---- heights ----
  progress('Levelling water', 0.3);
  const lv = s.include.water
    ? levelWater(g, h0, cover.map((c) => (c === WATER ? 1 : 0)))
    : { heights: h0, waterVertex: new Uint8Array(nV), bodies: 0 };
  const h = lv.heights;
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let v = 0; v < nV; v++) {
    if (h[v] < hMin) hMin = h[v];
    if (h[v] > hMax) hMax = h[v];
  }
  const zs = proj.scale * s.terrainExaggeration; // mm per metre of terrain
  const depress = lv.bodies > 0 ? GEOM.waterDepressMm : 0;
  const zSurface = new Float64Array(nV); // ground / water level
  const zTerrain = new Float64Array(nV); // printed terrain top (water recessed)
  for (let v = 0; v < nV; v++) {
    zSurface[v] = s.baseMm + depress + (h[v] - hMin) * zs;
    zTerrain[v] = zSurface[v] - (lv.waterVertex[v] ? depress : 0);
  }

  // ---- footprint, route and groove ----
  const footprint = shapePolygon(s.shape, W, H);
  const shaped = s.shape !== 'rectangle';
  const footCs = geo ? geo.section([footprint]) : null;
  const shapePrism = geo && shaped ? geo.prism(footCs!, -1, 5000) : null;
  const routeLines: Pt[][] = (s.include.route ? (input.route?.stages ?? []) : [])
    .map((st) => simplifyLine(st.map(([lon, lat]) => proj.toModel(lon, lat)), 0.04))
    .filter((l) => l.length >= 2);
  const floorZ = Math.min(1.2, s.baseMm / 2);
  let groove: Manifold | null = null;
  let nearRoute: ((x0: number, y0: number, x1: number, y1: number) => boolean) | null = null;
  if (geo && routeLines.length && s.route.style === 'insert') {
    const r = s.route.widthMm / 2 + s.route.clearanceMm;
    const cs = geo.own(corridor(geo, routeLines, r).intersect(footCs!));
    groove = geo.prism(cs, floorZ, 5000);
    nearRoute = proximity(routeLines, r + 0.5, W, H);
  }
  /** Clip a large part (terrain, slabs) to the footprint and cut the groove. */
  const shapeAndGroove = (m: MeshData): MeshData | null => {
    if (!geo || (!shapePrism && !groove)) return m;
    let r = geo.solid(m);
    if (shapePrism) r = geo.and(r, shapePrism);
    if (groove) r = geo.minus(r, groove);
    return r.isEmpty() ? null : geo.mesh(r);
  };
  /** Same for a small shell (building, road piece, marker): only touch it when needed. */
  const finishShell = (m: MeshData): MeshData | null => {
    if (!geo) return m;
    let out = m;
    if (shapePrism) {
      let allIn = true;
      for (let i = 0; i < out.positions.length && allIn; i += 3) {
        if (!pointInPolygon([out.positions[i], out.positions[i + 1]], footprint)) allIn = false;
      }
      if (!allIn) {
        const r = geo.and(geo.solid(out), shapePrism);
        if (r.isEmpty()) return null;
        out = geo.mesh(r);
      }
    }
    if (groove && nearRoute) {
      const b = meshBounds(out);
      if (nearRoute(b.min[0], b.min[1], b.max[0], b.max[1])) {
        const r = geo.minus(geo.solid(out), groove);
        if (r.isEmpty()) return null;
        out = geo.mesh(r);
      }
    }
    return out;
  };

  progress('Building terrain', 0.4);
  const parts: PartResult[] = [];
  const part = (id: PartId, name: string, mesh: MeshData, shells: number, inStl: boolean) => {
    if (!mesh.indices.length) return;
    if (id === 'route' || id === 'base' || id === 'labels') {
      // produced by Manifold: verify rather than trust
      stats.shells++;
      const a = analyzeShell(mesh);
      if (!a.watertight || a.volume <= 0) stats.failed++;
    }
    parts.push({
      id,
      name,
      slot: s.slots[id],
      color: s.colors[id],
      inStl,
      positions: mesh.positions,
      indices: mesh.indices,
      shells,
    });
  };

  const terrainRaw = terrainSolid(g, zTerrain);
  const terrainClean = cleanShell(terrainRaw);
  stats.shells++;
  stats.welded += terrainClean.welded;
  stats.degenerate += terrainClean.degenerate;
  if (terrainClean.flipped) stats.flipped++;
  const terrainOk = terrainClean.analysis.watertight;
  if (!terrainOk) stats.failed++;
  if (geo) progress('Shaping the terrain', 0.45);
  const terrainMesh = shapeAndGroove(terrainClean.mesh);
  if (terrainMesh) part('terrain', 'Terrain', terrainMesh, 1, true);

  // ---- water & park tint slabs ----
  if (waterCells) {
    const slab = maskSlab(
      g,
      cover,
      WATER,
      (v) => zTerrain[v] + GEOM.waterRaiseMm,
      (v) => Math.max(0.2, zTerrain[v] - GEOM.embedMm),
    );
    const m0 = accept(slab.mesh, stats, false); // corner-touching cells keep separate vertices
    const m = m0 && shapeAndGroove(m0);
    if (m) part('water', 'Water', m, 1, false);
    else warnings.push('Water layer failed the manifold check and was left out.');
  }
  if (parkCells) {
    const slab = maskSlab(
      g,
      cover,
      PARK,
      (v) => zTerrain[v] + GEOM.parkRaiseMm,
      (v) => Math.max(0.2, zTerrain[v] - GEOM.embedMm),
    );
    const m0 = accept(slab.mesh, stats, false); // corner-touching cells keep separate vertices
    const m = m0 && shapeAndGroove(m0);
    if (m) part('parks', 'Parks & green', m, 1, false);
    else warnings.push('Park layer failed the manifold check and was left out.');
  }

  // ---- buildings ----
  let buildingCount = 0;
  let buildingsDropped = 0;
  if (s.include.buildings && features.buildings.length) {
    progress('Extruding buildings', 0.5);
    const rect: Pt[][] = [[...footprint, footprint[0]]];
    const meshes: MeshData[] = [];
    const bScale = proj.scale * s.buildingScale;
    const total = features.buildings.length;
    features.buildings.forEach((b, bi) => {
      if (bi % 500 === 0) progress(`Extruding buildings (${bi}/${total})`, 0.5 + 0.25 * (bi / total));
      let polys: Pt[][][];
      try {
        const close = (r: Ring) => [...r, r[0]];
        const outerPolys = b.outers.map((r) => [close(r)] as any);
        let geom: any = outerPolys.length === 1 ? outerPolys[0] : polygonClipping.union(outerPolys[0], ...outerPolys.slice(1));
        if (b.inners.length) geom = polygonClipping.difference(geom, ...b.inners.map((r) => [close(r)] as any));
        polys = polygonClipping.intersection(geom, rect as any) as Pt[][][];
      } catch {
        buildingsDropped++;
        return;
      }
      if (!polys.length) return; // outside the window
      for (const poly of polys) {
        const rings: Ring[] = [];
        let removed = 0;
        for (const r of poly) {
          const c = cleanRing(r);
          removed += c.removed;
          if (c.ring.length >= 3 && Math.abs(ringArea(c.ring)) > 1e-6) rings.push(c.ring);
          else if (rings.length === 0) break; // outer ring collapsed
        }
        stats.welded += Math.max(0, removed - poly.length); // ignore the closing-point duplicate
        if (!rings.length) {
          buildingsDropped++;
          continue;
        }
        let area = Math.abs(ringArea(rings[0]));
        for (let k = 1; k < rings.length; k++) area -= Math.abs(ringArea(rings[k]));
        if (area < s.minFootprintMm2) {
          buildingsDropped++;
          continue;
        }
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        for (const p of rings[0]) {
          x0 = Math.min(x0, p[0]);
          y0 = Math.min(y0, p[1]);
          x1 = Math.max(x1, p[0]);
          y1 = Math.max(y1, p[1]);
        }
        let [gMin, gMax] = fieldRange(g, zSurface, x0, y0, x1, y1);
        let [tMin] = fieldRange(g, zTerrain, x0, y0, x1, y1);
        for (const p of rings[0]) {
          const zsf = sampleField(g, zSurface, p[0], p[1]);
          gMin = Math.min(gMin, zsf);
          gMax = Math.max(gMax, zsf);
          tMin = Math.min(tMin, sampleField(g, zTerrain, p[0], p[1]));
        }
        const zBot = Math.max(0.2, tMin - GEOM.buildingEmbedMm);
        const zTop = Math.max(gMin + b.heightM * bScale, gMax + s.minBuildingMm);
        const solid = extrudePolygon(rings, zBot, zTop);
        const ok0 = solid ? accept(solid, stats) : null;
        if (!ok0) {
          buildingsDropped++;
          continue;
        }
        const ok = finishShell(ok0);
        if (!ok) continue;
        meshes.push(ok);
        buildingCount++;
      }
    });
    if (meshes.length) part('buildings', 'Buildings', mergeMeshes(meshes), meshes.length, true);
  }

  // ---- roads ----
  let roadSegments = 0;
  if (s.include.roads && features.roads.length) {
    progress('Laying roads', 0.78);
    const meshes: MeshData[] = [];
    const step = Math.max(1, 3 * Math.max(g.dx, g.dy));
    const topAt = (x: number, y: number) => sampleField(g, zSurface, x, y) + GEOM.roadRaiseMm;
    const botAt = (x: number, y: number) => Math.max(0.2, sampleField(g, zTerrain, x, y) - GEOM.embedMm);
    const inside = (p: Pt) => p[0] >= 0 && p[0] <= W && p[1] >= 0 && p[1] <= H;
    for (const r of features.roads) {
      const hw = Math.max(s.minRoadMm, r.widthM * proj.scale * s.roadWidthScale) / 2;
      for (let k = 0; k + 1 < r.pts.length; k++) {
        let a = r.pts[k];
        let b = r.pts[k + 1];
        if (!inside(a) || !inside(b)) {
          const c = clipToRect(a, b, W, H);
          if (!c) continue;
          [a, b] = c;
        }
        if (shaped) {
          const c = clipToConvex(a, b, footprint);
          if (!c) continue;
          [a, b] = c;
        }
        const ribbon = roadRibbon(a, b, hw, k > 0 ? hw : 0, k + 2 < r.pts.length ? hw : 0, step, W, H, topAt, botAt);
        if (!ribbon) continue;
        const ok0 = accept(ribbon, stats);
        const ok = ok0 && finishShell(ok0);
        if (ok) {
          meshes.push(ok);
          roadSegments++;
        }
      }
    }
    if (meshes.length) part('roads', 'Roads', mergeMeshes(meshes), meshes.length, true);
  }

  // ---- marker ----
  if (s.include.marker && input.marker) {
    const [mx, my] = proj.toModel(input.marker.lon, input.marker.lat);
    if (mx > 0 && mx < W && my > 0 && my < H) {
      const size = s.markerSizeMm;
      const ring = heartRing(mx, my, size);
      const half = size / 2;
      const [, gMax] = fieldRange(g, zSurface, mx - half, my - half, mx + half, my + half);
      const [tMin] = fieldRange(g, zTerrain, mx - half, my - half, mx + half, my + half);
      const solid = extrudePolygon([ring], Math.max(0.2, tMin - GEOM.buildingEmbedMm), gMax + 1.6);
      const ok0 = solid ? accept(solid, stats) : null;
      const ok = ok0 && finishShell(ok0);
      if (ok) part('marker', 'Marker', ok, 1, true);
    } else {
      warnings.push('The marker is outside the selected area, so it was left out.');
    }
  }

  // ---- route ----
  let routeInfo: Report['route'] = null;
  if (geo && routeLines.length) {
    progress('Tracing the route', 0.85);
    const cs = geo.own(corridor(geo, routeLines, s.route.widthMm / 2).intersect(footCs!));
    if (!cs.isEmpty()) {
      const top = geo.solid(terrainSolid(g, zSurface.map((z) => z + s.route.raiseMm)));
      let wall = geo.and(geo.prism(cs, floorZ, 5000), top);
      if (s.route.style === 'raised') {
        const below = geo.solid(terrainSolid(g, zTerrain.map((z) => Math.max(0.1, z - GEOM.embedMm))));
        wall = geo.minus(wall, below);
      }
      if (!wall.isEmpty()) {
        part('route', s.route.style === 'insert' ? 'Route insert' : 'Route', geo.mesh(wall), 1, true);
        let lengthMm = 0;
        for (const l of routeLines) for (let k = 1; k < l.length; k++) lengthMm += Math.hypot(l[k][0] - l[k - 1][0], l[k][1] - l[k - 1][1]);
        let zMinT = Infinity;
        for (let v = 0; v < nV; v++) zMinT = Math.min(zMinT, zTerrain[v]);
        routeInfo = {
          style: s.route.style,
          lengthMm,
          widthMm: s.route.widthMm,
          clearanceMm: s.route.clearanceMm,
          grooveDepthMm: s.route.style === 'insert' ? zMinT - floorZ : 0,
          stages: routeLines.length,
        };
      }
    }
    if (!routeInfo) warnings.push('The route lies outside the selected area, so it was left out.');
  }

  // ---- plinth and labels ----
  let baseInfo: Report['base'] = null;
  if (geo && s.include.base) {
    progress('Building the base', 0.9);
    const texts = s.include.labels ? s.base : null;
    if (texts && !ext.glyphs) warnings.push('The label font did not load, so the base has no text.');
    const pl = buildPlinth(geo, s.shape, footprint, W, H, s.base.heightMm, texts, ext.glyphs ?? null);
    warnings.push(...pl.warnings);
    for (const p of parts) for (let i = 2; i < p.positions.length; i += 3) p.positions[i] += s.base.heightMm;
    part('base', 'Base', pl.base, 1, true);
    if (pl.labels) part('labels', 'Labels', pl.labels, pl.labelCount, true);
    baseInfo = { heightMm: s.base.heightMm, labels: pl.labelCount };
  }

  progress('Checking the model', 0.95);
  let triangles = 0;
  const lo: [number, number, number] = [Infinity, Infinity, Infinity];
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    triangles += p.indices.length / 3;
    const b = meshBounds(p);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], b.min[k]);
      hi[k] = Math.max(hi[k], b.max[k]);
    }
  }
  const report: Report = {
    sizeMm: [hi[0] - lo[0], hi[1] - lo[1], hi[2]],
    scale: 1000 / proj.scale,
    triangles,
    buildings: buildingCount,
    buildingsDropped,
    roadSegments,
    elevationRange: [hMin, hMax],
    welded: stats.welded,
    degenerate: stats.degenerate,
    flippedShells: stats.flipped,
    shellsChecked: stats.shells,
    shellsFailed: stats.failed,
    terrainWatertight: terrainOk,
    baseMm: s.baseMm,
    minBuildingMm: s.minBuildingMm,
    waterBodies: lv.bodies,
    waterAreaPct: (100 * waterCells) / cover.length,
    parkAreaPct: (100 * parkCells) / cover.length,
    realSizeM: [proj.widthM, proj.heightM],
    demZoom: dem.zoom,
    warnings,
    shape: s.shape,
    route: routeInfo,
    base: baseInfo,
  };
  progress('Done', 1);
  return { parts, report };
}

function clipToRect(a: Pt, b: Pt, W: number, H: number): [Pt, Pt] | null {
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
  if (t1 - t0 < 1e-9) return null;
  return [
    [a[0] + dx * t0, a[1] + dy * t0],
    [a[0] + dx * t1, a[1] + dy * t1],
  ];
}

/** Cyrus–Beck clip of segment a→b against a convex counter-clockwise polygon. */
function clipToConvex(a: Pt, b: Pt, poly: Pt[]): [Pt, Pt] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k];
    const q = poly[(k + 1) % poly.length];
    // inward normal of a CCW edge
    const nx = -(q[1] - p[1]);
    const ny = q[0] - p[0];
    const num = nx * (a[0] - p[0]) + ny * (a[1] - p[1]);
    const den = nx * dx + ny * dy;
    if (den === 0) {
      if (num < 0) return null;
    } else {
      const t = -num / den;
      if (den > 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return null;
    }
  }
  if (t1 - t0 < 1e-9) return null;
  return [
    [a[0] + dx * t0, a[1] + dy * t0],
    [a[0] + dx * t1, a[1] + dy * t1],
  ];
}

/** Coarse occupancy grid answering "is this box within r of the route?". */
function proximity(lines: Pt[][], r: number, W: number, H: number) {
  const cell = 2;
  const nx = Math.ceil(W / cell) + 1;
  const ny = Math.ceil(H / cell) + 1;
  const occ = new Uint8Array(nx * ny);
  const pad = r + cell;
  for (const l of lines) {
    for (let k = 0; k + 1 < l.length; k++) {
      const [ax, ay] = l[k];
      const [bx, by] = l[k + 1];
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - pad) / cell));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + pad) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - pad) / cell));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + pad) / cell));
      const vx = bx - ax;
      const vy = by - ay;
      const l2 = vx * vx + vy * vy || 1e-12;
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const cx = (i + 0.5) * cell;
          const cy = (j + 0.5) * cell;
          const t = Math.max(0, Math.min(1, ((cx - ax) * vx + (cy - ay) * vy) / l2));
          if (Math.hypot(ax + vx * t - cx, ay + vy * t - cy) <= pad) occ[j * nx + i] = 1;
        }
      }
    }
  }
  return (x0: number, y0: number, x1: number, y1: number): boolean => {
    const i0 = Math.max(0, Math.floor(x0 / cell));
    const i1 = Math.min(nx - 1, Math.floor(x1 / cell));
    const j0 = Math.max(0, Math.floor(y0 / cell));
    const j1 = Math.min(ny - 1, Math.floor(y1 / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (occ[j * nx + i]) return true;
    return false;
  };
}
