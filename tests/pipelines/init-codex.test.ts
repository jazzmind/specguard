import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { detectHostAgent } from '../../src/core/agent-work.js';
import { buildCodexRules, mergeClaudeSettings, mergeCodexHooks } from '../../src/core/scaffold.js';
import { NPX_RUNNER } from '../../src/core/runner.js';
import { runInit } from '../../src/pipelines/init.js';

const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'sg-codex-'));
const read = (dir: string, rel: string): string => readFileSync(path.join(dir, rel), 'utf8');
const json = (dir: string, rel: string): any => JSON.parse(read(dir, rel));
const wire = () => ({ runner: NPX_RUNNER, update: false, notes: [] as string[] });

describe('init --codex [integration-surfaces]', () => {
  // [claims: capabilities/integration-surfaces#init-codex-files]
  it("writes the repository's Codex hooks and execpolicy rules, and nothing without the flag", async () => {
    const plain = tmp();
    await runInit({ cwd: plain });
    expect(existsSync(path.join(plain, '.codex'))).toBe(false);

    const dir = tmp();
    const result = await runInit({ cwd: dir, codex: true, runner: 'npx' });
    expect(result.exitCode).toBe(0);
    expect(result.createdFiles.map((f) => path.relative(dir, f))).toEqual(expect.arrayContaining(['.codex/hooks.json', '.codex/rules/specguard.rules']));

    const hooks = json(dir, '.codex/hooks.json').hooks.PreToolUse;
    expect(hooks).toHaveLength(1);
    expect(hooks[0].matcher).toBe('^(apply_patch|Edit|Write|Bash)$');
    expect(hooks[0].hooks[0]).toMatchObject({ type: 'command', timeout: 10 });
    expect(hooks[0].hooks[0].command).toMatch(/^npx -y -p specguard-ai@\d+\.\d+ specguard hook pre-tool-use --agent codex$/);
    expect(hooks[0].hooks[0].onFailure).toBeUndefined(); // fails open by default

    const rules = read(dir, '.codex/rules/specguard.rules');
    expect(rules).toContain('prefix_rule(pattern=["specguard", "spec", "approve"], decision="forbidden"');
    expect(rules).toContain('pattern=["npx", "-y", "-p", "specguard-ai", "specguard", "spec", "approve"]');
    expect(rules).toContain('pattern=["npx", "-p", "specguard-ai", "specguard", "spec", "approve"]');
    expect(result.messages.join('\n')).toContain('/hooks');
  });

  // [claims: capabilities/integration-surfaces#init-codex-files]
  it('uses the installed bundle when the package is a local dependency', async () => {
    const dir = tmp();
    const bundle = path.join(dir, 'node_modules/specguard-ai/dist/hooks/specguard-hook.mjs');
    mkdirSync(path.dirname(bundle), { recursive: true });
    writeFileSync(bundle, '');
    await runInit({ cwd: dir, codex: true });
    expect(json(dir, '.codex/hooks.json').hooks.PreToolUse[0].hooks[0].command).toBe('node node_modules/specguard-ai/dist/hooks/specguard-hook.mjs pre-tool-use --agent codex');
  });

  // [claims: capabilities/integration-surfaces#init-codex-files]
  it("merges into the user's hooks file, never duplicates on a re-run, and never overwrites a rules file it does not own", async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, '.codex/rules'), { recursive: true });
    writeFileSync(path.join(dir, '.codex/hooks.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^Bash$', hooks: [{ type: 'command', command: 'my-own-linter' }] }], Stop: [{ hooks: [{ type: 'command', command: 'notify' }] }] } }));
    writeFileSync(path.join(dir, '.codex/rules/specguard.rules'), '# my rules, no marker\nprefix_rule(pattern=["rm"], decision="forbidden")\n');

    await runInit({ cwd: dir, codex: true, runner: 'npx' });
    await runInit({ cwd: dir, codex: true, runner: 'npx' });

    const hooks = json(dir, '.codex/hooks.json').hooks;
    expect(hooks.Stop).toHaveLength(1);
    expect(hooks.PreToolUse.map((e: any) => e.hooks[0].command)).toEqual(['my-own-linter', expect.stringContaining('hook pre-tool-use --agent codex')]);
    expect(read(dir, '.codex/rules/specguard.rules')).toBe('# my rules, no marker\nprefix_rule(pattern=["rm"], decision="forbidden")\n');
  });

  // [claims: capabilities/integration-surfaces#init-codex-files]
  it('regenerates a rules file it owns, and leaves a hooks file it cannot parse alone', async () => {
    const dir = tmp();
    await runInit({ cwd: dir, codex: true, runner: 'npx' });
    const rules = path.join(dir, '.codex/rules/specguard.rules');
    writeFileSync(rules, `${readFileSync(rules, 'utf8').split('\n')[0]}\nstale\n`);
    await runInit({ cwd: dir, codex: true, runner: 'npx' });
    expect(readFileSync(rules, 'utf8')).toBe(buildCodexRules());

    writeFileSync(path.join(dir, '.codex/hooks.json'), '{ not json');
    const again = await runInit({ cwd: dir, codex: true, runner: 'npx' });
    expect(read(dir, '.codex/hooks.json')).toBe('{ not json');
    expect(again.messages.join('\n')).toContain('malformed JSON');
  });

  // [claims: capabilities/integration-surfaces#init-codex-files]
  it('mergeCodexHooks is pure and idempotent', () => {
    const once = mergeCodexHooks({}, wire(), 'cmd pre-tool-use');
    expect(mergeCodexHooks(once, wire(), 'cmd pre-tool-use')).toEqual(once);
  });

  // [claims: capabilities/integration-surfaces#codex-plugin-hook-free]
  it('the Codex plugin stays hook-free so it remains listable: hooks reach Codex only through the repository', () => {
    const manifest = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../plugins/specguard/.codex-plugin/plugin.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(manifest).filter((k) => /hook/i.test(k))).toEqual([]);
  });

  // [claims: capabilities/integration-surfaces#harness-guard-hook]
  it('--harness claude also wires the guard into .claude/settings.json, merged with what is there, once', async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, '.claude'), { recursive: true });
    writeFileSync(path.join(dir, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }] } }));
    await runInit({ cwd: dir, harness: 'claude', runner: 'npx' });
    await runInit({ cwd: dir, harness: 'claude', runner: 'npx' });
    const settings = json(dir, '.claude/settings.json');
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    const pre = settings.hooks.PreToolUse;
    expect(pre.map((e: any) => e.hooks[0].command)).toEqual(['mine', expect.stringMatching(/specguard hook pre-tool-use$/)]);
    expect(pre[1]).toMatchObject({ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash' });
    expect(pre[1].hooks[0]).toMatchObject({ timeout: 5 });
    expect(pre[1].hooks[0].onFailure).toBeUndefined();
  });

  // [claims: capabilities/integration-surfaces#harness-guard-hook, capabilities/spec-first-changes#hook-on-error-deny]
  it('hooks.onError deny scaffolds the Claude guard with onFailure block', () => {
    const settings = mergeClaudeSettings({}, { ...wire(), guardCommand: 'g pre-tool-use', guardFailClosed: true }) as any;
    expect(settings.hooks.PreToolUse[0].hooks[0]).toMatchObject({ command: 'g pre-tool-use', onFailure: 'block' });
  });

  // [claims: capabilities/spec-first-changes#hook-codex-agent-env]
  it('a Codex session counts as an agent environment, and an explicit SPECGUARD_HOST_AGENT still wins', () => {
    expect(detectHostAgent({ CODEX_THREAD_ID: 'thread-1' })).toBe(true);
    expect(detectHostAgent({ CODEX_THREAD_ID: 'thread-1', SPECGUARD_HOST_AGENT: '0' })).toBe(false);
    expect(detectHostAgent({})).toBe(false);
  });
});
