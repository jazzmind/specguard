import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../src/core/config.js';
import { effectiveClaimProof, effectiveVerdict, type ProofRecord } from '../../src/core/proof-ledger.js';
import { assessmentKey, saveAssessments } from '../../src/core/drift-assessments.js';
import { hashFile, saveRegistry } from '../../src/core/drift-registry.js';
import { dependencyFingerprint } from '../../src/core/dependency-fingerprint.js';
import { parseSpecContent } from '../../src/core/spec-parser.js';
import {
  appendProofCoverage,
  fileHashesFor,
  ingestVerdicts,
  migrateLedgerPaths,
  runProofIngest,
  walkClaimVerdicts,
} from '../../src/pipelines/proof.js';
import { makeRepo } from '../helpers/repo.js';
import { AUTH_SPEC, SHOP_SPEC_WITH_ROWS, makeV2Repo } from '../helpers/v2-repo.js';

function ledger(dir: string, rel = '.specguard/proofs.json') {
  return JSON.parse(readFileSync(path.join(dir, rel), 'utf8')) as { proofs: Record<string, ProofRecord> };
}

async function status(dir: string, opts = {}): Promise<string[]> {
  const lines: string[] = [];
  await appendProofCoverage(await loadConfig(dir), (l) => lines.push(l), opts);
  return lines;
}

