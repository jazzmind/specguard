import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/llm.js', () => ({ llmGenerateObject: vi.fn(), llmGenerateText: vi.fn() }));

import { loadConfig } from '../../src/core/config.js';
import { llmGenerateObject } from '../../src/core/llm.js';
import { buildSpecGraph } from '../../src/core/spec-graph.js';
import { runSpecConsolidate } from '../../src/pipelines/spec-consolidate.js';
import { runResultsIngest } from '../../src/pipelines/results.js';
import { makeRepo, type TmpRepo } from '../helpers/repo.js';

const mocked = llmGenerateObject as unknown as ReturnType<typeof vi.fn>;

const POINTS = `# Points

<!--
  module: src/core/points.ts
  type: core
-->

## Overview

Points ledger.

## Acceptance Criteria

- [ ] Duplicates are rejected differently here <!-- claim: no-dupes -->
- [ ] Balance never goes negative
`;

let repo: TmpRepo;
let clusterAnswer: Record<string, unknown>;
let synthAnswer: Record<string, unknown>;

const cluster = (specs: string[]) => ({
  system: { title: 'Game', problem: 'p', users: ['Players'], value: 'v', nonGoals: [] },
  capabilities: [
    { id: 'scoring', title: 'Scoring', value: 'Fair points', rationale: 'r', sources: ['src/core/**'], tests: [], docs: [], specs, components: [] },
  ],
});

beforeEach(() => {
  mocked.mockReset();
  repo = makeRepo();
  repo.write('specs/core/points.md', POINTS);
  repo.write('src/core/points.ts', '/**\n * Spec: specs/core/points.md\n */\nexport const p = 1;\n');
  repo.write('src/core/awards.ts', '/**\n * Spec: specs/core/awards.md\n */\nexport const a = 1;\n');
  repo.write('tests/awards.test.ts', "it('awards once @claim:core/awards#award-once', () => {});\nit('dupes [claim: core/awards#no-dupes]', () => {});\n");
  repo.write(
    '.specguard/proofs.json',
    JSON.stringify({
      version: 1,
      proofs: {
        'core/awards#award-once': { claim: 'core/awards#award-once', verdict: 'proven', runId: 'r', specHash: 'h', fileHashes: {}, exercised: 1, counterexamples: 0, ingestedAt: '2026-01-01' },
      },
    }),
  );
  repo.write(
    '.specguard/drift-registry.json',
    JSON.stringify({ 'core/awards': { specKey: 'core/awards', specHash: 'h', files: { 'src/core/awards.ts': { hash: 'f', lastChecked: 't', lastVerdict: 'ok' } } } }),
  );
  clusterAnswer = cluster(['core/awards', 'core/points']);
  synthAnswer = {
    problemAndValue: 'Points are fair.',
    users: ['A player earns points'],
    requirements: [
      { text: 'Points are awarded exactly once per action', replaces: ['core/awards#award-once'] },
      { text: 'Duplicate awards are rejected', replaces: ['core/awards#no-dupes', 'core/points#no-dupes'] },
    ],
    scenarios: [{ name: 'Award once', steps: ['Act'], expected: ['Points added'] }],
    security: '',
    interfaces: '',
    outOfScope: '',
  };
  mocked.mockImplementation(async (opts: { pipeline: string }) => {
    if (opts.pipeline === 'summarize') return { summary: 's' };
    if (opts.pipeline === 'cluster') return clusterAnswer;
    if (opts.pipeline === 'spec-draft') return synthAnswer;
    throw new Error(opts.pipeline);
  });
});

const read = (rel: string) => readFileSync(path.join(repo.dir, rel), 'utf8');
const exists = (rel: string) => existsSync(path.join(repo.dir, rel));

