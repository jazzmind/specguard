import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { git, makeV01Repo, makeV02Repo, repoHash } from '../helpers/migrate-repos.js';

const cli = path.resolve(__dirname, '../../src/cli/index.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', tsx, cli, ...args], { cwd, encoding: 'utf8', timeout: 60_000, env: { ...process.env, SPECGUARD_HOST_AGENT: '0' } });

describe('specguard migrate on the CLI [platform-foundation]', () => {
  // [claims: capabilities/platform-foundation#migrate-dry-run-changes-nothing]
  it('is a dry run by default: prints the plan, changes nothing, and exits 14 while work is left', () => {
    const repo = makeV02Repo();
    const before = repoHash(repo.dir);

    const res = run(repo.dir, 'migrate');

    expect(res.status).toBe(14);
    expect(res.stdout).toContain('dry run, nothing was changed. Detected format: v0.2-0.3.');
    expect(res.stdout).toContain('[todo] untrack-ledger');
    expect(res.stdout).toContain('[person] as-built-approval');
    expect(repoHash(repo.dir)).toBe(before);
  });

  // [claims: capabilities/platform-foundation#migrate-dry-run-changes-nothing]
  it('--json prints the steps', () => {
    const repo = makeV02Repo();
    const res = run(repo.dir, '--json', 'migrate');
    const steps = JSON.parse(res.stdout) as Array<{ id: string; state: string }>;
    expect(steps.map((s) => s.id)).toContain('provisional-rows');
    expect(steps.find((s) => s.id === 'untrack-trace')?.state).toBe('todo');
    expect(run(repo.dir, 'migrate', '--json').stdout).toBe(res.stdout);
  });

  // [claims: capabilities/platform-foundation#migrate-apply-untracks-state, capabilities/platform-foundation#migrate-idempotent-rerun]
  it('--yes applies and leaves the person steps (exit 14), and the rerun is a no-op success (exit 0)', () => {
    const repo = makeV02Repo();

    const first = run(repo.dir, 'migrate', '--yes');
    expect(first.status).toBe(14);
    expect(first.stdout).toContain('applied 5 step(s)');
    expect(first.stdout).toContain('Left for you (never run by migrate): as-built-approval, first-ci-note.');
    expect(git(repo.dir, 'ls-files')).not.toContain('.specguard/proofs.json');
    expect(existsSync(path.join(repo.dir, '.specguard/proofs.json'))).toBe(true);

    const second = run(repo.dir, 'migrate', '--yes');
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('Nothing left to do');
  });

  // [claims: capabilities/platform-foundation#migrate-refuses-dirty-tree]
  it('refuses a dirty tree with exit 2 unless --allow-dirty', () => {
    const repo = makeV02Repo();
    repo.write('src/auth/login.ts', 'export const login = 2;\n');

    const refused = run(repo.dir, 'migrate', '--yes');
    expect(refused.status).toBe(2);
    expect(refused.stdout).toContain('uncommitted changes');
    expect(existsSync(path.join(repo.dir, '.gitignore'))).toBe(false);

    expect(run(repo.dir, 'migrate', '--yes', '--allow-dirty').status).toBe(14);
    expect(existsSync(path.join(repo.dir, '.gitignore'))).toBe(true);
  });

  // [claims: capabilities/platform-foundation#migrate-resumable]
  it('a v0.1 repository exits 12 with the agent commands printed, and --consolidate swaps them for `spec consolidate`', () => {
    const repo = makeV01Repo();

    const res = run(repo.dir, 'migrate', '--yes');
    expect(res.status).toBe(12);
    expect(res.stdout).toContain('$ specguard spec draft --yes');
    expect(res.stdout).toContain('$ specguard spec tag --yes');
    expect(existsSync(path.join(repo.dir, 'specs/_archive/v1/core/awards.md'))).toBe(true);

    const other = makeV01Repo();
    const plan = run(other.dir, 'migrate', '--consolidate');
    expect(plan.status).toBe(12);
    expect(plan.stdout).toContain('$ specguard spec consolidate --yes');
    expect(plan.stdout).not.toContain('$ specguard spec draft --yes');
  });
});
