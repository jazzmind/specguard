import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

import { claudePayload, editOf, hookRepo, readLog, runBundle } from '../helpers/hook-repo.js';

const cli = path.resolve(import.meta.dirname, '../../src/cli/index.ts');
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const run = (cwd: string, input: string | undefined, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', tsx, cli, ...args], { cwd, input, encoding: 'utf8', timeout: 60_000, env: { ...process.env, SPECGUARD_HOST_AGENT: '0' } });

describe('specguard hook [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#hook-commands]
  it('pre-tool-use prints exactly what the plugin bundle prints, for a deny, a warning and a silent allow', () => {
    for (const [level, rel] of [['enforce', 'src/shop/cart.ts'], ['warn', 'src/shop/cart.ts'], ['observe', 'src/shop/cart.ts'], ['enforce', 'src/orphan.ts']] as const) {
      const repo = hookRepo({ shop: level });
      const payload = editOf(repo, rel);
      const viaCli = run(repo.dir, payload, 'hook', 'pre-tool-use');
      const viaBundle = runBundle(payload);
      expect(viaCli.status, viaCli.stderr).toBe(0);
      expect(viaCli.stdout).toBe(viaBundle.stdout);
    }
  });

  // [claims: capabilities/spec-first-changes#hook-commands]
  it('pre-tool-use is silent in a directory with no SpecGuard config', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-hookcli-'));
    const r = run(dir, JSON.stringify({ cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'a.ts') } }), 'hook', 'pre-tool-use');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  // [claims: capabilities/spec-first-changes#hook-commands, capabilities/spec-first-changes#hook-index-cache]
  it('build-index writes the cache and reports what it holds, and `index` is an alias', () => {
    const repo = hookRepo({ shop: 'enforce' });
    const r = run(repo.dir, undefined, '--json', 'hook', 'build-index');
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ cached: true, capabilities: 3, ownedFiles: 4, openChanges: 0 });
    expect(existsSync(path.join(repo.dir, '.specguard/cache/hook-index.json'))).toBe(true);
    expect(run(repo.dir, undefined, 'hook', 'index').stdout).toContain('hook index: 3 capabilities, 4 owned files');
  });

  // [claims: capabilities/spec-first-changes#hook-commands]
  it('doctor prints the class of each path and what the guard would decide, for a path and for a shell command', () => {
    const repo = hookRepo({ shop: 'enforce' });
    const edit = run(repo.dir, undefined, 'hook', 'doctor', 'src/shop/cart.ts', 'tests/shop.test.ts');
    expect(edit.status, edit.stderr).toBe(0);
    expect(edit.stdout).toContain('src/shop/cart.ts: owned (shop)');
    expect(edit.stdout).toContain('tests/shop.test.ts: test');
    expect(edit.stdout).toContain('decision: deny [DENY_NO_CHANGE] level enforce');
    expect(edit.stdout).toContain('message: shop is at enforce: start a change');

    const json = JSON.parse(run(repo.dir, undefined, '--json', 'hook', 'doctor', 'src/orphan.ts').stdout) as { decision: { decision: string; log: { code: string } } };
    expect(json.decision).toMatchObject({ decision: 'allow', log: { code: 'FREE' } });

    const bash = run(repo.dir, undefined, 'hook', 'doctor', '--bash', 'specguard spec approve shop --yes');
    expect(bash.stdout).toContain('decision: deny [DENY_BASH_APPROVE]');
  });

  // [claims: capabilities/spec-first-changes#hook-commands, capabilities/spec-first-changes#hook-decision-log]
  it('log lists the recorded decisions, and --denied only the denials', () => {
    const repo = hookRepo({ shop: 'enforce' });
    expect(run(repo.dir, undefined, 'hook', 'log').stdout).toContain('no hook decisions logged yet');
    runBundle(editOf(repo, 'src/shop/cart.ts'));
    runBundle(editOf(repo, 'src/orphan.ts'));
    runBundle(claudePayload(repo, { tool: 'Bash', input: { command: 'ls' } }));
    expect(readLog(repo)).toHaveLength(3);
    const all = run(repo.dir, undefined, 'hook', 'log').stdout;
    expect(all).toContain('DENY_NO_CHANGE');
    expect(all).toContain('FREE');
    const denied = run(repo.dir, undefined, 'hook', 'log', '--denied').stdout;
    expect(denied).toContain('DENY_NO_CHANGE');
    expect(denied).not.toContain('FREE');
  });
});
