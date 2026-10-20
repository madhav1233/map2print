/**
 * Synthetic GPX files: a two-day hike looping through the synthetic city's
 * hills, with elevations from the fixture DEM and timestamps per day.
 */
import { FIXTURE_BBOX, fixtureElevation } from './synthetic';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Points of the whole loop in [u, v] window fractions. */
function loopUV(n: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([0.45 + 0.3 * Math.cos(t) + 0.04 * Math.sin(5 * t), 0.55 + 0.32 * Math.sin(t)]);
  }
  return pts;
}

export function hikeGpx(day: 1 | 2, opts: { withTime?: boolean; name?: string } = {}): string {
  const b = FIXTURE_BBOX;
  const all = loopUV(400);
  const half = Math.floor(all.length / 2);
  const pts = day === 1 ? all.slice(0, half + 1) : all.slice(half);
  const start = Date.UTC(2026, 6, day === 1 ? 25 : 26, 22, 0, 0); // 26 & 27 Jul, 06:00 in Perth
  const body = pts
    .map(([u, v], i) => {
      const lon = lerp(b.west, b.east, u);
      const lat = lerp(b.south, b.north, v);
      const ele = fixtureElevation(lon, lat);
      const time = opts.withTime === false ? '' : `<time>${new Date(start + i * 60000).toISOString()}</time>`;
      return `      <trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>${ele.toFixed(1)}</ele>${time}</trkpt>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="map2print tests" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Test Trail</name></metadata>
  <trk>
    <name>${opts.name ?? `Test Trail Day ${day}`}</name>
    <trkseg>
${body}
    </trkseg>
  </trk>
</gpx>
`;
}
