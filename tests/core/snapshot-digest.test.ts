import { describe, it, expect } from 'vitest';

import { snapshotDigest } from '../../src/core/snapshot.js';

const base = () => ({
  files: { 'specs/a.md': '# A\n', 'specs/b.md': '# B\n' },
  trace: { version: 1 as const, generated: '2026-01-01T00:00:00Z', nodes: [], unowned: [], issues: [], totals: { claims: 0, sourceFiles: 0 } },
  ledger: { 'x#y': { claim: 'x#y', verdict: 'proven' as const, runId: 'r1', specHash: 'h', ingestedAt: '2026-01-01T00:00:00Z' } },
  plans: [],
  contracts: undefined,
});

describe('snapshot digest', () => {
  // [claims: capabilities/team-server#publish-digest-check]
  it('is stable across key order and ignores trace.generated', () => {
    const a = snapshotDigest(base());
    const b = base();
    b.trace.generated = '2027-02-02T00:00:00Z';
    b.files = { 'specs/b.md': '# B\n', 'specs/a.md': '# A\n' };
    expect(snapshotDigest(b).total).toBe(a.total);
    expect(Object.keys(a.files)).toEqual(['specs/a.md', 'specs/b.md']);
  });

  // [claims: capabilities/team-server#publish-digest-check]
  it('changes only the section that changed, and names the changed file', () => {
    const a = snapshotDigest(base());
    const specs = base();
    specs.files['specs/a.md'] = '# A changed\n';
    const d = snapshotDigest(specs);
    expect(d.total).not.toBe(a.total);
    expect(d.sections.specs).not.toBe(a.sections.specs);
    expect(d.sections.ledger).toBe(a.sections.ledger);
    expect(d.files['specs/a.md']).not.toBe(a.files['specs/a.md']);
    expect(d.files['specs/b.md']).toBe(a.files['specs/b.md']);

    const proofs = base();
    proofs.ledger['x#y'] = { ...proofs.ledger['x#y'], verdict: 'failed' as never };
    const p = snapshotDigest(proofs);
    expect(p.sections.ledger).not.toBe(a.sections.ledger);
    expect(p.sections.specs).toBe(a.sections.specs);
  });
});
