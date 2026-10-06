import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { NPX_CLI, resolveRunner } from '../../src/core/runner.js';
import { getProfile } from '../../src/core/language-profiles.js';
import { scaffoldHarnessFiles } from '../../src/core/scaffold.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'sg-runner-'));
const touch = (p: string) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, '#!/bin/sh\n');
  chmodSync(p, 0o755);
};
const EMPTY_ENV = { PATH: '/nonexistent' } as NodeJS.ProcessEnv;
const settings = (cwd: string) => JSON.parse(readFileSync(path.join(cwd, '.claude/settings.json'), 'utf8'));

describe('resolveRunner [runner-resolution]', () => {
  it('prefers node_modules/.bin/specguard and its MCP sibling', () => {
    const cwd = tmp();
    touch(path.join(cwd, 'node_modules/.bin/specguard'));
    touch(path.join(cwd, 'node_modules/.bin/specguard-mcp'));
    const r = resolveRunner(cwd, {}, EMPTY_ENV);
    expect(r.cli).toBe('node_modules/.bin/specguard');
    expect(r.mcp).toEqual({ command: 'node_modules/.bin/specguard-mcp', args: [] });
  });

  it('SPECGUARD_CLI wins over the local bin', () => {
    const cwd = tmp();
    touch(path.join(cwd, 'node_modules/.bin/specguard'));
    const cli = path.join(tmp(), 'dist/cli/index.js');
    touch(cli);
    touch(path.join(path.dirname(cli), '../mcp/server.js'));
    const r = resolveRunner(cwd, {}, { ...EMPTY_ENV, SPECGUARD_CLI: cli });
    expect(r.cli).toBe(`node ${cli}`);
    expect(r.mcp.command).toBe('node');
    expect(r.mcp.args[0]).toMatch(/mcp\/server\.js$/);
  });

  it('falls back to npx only when nothing local exists, and --runner npx forces it', () => {
    const cwd = tmp();
    expect(resolveRunner(cwd, {}, EMPTY_ENV).cli).toBe(NPX_CLI);
    touch(path.join(cwd, 'node_modules/.bin/specguard'));
    expect(resolveRunner(cwd, { runner: 'npx' }, EMPTY_ENV).cli).toBe(NPX_CLI);
  });

  it('--runner path needs an existing file', () => {
    const cwd = tmp();
    expect(() => resolveRunner(cwd, { runner: 'path' }, EMPTY_ENV)).toThrow(/runner-path/);
    touch(path.join(cwd, 'bin/sg'));
    expect(resolveRunner(cwd, { runner: 'path', runnerPath: 'bin/sg' }, EMPTY_ENV).cli).toBe('bin/sg');
  });

  it('--runner node uses node_modules/specguard-ai', () => {
    const cwd = tmp();
    touch(path.join(cwd, 'node_modules/specguard-ai/dist/cli/index.js'));
    expect(resolveRunner(cwd, { runner: 'node' }, EMPTY_ENV).cli).toBe('node node_modules/specguard-ai/dist/cli/index.js');
  });
});

describe('scaffold wiring [no-silent-hook-rewrite]', () => {
  it('wires the local binary and records why in the hook', async () => {
    const cwd = tmp();
    touch(path.join(cwd, 'node_modules/.bin/specguard'));
    await scaffoldHarnessFiles({ cwd, profile: getProfile('typescript'), harness: 'claude', runner: undefined });
    const s = settings(cwd);
    const cmd = s.hooks.PostToolUse[0].hooks[0].command as string;
    expect(cmd).toContain('node_modules/.bin/specguard status');
    expect(cmd).toContain(': "specguard runner:');
    expect(cmd).not.toContain('npx -p');
  });

  it('prints a diff and leaves a differing hook alone; --update-hooks applies it', async () => {
    const cwd = tmp();
    await scaffoldHarnessFiles({ cwd, profile: getProfile('typescript'), harness: 'claude', runner: 'npx' });
    touch(path.join(cwd, 'node_modules/.bin/specguard'));
    const before = readFileSync(path.join(cwd, '.claude/settings.json'), 'utf8');

    const kept = await scaffoldHarnessFiles({ cwd, profile: getProfile('typescript'), harness: 'claude', runner: 'path', runnerPath: 'node_modules/.bin/specguard' });
    expect(readFileSync(path.join(cwd, '.claude/settings.json'), 'utf8')).toBe(before);
    const text = kept.messages.join('\n');
    expect(text).toContain('differs  .claude/settings.json PostToolUse hook');
    expect(text).toContain('--update-hooks');
    expect(text).toContain('- ');
    expect(text).toContain('+ ');

    await scaffoldHarnessFiles({ cwd, profile: getProfile('typescript'), harness: 'claude', runner: 'path', runnerPath: 'node_modules/.bin/specguard', updateHooks: true });
    const s = settings(cwd);
    expect(s.hooks.PostToolUse).toHaveLength(1);
    expect(s.hooks.PostToolUse[0].hooks[0].command).toContain('node_modules/.bin/specguard status');
  });

  it('is quiet when the generated wiring already matches', async () => {
    const cwd = tmp();
    await scaffoldHarnessFiles({ cwd, profile: getProfile('typescript'), harness: 'claude', runner: 'npx' });
    const again = await scaffoldHarnessFiles({ cwd, profile: getProfile('typescript'), harness: 'claude', runner: 'npx' });
    expect(again.messages.join('\n')).not.toContain('differs');
  });
});
