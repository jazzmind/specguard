import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { readMutationEvidence, runMutationIngest, type MutationEvidence } from '../../src/pipelines/mutation-ingest.js';
import { makeV2Repo } from '../helpers/v2-repo.js';

const strykerReport = (source: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    schemaVersion: '1',
    files: {
      'src/auth/login.ts': {
        language: 'typescript',
        source,
        mutants: [
          { id: '1', mutatorName: 'BooleanLiteral', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } }, status: 'Killed', killedBy: ['t1'], coveredBy: ['t1'] },
          { id: '2', mutatorName: 'BooleanLiteral', location: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } }, status: 'Survived', coveredBy: ['t1'] },
        ],
      },
    },
    testFiles: { 'tests/auth.test.ts': { tests: [{ id: 't1', name: 'logs in' }] } },
    ...extra,
  });

const pit = (sourceFile: string, cls: string) =>
  `<mutations><mutation detected='true' status='KILLED' numberOfTestsRun='1'><sourceFile>${sourceFile}</sourceFile><mutatedClass>${cls}</mutatedClass><mutatedMethod>m</mutatedMethod><methodDescription>()V</methodDescription><lineNumber>4</lineNumber><mutator>org.pitest.mutationtest.engine.gregor.mutators.MathMutator</mutator><indexes><index>1</index></indexes><blocks><block>0</block></blocks><killingTest>com.acme.CartTest.sums(com.acme.CartTest)</killingTest><description>d</description></mutation></mutations>`;

const stored = (dir: string) => JSON.parse(readFileSync(path.join(dir, '.specguard/mutation/report.json'), 'utf8')) as MutationEvidence;

describe('mutation ingest [coverage-and-mutation]', () => {
  // [claims: capabilities/coverage-and-mutation#ingest-commands]
  it('writes the normalized Stryker report with the embedded source hashes and the run metadata', async () => {
    const repo = makeV2Repo();
    repo.write('mutation.json', strykerReport('export const login = 1;\n'));
    const r = await runMutationIngest(['mutation.json'], repo.dir, { runId: 'm-1', origin: 'ci' });
    expect(r.exitCode).toBe(0);
    const e = stored(repo.dir);
    expect(e).toMatchObject({ version: 1, runId: 'm-1', origin: 'ci' });
    expect(e.report.tool).toBe('stryker');
    expect(e.report.mutants.map((m) => m.status)).toEqual(['killed', 'survived']);
    expect(Object.keys(e.report.sourceHashes)).toEqual(['src/auth/login.ts']);
    expect(r.messages.join('\n')).toContain('2 mutant(s) in 1 file(s) (1 killed, 1 survived)');
    expect(r.messages.join('\n')).toContain('lower bound');
    expect((await readMutationEvidence(repo.dir))?.runId).toBe('m-1');
  });

  // [claims: capabilities/coverage-and-mutation#evidence-staleness]
  it('hashes the files of a PIT report at ingest, since PIT does not embed source', async () => {
    const repo = makeV2Repo();
    repo.write('src/main/java/com/acme/Cart.java', 'class Cart {}\n');
    repo.write('mutations.xml', pit('Cart.java', 'com.acme.Cart'));
    const r = await runMutationIngest(['mutations.xml'], repo.dir);
    expect(r.exitCode).toBe(0);
    const e = stored(repo.dir);
    expect(e.report.tool).toBe('pit');
    expect(e.report.sourceHashes['src/main/java/com/acme/Cart.java']).toMatch(/^[0-9a-f]{64}$/);
    expect(r.messages.join('\n')).toContain('no per-test coverage');
  });

  // [claims: capabilities/coverage-and-mutation#ingest-commands]
  it('merges several reports of one tool, and refuses to mix tools', async () => {
    const repo = makeV2Repo();
    repo.write('mut-a.json', strykerReport('export const login = 1;\n'));
    repo.write('mut-b.json', strykerReport('export const login = 1;\n'));
    const merged = await runMutationIngest(['mut-*.json'], repo.dir);
    expect(merged.exitCode).toBe(0);
    expect(stored(repo.dir).report.mutants).toHaveLength(4);
    repo.write('c.xml', pit('Cart.java', 'com.acme.Cart'));
    repo.write('src/main/java/com/acme/Cart.java', 'class Cart {}\n');
    const mixed = await runMutationIngest(['mut-a.json', 'c.xml'], repo.dir);
    expect(mixed.exitCode).toBe(2);
    expect(mixed.messages.join(' ')).toContain('cannot combine');
  });

  // [claims: capabilities/coverage-and-mutation#ingest-commands]
  it('exits 2 and writes nothing for unparseable input, no matching file, or nothing that maps to the repo', async () => {
    const repo = makeV2Repo();
    repo.write('junk.json', '{"nothing":true}');
    expect((await runMutationIngest(['junk.json'], repo.dir)).exitCode).toBe(2);
    expect((await runMutationIngest(['absent-*.json'], repo.dir)).exitCode).toBe(2);
    repo.write('elsewhere.xml', pit('Nope.java', 'com.acme.Nope'));
    const unmapped = await runMutationIngest(['elsewhere.xml'], repo.dir);
    expect(unmapped.exitCode).toBe(2);
    expect(unmapped.messages.join(' ')).toContain('maps onto a repo file');
    expect(existsSync(path.join(repo.dir, '.specguard/mutation/report.json'))).toBe(false);
  });

  // [claims: capabilities/coverage-and-mutation#mutation-formats-parsed]
  it('config mutation.attribution "full" is honoured for a Stryker report', async () => {
    const repo = makeV2Repo({ mutation: { attribution: 'full' } });
    repo.write('mutation.json', strykerReport('export const login = 1;\n'));
    await runMutationIngest(['mutation.json'], repo.dir);
    expect(stored(repo.dir).report.attribution).toBe('full');
  });

  // [claims: capabilities/coverage-and-mutation#mutation-min-score]
  it('config accepts mutation.minScore, minKilled and timeoutAsKilled and rejects a score above 100', async () => {
    const ok = makeV2Repo({ mutation: { minScore: 85, minKilled: 2, timeoutAsKilled: false }, coverage: { sourceRoots: ['lib/java'] } });
    const cfg = await loadConfig(ok.dir);
    expect(cfg.mutation).toEqual({ minScore: 85, minKilled: 2, timeoutAsKilled: false });
    expect(cfg.coverage).toEqual({ sourceRoots: ['lib/java'] });
    const bad = makeV2Repo({ mutation: { minScore: 150 } });
    await expect(loadConfig(bad.dir)).rejects.toThrow();
  });
});
