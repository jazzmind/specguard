import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import { runProofPublish } from '../../src/pipelines/proof-store-cmd.js';
import { bareRemote, sh } from '../helpers/notes-git.js';
import { gitInit, makeV2Repo } from '../helpers/v2-repo.js';

const cli = path.resolve(__dirname, '../../src/cli/index.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const run = (cwd: string, env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', tsx, cli, ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, SPECGUARD_HOST_AGENT: '0', ...env } });

describe('the ci command group [ci-commands]', () => {
  // [claims: capabilities/integration-surfaces#ci-commands]
  it('lists run, packet and doctor, and the --from-pr option of spec approve', () => {
    const repo = makeV2Repo();
    const ci = run(repo.dir, {}, 'ci', '--help');
    expect(ci.status).toBe(0);
    for (const name of ['run', 'packet', 'doctor']) expect(ci.stdout).toContain(name);
    const runHelp = run(repo.dir, {}, 'ci', 'run', '--help');
    for (const flag of ['--event <file>', '--dry-run', '--full', '--no-tests', '--no-red', '--no-push', '--no-comment']) expect(runHelp.stdout).toContain(flag);
    expect(run(repo.dir, {}, 'spec', 'approve', '--help').stdout).toContain('--from-pr <n>');
  });

  // [claims: capabilities/integration-surfaces#ci-commands]
  it('ci packet prints a saved packet as markdown, and says what is wrong with a file that is not one', () => {
    const repo = makeV2Repo();
    const missing = run(repo.dir, {}, 'ci', 'packet');
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('run `specguard ci run` first');
    writeFileSync(path.join(repo.dir, 'other.json'), '{"schema":"other"}');
    const bad = run(repo.dir, {}, 'ci', 'packet', 'other.json');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('not a proof packet');
  });

  // [claims: capabilities/integration-surfaces#ci-commands]
  it('ci doctor reports on a repository that has no CI and exits 0', () => {
    const repo = makeV2Repo();
    gitInit(repo.dir);
    const out = run(repo.dir, { GITHUB_ACTIONS: '', SG_GITHUB_TOKEN: '' }, 'ci', 'doctor');
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('not running in GitHub Actions');
    expect(out.stdout).toContain('ci run can start here');
  });

  // [claims: capabilities/integration-surfaces#ci-commands]
  it('ci run --dry-run replays a recorded event from a file, writes the artifacts and nothing to the notes ref', () => {
    const repo = makeV2Repo();
    gitInit(repo.dir);
    const head = sh(repo.dir, 'rev-parse', 'HEAD');
    writeFileSync(path.join(repo.dir, 'event.json'), JSON.stringify({ before: '0'.repeat(40), after: head }));
    const out = run(repo.dir, { GITHUB_ACTIONS: '', GITHUB_EVENT_NAME: '', SG_GITHUB_TOKEN: 'token-for-tests' }, 'ci', 'run', '--dry-run', '--no-tests', '--event', 'event.json');
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('[ci] push at');
    expect(out.stdout).toContain('statement:');
    expect(out.stdout + out.stderr).not.toContain('token-for-tests');
    expect(sh(repo.dir, 'for-each-ref', 'refs/notes')).toBe('');
    expect(sh(repo.dir, 'ls-files', '--others', '--exclude-standard')).toContain('.specguard/ci/statement.json');
  });

  // [claims: capabilities/integration-surfaces#action-prove-gate]
  it('proof status reads the proofs CI holds in a note when the local ledger is gone, so the proof gate works on a fresh checkout', async () => {
    const repo = makeV2Repo();
    await ingestVerdicts({ runId: 'r1', verdicts: [{ claim: 'capabilities/auth#login-valid-code', verdict: 'proven' }, { claim: 'capabilities/auth#logout-clears-session', verdict: 'proven' }] }, repo.dir, { provenance: { origin: 'ci' } });
    gitInit(repo.dir);
    sh(repo.dir, 'remote', 'add', 'origin', bareRemote());
    const published = await runProofPublish(await loadConfig(repo.dir), { env: { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '1' }, sleep: async () => undefined });
    expect(published.exitCode).toBe(0);

    rmSync(path.join(repo.dir, '.specguard/proofs.json'));
    const status = run(repo.dir, {}, 'proof', 'status');
    expect(status.stdout).toMatch(/PROOFS: 2 proven, 0 failed/);
    expect(status.stdout).not.toContain('no ledger');
  });
});
