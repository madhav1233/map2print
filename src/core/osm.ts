/**
 * Parse an Overpass `out geom` JSON response into projected map features.
 */
import type { Projector } from './projection';

export type Pt = [number, number];
export type Ring = Pt[];

interface GeomPt {
  lat: number;
  lon: number;
}

export interface OsmElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  nodes?: number[];
  geometry?: (GeomPt | null)[];
  members?: { type: string; ref: number; role: string; geometry?: (GeomPt | null)[] }[];
}

export interface OsmJson {
  elements: OsmElement[];
}

export interface BuildingFeature {
  id: number;
  outers: Ring[];
  inners: Ring[];
  heightM: number;
  hasHeightTag: boolean;
}

export interface RoadFeature {
  pts: Pt[];
  widthM: number;
  kind: string;
}

export interface LineFeature {
  pts: Pt[];
  widthM: number;
}

/** A polygon given as a set of rings, filled with the even-odd rule. */
export type RingSet = Ring[];

export interface Features {
  buildings: BuildingFeature[];
  roads: RoadFeature[];
  waterAreas: RingSet[];
  /**
   * Water multipolygons only partly delivered (giant rivers / bays): just the
   * member ways that touch the window, as open polylines. Filled by parity
   * with the outside status resolved from the elevation data.
   */
  waterPartials: Pt[][][];
  waterLines: LineFeature[];
  /** Coastline chains (land on the left), projected. `closed` if the chain is a ring. */
  coastlines: { pts: Pt[]; closed: boolean }[];
  parks: RingSet[];
  forests: RingSet[];
  rocks: RingSet[];
  glaciers: RingSet[];
  /** Land-cover relations (parks, forests, rock, glaciers) too large to resolve locally (skipped). */
  partialLandSkipped: number;
}

export function emptyFeatures(): Features {
  return {
    buildings: [],
    roads: [],
    waterAreas: [],
    waterPartials: [],
    waterLines: [],
    coastlines: [],
    parks: [],
    forests: [],
    rocks: [],
    glaciers: [],
    partialLandSkipped: 0,
  };
}

const ROAD_WIDTHS: Record<string, number> = {
  motorway: 16,
  trunk: 14,
  primary: 12,
  secondary: 10,
  tertiary: 9,
  motorway_link: 8,
  trunk_link: 8,
  primary_link: 8,
  secondary_link: 7,
  tertiary_link: 7,
  residential: 7,
  unclassified: 7,
  road: 7,
  living_street: 6,
  pedestrian: 6,
  service: 4,
  busway: 6,
  footway: 2.5,
  path: 2,
  cycleway: 2.5,
  bridleway: 2,
  steps: 2,
  track: 3,
};

const MINOR_SERVICE = new Set(['driveway', 'parking_aisle', 'drive-through', 'alley', 'emergency_access']);
const PATH_KINDS = new Set(['footway', 'path', 'cycleway', 'bridleway', 'steps', 'track']);

const PARK_LEISURE = new Set(['park', 'garden', 'golf_course', 'nature_reserve', 'pitch', 'common', 'dog_park']);
const PARK_LANDUSE = new Set([
  'grass',
  'meadow',
  'recreation_ground',
  'cemetery',
  'village_green',
  'allotments',
  'orchard',
  'vineyard',
]);
const PARK_NATURAL = new Set(['scrub', 'grassland', 'heath']);
const ROCK_NATURAL = new Set(['bare_rock', 'scree', 'shingle']);

/** Land-cover class of an area, most specific first. */
export type LandClass = 'forest' | 'rock' | 'glacier' | 'park';
export function landClass(t: Record<string, string>): LandClass | null {
  if (t.natural === 'glacier') return 'glacier';
  if (t.natural !== undefined && ROCK_NATURAL.has(t.natural)) return 'rock';
  if (t.landuse === 'forest' || t.natural === 'wood') return 'forest';
  if (isPark(t)) return 'park';
  return null;
}

export function parseLength(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim().toLowerCase().replace(',', '.');
  const ftIn = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/);
  if (ftIn) return parseFloat(ftIn[1]) * 0.3048 + (ftIn[2] ? parseFloat(ftIn[2]) * 0.0254 : 0);
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*(m|meters?|metres?|ft|feet)?$/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return undefined;
  return m[2] === 'ft' || m[2] === 'feet' ? n * 0.3048 : n;
}

const SMALL_BUILDINGS: Record<string, number> = {
  house: 7,
  detached: 7,
  semidetached_house: 7,
  terrace: 8,
  bungalow: 4.5,
  garage: 3,
  garages: 3,
  shed: 2.5,
  hut: 3,
  carport: 3,
  roof: 4,
  kiosk: 3,
  cabin: 4,
  toilets: 3,
  service: 3,
};

