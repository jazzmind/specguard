import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { RemediateExit } from '../../src/core/exit-codes.js';
import { findAppFixTargets, runAppFix, type AppFixer } from '../../src/pipelines/remediate/app-fix.js';
import { BUGGY, FIXED, makeAppFixFixture } from '../fixtures/remediate/make-app-fix.js';

const T = 180_000;
const branchesOf = (remote: string): string[] => spawnSync('git', ['branch', '--list'], { cwd: remote, encoding: 'utf8' }).stdout.split('\n').map((l) => l.replace('*', '').trim()).filter(Boolean);
const rewrite = (path_: string, content: string): AppFixer => async () => [{ path: path_, content }];

describe('finding what to repair [app-fix-targets]', () => {
  // [claims: capabilities/security-and-remediation#app-fix-targets]
  it('lists capabilities with a failing claim and the source files a repair may touch, never tests or specs', async () => {
    const fx = await makeAppFixFixture();
    const { targets } = await findAppFixTargets(await fx.config());
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ capability: 'app', files: ['src/app.mjs'] });
    expect(targets[0].claims.map((c) => c.id)).toEqual(['doubles-large']); // the passing claim is not a target
    expect((await findAppFixTargets(await fx.config(), 'capabilities/app#doubles-small')).targets).toEqual([]);
    expect((await findAppFixTargets(await fx.config(), 'capabilities/app#doubles-large')).targets).toHaveLength(1);
    expect((await findAppFixTargets(await fx.config(), 'app')).targets).toHaveLength(1);
  }, T);
});

