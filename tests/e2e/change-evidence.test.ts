import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import type { CapabilityStatement } from '../../src/core/proof-statement.js';
import { runChangeDone } from '../../src/pipelines/change.js';
import { runCoverageIngest } from '../../src/pipelines/coverage-ingest.js';
import { runCheck } from '../../src/pipelines/check.js';
import { runEnforceRaise } from '../../src/pipelines/enforce.js';
import { runProofPublish } from '../../src/pipelines/proof-store-cmd.js';
import { runTestRun } from '../../src/pipelines/test-run.js';
import { addFreeShippingClaim, approveShop, gitCommit, writeShopCode } from '../helpers/change-fixture.js';
import { NOW, claudeEdit, e2eRepo, green, red, startChange, writeShippingTest } from '../helpers/e2e-protocol.js';
import type { TmpRepo } from '../helpers/repo.js';

const LCOV = 'SF:src/shop/cart.ts\nDA:1,3\nDA:2,1\nend_of_record\nSF:src/core/awards.ts\nDA:1,1\nend_of_record\n';
const PERSON = { agent: false, tty: true };
const CI_ENV = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '7' } as NodeJS.ProcessEnv;

/** Run the whole suite as the given kind of runner would: the provenance of the proof rows follows the environment. */
async function runSuite(repo: TmpRepo, ci: boolean): Promise<void> {
  repo.write('lcov.info', LCOV);
  const covered = await runCoverageIngest(['lcov.info'], repo.dir, { capability: 'shop', selection: 'tests', runId: `cov-${ci ? 'ci' : 'local'}`, origin: ci ? 'ci' : 'local' });
  expect(covered.exitCode, covered.messages.join('\n')).toBe(0);
  for (const key of ['GITHUB_ACTIONS', 'GITHUB_REPOSITORY', 'GITHUB_EVENT_NAME', 'GITHUB_RUN_ID', 'CI']) vi.stubEnv(key, ci ? (CI_ENV[key] ?? 'true') : '');
  try {
    const run = await runTestRun(await loadConfig(repo.dir), {});
    expect(run.exitCode, run.messages.join('\n')).toBe(0);
  } finally {
    vi.unstubAllEnvs();
  }
}

const shopOf = async (repo: TmpRepo): Promise<CapabilityStatement> => {
  const r = await runCheck(await loadConfig(repo.dir), {});
  return r.statement!.capabilities.find((c) => c.capability === 'shop')!;
};

afterEach(() => vi.unstubAllEnvs());

describe('the change protocol and the proof statement [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#e2e-certified-needs-ci, capabilities/spec-first-changes#e2e-hook-follows-red]
  it('a finished change is provisional on local evidence, certified only from CI evidence, and only then can the ratchet go to enforce', async () => {
    const repo = await e2eRepo({ shop: 'warn' });
    const id = await startChange(repo);
    addFreeShippingClaim(repo);
    await approveShop(repo);
    writeShippingTest(repo);
    expect((await red(repo, id)).exitCode).toBe(0);
    writeShopCode(repo);
    expect((await green(repo, id)).exitCode).toBe(0);
    gitCommit(repo.dir, 'free shipping');

    // the work is done and proven here, on this machine: provisional, with the reason named
    await runSuite(repo, false);
    gitCommit(repo.dir, 'local proof');
    let shop = await shopOf(repo);
    expect(shop.level, JSON.stringify(Object.entries(shop.pillars).map(([k, p]) => [k, p.status, p.reasons.map((r) => `${r.code}:${r.outcome}:${r.message}`)]))).toBe('provisional');
    expect(shop.evidence.origins).toEqual(['local']);
    expect(Object.values(shop.pillars).flatMap((p) => p.reasons).some((r) => r.code === 'LOCAL_EVIDENCE')).toBe(true);

    // a person cannot ratchet to enforce on it, and nothing is written
    const refused = await runEnforceRaise(await loadConfig(repo.dir), { targets: ['shop'], to: 'enforce', actor: PERSON, by: 'Ada' });
    expect(refused.exitCode).toBe(ExitCode.NotCertified);
    expect(refused.messages.join('\n')).toMatch(/only while it is certified/);

    // CI runs the same tests and publishes its note for the commit; the same commit is now certified from that note
    await runSuite(repo, true);
    const published = await runProofPublish(await loadConfig(repo.dir), { env: CI_ENV, noPush: true });
    expect(published.exitCode, published.messages.join('\n')).toBe(0);
    rmSync(path.join(repo.dir, '.specguard', 'proofs.json'), { force: true });
    shop = await shopOf(repo);
    expect(shop.level).toBe('certified');
    expect(shop.evidence.origins).toEqual(['ci']);
    expect(shop.certifiedAt).toMatch(/^[0-9a-f]{40}$/);

    // now the person turns the guard on. The change is still open with a valid red, so its own code stays open ...
    const raised = await runEnforceRaise(await loadConfig(repo.dir), { targets: ['shop'], to: 'enforce', actor: PERSON, by: 'Ada' });
    expect(raised.exitCode, raised.messages.join('\n')).toBe(0);
    expect(claudeEdit(repo, 'src/shop/cart.ts')).toMatchObject({ decision: 'allow', code: 'ALLOW_CHANGE' });
    // ... and once CI has validated it and it is closed, the next edit made without a change is denied
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.dir, encoding: 'utf8' }).trim();
    const done = await runChangeDone(await loadConfig(repo.dir), { id, ci: { commit: head, verdict: 'pass' }, now: NOW });
    expect(done.exitCode, done.messages.join('\n')).toBe(0);
    expect(claudeEdit(repo, 'src/shop/cart.ts')).toMatchObject({ decision: 'deny', code: 'DENY_NO_CHANGE' });
  }, 120_000);
});

describe('the hook stays fast with a change open and red recorded [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#e2e-hook-latency]
  it('answers from the cached index well inside the budget, for allow and deny alike', async () => {
    const repo = await e2eRepo({ shop: 'enforce' });
    const id = await startChange(repo);
    addFreeShippingClaim(repo);
    await approveShop(repo);
    writeShippingTest(repo);
    expect((await red(repo, id)).exitCode).toBe(0);

    const warm = claudeEdit(repo, 'src/shop/cart.ts');
    expect(warm.code).toBe('ALLOW_CHANGE');
    const times: number[] = [];
    for (let i = 0; i < 30; i += 1) times.push(claudeEdit(repo, i % 2 === 0 ? 'src/shop/cart.ts' : 'src/auth/login.ts').ran.ms);
    times.sort((a, b) => a - b);
    const p50 = times[15]!;
    const p95 = times[28]!;
    process.stdout.write(`hook latency: index rebuild ${Math.round(warm.ran.ms)} ms; warm over 30 spawned runs p50 ${Math.round(p50)} ms, p95 ${Math.round(p95)} ms\n`);
    // a spawned node process, so the budget has room for machine load; the in-process decision is far below it
    expect(p50, `p50 ${p50}`).toBeLessThan(200);
    expect(p95, `p95 ${p95}`).toBeLessThan(500);
  }, 120_000);
});
