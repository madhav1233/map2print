/**
 * Minimal indexed triangle mesh utilities: building, welding, degenerate
 * removal and manifold / orientation analysis.
 */

export interface MeshData {
  positions: Float32Array; // xyz triples, millimetres
  indices: Uint32Array; // triangle vertex indices
}

export class MeshBuilder {
  pos: number[] = [];
  idx: number[] = [];

  get vertexCount(): number {
    return this.pos.length / 3;
  }

  get triangleCount(): number {
    return this.idx.length / 3;
  }

  addVertex(x: number, y: number, z: number): number {
    this.pos.push(x, y, z);
    return this.pos.length / 3 - 1;
  }

  addTri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** Quad a-b-c-d in counter-clockwise order (as seen from outside). */
  addQuad(a: number, b: number, c: number, d: number): void {
    this.idx.push(a, b, c, a, c, d);
  }

  append(mesh: MeshData): void {
    const offset = this.vertexCount;
    const p = mesh.positions;
    for (let i = 0; i < p.length; i++) this.pos.push(p[i]);
    const ix = mesh.indices;
    for (let i = 0; i < ix.length; i++) this.idx.push(ix[i] + offset);
  }

  toData(): MeshData {
    return { positions: new Float32Array(this.pos), indices: new Uint32Array(this.idx) };
  }
}

export function emptyMesh(): MeshData {
  return { positions: new Float32Array(0), indices: new Uint32Array(0) };
}

export function mergeMeshes(meshes: MeshData[]): MeshData {
  let vCount = 0;
  let iCount = 0;
  for (const m of meshes) {
    vCount += m.positions.length;
    iCount += m.indices.length;
  }
  const positions = new Float32Array(vCount);
  const indices = new Uint32Array(iCount);
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    positions.set(m.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return { positions, indices };
}

/**
 * Merge vertices closer than `eps` (mm). Returns the welded mesh and the
 * number of vertices that were merged away.
 */
export function weldVertices(mesh: MeshData, eps = 1e-5): { mesh: MeshData; merged: number } {
  const { positions, indices } = mesh;
  const n = positions.length / 3;
  const inv = 1 / eps;
  const q = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) q[i] = Math.round(positions[i] * inv);
  // open-addressing hash table on quantised coordinates
  let cap = 1;
  while (cap < n * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  const remap = new Uint32Array(n);
  const keep = new Int32Array(n);
  let unique = 0;
  for (let i = 0; i < n; i++) {
    const x = q[i * 3];
    const y = q[i * 3 + 1];
    const z = q[i * 3 + 2];
    let hsh = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) & (cap - 1);
    for (;;) {
      const slot = table[hsh];
      if (slot < 0) {
        table[hsh] = i;
        keep[unique] = i;
        remap[i] = unique++;
        break;
      }
      if (q[slot * 3] === x && q[slot * 3 + 1] === y && q[slot * 3 + 2] === z) {
        remap[i] = remap[slot];
        break;
      }
      hsh = (hsh + 1) & (cap - 1);
    }
  }
  if (unique === n) return { mesh, merged: 0 };
  const out = new Float32Array(unique * 3);
  for (let k = 0; k < unique; k++) {
    const i = keep[k];
    out[k * 3] = positions[i * 3];
    out[k * 3 + 1] = positions[i * 3 + 1];
    out[k * 3 + 2] = positions[i * 3 + 2];
  }
  const newIdx = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) newIdx[i] = remap[indices[i]];
  return { mesh: { positions: out, indices: newIdx }, merged: n - unique };
}

/** Remove triangles that reference the same vertex twice or have ~zero area. */
export function removeDegenerate(mesh: MeshData, minArea = 1e-10): { mesh: MeshData; removed: number } {
  const { positions: p, indices } = mesh;
  const keep: number[] = [];
  let removed = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    if (a === b || b === c || a === c) {
      removed++;
      continue;
    }
    const ux = p[b * 3] - p[a * 3];
    const uy = p[b * 3 + 1] - p[a * 3 + 1];
    const uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3];
    const vy = p[c * 3 + 1] - p[a * 3 + 1];
    const vz = p[c * 3 + 2] - p[a * 3 + 2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    if (0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz) < minArea) {
      removed++;
      continue;
    }
    keep.push(a, b, c);
  }
  return { mesh: { positions: p, indices: new Uint32Array(keep) }, removed };
}

