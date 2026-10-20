import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { analyzeShell, cleanShell, mergeMeshes } from '../src/core/mesh';
import { makeGrid, rasterizeRings, levelWater, parityMask } from '../src/core/grid';
import { extrudePolygon, maskSlab, roadRibbon, terrainSolid, heartRing } from '../src/core/solids';
import { coastlineWater } from '../src/core/coastline';
import { assembleRings, buildingHeight, parseLength } from '../src/core/osm';
import { generateModel } from '../src/core/generate';
import { build3mf, parseBinaryStl, separateStlZip, singleStl } from '../src/core/export';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/types';
import { FIXTURE_BBOX, syntheticDem, syntheticOsm } from './fixtures/synthetic';

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe('solids are watertight by construction', () => {
  it('terrain heightfield solid', () => {
    const g = makeGrid(40, 30, 1);
    const r = rng(1);
    const z = new Float64Array((g.nx + 1) * (g.ny + 1)).map(() => 3 + r() * 5);
    const a = analyzeShell(terrainSolid(g, z));
    expect(a.watertight).toBe(true);
    expect(a.volume).toBeGreaterThan(0);
  });

  it('mask slab with diagonal pinch points', () => {
    const g = makeGrid(30, 30, 1);
    const mask = new Uint8Array(g.nx * g.ny);
    const r = rng(7);
    for (let c = 0; c < mask.length; c++) mask[c] = r() < 0.45 ? 1 : 0;
    // explicit checkerboard block
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) mask[j * g.nx + i] = (i + j) % 2 ? 1 : 0;
    const z = (v: number) => 5 + (v % 7) * 0.1;
    const { mesh, cells } = maskSlab(g, mask, 1, (v) => z(v) + 0.4, (v) => z(v) - 0.4);
    expect(cells).toBeGreaterThan(100);
    const a = analyzeShell(mesh);
    expect(a.boundaryEdges).toBe(0);
    expect(a.nonManifoldEdges).toBe(0);
    expect(a.inconsistentEdges).toBe(0);
    expect(a.volume).toBeGreaterThan(0);
    // the pipeline's clean-up must not glue the pinch vertices back together
    const cleaned = cleanShell(mesh, 1e-5, false);
    expect(cleaned.analysis.watertight).toBe(true);
    expect(cleanShell(mesh).analysis.watertight).toBe(false); // welding would break it
  });

  it('extruded polygon with a hole, either input winding', () => {
    const outer: [number, number][] = [[0, 0], [10, 0], [10, 8], [5, 10], [0, 8]];
    const hole: [number, number][] = [[3, 3], [3, 6], [7, 6], [7, 3]];
    for (const o of [outer, outer.slice().reverse()]) {
      const m = extrudePolygon([o, hole], 1, 6)!;
      const a = analyzeShell(m);
      expect(a.watertight).toBe(true);
      expect(a.volume).toBeCloseTo((10 * 8 + 10 - 12) * 5, 5);
    }
  });

  it('heart marker and road ribbon', () => {
    expect(analyzeShell(extrudePolygon([heartRing(10, 10, 8)], 1, 4)!).watertight).toBe(true);
    const rib = roadRibbon([2, 2], [20, 9], 0.4, 0.4, 0.4, 1.5, 30, 30, (x) => 5 + x * 0.05, () => 3);
    const a = analyzeShell(rib!);
    expect(a.watertight).toBe(true);
    expect(a.volume).toBeGreaterThan(0);
  });
});

