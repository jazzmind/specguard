import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  assignClaimIds,
  danglingClaimRefs,
  parseClaimRef,
  parseClaims,
  parseInvariants,
  slugFromText,
} from '../../src/core/claims.js';
import { parseSpecContent } from '../../src/core/spec-parser.js';
import { runClaimsAssign, runClaimsList } from '../../src/pipelines/claims.js';
import { runProofIngest } from '../../src/pipelines/proof.js';
import { effectiveVerdict } from '../../src/core/proof-ledger.js';

const ANCHORED = `# Widget

<!--
  module: src/widget.ts
  type: core
-->

## Acceptance Criteria

- [ ] Award is skipped when already earned <!-- claim: award-once -->
- [x] Drivers finish early

Plain prose is ignored
`;

describe('parseClaims', () => {
  it('reads anchors, checkboxes, and unanchored bullets', () => {
    const claims = parseClaims(ANCHORED.split('## Acceptance Criteria')[1]);
    expect(claims).toEqual([
      { id: 'award-once', text: 'Award is skipped when already earned', checked: false },
      { text: 'Drivers finish early', checked: true },
    ]);
  });
});

describe('assignClaimIds', () => {
  it('adds one id and leaves an existing anchor unchanged on a second pass', () => {
    const first = assignClaimIds(ANCHORED);
    expect(first.assigned.map((row) => row.id)).toEqual(['drivers-finish-early']);
    expect(first.content).toContain('<!-- claim: award-once -->');
    expect(first.content).toContain('<!-- claim: drivers-finish-early -->');
    const second = assignClaimIds(first.content);
    expect(second.assigned).toEqual([]);
    expect(second.content).toBe(first.content);
  });

  it('suffixes a slug that would collide', () => {
    const content = `# T

## Acceptance Criteria

- same words here
- same words here
`;
    const { assigned } = assignClaimIds(content);
    expect(assigned[0].id).toBe(slugFromText('same words here'));
    expect(assigned[1].id).toBe(`${assigned[0].id}-2`);
  });
});

describe('parseClaimRef', () => {
  it('accepts a repo-qualified ref and a bare ref, and rejects a string with no hash', () => {
    expect(parseClaimRef('services:automation/index#award-once')).toEqual({
      repo: 'services',
      specKey: 'automation/index',
      claimId: 'award-once',
    });
    expect(parseClaimRef('automation/index#award-once')?.repo).toBeUndefined();
    expect(parseClaimRef('not a ref')).toBeNull();
  });
});

describe('journey invariants', () => {
  it('reports a verifies ref that is missing from the catalog', () => {
    const spec = parseSpecContent(
      `# Journey

<!--
  module: specs/journeys/demo.md
  type: journey
-->

## World

A cloned experience.

## Actors and Goals

One driver.

## Invariants

### badge-iff
The badge matches the trace.

verifies: services:automation/index#award-once, services:automation/index#missing

## Budget

20 ticks.

## Evidence

verdicts.json
`,
      'specs/journeys/demo.md',
      'specs',
    );
    expect(spec.journey?.world).toContain('cloned');
    expect(spec.journey?.invariants).toHaveLength(1);
    expect(parseInvariants(spec.sections['Invariants'])[0].verifies).toHaveLength(2);
    const missing = danglingClaimRefs(spec.journey?.invariants ?? [], new Set([
      'services:automation/index#award-once',
    ]));
    expect(missing).toEqual(['badge-iff: services:automation/index#missing']);
  });
});

describe('claims assign and list', () => {
  it('writes anchors into a spec directory and list fails on a dangling journey ref', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sg-claims-'));
    const specs = path.join(dir, 'specs');
    mkdirSync(specs, { recursive: true });
    writeFileSync(
      path.join(specs, 'widget.md'),
      `# Widget\n\n## Acceptance Criteria\n\n- Does the thing\n`,
    );
    writeFileSync(
      path.join(specs, 'journey.md'),
      `# Journey\n\n<!--\n  type: journey\n-->\n\n## Invariants\n\n### only\nverifies: widget#not-real\n`,
    );

    const assigned = await runClaimsAssign({ dir: specs });
    expect(assigned.updated).toBe(1);
    const written = readFileSync(path.join(specs, 'widget.md'), 'utf8');
    expect(written).toContain('<!-- claim: does-the-thing -->');

    const listed = await runClaimsList({
      cwd: dir,
      workspace: false,
      config: {
        rootDir: dir,
        apps: [{
          name: 'widget',
          repo: '.',
          specDir: 'specs',
          sources: {},
          framework: 'vitest',
          testOutput: 'tests',
        }],
        llm: { provider: 'anthropic', model: 'claude', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
    });
    expect(listed.exitCode).toBe(2);
    expect(listed.messages.some((line) => line.includes('dangling'))).toBe(true);
  });
});

describe('proof ingest', () => {
  it('stores a proven verdict and a spec edit makes the effective verdict stale', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sg-proof-'));
    const specs = path.join(dir, 'specs');
    mkdirSync(specs, { recursive: true });
    mkdirSync(path.join(dir, '.specguard'), { recursive: true });
    const specPath = path.join(specs, 'widget.md');
    writeFileSync(
      specPath,
      `# Widget\n\n<!--\n  module: src/widget.ts\n  type: core\n-->\n\n## Acceptance Criteria\n\n- Does the thing <!-- claim: does-the-thing -->\n`,
    );
    writeFileSync(
      path.join(dir, '.specguard', 'config.json'),
      JSON.stringify({
        apps: [{
          name: 'widget',
          repo: '.',
          specDir: 'specs',
          sources: { api: ['src/**/*.ts'] },
          framework: 'vitest',
          testOutput: 'tests',
        }],
        llm: { provider: 'anthropic', model: 'claude', apiKeyEnv: 'ANTHROPIC_API_KEY' },
      }),
    );
    const verdicts = path.join(dir, 'verdicts.json');
    writeFileSync(
      verdicts,
      JSON.stringify({
        runId: 'run-1',
        verdicts: [{ claim: 'widget#does-the-thing', verdict: 'proven', exercised: 2, counterexamples: 0 }],
      }),
    );

    const ingested = await runProofIngest(verdicts, dir);
    expect(ingested.failed).toBe(0);
    expect(ingested.updated).toBe(1);
    const ledger = JSON.parse(readFileSync(path.join(dir, '.specguard', 'proofs.json'), 'utf8'));
    const row = ledger.proofs['widget#does-the-thing'];
    expect(row.verdict).toBe('proven');
    expect(effectiveVerdict(row, { specHash: row.specHash, fileHashes: {} })).toBe('proven');
    expect(effectiveVerdict(row, { specHash: 'changed', fileHashes: {} })).toBe('stale');
    expect(effectiveVerdict(undefined, { specHash: row.specHash, fileHashes: {} })).toBe('unproven');
    expect(effectiveVerdict(
      { ...row, fileHashes: { '/tmp/a.ts': 'old' } },
      { specHash: row.specHash, fileHashes: {} },
    )).toBe('proven');
  });
});
