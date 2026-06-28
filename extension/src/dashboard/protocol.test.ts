import { describe, it, expect } from 'vitest';
import { PIPELINE_NODES, RUNNABLE_PIPELINES } from './protocol.js';

describe('flow graph metadata', () => {
  it('every non-input node lists at least one upstream source', () => {
    for (const n of PIPELINE_NODES) {
      if (n.kind !== 'input') expect(n.from.length).toBeGreaterThan(0);
    }
  });
  it('all `from` ids reference existing nodes', () => {
    const ids = new Set(PIPELINE_NODES.map((n) => n.id));
    for (const n of PIPELINE_NODES) for (const f of n.from) expect(ids.has(f)).toBe(true);
  });
  it('includes the core pipelines as runnable', () => {
    const ids = RUNNABLE_PIPELINES.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['reverse', 'generate', 'drift', 'matrix', 'status']));
  });
});
