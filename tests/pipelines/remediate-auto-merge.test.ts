import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ProofLedger, ProofRecord } from '../../src/core/proof-ledger.js';
import { mergeLayerRecord } from '../../src/core/proof-ledger.js';
import { ingestRun, layersNotReproven, provenLayers } from '../../src/pipelines/remediate/ledger.js';
import { armAutoMerge } from '../../src/pipelines/remediate/ship.js';
import type { ExecResult } from '../../src/pipelines/remediate/types.js';
import { makeV2Repo } from '../helpers/v2-repo.js';

const LOGIN = 'capabilities/auth#login-valid-code';
const LOGOUT = 'capabilities/auth#logout-clears-session';

const fakeGh = (answers: Record<string, ExecResult>) => {
  const calls: string[][] = [];
  const gh = (args: string[]): ExecResult => {
    calls.push(args);
    const key = args[0] === 'api' ? 'api' : args.slice(0, 2).join(' ');
    return answers[key] ?? { stdout: '', stderr: 'unexpected', status: 1 };
  };
  return { gh, calls };
};
const done = (stdout = ''): ExecResult => ({ stdout, stderr: '', status: 0 });

describe('arming GitHub auto-merge [auto-merge-enforcement]', () => {
  // [claims: capabilities/security-and-remediation#auto-merge-enforcement]
  it('merges when ready only on a branch with required checks', () => {
    const { gh, calls } = fakeGh({ api: done('{"contexts":["ci"]}'), 'pr merge': done() });
    expect(armAutoMerge(gh, '/wt', 'https://x/pr/9', 'main')).toEqual({ armed: true });
    expect(calls[0][1]).toBe('repos/{owner}/{repo}/branches/main/protection/required_status_checks');
    expect(calls[1]).toEqual(['pr', 'merge', 'https://x/pr/9', '--auto', '--squash']);
  });

  // [claims: capabilities/security-and-remediation#auto-merge-enforcement]
  it('never asks to merge an unprotected branch, which would merge before any check ran', () => {
    const notFound: ExecResult = { stdout: '{"message":"Branch not protected"}', stderr: 'HTTP 404', status: 1 };
    const unprotected = fakeGh({ api: notFound, 'pr merge': done() });
    const res = armAutoMerge(unprotected.gh, '/wt', 'https://x/pr/9', 'main');
    expect(res.armed).toBe(false);
    expect(res.reason).toMatch(/no required status checks/);
    expect(unprotected.calls.flat()).not.toContain('merge');

    const noChecks = fakeGh({ api: done('{"contexts":[],"checks":[]}'), 'pr merge': done() });
    expect(armAutoMerge(noChecks.gh, '/wt', 'u', 'main').armed).toBe(false);
    expect(noChecks.calls.flat()).not.toContain('merge');
  });

  // [claims: capabilities/security-and-remediation#auto-merge-enforcement]
  it('reports a failed merge request instead of claiming it armed, and encodes the branch name', () => {
    const { gh, calls } = fakeGh({ api: done('{"contexts":["ci"]}'), 'pr merge': { stdout: '', stderr: 'auto-merge is not allowed for this repository', status: 1 } });
    const res = armAutoMerge(gh, '/wt', 'u', 'release/1.x');
    expect(res.armed).toBe(false);
    expect(res.reason).toContain('auto-merge is not allowed for this repository');
    expect(calls[0][1]).toContain('release%2F1.x');
  });
});

const row = (over: Partial<ProofRecord>): ProofRecord => ({
  claim: 'x#a', verdict: 'proven', runId: 'r', specHash: 'h', fileHashes: {}, dependencyFingerprint: 'fp-old', exercised: 1, counterexamples: 0, ingestedAt: '2026-10-22T10:00:00.000Z', ...over,
});

describe('per-layer reproof [layers-reproven]', () => {
  const ledger = (proofs: Record<string, ProofRecord>): ProofLedger => ({ version: 1, proofs });

  // [claims: capabilities/security-and-remediation#remediate-layer-aware]
  it('lists claims proven in a layer before the change and not after it', () => {
    const baseRow = mergeLayerRecord(mergeLayerRecord(undefined, row({}), 'unit'), row({ ingestedAt: '2026-10-22T11:00:00.000Z' }), 'e2e');
    const before = provenLayers(ledger({ [LOGIN]: baseRow }), '/nowhere', 'fp-old');
    expect([...(before.get(LOGIN) ?? [])].sort()).toEqual(['e2e', 'unit']);
    // after the bump only the unit tests re-ran, against the new fingerprint
    const afterRow = mergeLayerRecord(baseRow, row({ dependencyFingerprint: 'fp-new', ingestedAt: '2026-10-22T12:00:00.000Z' }), 'unit');
    const after = provenLayers(ledger({ [LOGIN]: afterRow }), '/nowhere', 'fp-new');
    expect([...(after.get(LOGIN) ?? [])]).toEqual(['unit']); // e2e is stale against the new fingerprint
    expect(layersNotReproven(before, after)).toEqual([{ claim: LOGIN, layers: ['e2e'] }]);
    expect(layersNotReproven(before, before)).toEqual([]);
  });

  // [claims: capabilities/security-and-remediation#remediate-layer-aware]
  it('does not count a stale or failed layer as proven before the change', () => {
    const rows = mergeLayerRecord(mergeLayerRecord(undefined, row({ dependencyFingerprint: 'fp-ancient' }), 'e2e'), row({ verdict: 'failed', ingestedAt: '2026-10-22T11:00:00.000Z' }), 'unit');
    expect(provenLayers(ledger({ [LOGIN]: rows }), '/nowhere', 'fp-old').size).toBe(0);
  });

  // [claims: capabilities/security-and-remediation#remediate-layer-aware]
  it('a remediation run keeps what a browser proved that the test command never reaches', async () => {
    const repo = makeV2Repo();
    const file = path.join(repo.dir, 'seed.json');
    // the user's ledger: login proven by the browser (functional layer); logout never proven
    const functional = row({ claim: LOGIN, evidence: 'agentic', fileHashes: {} });
    writeFileSync(file, JSON.stringify({ version: 1, proofs: { [LOGIN]: mergeLayerRecord(undefined, functional, 'functional') } }));
    const outcome = await ingestRun(
      [{ file: 'tests/auth.test.ts', title: 'logs out', fullTitle: 'logs out', status: 'pass', durationMs: 1, tags: [], claims: [LOGOUT], externalIds: [] }],
      repo.dir,
      file,
      'rem-1',
    );
    const proofs = JSON.parse(readFileSync(file, 'utf8')).proofs as Record<string, { verdict: string; layers?: Record<string, { verdict: string }> }>;
    expect(proofs[LOGIN]).toMatchObject({ verdict: 'proven', layers: { functional: { verdict: 'proven' } } }); // not swept to unexercised
    expect(proofs[LOGOUT]).toMatchObject({ verdict: 'proven', layers: { unit: { verdict: 'proven' } } });
    expect(outcome.claims[LOGOUT]).toBe('proven');
    expect(outcome.claims[LOGIN]).toBeUndefined();
  });
});
