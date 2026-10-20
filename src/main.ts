import '@fontsource/barlow/latin-400.css';
import '@fontsource/barlow/latin-500.css';
import '@fontsource/barlow/latin-600.css';
import '@fontsource/barlow-condensed/latin-600.css';
import '@fontsource/barlow-condensed/latin-700.css';
import './style.css';
import { MapView, MAX_SIDE_KM, boxAround, formatKm } from './mapView';
import { Preview } from './preview';
import { fetchDem, fetchOsm, searchPlaces, type Place } from './fetchers';
import { bboxSizeMeters } from './core/projection';
import { DEFAULT_SETTINGS, PART_ORDER, type BBox, type LonLat, type PartId, type PartResult, type Report, type Settings } from './core/types';
import type { WorkerRequest, WorkerResponse } from './worker';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const LAYER_NAMES: Record<PartId, string> = {
  terrain: 'Terrain & base',
  buildings: 'Buildings',
  roads: 'Roads',
  water: 'Water',
  parks: 'Parks & green space',
  marker: 'Heart marker',
};

// ---------- persisted settings ----------
const STORE_KEY = 'map2print:v1';
interface Saved {
  settings: Settings;
  bbox: BBox | null;
  place: string;
  marker: LonLat | null;
}
function loadSaved(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function save(): void {
  try {
    const data: Saved = { settings: readSettings(), bbox: mapView.getBBox(), place: placeName, marker };
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable: fine */
  }
}

const saved = loadSaved();
const settings: Settings = structuredClone(DEFAULT_SETTINGS);
if (saved.settings) {
  Object.assign(settings, saved.settings);
  settings.include = { ...DEFAULT_SETTINGS.include, ...saved.settings.include };
  settings.slots = { ...DEFAULT_SETTINGS.slots, ...saved.settings.slots };
  settings.colors = { ...DEFAULT_SETTINGS.colors, ...saved.settings.colors };
}
let placeName = saved.place ?? 'Lower Manhattan';
let marker: LonLat | null = saved.marker ?? null;
let searchedPoint: LonLat | null = null;

// ---------- map ----------
const mapView = new MapView($('map'));
const preview = new Preview($('preview'));
const DEFAULT_BBOX: BBox = { west: -74.023, east: -73.992, south: 40.6995, north: 40.7215 };

// ---------- form wiring ----------
const sizeEl = $<HTMLInputElement>('size');
const baseEl = $<HTMLInputElement>('base');
const exagEl = $<HTMLInputElement>('exag');
const bscaleEl = $<HTMLInputElement>('bscale');
const detailEl = $<HTMLSelectElement>('detail');
const pathsEl = $<HTMLInputElement>('paths');
const squareEl = $<HTMLInputElement>('square');

sizeEl.value = String(settings.sizeMm);
baseEl.value = String(settings.baseMm);
exagEl.value = String(settings.terrainExaggeration);
bscaleEl.value = String(settings.buildingScale);
detailEl.value = String(settings.cellMm);
if (![...detailEl.options].some((o) => o.value === detailEl.value)) detailEl.value = '0.5';
pathsEl.checked = settings.include.paths;

const legend = $('legend');
for (const id of PART_ORDER) {
  const li = document.createElement('li');
  const on = id === 'terrain' || settings.include[id as keyof Settings['include']];
  li.innerHTML = `
    <span class="swatch"><input type="color" aria-label="${LAYER_NAMES[id]} colour" data-color="${id}" value="${settings.colors[id]}"></span>
    <label class="${on ? '' : 'is-off'}"><input type="checkbox" data-layer="${id}" ${on ? 'checked' : ''} ${id === 'terrain' ? 'disabled' : ''}> ${LAYER_NAMES[id]}</label>
    <select data-slot="${id}" aria-label="${LAYER_NAMES[id]} filament slot">${Array.from({ length: 8 }, (_, k) => `<option value="${k + 1}" ${settings.slots[id] === k + 1 ? 'selected' : ''}>${k + 1}</option>`).join('')}</select>`;
  legend.appendChild(li);
}

function readSettings(): Settings {
  const num = (el: HTMLInputElement, lo: number, hi: number, d: number) => {
    const v = parseFloat(el.value);
    return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  };
  const s: Settings = structuredClone(settings);
  s.sizeMm = num(sizeEl, 40, 400, 180);
  s.baseMm = num(baseEl, 1, 20, 4);
  s.terrainExaggeration = num(exagEl, 0.5, 10, 1.5);
  s.buildingScale = num(bscaleEl, 0.5, 5, 1);
  s.cellMm = parseFloat(detailEl.value) || 0.5;
  s.include.paths = pathsEl.checked;
  legend.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((el) => {
    const id = el.dataset.layer as PartId;
    if (id !== 'terrain') s.include[id as keyof Settings['include']] = el.checked;
  });
  legend.querySelectorAll<HTMLSelectElement>('select[data-slot]').forEach((el) => {
    s.slots[el.dataset.slot as PartId] = parseInt(el.value, 10);
  });
  legend.querySelectorAll<HTMLInputElement>('input[data-color]').forEach((el) => {
    s.colors[el.dataset.color as PartId] = el.value;
  });
  return s;
}

// ---------- area readout ----------
function updateArea(b: BBox | null): void {
  const el = $('area-readout');
  const gen = $<HTMLButtonElement>('generate');
  if (!b) {
    el.className = 'area-readout is-empty';
    el.textContent = 'No area selected yet';
    gen.disabled = true;
    return;
  }
  const { width, height } = bboxSizeMeters(b);
  const over = Math.max(width, height) > MAX_SIDE_KM * 1000;
  el.className = 'area-readout';
  el.innerHTML = `${formatKm(width)} × ${formatKm(height)}${over ? `<span class="over">Keep each side under ${MAX_SIDE_KM} km so OpenStreetMap can return the data.</span>` : ''}`;
  gen.disabled = over || busy;
  $('stage-hint').hidden = true;
}

mapView.onChange = (b) => {
  updateArea(b);
  if (b && marker && !inside(marker, b)) placeMarkerDefault();
  markStale();
  save();
};
mapView.onDrawMode = (on) => {
  $('draw-btn').textContent = on ? 'Cancel drawing' : 'Draw new area';
  const hint = $('stage-hint');
  hint.textContent = 'Drag on the map to outline your region';
  hint.hidden = !on && !!mapView.getBBox();
};
mapView.onMarkerMove = (p) => {
  marker = p;
  markStale();
  save();
};

$('draw-btn').addEventListener('click', () => {
  showView('map');
  mapView.setDrawMode(!mapView.drawMode);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mapView.drawMode) mapView.setDrawMode(false);
});
squareEl.addEventListener('change', () => {
  mapView.square = squareEl.checked;
  mapView.applySquare();
});

