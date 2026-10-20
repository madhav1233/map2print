/// <reference lib="webworker" />
import { generateModel, needsGeometryEngine, type Extras, type GenerateInput } from './core/generate';
import { build3mf, partStl, separateStlZip, singleStl } from './core/export';
import { glyphsFromFont } from './core/memento';
import ManifoldModule from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import fontUrl from '@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff?url';
import { parse as parseFont } from 'opentype.js';
import type { PartId, PartResult } from './core/types';

export type WorkerRequest = { id: number } & (
  | { type: 'generate'; input: GenerateInput }
  | { type: 'export'; format: ExportFormat; title: string; baseName: string; slots: Partial<Record<PartId, number>> }
);

export type WorkerResponse = { id: number } & (
  | { type: 'progress'; stage: string; fraction?: number }
  | { type: 'result'; parts: PartResult[]; report: import('./core/types').Report }
  | { type: 'file'; format: ExportFormat; data: Uint8Array }
  | { type: 'error'; message: string }
);

export type ExportFormat = 'stl' | '3mf' | 'zip' | 'route';

let lastParts: PartResult[] = [];

// Geometry engine (WASM) and label font load on first use only.
let extras: Promise<Extras> | null = null;
function loadExtras(): Promise<Extras> {
  extras ??= Promise.all([
    ManifoldModule({ locateFile: () => wasmUrl }).then((w) => {
      w.setup();
      return w;
    }),
    fetch(fontUrl)
      .then((r) => r.arrayBuffer())
      .then((b) => glyphsFromFont(parseFont(b)))
      .catch(() => undefined),
  ]).then(([wasm, glyphs]) => ({ wasm, glyphs }));
  extras.catch(() => (extras = null));
  return extras;
}

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  const id = msg.id;
  try {
    if (msg.type === 'generate') {
      let ext: Extras = {};
      if (needsGeometryEngine(msg.input)) {
        post({ id, type: 'progress', stage: 'Loading the geometry engine', fraction: 0 });
        ext = await loadExtras();
      }
      const result = generateModel(msg.input, (stage, fraction) => post({ id, type: 'progress', stage, fraction }), ext);
      lastParts = result.parts;
      // send copies so the worker keeps its own for exports
      const parts = result.parts.map((p) => ({ ...p, positions: p.positions.slice(), indices: p.indices.slice() }));
      post(
        { id, type: 'result', parts, report: result.report },
        parts.flatMap((p) => [p.positions.buffer, p.indices.buffer]),
      );
    } else if (msg.type === 'export') {
      if (!lastParts.length) throw new Error('Generate a model first.');
      const parts = lastParts.map((p) => ({ ...p, slot: msg.slots[p.id] ?? p.slot }));
      const data =
        msg.format === 'stl'
          ? singleStl(parts)
          : msg.format === '3mf'
            ? build3mf(parts, msg.title)
            : msg.format === 'route'
              ? partStl(parts, 'route')
              : separateStlZip(parts, msg.baseName);
      post({ id, type: 'file', format: msg.format, data }, [data.buffer]);
    }
  } catch (e) {
    post({ id, type: 'error', message: (e as Error).message || String(e) });
  }
};