export interface ShellAnalysis {
  triangles: number;
  /** Edges used by only one triangle (holes). */
  boundaryEdges: number;
  /** Undirected edges used by more than two triangles. */
  nonManifoldEdges: number;
  /** Edges whose two triangles traverse them in the same direction (flipped winding). */
  inconsistentEdges: number;
  /** Signed volume, mm³. Positive = outward-facing normals. */
  volume: number;
  watertight: boolean;
}

/**
 * Checks that every edge is shared by exactly two triangles with opposite
 * traversal directions (closed, 2-manifold, consistently wound) and computes
 * the signed volume.
 */
export function analyzeShell(mesh: MeshData): ShellAnalysis {
  const { positions: p, indices } = mesh;
  const n = p.length / 3;
  // sorted directed-edge keys; counts come from runs of equal keys
  const keys = new Float64Array(indices.length);
  for (let t = 0; t < indices.length; t += 3) {
    for (let k = 0; k < 3; k++) keys[t + k] = indices[t + k] * n + indices[t + ((k + 1) % 3)];
  }
  keys.sort();
  const countOf = (key: number): number => {
    let lo = 0;
    let hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (keys[mid] < key) lo = mid + 1;
      else hi = mid;
    }
    let c = 0;
    while (lo + c < keys.length && keys[lo + c] === key) c++;
    return c;
  };
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (let i = 0; i < keys.length; ) {
    const key = keys[i];
    let count = 1;
    while (i + count < keys.length && keys[i + count] === key) count++;
    i += count;
    const a = Math.floor(key / n);
    const b = key - a * n;
    const rev = countOf(b * n + a);
    if (count > 1) inconsistentEdges++;
    if (a < b || rev === 0) {
      const total = count + rev;
      if (total === 1) boundaryEdges++;
      else if (total > 2) nonManifoldEdges++;
    }
  }
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    volume +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  volume /= 6;
  return {
    triangles: indices.length / 3,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    volume,
    watertight: boundaryEdges === 0 && nonManifoldEdges === 0 && inconsistentEdges === 0,
  };
}

export function flipWinding(mesh: MeshData): MeshData {
  const idx = new Uint32Array(mesh.indices);
  for (let t = 0; t < idx.length; t += 3) {
    const tmp = idx[t + 1];
    idx[t + 1] = idx[t + 2];
    idx[t + 2] = tmp;
  }
  return { positions: mesh.positions, indices: idx };
}

/**
 * Full clean-up for a single closed shell: weld, drop degenerate triangles,
 * verify manifoldness and make normals point outward.
 */
export interface CleanShellResult {
  mesh: MeshData;
  welded: number;
  degenerate: number;
  flipped: boolean;
  analysis: ShellAnalysis;
}

/**
 * `weld: false` keeps coincident vertices apart: shells that duplicate a vertex
 * on purpose (two cells touching only at a corner) would otherwise be glued
 * back into a non-manifold pinch.
 */
export function cleanShell(mesh: MeshData, eps = 1e-5, weld = true): CleanShellResult {
  const w = weld ? weldVertices(mesh, eps) : { mesh, merged: 0 };
  const d = removeDegenerate(w.mesh);
  let m = d.mesh;
  let analysis = analyzeShell(m);
  let flipped = false;
  if (analysis.volume < 0) {
    m = flipWinding(m);
    flipped = true;
    analysis = { ...analysis, volume: -analysis.volume };
  }
  return { mesh: m, welded: w.merged, degenerate: d.removed, flipped, analysis };
}

export function meshBounds(mesh: MeshData): { min: [number, number, number]; max: [number, number, number] } {
  const p = mesh.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return { min, max };
}
