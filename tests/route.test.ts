import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { parse as parseFont } from 'opentype.js';
import { formatDateRange, formatDistance, orderStages, parseGpx, summarize } from '../src/core/gpx';
import { fitRouteBox, glyphsFromFont, pointInPolygon, shapePolygon, type Glyphs } from '../src/core/memento';
import { generateModel } from '../src/core/generate';
import { analyzeShell } from '../src/core/mesh';
import { build3mf, partStl, parseBinaryStl } from '../src/core/export';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/types';
import { syntheticDem, syntheticOsm } from './fixtures/synthetic';
import { hikeGpx } from './fixtures/gpx';

let wasm: ManifoldToplevel;
let glyphs: Glyphs;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
  const buf = readFileSync('node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff');
  glyphs = glyphsFromFont(parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
});

describe('GPX', () => {
  it('parses tracks, orders multi-day stages and summarises them', () => {
    const day2 = parseGpx(hikeGpx(2), 'day2.gpx');
    const day1 = parseGpx(hikeGpx(1), 'day1.gpx');
    const stages = orderStages([...day2, ...day1]);
    expect(stages.map((s) => s.name)).toEqual(['Test Trail Day 1', 'Test Trail Day 2']);
    expect(stages[0].points.length).toBe(201);
    expect(stages[0].distanceM).toBeGreaterThan(2000);
    expect(stages[0].ascentM).toBeGreaterThan(0);
    const sum = summarize(stages);
    expect(sum.title).toBe('Test Trail');
    expect(sum.days).toBe(2);
    expect(formatDistance(sum.distanceM)).toMatch(/^\d+(\.\d)? km$/);
    expect(sum.utcOffsetH).toBe(8); // Perth
    expect(formatDateRange(sum.start, sum.end, sum.utcOffsetH)).toBe('26–27 Jul 2026');
  });

  it('handles routes, prefixed tags, entities and missing elevation', () => {
    const xml = `<?xml version="1.0"?><gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1">
      <gpx:rte><gpx:name>Cape to Cape &amp; back</gpx:name>
        <gpx:rtept lat='-33.95' lon='115.07'/><gpx:rtept lat='-33.96' lon='115.08'/><gpx:rtept lat='-33.97' lon='115.07'/>
      </gpx:rte></gpx:gpx>`;
    const [st] = parseGpx(xml, 'c2c.gpx');
    expect(st.name).toBe('Cape to Cape & back');
    expect(st.points).toHaveLength(3);
    expect(st.ascentM).toBe(0);
    expect(() => parseGpx('<gpx></gpx>', 'empty.gpx')).toThrow(/no track or route/);
    expect(() => parseGpx('<html></html>', 'page.html')).toThrow(/isn't a GPX file/);
  });

  it('frames a route so it fits inside the chosen shape', () => {
    const pts = parseGpx(hikeGpx(1)).flatMap((s) => s.points);
    for (const shape of ['octagon', 'hexagon', 'circle', 'rectangle'] as const) {
      const b = fitRouteBox(pts, shape, 0.08);
      // map points into model space of a 100 mm model and test containment
      const W = 100;
      const sx = W / (b.east - b.west);
      const H = (b.north - b.south) * sx * (111_000 / (111_000 * Math.cos((((b.south + b.north) / 2) * Math.PI) / 180)));
      const poly = shapePolygon(shape, W, H);
      const inside = pts.every((p) => pointInPolygon([(p.lon - b.west) * sx, ((p.lat - b.south) / (b.north - b.south)) * H], poly));
      expect(inside, shape).toBe(true);
    }
  });
});

describe('route keepsake pipeline', () => {
  const stages = [...parseGpx(hikeGpx(1)), ...parseGpx(hikeGpx(2))].map((s) => s.points.map((p) => [p.lon, p.lat] as [number, number]));
  const base = (over: Partial<Settings>): Settings => ({
    ...DEFAULT_SETTINGS,
    cellMm: 0.8,
    include: { ...DEFAULT_SETTINGS.include, buildings: true, roads: true, base: true, labels: true },
    base: { heightMm: 10, title: 'Test Trail', left: '27 km', right: '26–27 Jul 2026' },
    ...over,
  });

  it('octagon + slot-in insert + plinth with labels: every part closed, insert fits its groove', () => {
    const settings = base({ shape: 'octagon', route: { ...DEFAULT_SETTINGS.route, style: 'insert' } });
    const fx = { bbox: { west: 115.85, south: -31.965, east: 115.875, north: -31.945 } };
    const t0 = Date.now();
    const r = generateModel({ ...fx, dem: syntheticDem(), osm: syntheticOsm(), settings, route: { stages } }, () => {}, { wasm, glyphs });
    console.log('insert pipeline ms', Date.now() - t0, 'tris', r.report.triangles, JSON.stringify(r.report.route), r.report.warnings);
    const ids = r.parts.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['terrain', 'water', 'route', 'base', 'labels', 'buildings', 'roads']));
    for (const p of r.parts) {
      const a = analyzeShell(p);
      expect(a.boundaryEdges, p.id).toBe(0);
      expect(a.nonManifoldEdges, p.id).toBe(0);
      expect(a.volume, p.id).toBeGreaterThan(0);
    }
    expect(r.report.route?.style).toBe('insert');
    expect(r.report.route?.grooveDepthMm).toBeGreaterThan(1);
    expect(r.report.base?.labels).toBe(3);

    // the insert must not collide with anything it slots into
    const solid = (id: string) => {
      const p = r.parts.find((q) => q.id === id)!;
      const mesh = new wasm.Mesh({ numProp: 3, vertProperties: p.positions, triVerts: p.indices });
      mesh.merge();
      return new wasm.Manifold(mesh);
    };
    const insert = solid('route');
    for (const other of ['terrain', 'water', 'buildings', 'roads']) {
      const o = solid(other);
      expect(insert.intersect(o).volume(), other).toBeLessThan(1e-3);
    }

    // terrain sits on the plinth and stays inside the octagon
    const t = r.parts.find((p) => p.id === 'terrain')!;
    let zMin = Infinity;
    for (let i = 2; i < t.positions.length; i += 3) zMin = Math.min(zMin, t.positions[i]);
    expect(zMin).toBeCloseTo(10, 5);

    // exports
    const files = unzipSync(build3mf(r.parts, 'Test Trail'));
    const cfg = strFromU8(files['Metadata/model_settings.config']);
    expect(cfg).toContain('value="Route insert"');
    expect(cfg).toContain('value="Labels"');
    const ins = parseBinaryStl(partStl(r.parts, 'route'));
    let insZ = Infinity;
    for (let i = 2; i < ins.positions.length; i += 3) insZ = Math.min(insZ, ins.positions[i]);
    expect(insZ).toBe(0);
  });

  it('raised route on a plain rectangle needs no base', () => {
    const settings = base({ include: { ...DEFAULT_SETTINGS.include, buildings: false, roads: false } });
    const r = generateModel(
      { bbox: { west: 115.85, south: -31.965, east: 115.875, north: -31.945 }, dem: syntheticDem(), osm: syntheticOsm(), settings, route: { stages } },
      () => {},
      { wasm, glyphs },
    );
    const route = r.parts.find((p) => p.id === 'route')!;
    expect(route.name).toBe('Route');
    expect(analyzeShell(route).watertight).toBe(true);
    expect(r.parts.some((p) => p.id === 'base')).toBe(false);
    expect(r.report.route?.style).toBe('raised');
  });

  it('city models without route or shape still run without the geometry engine', () => {
    const r = generateModel({ bbox: { west: 115.85, south: -31.965, east: 115.875, north: -31.945 }, dem: syntheticDem(), osm: syntheticOsm(), settings: { ...DEFAULT_SETTINGS, cellMm: 0.8 } });
    expect(r.parts.length).toBeGreaterThan(3);
  });
});
