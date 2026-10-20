/**
 * GPX parsing and route statistics. Regex-based on purpose so it runs the same
 * in the browser, in a Web Worker and in Node tests (no DOMParser needed).
 */

export interface TrackPoint {
  lat: number;
  lon: number;
  ele?: number;
  time?: number; // ms since epoch
}

export interface Stage {
  /** Display name: track name, GPX metadata name or file name. */
  name: string;
  file: string;
  points: TrackPoint[];
  start?: number;
  end?: number;
  distanceM: number;
  ascentM: number;
  descentM: number;
}

const tag = (name: string) => `(?:[\\w-]+:)?${name}`;

function attr(attrs: string, name: string): number {
  const m = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`));
  return m ? parseFloat(m[1]) : NaN;
}

function child(body: string, name: string): string | undefined {
  const m = body.match(new RegExp(`<${tag(name)}[^>]*>([\\s\\S]*?)</${tag(name)}>`));
  return m ? decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim()) : undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, '&');
}

function points(block: string, pointTag: string): TrackPoint[] {
  const re = new RegExp(`<${tag(pointTag)}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag(pointTag)}>)`, 'g');
  const out: TrackPoint[] = [];
  for (const m of block.matchAll(re)) {
    const lat = attr(m[1], 'lat');
    const lon = attr(m[1], 'lon');
    if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const p: TrackPoint = { lat, lon };
    if (m[2]) {
      const ele = parseFloat(child(m[2], 'ele') ?? '');
      if (isFinite(ele)) p.ele = ele;
      const t = Date.parse(child(m[2], 'time') ?? '');
      if (isFinite(t)) p.time = t;
    }
    out.push(p);
  }
  return out;
}

/** Name of a trk/rte block: its own <name>, ignoring names nested in points. */
function blockName(block: string, pointTag: string): string | undefined {
  const firstPoint = block.search(new RegExp(`<${tag(pointTag)}\\b`));
  return child(firstPoint > 0 ? block.slice(0, firstPoint) : block, 'name');
}

export function haversine(a: TrackPoint, b: TrackPoint): number {
  const R = 6371008.8;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Distance and climb, with a small hysteresis so GPS elevation noise doesn't add up. */
export function routeStats(pts: TrackPoint[]): { distanceM: number; ascentM: number; descentM: number } {
  let distanceM = 0;
  for (let i = 1; i < pts.length; i++) distanceM += haversine(pts[i - 1], pts[i]);
  let ascentM = 0;
  let descentM = 0;
  let anchor: number | undefined;
  const threshold = 3;
  for (const p of pts) {
    if (p.ele === undefined) continue;
    if (anchor === undefined) {
      anchor = p.ele;
      continue;
    }
    const d = p.ele - anchor;
    if (d >= threshold) {
      ascentM += d;
      anchor = p.ele;
    } else if (d <= -threshold) {
      descentM -= d;
      anchor = p.ele;
    }
  }
  return { distanceM, ascentM, descentM };
}

function makeStage(name: string, file: string, pts: TrackPoint[]): Stage {
  const times = pts.map((p) => p.time).filter((t): t is number => t !== undefined);
  return {
    name,
    file,
    points: pts,
    start: times.length ? Math.min(...times.slice(0, 50)) : undefined,
    end: times.length ? Math.max(...times.slice(-50)) : undefined,
    ...routeStats(pts),
  };
}

/**
 * Parse a GPX document into stages: one per <trk> (its segments joined), or one
 * per <rte> when the file has no tracks. Throws a readable error for files
 * without usable points.
 */
export function parseGpx(xml: string, fileName = 'route.gpx'): Stage[] {
  if (!/<(?:[\w-]+:)?gpx\b/.test(xml)) throw new Error(`${fileName} isn't a GPX file.`);
  const fileBase = fileName.replace(/\.gpx$/i, '');
  const meta = xml.match(new RegExp(`<${tag('metadata')}\\b[\\s\\S]*?</${tag('metadata')}>`));
  const metaName = meta ? child(meta[0], 'name') : undefined;
  const stages: Stage[] = [];
  const trks = [...xml.matchAll(new RegExp(`<${tag('trk')}\\b[\\s\\S]*?</${tag('trk')}>`, 'g'))];
  for (const [i, m] of trks.entries()) {
    const pts = points(m[0], 'trkpt');
    if (pts.length < 2) continue;
    const name = blockName(m[0], 'trkpt') ?? metaName ?? (trks.length > 1 ? `${fileBase} ${i + 1}` : fileBase);
    stages.push(makeStage(name, fileName, pts));
  }
  if (!stages.length) {
    const rtes = [...xml.matchAll(new RegExp(`<${tag('rte')}\\b[\\s\\S]*?</${tag('rte')}>`, 'g'))];
    for (const [i, m] of rtes.entries()) {
      const pts = points(m[0], 'rtept');
      if (pts.length < 2) continue;
      const name = blockName(m[0], 'rtept') ?? metaName ?? (rtes.length > 1 ? `${fileBase} ${i + 1}` : fileBase);
      stages.push(makeStage(name, fileName, pts));
    }
  }
  if (!stages.length) throw new Error(`${fileName} has no track or route with at least two points.`);
  return stages;
}

