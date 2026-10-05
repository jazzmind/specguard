import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../src/core/config.js';
import { effectiveVerdict, type ProofRecord } from '../../src/core/proof-ledger.js';
import { dependencyFingerprint } from '../../src/core/dependency-fingerprint.js';
import { saveRegistry } from '../../src/core/drift-registry.js';
import {
  appendProofCoverage,
  fileHashesFor,
  ingestVerdicts,
  migrateLedgerPaths,
  runProofIngest,
} from '../../src/pipelines/proof.js';
import { makeRepo } from '../helpers/repo.js';

function ledger(dir: string, rel = '.specguard/proofs.json') {
  return JSON.parse(readFileSync(path.join(dir, rel), 'utf8')) as { proofs: Record<string, ProofRecord> };
}

async function status(dir: string, opts = {}): Promise<string[]> {
  const lines: string[] = [];
  await appendProofCoverage(await loadConfig(dir), (l) => lines.push(l), opts);
  return lines;
}

describe('proof ledger', () => {
  it('rejects a verdicts file without runId or verdicts', async () => {
    const repo = makeRepo();
    repo.write('v.json', JSON.stringify({ verdicts: [] }));
    const r = await runProofIngest('v.json', repo.dir);
    expect(r.exitCode).toBe(2);
    expect(r.messages[0]).toMatch(/not valid/);
  });

  it('fails unknown claims and stores known ones; later ingest replaces the row', async () => {
    const repo = makeRepo();
    repo.write(
      'v.json',
      JSON.stringify({
        runId: 'r1',
        verdicts: [
          { claim: 'core/awards#award-once', verdict: 'proven', exercised: 2 },
          { claim: 'core/missing#x', verdict: 'proven' },
          { claim: 'not-a-ref', verdict: 'proven' },
        ],
      }),
    );
    const r = await runProofIngest('v.json', repo.dir);
    expect(r.failed).toBe(2);
    expect(r.updated).toBe(1);
    expect(Object.keys(ledger(repo.dir).proofs)).toEqual(['core/awards#award-once']);

    repo.write('v2.json', JSON.stringify({ runId: 'r2', verdicts: [{ claim: 'core/awards#award-once', verdict: 'failed', counterexamples: 1 }] }));
    await runProofIngest('v2.json', repo.dir);
    const row = ledger(repo.dir).proofs['core/awards#award-once'];
    expect(row).toMatchObject({ runId: 'r2', verdict: 'failed', counterexamples: 1 });
  });

  it('marks proofs stale when the spec changes', async () => {
    const repo = makeRepo();
    await ingestVerdicts({ runId: 'r', verdicts: [{ claim: 'core/awards#award-once', verdict: 'proven' }] }, repo.dir);
    expect((await status(repo.dir)).join('\n')).toContain('1 proven');
    writeFileSync(path.join(repo.dir, 'specs/core/awards.md'), readFileSync(path.join(repo.dir, 'specs/core/awards.md'), 'utf8') + '\nedit\n');
    const lines = await status(repo.dir);
    expect(lines.join('\n')).toContain('[proof-stale] core/awards#award-once');
  });

  it('records the dependency fingerprint and goes stale on a lockfile change', async () => {
    const repo = makeRepo();
    await ingestVerdicts({ runId: 'r', verdicts: [{ claim: 'core/awards#award-once', verdict: 'proven' }] }, repo.dir);
    const row = ledger(repo.dir).proofs['core/awards#award-once'];
    expect(row.dependencyFingerprint).toBe(dependencyFingerprint(repo.dir));
    expect(row.dependencyFingerprint).toBeTruthy();
    repo.write('package-lock.json', '{"lockfileVersion":3,"packages":{"x":{"version":"2"}}}\n');
    expect((await status(repo.dir)).join('\n')).toContain('[proof-stale] core/awards#award-once');
  });

  it('effectiveVerdict ignores a missing fingerprint on either side', () => {
    const rec: ProofRecord = {
      claim: 'a#b', verdict: 'proven', runId: 'r', specHash: 'h', fileHashes: {}, exercised: 1, counterexamples: 0, ingestedAt: '',
    };
    expect(effectiveVerdict(rec, { specHash: 'h', fileHashes: {}, dependencyFingerprint: 'x' })).toBe('proven');
    expect(effectiveVerdict({ ...rec, dependencyFingerprint: 'a' }, { specHash: 'h', fileHashes: {} })).toBe('proven');
    expect(effectiveVerdict({ ...rec, dependencyFingerprint: 'a' }, { specHash: 'h', fileHashes: {}, dependencyFingerprint: 'b' })).toBe('stale');
    expect(effectiveVerdict(undefined, { specHash: 'h', fileHashes: {} })).toBe('unproven');
  });

  it('goes stale when a recorded source file changes on disk, even before drift runs', async () => {
    const repo = makeRepo();
    const src = path.join(repo.dir, 'src/core/awards.ts');
    const { createHash } = await import('node:crypto');
    saveRegistry(repo.dir, {
      'app/core/awards': {
        specKey: 'app/core/awards',
        specHash: 'x',
        files: { 'src/core/awards.ts': { hash: createHash('sha256').update(readFileSync(src)).digest('hex'), lastChecked: '', lastVerdict: 'no-drift' } },
      },
    });
    await ingestVerdicts({ runId: 'r', verdicts: [{ claim: 'core/awards#award-once', verdict: 'proven' }] }, repo.dir);
    expect(Object.keys(ledger(repo.dir).proofs['core/awards#award-once'].fileHashes)).toEqual(['src/core/awards.ts']);
    writeFileSync(src, 'export const x = 2;\n');
    expect((await status(repo.dir)).join('\n')).toContain('[proof-stale]');
  });

  it('fileHashesFor matches the exact app and spec key', () => {
    const repo = makeRepo();
    const entry = (file: string) => ({
      specKey: '', specHash: '', files: { [file]: { hash: 'h', lastChecked: '', lastVerdict: 'no-drift' as const } },
    });
    saveRegistry(repo.dir, { 'one/core/awards': entry('a.ts'), 'two/core/awards': entry('b.ts'), 'one/other/core/awards': entry('c.ts') });
    expect(Object.keys(fileHashesFor(repo.dir, 'core/awards', ['one']))).toEqual(['a.ts']);
    expect(Object.keys(fileHashesFor(repo.dir, 'core/awards', ['two']))).toEqual(['b.ts']);
  });

  it('migrates absolute fileHashes keys to relative POSIX keys', () => {
    const root = '/some/machine/repo';
    const l = {
      version: 1 as const,
      proofs: {
        'a#b': {
          claim: 'a#b', verdict: 'proven' as const, runId: 'r', specHash: 'h', exercised: 1, counterexamples: 0, ingestedAt: '',
          fileHashes: { [`${root}/src/x.ts`]: 'h1', 'src/y.ts': 'h2' },
        },
      },
    };
    expect(migrateLedgerPaths(l, [root])).toBe(true);
    expect(l.proofs['a#b'].fileHashes).toEqual({ 'src/x.ts': 'h1', 'src/y.ts': 'h2' });
    expect(migrateLedgerPaths(l, [root])).toBe(false);
  });

  it('honours --ledger and paths.proofLedger so two ledgers sit side by side', async () => {
    const repo = makeRepo({ paths: { proofLedger: '.specguard/patched.json' } });
    const v = { runId: 'r', verdicts: [{ claim: 'core/awards#award-once', verdict: 'proven' as const }] };
    await ingestVerdicts(v, repo.dir);
    await ingestVerdicts({ ...v, verdicts: [{ claim: 'core/awards#award-once', verdict: 'failed' as const }] }, repo.dir, { ledger: '.specguard/baseline.json' });
    expect(ledger(repo.dir, '.specguard/patched.json').proofs['core/awards#award-once'].verdict).toBe('proven');
    expect(ledger(repo.dir, '.specguard/baseline.json').proofs['core/awards#award-once'].verdict).toBe('failed');
    expect((await status(repo.dir)).join('\n')).toContain('1 proven');
    expect((await status(repo.dir, { ledger: '.specguard/baseline.json' })).join('\n')).toContain('1 failed');
  });
});
