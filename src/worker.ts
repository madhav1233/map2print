/// <reference lib="webworker" />
import { generateModel, type GenerateInput } from './core/generate';
import { build3mf, separateStlZip, singleStl } from './core/export';
import type { PartId, PartResult } from './core/types';

export type WorkerRequest = { id: number } & (
  | { type: 'generate'; input: GenerateInput }
  | { type: 'export'; format: 'stl' | '3mf' | 'zip'; title: string; baseName: string; slots: Partial<Record<PartId, number>> }
);

export type WorkerResponse = { id: number } & (
  | { type: 'progress'; stage: string; fraction?: number }
  | { type: 'result'; parts: PartResult[]; report: import('./core/types').Report }
  | { type: 'file'; format: 'stl' | '3mf' | 'zip'; data: Uint8Array }
  | { type: 'error'; message: string }
);

let lastParts: PartResult[] = [];

const post = (msg: WorkerResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  const id = msg.id;
  try {
    if (msg.type === 'generate') {
      const result = generateModel(msg.input, (stage, fraction) => post({ id, type: 'progress', stage, fraction }));
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
            : separateStlZip(parts, msg.baseName);
      post({ id, type: 'file', format: msg.format, data }, [data.buffer]);
    }
  } catch (e) {
    post({ id, type: 'error', message: (e as Error).message || String(e) });
  }
};