export function buildingHeight(tags: Record<string, string>): { height: number; tagged: boolean } {
  const h = parseLength(tags.height) ?? parseLength(tags['building:height']);
  if (h !== undefined && h > 0) return { height: Math.max(2, h), tagged: true };
  const levels = parseFloat(tags['building:levels'] ?? '');
  if (isFinite(levels) && levels > 0) {
    const roof = parseFloat(tags['roof:levels'] ?? '');
    return { height: levels * 3.2 + (isFinite(roof) ? roof * 1.6 : 0) + 1, tagged: true };
  }
  const kind = tags.building ?? 'yes';
  return { height: SMALL_BUILDINGS[kind] ?? 9, tagged: false };
}

function key(p: GeomPt): string {
  return `${p.lon.toFixed(7)},${p.lat.toFixed(7)}`;
}

function cleanGeom(g: (GeomPt | null)[] | undefined): GeomPt[] | null {
  if (!g || g.length < 2) return null;
  for (const p of g) if (!p) return null;
  return g as GeomPt[];
}

/** Join way fragments end-to-end into closed rings (multipolygon assembly). */
export function assembleRings(ways: GeomPt[][]): GeomPt[][] {
  const rings: GeomPt[][] = [];
  const open: (GeomPt[] | null)[] = [];
  for (const w of ways) {
    if (w.length < 2) continue;
    if (key(w[0]) === key(w[w.length - 1])) {
      if (w.length >= 4) rings.push(w);
    } else open.push(w);
  }
  const byEnd = new Map<string, number[]>();
  const addEnd = (k: string, i: number) => {
    const l = byEnd.get(k);
    if (l) l.push(i);
    else byEnd.set(k, [i]);
  };
  open.forEach((w, i) => {
    addEnd(key(w![0]), i);
    addEnd(key(w![w!.length - 1]), i);
  });
  const take = (k: string, not: number): number => {
    const l = byEnd.get(k);
    if (!l) return -1;
    for (const i of l) if (i !== not && open[i]) return i;
    return -1;
  };
  for (let s = 0; s < open.length; s++) {
    if (!open[s]) continue;
    let cur = open[s]!.slice();
    open[s] = null;
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 100000) {
      const endK = key(cur[cur.length - 1]);
      const i = take(endK, -1);
      if (i < 0) break;
      const w = open[i]!;
      open[i] = null;
      if (key(w[0]) === endK) cur = cur.concat(w.slice(1));
      else cur = cur.concat(w.slice(0, -1).reverse());
    }
    if (key(cur[0]) === key(cur[cur.length - 1]) && cur.length >= 4) rings.push(cur);
  }
  return rings;
}

/** Chain coastline ways by shared node ids. */
function chainCoastlines(ways: { nodes: number[]; geom: GeomPt[] }[]): { pts: GeomPt[]; closed: boolean }[] {
  const byFirst = new Map<number, number>();
  const lastIds = new Set<number>();
  ways.forEach((w, i) => {
    byFirst.set(w.nodes[0], i);
    lastIds.add(w.nodes[w.nodes.length - 1]);
  });
  const used = new Array(ways.length).fill(false);
  const out: { pts: GeomPt[]; closed: boolean }[] = [];
  const follow = (start: number) => {
    let pts: GeomPt[] = ways[start].geom.slice();
    const firstNode = ways[start].nodes[0];
    let lastNode = ways[start].nodes[ways[start].nodes.length - 1];
    used[start] = true;
    let guard = 0;
    while (lastNode !== firstNode && guard++ < 100000) {
      const nx = byFirst.get(lastNode);
      if (nx === undefined || used[nx]) break;
      used[nx] = true;
      pts = pts.concat(ways[nx].geom.slice(1));
      lastNode = ways[nx].nodes[ways[nx].nodes.length - 1];
    }
    out.push({ pts, closed: lastNode === firstNode });
  };
  // Start at chain heads first (ways nobody flows into), then whatever cycles remain.
  ways.forEach((w, i) => {
    if (!used[i] && !lastIds.has(w.nodes[0])) follow(i);
  });
  ways.forEach((_, i) => {
    if (!used[i]) follow(i);
  });
  return out;
}

export function isRoad(tags: Record<string, string>, includePaths: boolean): boolean {
  const hw = tags.highway;
  if (!hw || !(hw in ROAD_WIDTHS)) return false;
  if (tags.area === 'yes') return false;
  if (tags.tunnel && tags.tunnel !== 'no') return false;
  if (tags.indoor === 'yes') return false;
  if (PATH_KINDS.has(hw) && !includePaths) return false;
  if (hw === 'service' && tags.service && MINOR_SERVICE.has(tags.service) && !includePaths) return false;
  return true;
}

