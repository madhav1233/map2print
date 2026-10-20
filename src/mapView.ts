/**
 * Leaflet map with a drawable, resizable, movable selection rectangle and an
 * optional draggable marker.
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { bboxSizeMeters, metersPerDegree } from './core/projection';
import { unitShape } from './core/memento';
import type { BBox, LonLat, Shape } from './core/types';

/** Largest area the app will model (terrain and route). */
export const MAX_SIDE_KM = 200;
/** Buildings and roads are only fetched up to this size. */
export const DETAIL_MAX_KM = 8;
/** Water and parks come from OpenStreetMap up to this size, beyond it from elevation. */
export const LANDCOVER_MAX_KM = 60;

export function formatKm(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

export class MapView {
  readonly map: L.Map;
  private rect: L.Rectangle | null = null;
  private label: L.Marker | null = null;
  private corners: L.Marker[] = [];
  private mover: L.Marker | null = null;
  private pin: L.Marker | null = null;
  private routeLayer: L.LayerGroup | null = null;
  private shapeOutline: L.Polygon | null = null;
  private shape: Shape = 'rectangle';
  private drawing = false;
  private start: L.LatLng | null = null;
  private bbox: BBox | null = null;
  square = false;
  onChange: (b: BBox | null) => void = () => {};
  onDrawMode: (on: boolean) => void = () => {};
  onMarkerMove: (p: LonLat) => void = () => {};

  constructor(el: HTMLElement) {
    this.map = L.map(el, { zoomControl: false, worldCopyJump: true, preferCanvas: true }).setView([40.7128, -74.006], 13);
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    // Keyless basemaps only: the site is public and static, so it must not depend on API keys.
    const osm = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    const basemaps: Record<string, L.TileLayer> = {
      Streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osm }),
      Topographic: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
        maxZoom: 17,
        subdomains: 'abc',
        attribution: `${osm}, SRTM | Style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`,
      }),
    };
    let chosen = 'Streets';
    try {
      const saved = localStorage.getItem('map2print:basemap');
      if (saved && saved in basemaps) chosen = saved;
    } catch {
      /* storage unavailable */
    }
    basemaps[chosen].addTo(this.map);
    L.control.layers(basemaps, undefined, { position: 'bottomleft' }).addTo(this.map);
    this.map.on('baselayerchange', (e: L.LayersControlEvent) => {
      try {
        localStorage.setItem('map2print:basemap', e.name);
      } catch {
        /* storage unavailable */
      }
    });

    const c = this.map.getContainer();
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
  }

  get drawMode(): boolean {
    return this.drawing;
  }

  setDrawMode(on: boolean): void {
    this.drawing = on;
    this.start = null;
    this.map.getContainer().classList.toggle('is-drawing', on);
    if (on) this.map.dragging.disable();
    else this.map.dragging.enable();
    this.onDrawMode(on);
  }

  private latLngOf(e: PointerEvent): L.LatLng {
    return this.map.mouseEventToLatLng(e as unknown as MouseEvent);
  }

  private down(e: PointerEvent): void {
    if (!this.drawing || e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.leaflet-control, .leaflet-marker-icon')) return;
    e.preventDefault();
    this.map.getContainer().setPointerCapture?.(e.pointerId);
    this.start = this.latLngOf(e);
  }

  private move(e: PointerEvent): void {
    if (!this.drawing || !this.start) return;
    this.setBBox(this.fromCorners(this.start, this.latLngOf(e)), false);
  }

  private up(e: PointerEvent): void {
    if (!this.drawing || !this.start) return;
    const end = this.latLngOf(e);
    const a = this.map.latLngToContainerPoint(this.start);
    const b = this.map.latLngToContainerPoint(end);
    this.start = null;
    if (a.distanceTo(b) < 8) return; // a click, not a drag
    this.setBBox(this.fromCorners(this.map.containerPointToLatLng(a), end), true);
    this.setDrawMode(false);
  }

  /** Rectangle from two corners, honouring the square lock (in metres). */
  private fromCorners(a: L.LatLng, b: L.LatLng): BBox {
    let { lat: lat2, lng: lon2 } = b;
    if (this.square) {
      const mpd = metersPerDegree((a.lat + b.lat) / 2);
      const wm = Math.abs(lon2 - a.lng) * mpd.lon;
      const hm = Math.abs(lat2 - a.lat) * mpd.lat;
      const side = Math.max(wm, hm);
      lon2 = a.lng + Math.sign(lon2 - a.lng || 1) * (side / mpd.lon);
      lat2 = a.lat + Math.sign(lat2 - a.lat || 1) * (side / mpd.lat);
    }
    return {
      west: Math.min(a.lng, lon2),
      east: Math.max(a.lng, lon2),
      south: Math.min(a.lat, lat2),
      north: Math.max(a.lat, lat2),
    };
  }

  getBBox(): BBox | null {
    return this.bbox;
  }

  /** Square-ify the current selection around its centre. */
  applySquare(): void {
    if (!this.bbox || !this.square) return;
    const b = this.bbox;
    const { width, height } = bboxSizeMeters(b);
    const side = Math.max(width, height);
    this.setBBox(boxAround({ lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 }, side, side), true);
  }

  clear(): void {
    this.bbox = null;
    this.rect?.remove();
    this.label?.remove();
    this.corners.forEach((m) => m.remove());
    this.mover?.remove();
    this.rect = this.label = this.mover = null;
    this.corners = [];
    this.onChange(null);
  }

  setBBox(b: BBox, final = true): void {
    this.bbox = b;
    const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
    if (!this.rect) {
      this.rect = L.rectangle(bounds, {
        color: '#1f2a33',
        weight: 1.5,
        dashArray: '6 4',
        fillColor: '#2f6e9e',
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(this.map);
    } else this.rect.setBounds(bounds);

    const { width, height } = bboxSizeMeters(b);
    const tooBig = Math.max(width, height) > MAX_SIDE_KM * 1000;
    this.rect.setStyle({ color: tooBig ? '#a8322d' : '#1f2a33' });
    const text = `${formatKm(width)} × ${formatKm(height)}`;
    const labelIcon = L.divIcon({ className: `sel-label${tooBig ? ' is-over' : ''}`, html: `<span>${text}</span>`, iconSize: undefined });
    const top = L.latLng(b.north, (b.west + b.east) / 2);
    if (!this.label) this.label = L.marker(top, { icon: labelIcon, interactive: false, keyboard: false }).addTo(this.map);
    else {
      this.label.setLatLng(top);
      this.label.setIcon(labelIcon);
    }
    this.drawShape();
    if (final) {
      this.placeHandles();
      this.onChange(b);
    }
  }

  setShape(shape: Shape): void {
    this.shape = shape;
    this.drawShape();
  }

  /** Outline of a non-rectangular footprint, inscribed in the selection like the model. */
  private drawShape(): void {
    const b = this.bbox;
    if (!b || this.shape === 'rectangle') {
      this.shapeOutline?.remove();
      this.shapeOutline = null;
      return;
    }
    const mpd = metersPerDegree((b.south + b.north) / 2);
    const { width, height } = bboxSizeMeters(b);
    const h = Math.min(width, height) / 2;
    const c = { lon: (b.west + b.east) / 2, lat: (b.south + b.north) / 2 };
    const pts = unitShape(this.shape).map(([x, y]) => L.latLng(c.lat + (y * h) / mpd.lat, c.lon + (x * h) / mpd.lon));
    if (!this.shapeOutline) {
      this.shapeOutline = L.polygon(pts, { color: '#1f2a33', weight: 2, fill: false, interactive: false }).addTo(this.map);
    } else this.shapeOutline.setLatLngs(pts);
  }

  /** Draw GPX stages; each stage gets its own colour, with start and finish dots. */
  showRoute(stages: { color: string; pts: [number, number][] }[]): void {
    this.routeLayer?.remove();
    this.routeLayer = null;
    if (!stages.length) return;
    const g = L.layerGroup();
    for (const st of stages) {
      L.polyline(st.pts, { color: '#f7f8f4', weight: 7, opacity: 0.9, interactive: false }).addTo(g);
      L.polyline(st.pts, { color: st.color, weight: 3.5, interactive: false }).addTo(g);
    }
    const first = stages[0].pts[0];
    const lastStage = stages[stages.length - 1].pts;
    const last = lastStage[lastStage.length - 1];
    L.circleMarker(first, { radius: 6, color: '#1f2a33', weight: 2, fillColor: '#3e7b3a', fillOpacity: 1, interactive: false }).addTo(g);
    L.circleMarker(last, { radius: 6, color: '#1f2a33', weight: 2, fillColor: '#f7f8f4', fillOpacity: 1, interactive: false }).addTo(g);
    this.routeLayer = g.addTo(this.map);
  }

  private placeHandles(): void {
    const b = this.bbox!;
    const pts: [number, number][] = [
      [b.south, b.west],
      [b.south, b.east],
      [b.north, b.east],
      [b.north, b.west],
    ];
    if (!this.corners.length) {
      this.corners = pts.map((p, k) => {
        const m = L.marker(p, {
          draggable: true,
          icon: L.divIcon({ className: 'sel-handle', iconSize: [14, 14] }),
          keyboard: false,
          title: 'Drag to resize',
        }).addTo(this.map);
        m.on('drag', () => {
          const opp = this.corners[(k + 2) % 4].getLatLng();
          this.setBBox(this.fromCorners(opp, m.getLatLng()), false);
          this.syncHandles(k);
        });
        m.on('dragend', () => this.setBBox(this.bbox!, true));
        return m;
      });
      this.mover = L.marker([(b.south + b.north) / 2, (b.west + b.east) / 2], {
        draggable: true,
        icon: L.divIcon({ className: 'sel-mover', iconSize: [26, 26], html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3 3h-2v6h6V9l3 3-3 3v-2h-6v6h2l-3 3-3-3h2v-6H5v2l-3-3 3-3v2h6V5H9z"/></svg>' }),
        title: 'Drag to move the area',
        keyboard: false,
      }).addTo(this.map);
      this.mover.on('drag', () => {
        const c = this.mover!.getLatLng();
        const cur = this.bbox!;
        const hw = (cur.east - cur.west) / 2;
        const hh = (cur.north - cur.south) / 2;
        this.setBBox({ west: c.lng - hw, east: c.lng + hw, south: c.lat - hh, north: c.lat + hh }, false);
        this.syncHandles(-1, false);
      });
      this.mover.on('dragend', () => this.setBBox(this.bbox!, true));
    } else this.syncHandles(-1, true);
  }

  private syncHandles(skip: number, moveMover = true): void {
    const b = this.bbox!;
    const pts: [number, number][] = [
      [b.south, b.west],
      [b.south, b.east],
      [b.north, b.east],
      [b.north, b.west],
    ];
    this.corners.forEach((m, k) => {
      if (k !== skip) m.setLatLng(pts[k]);
    });
    if (moveMover) this.mover?.setLatLng([(b.south + b.north) / 2, (b.west + b.east) / 2]);
  }

  fitSelection(animate = true): void {
    if (!this.bbox) return;
    const go = () => {
      const b = this.bbox!;
      this.map.fitBounds(L.latLngBounds([b.south, b.west], [b.north, b.east]), { padding: [60, 60], animate });
    };
    // Leaflet ignores a new view while a zoom animation runs, so wait for it.
    if ((this.map as unknown as { _animatingZoom?: boolean })._animatingZoom) this.map.once('zoomend', go);
    else go();
  }

  showPin(p: LonLat | null): void {
    if (!p) {
      this.pin?.remove();
      this.pin = null;
      return;
    }
    if (!this.pin) {
      this.pin = L.marker([p.lat, p.lon], {
        draggable: true,
        title: 'Drag to place the marker',
        icon: L.divIcon({
          className: 'heart-pin',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
          html: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 28C6 20 2 15 2 10a7 7 0 0 1 14-2 7 7 0 0 1 14 2c0 5-4 10-14 18z"/></svg>',
        }),
      }).addTo(this.map);
      this.pin.on('dragend', () => {
        const ll = this.pin!.getLatLng();
        this.onMarkerMove({ lon: ll.lng, lat: ll.lat });
      });
    } else this.pin.setLatLng([p.lat, p.lon]);
  }

  invalidate(): void {
    this.map.invalidateSize();
  }
}

export function boxAround(c: LonLat, widthM: number, heightM: number): BBox {
  const mpd = metersPerDegree(c.lat);
  const dLon = widthM / 2 / mpd.lon;
  const dLat = heightM / 2 / mpd.lat;
  return { west: c.lon - dLon, east: c.lon + dLon, south: c.lat - dLat, north: c.lat + dLat };
}
