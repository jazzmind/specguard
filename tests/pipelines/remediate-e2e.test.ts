import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { RemediateExit } from '../../src/core/exit-codes.js';
import { runRemediate } from '../../src/pipelines/remediate/index.js';
import { makeFixture } from '../fixtures/remediate/make-project.js';

const T = 180_000;

function remoteBranches(remote: string): string[] {
  return spawnSync('git', ['branch', '--list'], { cwd: remote, encoding: 'utf8' }).stdout.split('\n').map((l) => l.replace('*', '').trim()).filter(Boolean);
}

describe('remediate end to end (local bare remote, fake gh, canned npm audit)', () => {
  it('PRESERVED: a safe bump produces a branch and a normal PR; the user tree is untouched', async () => {
    // claim: pr-modes
    // claim: worktree-only
    // claim: select-then-full
    // claim: proofs-restale
    // claim: scoped-commit
    // claim: no-test-rewrite
    // claim: redetect
    // claim: write-allowlist
    // claim: evidence-report
    // claim: no-auto-merge
    const fx = makeFixture('safe');
    const config = await fx.config();
    const res = await runRemediate(config, { pr: true, runId: 'run-safe' }, fx.deps);
    expect(res.messages.join('\n')).not.toMatch(/\[error\]/);
    expect(res.exitCode).toBe(RemediateExit.Preserved);

    const item = res.report!.results[0];
    expect(item.verdict).toBe('PRESERVED');
    expect(item.branch).toBe('specguard/remediate/ghsa-test-vuln-0001');
    expect(item.changedFiles.map((f) => f.path).sort()).toEqual(['package-lock.json', 'package.json']);
    expect(item.selectedTests.total).toBeGreaterThan(0);
    expect(item.baseline!.total).toBe(2);
    expect(item.patched!.total).toBe(2);

    // branch exists locally and on the bare remote, with exactly one commit that only touches manifest + lockfile
    expect(fx.git('branch', '--list', item.branch)).toContain(item.branch);
    expect(remoteBranches(fx.remote)).toContain(item.branch);
    const changed = fx.git('diff', '--name-only', `main..${item.branch}`).split('\n').sort();
    expect(changed).toEqual(['package-lock.json', 'package.json']);
    expect(fx.git('show', `${item.branch}:package.json`)).toContain('"vulnlib": "^1.0.1"');

    // fake gh recorded a normal (non-draft) PR with the full body
    const create = fx.ghCalls.find((c) => c.args[1] === 'create')!;
    expect(create.args).not.toContain('--draft');
    expect(create.args).toContain('--base');
    expect(create.body).toContain('SpecGuard remediation: PRESERVED');
    expect(create.body).toContain('GHSA-test-vuln-0001');
    expect(create.body).toContain('1.0.0 -> **1.0.1**');
    expect(create.body).toMatch(/Baseline \(unpatched\) \| 2 \|/);
    expect(create.body).toContain('Selected first');
    expect(item.pr).toMatchObject({ draft: false, pushed: true, url: 'https://example.test/acme/fixture/pull/7' });
    expect(fx.ghCalls.every((c) => !c.args.includes('merge'))).toBe(true);

    // evidence: report json, baseline and patched ledgers; patched claims re-proven with a new fingerprint
    const evid = path.join(fx.dir, '.specguard/remediation');
    expect(existsSync(path.join(evid, 'run-safe.json'))).toBe(true);
    const baselineLedger = JSON.parse(readFileSync(path.join(evid, 'run-safe/baseline-proofs.json'), 'utf8'));
    const patchedLedger = JSON.parse(readFileSync(path.join(evid, 'run-safe/ghsa-test-vuln-0001/patched-proofs.json'), 'utf8'));
    const claim = 'app/clean#trims';
    expect(baselineLedger.proofs[claim].verdict).toBe('proven');
    expect(patchedLedger.proofs[claim].verdict).toBe('proven');
    expect(patchedLedger.proofs[claim].dependencyFingerprint).not.toBe(baselineLedger.proofs[claim].dependencyFingerprint);
    expect(item.verdictDetail!.diff.claimCount).toEqual({ baseline: 2, patched: 2 });

    // the user's working tree and branch were never touched, and no worktree remains
    expect(fx.git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(fx.git('status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(fx.dir, 'package.json'), 'utf8')).toContain('"^1.0.0"');
    expect(fx.git('worktree', 'list').split('\n')).toHaveLength(1);
    expect(existsSync(path.join(fx.dir, '.specguard/remediate.lock'))).toBe(false);
  }, T);

  it('idempotent: a re-run skips an advisory whose branch already exists', async () => {
    // claim: idempotent
    const fx = makeFixture('safe');
    const config = await fx.config();
    const first = await runRemediate(config, { runId: 'r1' }, fx.deps);
    expect(first.exitCode).toBe(RemediateExit.Preserved);
    const again = await runRemediate(config, { runId: 'r2' }, fx.deps);
    expect(again.exitCode).toBe(0);
    expect(again.messages.join('\n')).toMatch(/already exists; skipped \(idempotent re-run\)/);
    expect(fx.ghCalls.filter((c) => c.args[1] === 'create')).toHaveLength(0);
    // without --pr the branch stays local only
    expect(remoteBranches(fx.remote).filter((b) => b.startsWith('specguard/'))).toEqual([]);
  }, T);

  it('CHANGED: a bump that changes behavior fails a baseline-passing test, opens a draft, exits 9', async () => {
    const fx = makeFixture('breaking');
    const config = await fx.config();
    const res = await runRemediate(config, { pr: true, runId: 'run-breaking' }, fx.deps);
    expect(res.exitCode).toBe(RemediateExit.Changed);
    const item = res.report!.results[0];
    expect(item.verdict).toBe('CHANGED');
    expect(item.verdictDetail!.diff.regressedTests.map((r) => r.id)).toEqual(
      expect.arrayContaining(['test/app.test.mjs::app keeps case @claim:app/clean#keeps-case']),
    );
    expect(item.verdictDetail!.diff.claimDrops.map((c) => c.claim)).toContain('app/clean#keeps-case');
    const create = fx.ghCalls.find((c) => c.args[1] === 'create')!;
    expect(create.args).toContain('--draft');
    expect(create.body).toContain('Behavior changed');
    expect(create.body).toContain('keeps case');
    expect(item.pr?.draft).toBe(true);
  }, T);

  it('INCONCLUSIVE: a flaky test in the selected set is excluded and reported, draft PR, exit 10', async () => {
    const fx = makeFixture('flaky');
    const config = await fx.config();
    const res = await runRemediate(config, { pr: true, runId: 'run-flaky' }, fx.deps);
    expect(res.messages.join('\n')).not.toMatch(/\[error\]/);
    const item = res.report!.results[0];
    expect(item.verdict).toBe('INCONCLUSIVE');
    expect(res.exitCode).toBe(RemediateExit.Inconclusive);
    expect(item.verdictDetail!.diff.flaky).toEqual(['test/flaky.test.mjs::flaky alternates']);
    expect(fx.ghCalls.find((c) => c.args[1] === 'create')!.args).toContain('--draft');
  }, T);

  it('--dry-run runs the whole loop and leaves no branch, no push, no PR and no files', async () => {
    // claim: dry-run
    const fx = makeFixture('safe');
    const config = await fx.config();
    const res = await runRemediate(config, { dryRun: true, pr: true, runId: 'dry' }, fx.deps);
    expect(res.exitCode).toBe(RemediateExit.Preserved);
    expect(res.report!.results[0].verdict).toBe('PRESERVED');
    expect(fx.git('branch', '--list')).toBe('* main');
    expect(remoteBranches(fx.remote)).toEqual(['main']);
    expect(fx.ghCalls.filter((c) => c.args[1] === 'create')).toHaveLength(0);
    expect(fx.git('status', '--porcelain', '--ignored')).toBe('');
    expect(existsSync(path.join(fx.dir, '.specguard/remediation'))).toBe(false);
    expect(fx.git('worktree', 'list').split('\n')).toHaveLength(1);
  }, T);

  it('refuses a dirty working tree and a fresh lock; replaces a stale lock', async () => {
    // claim: refuse-dirty-lock
    const fx = makeFixture('safe');
    const config = await fx.config();
    writeFileSync(path.join(fx.dir, 'notes.txt'), 'wip');
    const dirty = await runRemediate(config, { runId: 'd' }, fx.deps);
    expect(dirty.exitCode).toBe(RemediateExit.SetupError);
    expect(dirty.messages.join('\n')).toMatch(/not clean/);
    rmFile(path.join(fx.dir, 'notes.txt'));

    mkdirSync(path.join(fx.dir, '.specguard'), { recursive: true });
    writeFileSync(path.join(fx.dir, '.specguard/remediate.lock'), JSON.stringify({ runId: 'other', pid: 1, startedAt: '2026-10-06T11:30:00Z' }));
    const locked = await runRemediate(config, { runId: 'l' }, fx.deps);
    expect(locked.exitCode).toBe(RemediateExit.SetupError);
    expect(locked.messages.join('\n')).toMatch(/lock is fresh/);

    writeFileSync(path.join(fx.dir, '.specguard/remediate.lock'), JSON.stringify({ runId: 'old', pid: 1, startedAt: '2026-10-01T00:00:00Z' }));
    const ok = await runRemediate(config, { runId: 's' }, fx.deps);
    expect(ok.exitCode).toBe(RemediateExit.Preserved);
  }, T);

  it('--scan-only reports and exits 5 without changing anything', async () => {
    // claim: scan-only
    const fx = makeFixture('safe');
    const res = await runRemediate(await fx.config(), { scanOnly: true }, fx.deps);
    expect(res.exitCode).toBe(5);
    expect(res.report!.detection.advisories.map((a) => a.id)).toEqual(['GHSA-test-vuln-0001']);
    expect(fx.git('branch', '--list')).toBe('* main');
    expect(fx.git('status', '--porcelain', '--ignored')).toBe('');
  }, T);

  it('an unparseable baseline counts as a failure: exit 11, nothing applied', async () => {
    // claim: baseline-not-green
    const fx = makeFixture('safe', { testCommand: 'true' });
    const res = await runRemediate(await fx.config(), { runId: 'bad' }, fx.deps);
    expect(res.exitCode).toBe(RemediateExit.SetupError);
    expect(res.messages.join('\n')).toMatch(/could not be parsed/);
    expect(fx.git('branch', '--list')).toBe('* main');
    expect(fx.git('worktree', 'list').split('\n')).toHaveLength(1);
  }, T);
});

function rmFile(p: string): void {
  spawnSync('rm', ['-f', p]);
}