describe('spec consolidate [spec-consolidate]', () => {
  // [claims: capabilities/spec-authoring#spec-draft-proposes-map]
  it('stops at the map for review without touching anything [consolidate-map-first]', async () => {
    const r = await runSpecConsolidate(await loadConfig(repo.dir), {});
    expect(r.exitCode).toBe(0);
    expect(exists('.specguard/spec-map.json')).toBe(true);
    expect(exists('specs/capabilities/scoring.md')).toBe(false);
    expect(exists('specs/core/awards.md')).toBe(true);
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('refuses to proceed while a v1 spec is unassigned and archives nothing [unassigned-stops]', async () => {
    clusterAnswer = cluster(['core/awards']);
    const r = await runSpecConsolidate(await loadConfig(repo.dir), { yes: true });
    expect(r.exitCode).toBe(2);
    expect(r.messages.join('\n')).toContain('core/points');
    expect(exists('specs/capabilities/scoring.md')).toBe(false);
    expect(exists('specs/core/points.md')).toBe(true);
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('migrates specs, tags, ledger, registry and source comments in one pass [full-migration]', async () => {
    const config = await loadConfig(repo.dir);
    const r = await runSpecConsolidate(config, { yes: true, rewriteSourceRefs: true });
    expect(r.failed).toBe(0);

    // The capability keeps the model's requirements and carries over the anchored claim nobody absorbed,
    // but not the bullet that never had an id: it has no reference to preserve.
    const cap = read('specs/capabilities/scoring.md');
    expect(cap).toContain('<!-- claim: points-are-awarded-exactly-once-per -->');
    expect(cap).toContain('Nothing tests this');
    expect(cap).not.toContain('Balance never goes negative');

    // Old specs are archived, not deleted.
    expect(exists('specs/core/awards.md')).toBe(false);
    expect(exists('specs/_archive/v1/core/awards.md')).toBe(true);

    const migration = JSON.parse(read('.specguard/claim-migration.json'));
    const target = migration.aliases['core/awards#award-once'] as string;
    expect(target).toMatch(/^capabilities\/scoring#points-are-awarded-exactly-once-per$/);
    // Two old claims that said the same thing in different specs land on one new claim.
    expect(migration.aliases['core/awards#no-dupes']).toBe(migration.aliases['core/points#no-dupes']);
    expect(migration.specs['core/awards']).toBe('capabilities/scoring');

    // Tags in tests now point at the new refs.
    const tests = read('tests/awards.test.ts');
    expect(tests).toContain(`@claim:${target}`);
    expect(tests).not.toContain('core/awards#');

    // The proof moved with its claim and stays stale rather than claiming a proof it cannot back.
    const ledger = JSON.parse(read('.specguard/proofs.json')).proofs;
    expect(Object.keys(ledger)).toContain(target);
    expect(Object.keys(ledger)).not.toContain('core/awards#award-once');

    // The drift registry follows the spec.
    const registry = JSON.parse(read('.specguard/drift-registry.json'));
    expect(Object.keys(registry)).toEqual(['capabilities/scoring']);
    expect(Object.keys(registry['capabilities/scoring'].files)).toEqual(['src/core/awards.ts']);

    // Source comments.
    expect(read('src/core/awards.ts')).toContain('Spec: specs/capabilities/scoring.md');

    // The result is a valid spec tree.
    const graph = await buildSpecGraph(await loadConfig(repo.dir));
    expect(graph.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(graph.nodes.get('scoring')?.ownedFiles).toEqual(['src/core/awards.ts', 'src/core/points.ts']);
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('accepts results that still carry an old tag after the migration [old-tags-still-ingest]', async () => {
    await runSpecConsolidate(await loadConfig(repo.dir), { yes: true });
    repo.write('a.xml', '<testsuite name="s"><testcase classname="c" name="t @claim:core/awards#award-once"/></testsuite>');
    await runResultsIngest(['a.xml'], repo.dir);
    const ledger = JSON.parse(read('.specguard/proofs.json')).proofs;
    expect(ledger['capabilities/scoring#points-are-awarded-exactly-once-per'].verdict).toBe('proven');
    expect(Object.keys(ledger)).not.toContain('core/awards#award-once');
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('--no-archive writes the capability but leaves old specs, tags and ledger alone [no-archive]', async () => {
    await runSpecConsolidate(await loadConfig(repo.dir), { yes: true, noArchive: true });
    expect(exists('specs/capabilities/scoring.md')).toBe(true);
    expect(exists('specs/core/awards.md')).toBe(true);
    expect(read('tests/awards.test.ts')).toContain('@claim:core/awards#award-once');
    expect(exists('.specguard/claim-migration.json')).toBe(false);
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('still rewrites tags when the capability id equals the key of a v1 spec it absorbs [id-equals-key]', async () => {
    repo.write('specs/scoring.md', POINTS.replace('<!--\n  module: src/core/points.ts', '<!--\n  module: src/core/scoring.ts').replace('no-dupes', 'lockout'));
    repo.write('src/core/scoring.ts', 'export const s = 1;\n');
    repo.write('tests/scoring.test.ts', "it('locks out @claim:scoring#lockout', () => {});\n");
    clusterAnswer = cluster(['core/awards', 'core/points', 'scoring']);
    const r = await runSpecConsolidate(await loadConfig(repo.dir), { yes: true });
    expect(r.failed).toBe(0);
    const migration = JSON.parse(read('.specguard/claim-migration.json'));
    expect(migration.aliases['scoring#lockout']).toBe('capabilities/scoring#lockout');
    expect(read('tests/scoring.test.ts')).toContain('@claim:capabilities/scoring#lockout');
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('does not archive or rewrite anything when a capability already exists and --force was not given [partial-rerun]', async () => {
    await runSpecConsolidate(await loadConfig(repo.dir), { yes: true, noArchive: true });
    const r = await runSpecConsolidate(await loadConfig(repo.dir), { yes: true });
    expect(r.skipped).toBeGreaterThan(0);
    expect(r.messages.join('\n')).toContain('nothing was archived or rewritten');
    expect(exists('specs/core/awards.md')).toBe(true);
    expect(read('tests/awards.test.ts')).toContain('@claim:core/awards#award-once');
    expect(exists('.specguard/claim-migration.json')).toBe(false);
    // With --force the whole migration happens together.
    await runSpecConsolidate(await loadConfig(repo.dir), { yes: true, force: true });
    expect(exists('specs/_archive/v1/core/awards.md')).toBe(true);
    expect(read('tests/awards.test.ts')).not.toContain('core/awards#');
  });

  // [claims: capabilities/spec-authoring#spec-consolidate-migrates-state]
  it('archives v1 specs from where they were read when the specs directory is not specs/ [real-path]', async () => {
    mkdirSync(path.join(repo.dir, 'docs'), { recursive: true });
    renameSync(path.join(repo.dir, 'specs'), path.join(repo.dir, 'docs/specs'));
    const cfg = JSON.parse(read('.specguard/config.json'));
    cfg.apps[0].specDir = 'docs/specs';
    writeFileSync(path.join(repo.dir, '.specguard/config.json'), JSON.stringify(cfg));
    const r = await runSpecConsolidate(await loadConfig(repo.dir), { yes: true });
    expect(r.failed).toBe(0);
    expect(exists('docs/specs/core/awards.md')).toBe(false);
    expect(exists('specs/_archive/v1/core/awards.md')).toBe(true);
    expect(r.messages.join('\n')).toContain('archived 2 of 2');
  });
});
