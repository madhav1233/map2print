/**
 * Binary STL and multi-part 3MF writers.
 *
 * The 3MF follows the layout Bambu Studio / OrcaSlicer write themselves: an
 * assembly object in 3D/3dmodel.model whose components point at mesh objects
 * in 3D/Objects/object_1.model, plus Metadata/model_settings.config assigning
 * each part its filament (AMS slot). Other 3MF readers still see one object
 * made of several coloured parts.
 */
import { strToU8, zipSync } from 'fflate';
import { mergeMeshes, type MeshData } from './mesh';
import type { PartResult } from './types';

export function toBinaryStl(mesh: MeshData, header = 'map2print'): Uint8Array {
  const { positions: p, indices } = mesh;
  const triCount = indices.length / 3;
  const buf = new ArrayBuffer(84 + triCount * 50);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const head = strToU8(header.slice(0, 79));
  u8.set(head, 0);
  dv.setUint32(80, triCount, true);
  let o = 84;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    dv.setFloat32(o, nx, true);
    dv.setFloat32(o + 4, ny, true);
    dv.setFloat32(o + 8, nz, true);
    o += 12;
    for (const v of [a, b, c]) {
      dv.setFloat32(o, p[v], true);
      dv.setFloat32(o + 4, p[v + 1], true);
      dv.setFloat32(o + 8, p[v + 2], true);
      o += 12;
    }
    dv.setUint16(o, 0, true);
    o += 2;
  }
  return u8;
}

/** Parse a binary STL back into triangles (used by tests and verification). */
export function parseBinaryStl(data: Uint8Array): { triangles: number; positions: Float32Array } {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = dv.getUint32(80, true);
  const positions = new Float32Array(n * 9);
  let o = 84;
  for (let t = 0; t < n; t++) {
    o += 12;
    for (let k = 0; k < 9; k++) {
      positions[t * 9 + k] = dv.getFloat32(o, true);
      o += 4;
    }
    o += 2;
  }
  return { triangles: n, positions };
}

export function singleStl(parts: PartResult[]): Uint8Array {
  return toBinaryStl(mergeMeshes(parts.filter((p) => p.inStl)), 'map2print single-colour model');
}

export function separateStlZip(parts: PartResult[], baseName: string): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const p of parts) {
    files[`${baseName}-${p.id}.stl`] = toBinaryStl(p, `map2print ${p.name}`);
  }
  files['README.txt'] = strToU8(
    [
      'map2print - separate parts',
      '',
      'All parts share the same coordinate origin. Import them together into your',
      'slicer and keep them as one object (e.g. Bambu Studio / OrcaSlicer: "Load as',
      'single object with multiple parts") so they stay aligned, then give each part',
      'its own filament.',
      '',
      ...parts.map((p) => `${baseName}-${p.id}.stl  ${p.name}  (suggested slot ${p.slot})`),
      '',
      'Map data (c) OpenStreetMap contributors, ODbL. Elevation: Terrain Tiles (AWS Open Data).',
    ].join('\n'),
  );
  return zipSync(files, { level: 0 }); // binary STL barely compresses; storing is ~8x faster
}

const n4 = (x: number) => {
  const r = Math.round(x * 10000) / 10000;
  return Object.is(r, -0) ? '0' : String(r);
};

function meshXml(p: PartResult, chunks: string[]): void {
  const pos = p.positions;
  const idx = p.indices;
  chunks.push('<mesh><vertices>');
  let buf = '';
  for (let i = 0; i < pos.length; i += 3) {
    buf += `<vertex x="${n4(pos[i])}" y="${n4(pos[i + 1])}" z="${n4(pos[i + 2])}"/>`;
    if (buf.length > 1 << 16) {
      chunks.push(buf);
      buf = '';
    }
  }
  chunks.push(buf, '</vertices><triangles>');
  buf = '';
  for (let t = 0; t < idx.length; t += 3) {
    buf += `<triangle v1="${idx[t]}" v2="${idx[t + 1]}" v3="${idx[t + 2]}"/>`;
    if (buf.length > 1 << 16) {
      chunks.push(buf);
      buf = '';
    }
  }
  chunks.push(buf, '</triangles></mesh>');
}

