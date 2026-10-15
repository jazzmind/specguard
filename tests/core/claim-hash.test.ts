import { describe, expect, it } from 'vitest';

import { claimHashOf, isV2Spec } from '../../src/core/claim-hash.js';
import { effectiveVerdict, type ProofRecord } from '../../src/core/proof-ledger.js';
import { parseSpecContent } from '../../src/core/spec-parser.js';

function spec(opts: { front?: string; value?: string; claims?: string[]; extra?: string } = {}) {
  const front = opts.front ?? 'sources:\n  - "src/**"\nhistory:\n  - h1';
  const claims = opts.claims ?? ['Awards once <!-- claim: award-once -->', 'No duplicates <!-- claim: no-dupes -->'];
  const text = `---\nid: awards\nkind: capability\n${front}\n---\n# Awards\n\n## Problem & Value\n\n${opts.value ?? 'Players are rewarded fairly.'}\n\n## Requirements\n\n${claims.map((c) => `- [ ] ${c}`).join('\n')}\n\n## Scenarios\n\n${opts.extra ?? ''}\n`;
  return parseSpecContent(text, '/r/specs/awards.md', '/r/specs');
}

const record = (claimHash?: string, specHash = 'old'): ProofRecord => ({
  claim: 'awards#award-once',
  verdict: 'proven',
  runId: 'r',
  specHash,
  claimHash,
  fileHashes: {},
  exercised: 1,
  counterexamples: 0,
  ingestedAt: 'now',
});

describe('claim-scoped hashing [claim-hash]', () => {
  const base = claimHashOf(spec(), 'award-once');

  // [claims: capabilities/traceability-and-drift#claim-scoped-hash]
  it('ignores frontmatter, other claims and scenarios [claim-hash-stable]', () => {
    expect(base).toBeDefined();
    expect(claimHashOf(spec({ front: 'sources:\n  - "other/**"\nhistory:\n  - h1\n  - h2' }), 'award-once')).toBe(base);
    expect(claimHashOf(spec({ claims: ['Awards once <!-- claim: award-once -->', 'Something else entirely <!-- claim: no-dupes -->'] }), 'award-once')).toBe(base);
    expect(claimHashOf(spec({ extra: '### Scenario 1: new\n' }), 'award-once')).toBe(base);
  });

  // [claims: capabilities/traceability-and-drift#claim-scoped-hash]
  it('changes when the claim text or the Problem & Value changes [claim-hash-sensitive]', () => {
    expect(claimHashOf(spec({ claims: ['Awards exactly once <!-- claim: award-once -->'] }), 'award-once')).not.toBe(base);
    expect(claimHashOf(spec({ value: 'A different purpose.' }), 'award-once')).not.toBe(base);
  });

  it('is undefined for v1 specs and unknown claims [claim-hash-v1]', () => {
    const v1 = parseSpecContent('# T\n\n<!--\n  module: src/a.ts\n-->\n\n## Acceptance Criteria\n\n- [ ] x <!-- claim: x-y -->\n', '/r/specs/t.md', '/r/specs');
    expect(isV2Spec(v1)).toBe(false);
    expect(claimHashOf(v1, 'x-y')).toBeUndefined();
    expect(claimHashOf(spec(), 'nope')).toBeUndefined();
  });

  // [claims: capabilities/traceability-and-drift#claim-scoped-file-staleness]
  it('a v2 proof stays proven when only the whole-file hash moved [verdict-claim-scoped]', () => {
    expect(effectiveVerdict(record(base), { specHash: 'new', claimHash: base, fileHashes: {} })).toBe('proven');
    expect(effectiveVerdict(record(base), { specHash: 'new', claimHash: 'different', fileHashes: {} })).toBe('stale');
  });

  // [claims: capabilities/traceability-and-drift#stale-proof-is-drift]
  it('a v1 proof still goes stale on any whole-file change [verdict-v1-unchanged]', () => {
    expect(effectiveVerdict(record(undefined), { specHash: 'new', fileHashes: {} })).toBe('stale');
    expect(effectiveVerdict(record(undefined), { specHash: 'old', fileHashes: {} })).toBe('proven');
    // A v2 spec checked against an old v1-era proof row falls back to the file hash.
    expect(effectiveVerdict(record(undefined), { specHash: 'new', claimHash: base, fileHashes: {} })).toBe('stale');
  });
});

describe('wrapped claims and the hash [claim-hash-wrapped]', () => {
  // [claims: capabilities/traceability-and-drift#claim-scoped-hash]
  it('changes when only the continuation line of a claim changes', () => {
    const a = spec({ claims: ['Awards once\n  per player <!-- claim: award-once -->'] });
    const b = spec({ claims: ['Awards once\n  per team <!-- claim: award-once -->'] });
    expect(claimHashOf(a, 'award-once')).not.toBe(claimHashOf(b, 'award-once'));
  });
});