const inside = (p: LonLat, b: BBox) => p.lon > b.west && p.lon < b.east && p.lat > b.south && p.lat < b.north;

function placeMarkerDefault(): void {
  const b = mapView.getBBox();
  if (!b) return;
  marker = searchedPoint && inside(searchedPoint, b) ? searchedPoint : { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 };
  syncMarker();
}

function syncMarker(): void {
  const on = (legend.querySelector('input[data-layer="marker"]') as HTMLInputElement).checked;
  if (on && !marker) placeMarkerDefault();
  mapView.showPin(on ? marker : null);
}

legend.addEventListener('change', (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement && t.dataset.layer) {
    t.closest('label')!.classList.toggle('is-off', !t.checked);
    if (t.dataset.layer === 'marker') syncMarker();
    markStale();
  }
  save();
});
legend.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  if (t.dataset.color) preview.setColor(t.dataset.color as PartId, t.value);
});
for (const el of [sizeEl, baseEl, exagEl, bscaleEl, detailEl, pathsEl]) {
  el.addEventListener('change', () => {
    markStale();
    save();
  });
}

// ---------- search ----------
const results = $<HTMLUListElement>('search-results');
let searchAbort: AbortController | null = null;
$('search').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>('search-input').value.trim();
  if (!q) return;
  searchAbort?.abort();
  searchAbort = new AbortController();
  results.hidden = false;
  results.innerHTML = '<li class="muted">Searching…</li>';
  try {
    const places = await searchPlaces(q, searchAbort.signal);
    if (!places.length) {
      results.innerHTML = '<li class="muted">No places found. Try a city name or a street address.</li>';
      return;
    }
    results.innerHTML = '';
    for (const p of places) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = p.name;
      btn.addEventListener('click', () => choosePlace(p));
      li.appendChild(btn);
      results.appendChild(li);
    }
    (results.querySelector('button') as HTMLButtonElement | null)?.focus();
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    results.innerHTML = `<li class="muted">${(err as Error).message}</li>`;
  }
});
document.addEventListener('click', (e) => {
  if (!(e.target as HTMLElement).closest('#search')) results.hidden = true;
});