describe('proof ledger', () => {
  // [claims: capabilities/conformance-testing#ingest-validation]
  it('rejects a verdicts file without runId or verdicts', async () => {
    const repo = makeRepo();
    repo.write('v.json', JSON.stringify({ verdicts: [] }));
    const r = await runProofIngest('v.json', repo.dir);
    expect(r.exitCode).toBe(2);
    expect(r.messages[0]).toMatch(/not valid/);
  });

  // [claims: capabilities/conformance-testing#ingest-validation]
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

  // [claims: capabilities/conformance-testing#stale-rule]
  it('marks proofs stale when the spec changes', async () => {
    const repo = makeRepo();
    await ingestVerdicts({ runId: 'r', verdicts: [{ claim: 'core/awards#award-once', verdict: 'proven' }] }, repo.dir);
    expect((await status(repo.dir)).join('\n')).toContain('1 proven');
    writeFileSync(path.join(repo.dir, 'specs/core/awards.md'), readFileSync(path.join(repo.dir, 'specs/core/awards.md'), 'utf8') + '\nedit\n');
    const lines = await status(repo.dir);
    expect(lines.join('\n')).toContain('[proof-stale] core/awards#award-once');
  });

  // [claims: capabilities/conformance-testing#ledger-records-basis, capabilities/conformance-testing#stale-rule]
  it('records the dependency fingerprint and goes stale on a lockfile change', async () => {
    const repo = makeRepo();
    await ingestVerdicts({ runId: 'r', verdicts: [{ claim: 'core/awards#award-once', verdict: 'proven' }] }, repo.dir);
    const row = ledger(repo.dir).proofs['core/awards#award-once'];
    expect(row.dependencyFingerprint).toBe(dependencyFingerprint(repo.dir));
    expect(row.dependencyFingerprint).toBeTruthy();
    repo.write('package-lock.json', '{"lockfileVersion":3,"packages":{"x":{"version":"2"}}}\n');
    expect((await status(repo.dir)).join('\n')).toContain('[proof-stale] core/awards#award-once');
  });

  // [claims: capabilities/conformance-testing#stale-rule]
  it('effectiveVerdict ignores a missing fingerprint on either side', () => {
    const rec: ProofRecord = {
      claim: 'a#b', verdict: 'proven', runId: 'r', specHash: 'h', fileHashes: {}, exercised: 1, counterexamples: 0, ingestedAt: '',
    };
    expect(effectiveVerdict(rec, { specHash: 'h', fileHashes: {}, dependencyFingerprint: 'x' })).toBe('proven');
    expect(effectiveVerdict({ ...rec, dependencyFingerprint: 'a' }, { specHash: 'h', fileHashes: {} })).toBe('proven');
    expect(effectiveVerdict({ ...rec, dependencyFingerprint: 'a' }, { specHash: 'h', fileHashes: {}, dependencyFingerprint: 'b' })).toBe('stale');
    expect(effectiveVerdict(undefined, { specHash: 'h', fileHashes: {} })).toBe('unproven');
  });

  // [claims: capabilities/conformance-testing#ledger-records-basis, capabilities/conformance-testing#stale-rule]
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

  // [claims: capabilities/conformance-testing#shared-ingest-and-ledger-path]
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

  // [claims: capabilities/conformance-testing#shared-ingest-and-ledger-path]
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

describe('ledger versions [ledger-version]', () => {
  // [claims: capabilities/conformance-testing#shared-ingest-and-ledger-path]
  it('refuses to read or overwrite a ledger written by a newer SpecGuard', async () => {
    const repo = makeRepo();
    const file = path.join(repo.dir, '.specguard', 'proofs.json');
    repo.write('.specguard/proofs.json', JSON.stringify({ version: 3, proofs: { 'a#b': { claim: 'a#b', verdict: 'proven' } } }));
    const before = readFileSync(file, 'utf8');
    repo.write('v.json', JSON.stringify({ runId: 'r', verdicts: [{ claim: 'core/awards#award-once', verdict: 'proven' }] }));
    await expect(runProofIngest('v.json', repo.dir)).rejects.toThrow(/version 3/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

const LOGIN = 'capabilities/auth#login-valid-code';
const CART = 'capabilities/shop#cart-totals';
const LAYERED_AUTH = AUTH_SPEC.replace('tests:\n  - "tests/auth.test.ts"\n---', 'tests:\n  - "tests/auth.test.ts"\nlayers:\n  default: [unit]\n---');

async function walk(dir: string, opts = {}): Promise<Map<string, { verdict: string; missing: string[] }>> {
  const seen = new Map<string, { verdict: string; missing: string[] }>();
  await walkClaimVerdicts(await loadConfig(dir), (ref, verdict, detail) => seen.set(ref, { verdict, missing: detail?.missing ?? [] }), opts);
  return seen;
}

describe('agentic and manual evidence [nonautomated-evidence-functional-only]', () => {
  // [claims: capabilities/conformance-testing#nonautomated-evidence-functional-only]
  it('refuses agentic or manual evidence for an automated layer and stores nothing', async () => {
    const repo = makeV2Repo();
    repo.write('specs/capabilities/auth.md', LAYERED_AUTH);
    for (const evidence of ['agentic', 'manual'] as const) {
      const r = await ingestVerdicts({ runId: 'r1', verdicts: [{ claim: LOGIN, verdict: 'proven', exercised: 1, evidence, layer: 'unit' }] }, repo.dir);
      expect(r.failed).toBe(1);
      expect(r.updated).toBe(0);
      expect(r.exitCode).toBe(2);
      expect(r.messages.join('\n')).toContain(`${evidence} evidence can only prove the functional layer`);
    }
    expect(existsSync(path.join(repo.dir, '.specguard/proofs.json')) ? ledger(repo.dir).proofs[LOGIN] : undefined).toBeUndefined();
  });

  // [claims: capabilities/conformance-testing#nonautomated-evidence-functional-only]
  it('records agentic or manual evidence without a layer as functional, and accepts an explicit functional layer', async () => {
    const repo = makeV2Repo();
    await ingestVerdicts({ runId: 'r1', verdicts: [{ claim: LOGIN, verdict: 'proven', exercised: 1, evidence: 'manual' }] }, repo.dir);
    expect(Object.keys(ledger(repo.dir).proofs[LOGIN].layers ?? {})).toEqual(['functional']);
    expect(ledger(repo.dir).proofs[LOGIN].evidence).toBe('manual');
    const r = await ingestVerdicts({ runId: 'r2', verdicts: [{ claim: LOGIN, verdict: 'proven', exercised: 1, evidence: 'agentic', layer: 'functional' }] }, repo.dir);
    expect(r.failed).toBe(0);
  });

  // [claims: capabilities/conformance-testing#nonautomated-evidence-functional-only]
  it('a required unit layer stays missing when only agentic evidence sits in it', async () => {
    const repo = makeV2Repo();
    repo.write('specs/capabilities/auth.md', LAYERED_AUTH);
    await ingestVerdicts({ runId: 'r1', verdicts: [{ claim: LOGIN, verdict: 'proven', exercised: 1, layer: 'unit' }] }, repo.dir);
    // An older or hand-edited ledger: agentic evidence under the unit layer.
    const file = path.join(repo.dir, '.specguard/proofs.json');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.proofs[LOGIN].layers.unit.evidence = 'agentic';
    writeFileSync(file, JSON.stringify(stored));
    const seen = await walk(repo.dir);
    expect(seen.get(LOGIN)?.missing).toEqual(['unit']);

    const record = stored.proofs[LOGIN] as ProofRecord;
    const proof = effectiveClaimProof(record, { specHash: record.specHash, claimHash: record.claimHash, fileHashes: record.fileHashes }, ['unit']);
    expect(proof.missing).toEqual(['unit']);
    expect(proof.complete).toBe(false);
    // The same layer with test evidence is satisfied.
    delete stored.proofs[LOGIN].layers.unit.evidence;
    expect(effectiveClaimProof(stored.proofs[LOGIN], { specHash: record.specHash, claimHash: record.claimHash, fileHashes: record.fileHashes }, ['unit']).complete).toBe(true);
  });
});

describe('deterministic walk [deterministic-walk]', () => {
  // [claims: capabilities/conformance-testing#deterministic-walk]
  it('goes stale on any changed owned file where the default walk trusts a drift assessment', async () => {
    const repo = makeV2Repo();
    await ingestVerdicts({ runId: 'r1', verdicts: [{ claim: LOGIN, verdict: 'proven', exercised: 1 }] }, repo.dir);
    repo.write('src/auth/login.ts', 'export const login = 2;\n');
    const now = hashFile(path.join(repo.dir, 'src/auth/login.ts'))!;
    saveAssessments(repo.dir, { 'capabilities/auth': { [assessmentKey('src/auth/login.ts', now)]: { affectedClaims: [], at: '2999-01-01T00:00:00.000Z', reason: 'comment only' } } });

    expect((await walk(repo.dir)).get(LOGIN)?.verdict).toBe('proven');
    expect((await walk(repo.dir, { deterministic: true })).get(LOGIN)?.verdict).toBe('stale');
    // `proof status` reports the stale row in deterministic mode.
    expect((await status(repo.dir, { deterministic: true })).join('\n')).toContain('[proof-stale] capabilities/auth#login-valid-code');
  });
});

describe('row proofs [row-proofs]', () => {
  const rowRef = (id: string) => `${CART}/${id}`;
  const rowHash = (dir: string, id: string): string => {
    const abs = path.join(dir, 'specs/capabilities/shop.md');
    const claim = parseSpecContent(readFileSync(abs, 'utf8'), abs, path.dirname(abs)).claims.find((c) => c.id === 'cart-totals');
    return claim!.examples!.rows.find((r) => r.id === id)!.hash;
  };
  const repoWithRows = () => {
    const repo = makeV2Repo();
    repo.write('specs/capabilities/shop.md', SHOP_SPEC_WITH_ROWS);
    return repo;
  };

  // [claims: capabilities/conformance-testing#row-proofs]
  it('stores a row proof under cap#claim/row with the row hash, and rejects a row that is not in the table', async () => {
    const repo = repoWithRows();
    const r = await ingestVerdicts({ runId: 'r1', verdicts: [
      { claim: rowRef('ny-small'), verdict: 'proven', exercised: 1 },
      { claim: rowRef('nope'), verdict: 'proven', exercised: 1 },
    ] }, repo.dir);
    expect(r.updated).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.messages.join('\n')).toContain('example row not found');
    const proofs = ledger(repo.dir).proofs;
    expect(Object.keys(proofs)).toEqual([rowRef('ny-small')]);
    expect(proofs[rowRef('ny-small')].claimHash).toBe(rowHash(repo.dir, 'ny-small'));
    // A spec without a table has no rows at all.
    const plain = makeV2Repo();
    const none = await ingestVerdicts({ runId: 'r1', verdicts: [{ claim: `${LOGIN}/x`, verdict: 'proven' }] }, plain.dir);
    expect(none.failed).toBe(1);
  });

  // [claims: capabilities/conformance-testing#row-proofs]
  it('the walk visits each row after its claim, and a changed row cell stales only that row', async () => {
    const repo = repoWithRows();
    await ingestVerdicts({ runId: 'r1', verdicts: [
      { claim: CART, verdict: 'proven', exercised: 1 },
      { claim: rowRef('ny-small'), verdict: 'proven', exercised: 1 },
      { claim: rowRef('ny-free'), verdict: 'proven', exercised: 1 },
    ] }, repo.dir);
    const order: string[] = [];
    const counts = await walkClaimVerdicts(await loadConfig(repo.dir), (ref) => order.push(ref));
    expect(order.filter((ref) => ref.startsWith(CART))).toEqual([CART, rowRef('ny-small'), rowRef('ny-free')]);
    expect(counts?.proven).toBe(3);

    repo.write('specs/capabilities/shop.md', SHOP_SPEC_WITH_ROWS.replace('| 5.00  |', '| 6.00  |'));
    const seen = await walk(repo.dir);
    expect(seen.get(rowRef('ny-small'))?.verdict).toBe('stale');
    expect(seen.get(rowRef('ny-free'))?.verdict).toBe('proven');
    expect(seen.get(CART)?.verdict).toBe('proven');
  });

  // [claims: capabilities/conformance-testing#row-proofs]
  it('an unproven row is counted unproven, and a spec without tables is walked as before', async () => {
    const repo = repoWithRows();
    await ingestVerdicts({ runId: 'r1', verdicts: [{ claim: CART, verdict: 'proven', exercised: 1 }] }, repo.dir);
    const seen = await walk(repo.dir);
    expect(seen.get(rowRef('ny-small'))?.verdict).toBe('unproven');

    const plain = makeV2Repo();
    await ingestVerdicts({ runId: 'r1', verdicts: [{ claim: CART, verdict: 'proven', exercised: 1 }] }, plain.dir);
    const refs: string[] = [];
    const counts = await walkClaimVerdicts(await loadConfig(plain.dir), (ref) => refs.push(ref));
    expect(refs).toEqual([LOGIN, 'capabilities/auth#logout-clears-session', CART]);
    expect(counts).toMatchObject({ proven: 1, unproven: 2 });
  });
});