describe('map data handling', () => {
  it('parses lengths and building heights', () => {
    expect(parseLength('12')).toBe(12);
    expect(parseLength('12.5 m')).toBe(12.5);
    expect(parseLength('40 ft')).toBeCloseTo(12.192);
    expect(parseLength("10'6\"")).toBeCloseTo(3.2004);
    expect(buildingHeight({ building: 'yes', 'building:levels': '4' }).height).toBeCloseTo(13.8);
    expect(buildingHeight({ building: 'garage' }).height).toBe(3);
  });

  it('assembles multipolygon rings from split, reversed ways', () => {
    const p = (lon: number, lat: number) => ({ lon, lat });
    const rings = assembleRings([
      [p(0, 0), p(1, 0), p(1, 1)],
      [p(0, 0), p(0, 1), p(1, 1)],
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(5);
  });

  it('builds sea polygons from a coastline (water on the right)', () => {
    // coastline running north along x = 5: land west, sea east
    const sea = coastlineWater([{ pts: [[5, -1], [5, 11]], closed: false }], 10, 10);
    expect(sea).toHaveLength(1);
    const g = makeGrid(10, 10, 1);
    const mask = new Uint8Array(100);
    rasterizeRings(g, sea[0], mask, 1);
    expect(mask[5 * 10 + 8]).toBe(1); // east is sea
    expect(mask[5 * 10 + 1]).toBe(0); // west is land
    // island fully inside, no crossing coastline → everything else is sea
    const isl = coastlineWater([{ pts: [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]], closed: true }], 10, 10);
    const m2 = new Uint8Array(100);
    for (const poly of isl) rasterizeRings(g, poly, m2, 1);
    expect(m2[0]).toBe(1);
    expect(m2[5 * 10 + 5]).toBe(0);
  });

  it('fills a polygon known only near the window, up to inversion', () => {
    // band 3 < y < 6 crossing the whole window; caps lie outside
    const g = makeGrid(10, 10, 1);
    const lines: [number, number][][] = [
      [[-5, 6], [15, 6]],
      [[15, 3], [-5, 3]],
      [[4, 4], [6, 4], [6, 5], [4, 5], [4, 4]], // island
    ];
    const m = parityMask(g, lines);
    expect(m[4 * 10 + 1]).toBe(1); // in the band
    expect(m[4 * 10 + 5]).toBe(0); // the island
    expect(m[1 * 10 + 1]).toBe(0); // south of the band
    expect(m[8 * 10 + 8]).toBe(0); // north of the band
  });

  it('levels a lake to its shoreline', () => {
    const g = makeGrid(20, 20, 1);
    const h = new Float64Array(21 * 21).map((_, v) => 10 + (v % 21) * 0.1);
    const water = new Uint8Array(400);
    for (let j = 5; j < 12; j++) for (let i = 5; i < 12; i++) water[j * 20 + i] = 1;
    for (let j = 7; j < 10; j++) for (let i = 7; i < 10; i++) h[j * 21 + i] = -30; // bathymetry
    const r = levelWater(g, h, water);
    expect(r.bodies).toBe(1);
    const inner = r.heights[8 * 21 + 8];
    expect(inner).toBeGreaterThan(9);
    expect(r.heights[6 * 21 + 6]).toBe(inner);
  });
});

describe('full pipeline on the synthetic city', () => {
  const settings: Settings = { ...DEFAULT_SETTINGS, include: { ...DEFAULT_SETTINGS.include, marker: true }, cellMm: 0.6 };
  const center = { lon: (FIXTURE_BBOX.west + FIXTURE_BBOX.east) / 2, lat: (FIXTURE_BBOX.south + FIXTURE_BBOX.north) / 2 };
  const t0 = Date.now();
  const result = generateModel({ bbox: FIXTURE_BBOX, dem: syntheticDem(), osm: syntheticOsm(), settings, marker: center });
  const elapsed = Date.now() - t0;

  it('produces every part and a sane report', () => {
    const ids = result.parts.map((p) => p.id).sort();
    expect(ids).toEqual(['buildings', 'marker', 'parks', 'roads', 'terrain', 'water']);
    const r = result.report;
    expect(r.shellsFailed).toBe(0);
    expect(r.terrainWatertight).toBe(true);
    expect(Math.max(r.sizeMm[0], r.sizeMm[1])).toBeCloseTo(180, 3);
    expect(r.buildings).toBeGreaterThan(200);
    expect(r.buildingsDropped).toBeGreaterThanOrEqual(1); // the shed
    expect(r.roadSegments).toBeGreaterThan(20);
    expect(r.waterBodies).toBeGreaterThanOrEqual(2); // lake + river joined to the sea
    expect(r.elevationRange[0]).toBeGreaterThan(-8); // bathymetry was levelled away
    expect(r.waterAreaPct).toBeGreaterThan(15); // river (partial relation) + sea + lake + pond
    expect(r.waterAreaPct).toBeLessThan(45); // ...and the partial river was not inverted
    console.log(`pipeline ${elapsed} ms`, JSON.stringify({ ...r, warnings: r.warnings }, null, 0));
  });

  it('every part is made of closed, outward-facing shells', () => {
    for (const p of result.parts) {
      const a = analyzeShell(p);
      expect(a.boundaryEdges, p.id).toBe(0);
      expect(a.nonManifoldEdges, p.id).toBe(0);
      expect(a.inconsistentEdges, p.id).toBe(0);
      expect(a.volume, p.id).toBeGreaterThan(0);
    }
  });

  it('terrain has a flat base at z = 0 and starts at the base thickness', () => {
    const t = result.parts.find((p) => p.id === 'terrain')!;
    let zMin = Infinity;
    for (let i = 2; i < t.positions.length; i += 3) zMin = Math.min(zMin, t.positions[i]);
    expect(zMin).toBe(0);
  });

  it('exports STL, a zip of parts and a Bambu-style 3MF', () => {
    const stl = singleStl(result.parts);
    const parsed = parseBinaryStl(stl);
    const expected = result.parts.filter((p) => p.inStl).reduce((n, p) => n + p.indices.length / 3, 0);
    expect(parsed.triangles).toBe(expected);
    const merged = mergeMeshes(result.parts.filter((p) => p.inStl));
    expect(analyzeShell(merged).nonManifoldEdges).toBe(0);

    const zip = unzipSync(separateStlZip(result.parts, 'test'));
    expect(Object.keys(zip).filter((k) => k.endsWith('.stl'))).toHaveLength(result.parts.length);

    const files = unzipSync(build3mf(result.parts, 'Test City'));
    expect(Object.keys(files).sort()).toEqual([
      '3D/3dmodel.model',
      '3D/Objects/object_1.model',
      '3D/_rels/3dmodel.model.rels',
      'Metadata/model_settings.config',
      '[Content_Types].xml',
      '_rels/.rels',
    ]);
    const root = strFromU8(files['3D/3dmodel.model']);
    const sub = strFromU8(files['3D/Objects/object_1.model']);
    const cfg = strFromU8(files['Metadata/model_settings.config']);
    expect((root.match(/<component /g) ?? []).length).toBe(result.parts.length);
    expect((sub.match(/<object /g) ?? []).length).toBe(result.parts.length);
    const tri = (sub.match(/<triangle /g) ?? []).length;
    expect(tri).toBe(result.parts.reduce((n, p) => n + p.indices.length / 3, 0));
    for (const p of result.parts) expect(cfg).toContain(`<metadata key="extruder" value="${p.slot}"/>`);
    expect(cfg).toContain('subtype="normal_part"');
  });
});