function choosePlace(p: Place): void {
  results.hidden = true;
  placeName = p.name.split(',')[0];
  searchedPoint = { lon: p.lon, lat: p.lat };
  // Default to a 2 km square around the result, or the place itself if it is smaller.
  let side = 2000;
  if (p.bbox) {
    const { width, height } = bboxSizeMeters(p.bbox);
    const extent = Math.max(width, height);
    if (extent > 300 && extent < 2000) side = Math.max(800, extent * 1.2);
  }
  mapView.setBBox(boxAround(searchedPoint, side, side));
  mapView.fitSelection();
  marker = searchedPoint;
  syncMarker();
  showView('map');
  save();
}

// ---------- views ----------
function showView(v: 'map' | '3d'): void {
  $('tab-map').setAttribute('aria-selected', String(v === 'map'));
  $('tab-3d').setAttribute('aria-selected', String(v === '3d'));
  $('preview').hidden = v !== '3d';
  $('map').style.visibility = v === 'map' ? 'visible' : 'hidden';
  if (v === '3d') preview.resize();
  else mapView.invalidate();
}
$('tab-map').addEventListener('click', () => showView('map'));
$('tab-3d').addEventListener('click', () => showView('3d'));

// ---------- worker ----------
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
type Req = WorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;
const pending = new Map<number, (r: WorkerResponse) => void>();
let nextId = 1;
worker.onmessage = (e: MessageEvent<WorkerResponse>) => pending.get(e.data.id)?.(e.data);
function ask(req: Req, onProgress?: (stage: string, f?: number) => void): Promise<WorkerResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, (r) => {
      if (r.type === 'progress') return onProgress?.(r.stage, r.fraction);
      pending.delete(id);
      resolve(r);
    });
    worker.postMessage({ ...req, id } as WorkerRequest);
  });
}

// ---------- generate ----------
let busy = false;
let generated = false;
let lastReport: Report | null = null;
let abort: AbortController | null = null;

function setProgress(f: number, text: string): void {
  $('progress').hidden = false;
  $('progress-fill').style.width = `${Math.round(f * 100)}%`;
  $('progress-text').textContent = text;
}

function showError(msg: string | null): void {
  const el = $('error');
  el.hidden = !msg;
  el.textContent = msg ?? '';
}

function markStale(): void {
  if (generated) $('generate').textContent = 'Generate again with these settings';
}

