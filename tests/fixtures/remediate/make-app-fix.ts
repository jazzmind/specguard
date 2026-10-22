/**
 * A small project with a bug: a capability spec with two claims, one proven and one failing, a vitest suite,
 * a ledger that already records the failure, a local bare remote and a fake `gh`. Used to drive
 * `remediate --from failing` end to end with a scripted fixer in place of the model.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../../../src/core/config.js';
import type { SpecGuardConfig } from '../../../src/core/types.js';
import type { CommandResult, CommandRunner } from '../../../src/core/ecosystems/index.js';
import { realGit } from '../../../src/pipelines/remediate/git.js';
import type { Exec, RemediateDeps } from '../../../src/pipelines/remediate/types.js';
import { runTestRun } from '../../../src/pipelines/test-run.js';

const VITEST = path.resolve(__dirname, '../../../node_modules/vitest/vitest.mjs');

export const BUGGY = 'export const double = (n) => (n > 5 ? n * 2 + 1 : n * 2);\n';
export const FIXED = 'export const double = (n) => n * 2;\n';

export interface AppFixFixture {
  dir: string;
  remote: string;
  ghCalls: Array<{ args: string[]; body?: string }>;
  deps: Partial<RemediateDeps>;
  config: () => Promise<SpecGuardConfig>;
  git: (...args: string[]) => string;
}

const w = (dir: string, rel: string, text: string): void => {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
};

export async function makeAppFixFixture(): Promise<AppFixFixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-appfix-'));
  const remote = path.join(mkdtempSync(path.join(os.tmpdir(), 'sg-appfix-remote-')), 'origin.git');
  const git = (...args: string[]): string => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };

  w(dir, 'package.json', JSON.stringify({ name: 'appfix', version: '1.0.0', private: true }, null, 2) + '\n');
  w(dir, 'package-lock.json', JSON.stringify({ name: 'appfix', lockfileVersion: 3, packages: { '': { name: 'appfix' } } }, null, 2) + '\n');
  w(dir, '.gitignore', 'node_modules/\n.specguard/runs/\n.specguard/remediation/\n.specguard/remediate.lock\n.specguard/llm-usage.json\n.specguard/trace.json\n.specguard/cache/\n.specguard/evidence/\n.specguard/reports/\n.specguard/drift-registry.json\n');
  w(dir, 'vitest.config.mjs', 'export default { test: { globals: true, include: ["test/**/*.test.mjs"] } };\n');
  w(dir, 'src/app.mjs', BUGGY);
  w(
    dir,
    'test/app.test.mjs',
    `import { double } from '../src/app.mjs';
describe('double', () => {
  it('doubles a small number @claim:capabilities/app#doubles-small', () => { expect(double(2)).toBe(4); });
  it('doubles a large number @claim:capabilities/app#doubles-large', () => { expect(double(10)).toBe(20); });
});
`,
  );
  w(dir, 'specs/system.md', '---\nid: system\nkind: system\nvalue: Doubling works.\n---\n# System\n\n## Problem\n\nPeople need numbers doubled.\n');
  w(
    dir,
    'specs/capabilities/app.md',
    `---
id: app
kind: capability
parent: system
value: Callers get a number doubled correctly.
sources:
  - "src/**"
tests:
  - "test/**"
---
# App

## Problem & Value

Callers rely on \`double\` returning exactly twice its input.

## Requirements

- [ ] Small numbers are doubled <!-- claim: doubles-small -->
- [ ] Large numbers are doubled <!-- claim: doubles-large -->

## Scenarios

### Scenario 1: Double
**Steps:**
1. Call double

**Expected Results:**
- Twice the input
`,
  );
  w(
    dir,
    '.specguard/config.json',
    JSON.stringify({
      apps: [
        {
          name: 'app', repo: '.', specDir: 'specs', sources: { routes: ['src/**/*.mjs'], tests: ['test/**/*.mjs'] }, framework: 'vitest', testOutput: 'test/',
          test: { command: `node ${VITEST} run`, reporter: 'vitest' },
        },
      ],
      llm: { provider: 'none', model: 'none', apiKeyEnv: 'NONE' },
      remediate: { semgrep: false, gitleaks: false, osv: false },
    }),
  );

  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');

  // Record the failure the way a normal run does, then commit the ledger so the working tree is clean.
  const run = await runTestRun(await loadConfig(dir), { runId: 'seed' });
  if (run.exitCode === 0) throw new Error('the fixture should have a failing claim');
  git('add', '-A');
  git('commit', '-q', '-m', 'record the failing proof');

  mkdirSync(path.dirname(remote), { recursive: true });
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  git('remote', 'add', 'origin', remote);
  git('push', '-q', 'origin', 'main');

  const ghCalls: AppFixFixture['ghCalls'] = [];
  const gh: Exec = (args) => {
    const bodyFile = args[args.indexOf('--body-file') + 1];
    ghCalls.push({ args, body: bodyFile && existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8') : undefined });
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: '[]', stderr: '', status: 0 };
    if (args[0] === 'pr' && args[1] === 'create') return { stdout: 'https://example.test/acme/appfix/pull/3\n', stderr: '', status: 0 };
    return { stdout: '', stderr: 'unexpected gh call', status: 1 };
  };
  // No dependencies and nothing to build: npm install and node --version succeed, everything else is absent.
  const runner: CommandRunner = async (cmd, args): Promise<CommandResult> => {
    if (cmd === 'npm' && (args[0] === 'install' || args[0] === 'ci')) return { stdout: 'ok', stderr: '', status: 0 };
    if (cmd === 'node' || cmd === 'npm') return { stdout: 'v22.0.0', stderr: '', status: 0 };
    return { stdout: '', stderr: `${cmd}: not found`, status: null, error: 'ENOENT' };
  };
  const deps: Partial<RemediateDeps> = { run: runner, git: realGit, gh, http: async () => ({ status: 404, text: '' }), now: () => new Date('2026-10-22T12:00:00Z'), llm: false };
  return { dir, remote, ghCalls, deps, config: () => loadConfig(dir), git };
}
