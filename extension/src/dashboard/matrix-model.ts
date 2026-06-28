import type { MatrixModel, MatrixRow } from './protocol.js';

interface TraceabilityEntry { specKey: string; title?: string; appName?: string; tests?: string[]; docs?: string[]; sourceModule?: string; }
export interface TraceabilityFile { generatedAt?: string; entries?: TraceabilityEntry[]; }

/** Convert `.specguard/traceability.json` into a flat, render-ready matrix. */
export function toMatrixModel(raw: unknown): MatrixModel {
  const file = (raw ?? {}) as TraceabilityFile;
  if (!Array.isArray(file.entries)) return { generatedAt: null, rows: [] };
  const rows: MatrixRow[] = file.entries.map((e) => {
    const tests = Array.isArray(e.tests) ? e.tests : [];
    const docs = Array.isArray(e.docs) ? e.docs : [];
    return {
      specKey: e.specKey,
      title: e.title ?? e.specKey,
      appName: e.appName ?? '',
      sourceModule: e.sourceModule ?? '',
      hasTests: tests.length > 0,
      testCount: tests.length,
      hasDocs: docs.length > 0,
    };
  });
  return { generatedAt: file.generatedAt ?? null, rows };
}