$('generate').addEventListener('click', async () => {
  const bbox = mapView.getBBox();
  if (!bbox || busy) return;
  const s = readSettings();
  busy = true;
  const gen = $<HTMLButtonElement>('generate');
  gen.disabled = true;
  gen.textContent = 'Generating…';
  showError(null);
  abort = new AbortController();
  try {
    const { width, height } = bboxSizeMeters(bbox);
    const mmPerM = s.sizeMm / Math.max(width, height);
    const cellM = s.cellMm / mmPerM;
    setProgress(0.02, 'Downloading elevation tiles');
    const dem = await fetchDem(bbox, cellM, (d, t) => setProgress(0.02 + 0.28 * (d / t), `Downloading elevation tiles (${d} of ${t})`), abort.signal);
    const needOsm = s.include.buildings || s.include.roads || s.include.water || s.include.parks;
    let osm = null;
    if (needOsm) {
      setProgress(0.32, 'Querying OpenStreetMap');
      osm = await fetchOsm(bbox, { includePaths: s.include.paths }, (m) => setProgress(0.34, m), abort.signal);
    }
    setProgress(0.55, 'Building the model');
    const res = await ask(
      { type: 'generate', input: { bbox, dem, osm, settings: s, marker: s.include.marker ? marker : null } },
      (stage, f) => setProgress(0.55 + 0.45 * (f ?? 0), stage),
    );
    if (res.type === 'error') throw new Error(res.message);
    if (res.type !== 'result') throw new Error('Unexpected response from the model builder.');
    showResult(res.parts, res.report);
    generated = true;
    $('progress').hidden = true;
  } catch (e) {
    if ((e as Error).name !== 'AbortError') showError((e as Error).message);
    $('progress').hidden = true;
  } finally {
    busy = false;
    gen.disabled = !mapView.getBBox();
    gen.textContent = generated ? 'Generate again' : 'Generate model';
  }
});

const ok = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm-1.2 12.7L4.9 9.8l1.4-1.4 2.5 2.5 5-5 1.4 1.4z"/></svg>';
const bad = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm3.5 11.1-1.4 1.4L10 11.4l-2.1 2.1-1.4-1.4L8.6 10 6.5 7.9l1.4-1.4L10 8.6l2.1-2.1 1.4 1.4-2.1 2.1z"/></svg>';
const warnIcon = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1.5 19 18H1zm-1 6v5h2v-5zm0 6.5v2h2v-2z"/></svg>';

const fmt = (n: number) => n.toLocaleString('en-US');

function niceDistance(maxM: number): number {
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];
  let best = steps[0];
  for (const s of steps) if (s <= maxM) best = s;
  return best;
}