function isWaterArea(t: Record<string, string>): boolean {
  return (
    t.natural === 'water' ||
    t.waterway === 'riverbank' ||
    t.waterway === 'dock' ||
    t.landuse === 'reservoir' ||
    t.landuse === 'basin'
  );
}

function isPark(t: Record<string, string>): boolean {
  return (
    (t.leisure !== undefined && PARK_LEISURE.has(t.leisure)) ||
    (t.landuse !== undefined && PARK_LANDUSE.has(t.landuse)) ||
    (t.natural !== undefined && PARK_NATURAL.has(t.natural))
  );
}

export function parseOsm(json: OsmJson, proj: Projector, opts: { includePaths: boolean }): Features {
  const P = (g: GeomPt[]): Pt[] => g.map((p) => proj.toModel(p.lon, p.lat));
  const f = emptyFeatures();
  const landList = (c: LandClass): RingSet[] =>
    c === 'forest' ? f.forests : c === 'rock' ? f.rocks : c === 'glacier' ? f.glaciers : f.parks;
  const coast: { nodes: number[]; geom: GeomPt[] }[] = [];
  // Relations may arrive without member geometry (`out body`) next to their
  // member ways (`out geom`), so index every way's geometry by id first.
  const wayGeom = new Map<number, GeomPt[]>();
  for (const el of json.elements ?? []) {
    if (el.type === 'way') {
      const g = cleanGeom(el.geometry);
      if (g) wayGeom.set(el.id, g);
    }
  }

  for (const el of json.elements ?? []) {
    const t = el.tags ?? {};
    if (el.type === 'way') {
      const g = cleanGeom(el.geometry);
      if (!g) continue;
      const closed = el.nodes ? el.nodes[0] === el.nodes[el.nodes.length - 1] : key(g[0]) === key(g[g.length - 1]);
      if (t.natural === 'coastline' && el.nodes) {
        coast.push({ nodes: el.nodes, geom: g });
        continue;
      }
      if (t.building && t.building !== 'no' && closed && g.length >= 4) {
        const h = buildingHeight(t);
        f.buildings.push({ id: el.id, outers: [P(g)], inners: [], heightM: h.height, hasHeightTag: h.tagged });
        continue;
      }
      if (t.highway && isRoad(t, opts.includePaths)) {
        const w = (parseLength(t.width) ?? ROAD_WIDTHS[t.highway]) * 1;
        f.roads.push({ pts: P(g), widthM: w, kind: t.highway });
        continue;
      }
      if (isWaterArea(t) && closed && g.length >= 4) {
        f.waterAreas.push([P(g)]);
        continue;
      }
      if ((t.waterway === 'river' || t.waterway === 'canal') && !closed) {
        const w = parseLength(t.width) ?? (t.waterway === 'river' ? 25 : 12);
        f.waterLines.push({ pts: P(g), widthM: w });
        continue;
      }
      const lc = landClass(t);
      if (lc && closed && g.length >= 4) landList(lc).push([P(g)]);
    } else if (el.type === 'relation' && el.members) {
      if (t.type !== 'multipolygon') continue;
      const water = isWaterArea(t);
      const building = !!t.building && t.building !== 'no';
      const land = water || building ? null : landClass(t);
      if (!water && !building && !land) continue;
      const outerWays: GeomPt[][] = [];
      const innerWays: GeomPt[][] = [];
      let missing = 0;
      for (const m of el.members) {
        if (m.type !== 'way') continue;
        const g = cleanGeom(m.geometry) ?? wayGeom.get(m.ref) ?? null;
        if (!g) {
          missing++;
          continue;
        }
        (m.role === 'inner' ? innerWays : outerWays).push(g);
      }
      if (missing > 0 && !building) {
        // Only the members touching the window were delivered.
        if (water && outerWays.length + innerWays.length) f.waterPartials.push([...outerWays, ...innerWays].map(P));
        else if (land) f.partialLandSkipped++;
        continue;
      }
      const outers = assembleRings(outerWays).map(P);
      const inners = assembleRings(innerWays).map(P);
      if (!outers.length) continue;
      if (building) {
        const h = buildingHeight(t);
        f.buildings.push({ id: el.id, outers, inners, heightM: h.height, hasHeightTag: h.tagged });
      } else if (water) {
        f.waterAreas.push([...outers, ...inners]);
      } else if (land) {
        landList(land).push([...outers, ...inners]);
      }
    }
  }

  for (const c of chainCoastlines(coast)) f.coastlines.push({ pts: P(c.pts), closed: c.closed });
  return f;
}