describe('repair end to end (real git, worktrees and vitest; fake gh and a scripted fixer) [app-fix]', () => {
  // [claims: capabilities/security-and-remediation#app-fix-loop, capabilities/security-and-remediation#app-fix-pr-only]
  it('repairs the bug: the targeted claim is proven, nothing else moved, a normal PR is opened, nothing is merged', async () => {
    const fx = await makeAppFixFixture();
    const res = await runAppFix(await fx.config(), { pr: true, runId: 'fix-1' }, { ...fx.deps, appFix: rewrite('src/app.mjs', FIXED) });
    expect(res.messages.join('\n')).not.toMatch(/\[error\]/);
    expect(res.exitCode).toBe(RemediateExit.Preserved);
    expect(res.fixed).toEqual(['app']);

    const branch = 'specguard/remediate/app-fix-app';
    expect(fx.git('branch', '--list', branch)).toContain(branch);
    expect(branchesOf(fx.remote)).toContain(branch);
    expect(fx.git('diff', '--name-only', `main..${branch}`)).toBe('src/app.mjs'); // only the source file
    expect(fx.git('show', `${branch}:src/app.mjs`)).toBe(FIXED.trim());
    const create = fx.ghCalls.find((c) => c.args[1] === 'create')!;
    expect(create.args).not.toContain('--draft');
    expect(create.body).toContain('**Repaired.**');
    expect(create.body).toContain('`capabilities/app#doubles-large`');
    expect(create.body).toContain('never auto-merged');
    expect(fx.ghCalls.flatMap((c) => c.args)).not.toContain('merge');
    // the user's tree and the buggy file on main are untouched
    expect(fx.git('status', '--porcelain')).toBe('');
    expect(readFileSync(path.join(fx.dir, 'src/app.mjs'), 'utf8')).toBe(BUGGY);
  }, T);

  // [claims: capabilities/security-and-remediation#app-fix-loop]
  it('a repair that does not fix the claim is a draft that says so', async () => {
    const fx = await makeAppFixFixture();
    const res = await runAppFix(await fx.config(), { pr: true, runId: 'fix-2' }, { ...fx.deps, appFix: rewrite('src/app.mjs', '// still wrong\n' + BUGGY) });
    expect(res.exitCode).toBe(RemediateExit.Changed);
    const create = fx.ghCalls.find((c) => c.args[1] === 'create')!;
    expect(create.args).toContain('--draft');
    expect(create.body).toContain('target-unfixed');
    expect(res.fixed).toEqual([]);
  }, T);

  // [claims: capabilities/security-and-remediation#app-fix-loop]
  it('a repair that breaks a claim that passed is a draft naming the regression', async () => {
    const fx = await makeAppFixFixture();
    const res = await runAppFix(await fx.config(), { pr: true, runId: 'fix-3' }, { ...fx.deps, appFix: rewrite('src/app.mjs', 'export const double = (n) => (n < 5 ? n * 3 : n * 2);\n') });
    expect(res.exitCode).toBe(RemediateExit.Changed);
    const body = fx.ghCalls.find((c) => c.args[1] === 'create')!.body!;
    expect(body).toContain('test-regressed');
    expect(body).toContain('doubles a small number');
  }, T);

  // [claims: capabilities/security-and-remediation#app-fix-loop]
  it('refuses a repair that changes a test, a spec or any file it was not shown, and leaves no branch', async () => {
    const fx = await makeAppFixFixture();
    for (const file of ['test/app.test.mjs', 'specs/capabilities/app.md', 'package.json']) {
      const res = await runAppFix(await fx.config(), { pr: true, runId: `fix-x-${file.length}` }, { ...fx.deps, appFix: rewrite(file, 'tampered\n') });
      expect(res.exitCode).toBe(RemediateExit.SetupError);
      expect(res.messages.join('\n')).toContain('named files it may not change');
    }
    expect(fx.git('branch', '--list', 'specguard/remediate/*')).toBe('');
    expect(branchesOf(fx.remote)).toEqual(['main']);
    expect(fx.ghCalls.some((c) => c.args[1] === 'create')).toBe(false);
    expect(fx.git('status', '--porcelain')).toBe('');
  }, T);

  // [claims: capabilities/security-and-remediation#app-fix-pr-only]
  it('--dry-run leaves no branch, push or pull request, and --pr is needed to open one', async () => {
    const fx = await makeAppFixFixture();
    const dry = await runAppFix(await fx.config(), { dryRun: true, pr: true, runId: 'fix-d' }, { ...fx.deps, appFix: rewrite('src/app.mjs', FIXED) });
    expect(dry.exitCode).toBe(RemediateExit.Preserved);
    expect(fx.git('branch', '--list', 'specguard/remediate/*')).toBe('');
    expect(fx.ghCalls.filter((c) => c.args[1] !== 'list')).toEqual([]); // looking for an existing PR is read-only
    const local = await runAppFix(await fx.config(), { runId: 'fix-l' }, { ...fx.deps, appFix: rewrite('src/app.mjs', FIXED) });
    expect(local.exitCode).toBe(RemediateExit.Preserved);
    expect(fx.git('branch', '--list', 'specguard/remediate/app-fix-app')).toContain('app-fix-app'); // committed, not pushed
    expect(branchesOf(fx.remote)).toEqual(['main']);
    expect(fx.ghCalls.some((c) => c.args[1] === 'create')).toBe(false);
  }, T);

  // [claims: capabilities/security-and-remediation#app-fix-pr-only]
  it('skips when the fixer has no safe repair, and when a branch for it already exists', async () => {
    const fx = await makeAppFixFixture();
    const none = await runAppFix(await fx.config(), { runId: 'fix-n' }, { ...fx.deps, appFix: async () => null });
    expect(none.messages.join('\n')).toContain('no safe repair was produced');
    expect(fx.git('branch', '--list', 'specguard/remediate/*')).toBe('');
    await runAppFix(await fx.config(), { runId: 'fix-a' }, { ...fx.deps, appFix: rewrite('src/app.mjs', FIXED) });
    const again = await runAppFix(await fx.config(), { runId: 'fix-b' }, { ...fx.deps, appFix: rewrite('src/app.mjs', FIXED) });
    expect(again.messages.join('\n')).toContain('skipped (idempotent re-run)');
  }, T);
});