function showResult(parts: PartResult[], r: Report): void {
  lastReport = r;
  preview.setParts(
    parts.map((p) => ({ id: p.id, color: readSettings().colors[p.id], positions: p.positions, indices: p.indices })),
    r.sizeMm,
  );
  $('tab-3d').removeAttribute('disabled');
  showView('3d');

  const checks: [string, string][] = [];
  const has = (id: PartId) => parts.some((p) => p.id === id);
  checks.push(
    r.terrainWatertight
      ? ['ok', 'Terrain shell is watertight and manifold: every edge is shared by exactly two faces']
      : ['bad', 'Terrain shell has open or non-manifold edges'],
  );
  checks.push(['ok', `${fmt(r.welded)} duplicate vertices welded, ${fmt(r.degenerate)} degenerate triangles removed`]);
  checks.push(
    r.shellsFailed === 0
      ? ['ok', `Outward-facing normals with consistent winding on all ${fmt(r.shellsChecked)} shells`]
      : ['warn', `${fmt(r.shellsFailed)} of ${fmt(r.shellsChecked)} shells failed checks and were left out`],
  );
  checks.push(['ok', `Flat ${r.baseMm} mm base, so no supports are needed`]);
  if (has('buildings') || r.buildingsDropped)
    checks.push([
      'ok',
      `${fmt(r.buildings)} buildings extruded and embedded into the terrain (min height ${r.minBuildingMm} mm, ${fmt(r.buildingsDropped)} unprintably small footprints dropped)`,
    ]);
  if (has('roads')) checks.push(['ok', `${fmt(r.roadSegments)} road segments raised onto the terrain`]);
  if (has('water') || has('parks')) {
    const bits = [];
    if (has('water')) bits.push(`${r.waterBodies} water ${r.waterBodies === 1 ? 'body' : 'bodies'} levelled and tinted (${r.waterAreaPct.toFixed(0)}% of the area)`);
    if (has('parks')) bits.push(`parks and green space tinted (${r.parkAreaPct.toFixed(0)}%)`);
    checks.push(['ok', `Land cover from OpenStreetMap: ${bits.join('; ')}`]);
  }
  const slots = new Set(parts.map((p) => readSettings().slots[p.id]));
  checks.push(['ok', `Multi-colour 3MF available: ${parts.length} parts on ${slots.size} filament slots`]);
  for (const w of r.warnings) checks.push(['warn', w]);
  $('checks').innerHTML = checks
    .map(([k, t]) => `<li class="${k}">${k === 'ok' ? ok : k === 'bad' ? bad : warnIcon}<span>${t}</span></li>`)
    .join('');

  // graphic scale bar sized to ~70% of the panel width
  const barMm = 0.6 * r.sizeMm[0];
  const dist = niceDistance((barMm / 1000) * r.scale);
  const distMm = (dist * 1000) / r.scale;
  const label = (m: number) => (m >= 1000 ? `${m / 1000} km` : `${m} m`);
  $('scale-bar').innerHTML = `
    <div class="scale-ratio">1 : ${fmt(Math.round(r.scale))}</div>
    <div class="scale-bar" style="width:${Math.min(100, (distMm / barMm) * 70)}%"><span></span><span></span><span></span><span></span></div>
    <div class="scale-ticks" style="width:${Math.min(100, (distMm / barMm) * 70)}%"><span>0</span><span>${label(dist / 2)}</span><span>${label(dist)}</span></div>
    <p class="scale-caption">${label(dist)} on the ground is ${distMm.toFixed(1)} mm on the print.</p>`;

  const [x, y, z] = r.sizeMm;
  const rows: [string, string][] = [
    ['Model size', `${x.toFixed(0)} × ${y.toFixed(0)} × ${z.toFixed(1)} mm`],
    ['Real area', `${formatKm(r.realSizeM[0])} × ${formatKm(r.realSizeM[1])}`],
    ['Triangles', fmt(r.triangles)],
    ['Buildings', fmt(r.buildings)],
    ['Road segments', fmt(r.roadSegments)],
    ['Elevation range', `${Math.round(r.elevationRange[0])} to ${Math.round(r.elevationRange[1])} m`],
  ];
  $('stats').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  $('results').hidden = false;
}

// ---------- downloads ----------
function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'area';
}

async function download(format: 'stl' | '3mf' | 'zip', btn: HTMLButtonElement): Promise<void> {
  if (!lastReport || busy) return;
  const s = readSettings();
  const base = `map2print-${slug(placeName)}-${Math.round(s.sizeMm)}mm`;
  btn.disabled = true;
  showError(null);
  try {
    const res = await ask({ type: 'export', format, title: `${placeName} (1:${Math.round(lastReport.scale)})`, baseName: base, slots: s.slots });
    if (res.type === 'error') throw new Error(res.message);
    if (res.type !== 'file') return;
    const type = format === '3mf' ? 'model/3mf' : format === 'zip' ? 'application/zip' : 'model/stl';
    const url = URL.createObjectURL(new Blob([res.data as Uint8Array<ArrayBuffer>], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${base}${format === 'zip' ? '-parts.zip' : '.' + format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) {
    showError((e as Error).message);
  } finally {
    btn.disabled = false;
  }
}
$('dl-3mf').addEventListener('click', (e) => download('3mf', e.currentTarget as HTMLButtonElement));
$('dl-stl').addEventListener('click', (e) => download('stl', e.currentTarget as HTMLButtonElement));
$('dl-zip').addEventListener('click', (e) => download('zip', e.currentTarget as HTMLButtonElement));

// ---------- start ----------
const startBBox = saved.bbox ?? DEFAULT_BBOX;
mapView.setBBox(startBBox);
mapView.fitSelection();
syncMarker();
updateArea(startBBox);