function concat(chunks: string[]): Uint8Array {
  const enc = new TextEncoder();
  const parts = chunks.map((c) => enc.encode(c));
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function build3mf(parts: PartResult[], title: string): Uint8Array {
  const used = parts.filter((p) => p.indices.length > 0);
  const NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
  const PNS = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';
  const assemblyId = used.length + 1;
  const subPath = '/3D/Objects/object_1.model';
  let maxX = 0;
  let maxY = 0;
  for (const p of used) {
    for (let i = 0; i < p.positions.length; i += 3) {
      if (p.positions[i] > maxX) maxX = p.positions[i];
      if (p.positions[i + 1] > maxY) maxY = p.positions[i + 1];
    }
  }

  // ---- sub-model with the meshes ----
  const sub: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    `<model unit="millimeter" xml:lang="en-US" xmlns="${NS}" xmlns:p="${PNS}" requiredextensions="p">`,
    '<metadata name="BambuStudio:3mfVersion">1</metadata>',
    '<resources>',
  ];
  used.forEach((p, k) => {
    sub.push(`<object id="${k + 1}" p:UUID="${uuid(k + 1)}" type="model">`);
    meshXml(p, sub);
    sub.push('</object>');
  });
  sub.push('</resources><build/></model>');

  // ---- root model: one assembly placed on the plate ----
  const root: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    `<model unit="millimeter" xml:lang="en-US" xmlns="${NS}" xmlns:p="${PNS}" requiredextensions="p">`,
    `<metadata name="Title">${esc(title)}</metadata>`,
    '<metadata name="Application">map2print</metadata>',
    '<metadata name="BambuStudio:3mfVersion">1</metadata>',
    '<metadata name="Copyright">Map data (c) OpenStreetMap contributors (ODbL)</metadata>',
    '<resources>',
    `<object id="${assemblyId}" p:UUID="${uuid(assemblyId)}" type="model"><components>`,
    ...used.map((_, k) => `<component p:path="${subPath}" objectid="${k + 1}" p:UUID="${uuid(100 + k)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`),
    '</components></object>',
    '</resources>',
    // centre on a 256 mm plate (X1/P1/A1); use Arrange in the slicer for smaller beds
    `<build p:UUID="${uuid(999)}"><item objectid="${assemblyId}" p:UUID="${uuid(998)}" transform="1 0 0 0 1 0 0 0 1 ${n4(128 - maxX / 2)} ${n4(128 - maxY / 2)} 0" printable="1"/></build>`,
    '</model>',
  ];

  const settings: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n',
    `  <object id="${assemblyId}">\n`,
    `    <metadata key="name" value="${esc(title)}"/>\n`,
    `    <metadata key="extruder" value="${used[0]?.slot ?? 1}"/>\n`,
    ...used.map(
      (p, k) =>
        `    <part id="${k + 1}" subtype="normal_part">\n` +
        `      <metadata key="name" value="${esc(p.name)}"/>\n` +
        `      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>\n` +
        `      <metadata key="extruder" value="${p.slot}"/>\n` +
        `    </part>\n`,
    ),
    '  </object>\n',
    '  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n    <metadata key="locked" value="false"/>\n',
    `    <model_instance>\n      <metadata key="object_id" value="${assemblyId}"/>\n      <metadata key="instance_id" value="0"/>\n      <metadata key="identify_id" value="${assemblyId * 100}"/>\n    </model_instance>\n`,
    '  </plate>\n</config>\n',
  ];

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '<Default Extension="config" ContentType="text/xml"/>' +
    '</Types>';
  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
    '</Relationships>';
  const modelRels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Target="${subPath}" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    '</Relationships>';

  return zipSync(
    {
      '[Content_Types].xml': strToU8(contentTypes),
      '_rels/.rels': strToU8(rels),
      '3D/3dmodel.model': concat(root),
      '3D/_rels/3dmodel.model.rels': strToU8(modelRels),
      '3D/Objects/object_1.model': concat(sub),
      'Metadata/model_settings.config': strToU8(settings.join('')),
    },
    { level: 1 },
  );
}

/** Deterministic RFC-4122-shaped id; uniqueness within the file is all that matters. */
function uuid(n: number): string {
  const h = n.toString(16).padStart(12, '0');
  return `6d617032-7072-4e74-8000-${h}`;
}