/** Chronological order when every stage has timestamps; otherwise keep the given order. */
export function orderStages(stages: Stage[]): Stage[] {
  if (stages.every((s) => s.start !== undefined)) return stages.slice().sort((a, b) => a.start! - b.start!);
  return stages.slice();
}

export interface RouteSummary {
  distanceM: number;
  ascentM: number;
  days: number;
  start?: number;
  end?: number;
  title: string;
  /** Local time offset estimated from the route's longitude, in hours. */
  utcOffsetH: number;
}

/** Hours east of UTC, from longitude (15° per hour): good enough for calendar dates. */
export function offsetFromLongitude(lon: number): number {
  return Math.max(-12, Math.min(14, Math.round(lon / 15)));
}

export function summarize(stages: Stage[]): RouteSummary {
  const distanceM = stages.reduce((n, s) => n + s.distanceM, 0);
  const ascentM = stages.reduce((n, s) => n + s.ascentM, 0);
  const starts = stages.map((s) => s.start).filter((t): t is number => t !== undefined);
  const ends = stages.map((s) => s.end).filter((t): t is number => t !== undefined);
  let lonSum = 0;
  let lonN = 0;
  for (const st of stages) for (let i = 0; i < st.points.length; i += 25) {
    lonSum += st.points[i].lon;
    lonN++;
  }
  const utcOffsetH = offsetFromLongitude(lonN ? lonSum / lonN : 0);
  const dayKeys = new Set(starts.map((t) => new Date(t + utcOffsetH * 3600e3).toISOString().slice(0, 10)));
  const names = [...new Set(stages.map((s) => s.name))];
  // a shared prefix like "Larapinta Trail" across "Larapinta Trail Day 1/2/3"
  let title = names[0] ?? 'My route';
  if (names.length > 1) {
    let p = names[0];
    for (const n of names) while (p && !n.startsWith(p)) p = p.slice(0, -1);
    p = p.replace(/[\s\-–—:,|·]*(day|stage|etappe|section|leg)?\s*\d*\s*$/i, '').trim();
    title = p.length >= 3 ? p : names[0];
  }
  return {
    distanceM,
    ascentM,
    days: Math.max(dayKeys.size, stages.length > 1 && !dayKeys.size ? stages.length : 1),
    start: starts.length ? Math.min(...starts) : undefined,
    end: ends.length ? Math.max(...ends) : undefined,
    title,
    utcOffsetH,
  };
}

export function formatDistance(m: number): string {
  const km = m / 1000;
  return km >= 100 ? `${Math.round(km)} km` : km >= 10 ? `${km.toFixed(1).replace(/\.0$/, '')} km` : `${km.toFixed(1)} km`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "26 Jul 2026", "12–16 Jul 2026", "28 Jun – 3 Jul 2026", as local dates at `offsetH`. */
export function formatDateRange(start?: number, end?: number, offsetH = 0): string {
  if (start === undefined) return '';
  const a = new Date(start + offsetH * 3600e3);
  const b = new Date((end ?? start) + offsetH * 3600e3);
  const d = (x: Date) => x.getUTCDate();
  const mo = (x: Date) => MONTHS[x.getUTCMonth()];
  const y = (x: Date) => x.getUTCFullYear();
  if (a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)) return `${d(a)} ${mo(a)} ${y(a)}`;
  if (y(a) === y(b) && a.getUTCMonth() === b.getUTCMonth()) return `${d(a)}–${d(b)} ${mo(a)} ${y(a)}`;
  if (y(a) === y(b)) return `${d(a)} ${mo(a)} – ${d(b)} ${mo(b)} ${y(a)}`;
  return `${d(a)} ${mo(a)} ${y(a)} – ${d(b)} ${mo(b)} ${y(b)}`;
}
