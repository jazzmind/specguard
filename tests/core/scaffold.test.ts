import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, it, expect, afterAll } from 'vitest';

import { scaffoldHarnessFiles } from '../../src/core/scaffold.js';
import { getProfile } from '../../src/core/language-profiles.js';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'specguard-scaffold-'));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe('scaffoldHarnessFiles', () => {
  it('greenfield Claude scaffold writes the expected files, language-aware', async () => {
    const cwd = makeTempDir();
    const res = await scaffoldHarnessFiles({ cwd, profile: getProfile('python'), harness: 'claude' });

    expect(existsSync(path.join(cwd, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(path.join(cwd, '.claude/skills/specguard/SKILL.md'))).toBe(true);
    expect(existsSync(path.join(cwd, '.claude/commands/goal.md'))).toBe(true);
    expect(existsSync(path.join(cwd, '.claude/settings.json'))).toBe(true);
    expect(existsSync(path.join(cwd, 'AGENTS.md'))).toBe(true);

    const skill = readFileSync(path.join(cwd, '.claude/skills/specguard/SKILL.md'), 'utf8');
    expect(skill).toContain('pytest');

    const settings = JSON.parse(readFileSync(path.join(cwd, '.claude/settings.json'), 'utf8'));
    expect(settings.mcpServers['specguard-mcp']).toBeTruthy();
    expect(JSON.stringify(settings.hooks.PostToolUse)).toContain('specguard status');

    expect(res.created.length).toBeGreaterThan(0);
  });

  it('does not generate Cursor files for harness: claude', async () => {
    const cwd = makeTempDir();
    await scaffoldHarnessFiles({ cwd, profile: getProfile('typescript'), harness: 'claude' });
    expect(existsSync(path.join(cwd, '.cursor'))).toBe(false);
  });

  it('is idempotent and preserves user content', async () => {
    const cwd = makeTempDir();
    await scaffoldHarnessFiles({ cwd, profile: getProfile('typescript'), harness: 'claude' });

    // Hand-edit settings + append prose under CLAUDE.md sentinels.
    const settingsPath = path.join(cwd, '.claude/settings.json');
    const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
    s.userKey = 'keep-me';
    writeFileSync(settingsPath, JSON.stringify(s, null, 2));
    const claudePath = path.join(cwd, 'CLAUDE.md');
    writeFileSync(claudePath, readFileSync(claudePath, 'utf8') + '\n## My own notes\nhello\n');

    await scaffoldHarnessFiles({ cwd, profile: getProfile('typescript'), harness: 'claude' });

    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    expect(after.userKey).toBe('keep-me');
    expect(after.mcpServers['specguard-mcp']).toBeTruthy();
    expect(readFileSync(claudePath, 'utf8')).toContain('## My own notes');
  });

  it('skips a user-authored AGENTS.md lacking the managed marker', async () => {
    const cwd = makeTempDir();
    writeFileSync(path.join(cwd, 'AGENTS.md'), '# My agents\nhand written\n');
    const res = await scaffoldHarnessFiles({ cwd, profile: getProfile('typescript'), harness: 'claude' });
    expect(readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8')).toBe('# My agents\nhand written\n');
    expect(res.skipped.some((p) => p.endsWith('AGENTS.md'))).toBe(true);
  });

  it('leaves malformed JSON config unchanged', async () => {
    const cwd = makeTempDir();
    mkdirSync(path.join(cwd, '.cursor'), { recursive: true });
    writeFileSync(path.join(cwd, '.cursor/mcp.json'), '{ not json');
    const res = await scaffoldHarnessFiles({ cwd, profile: getProfile('typescript'), harness: 'cursor' });
    expect(readFileSync(path.join(cwd, '.cursor/mcp.json'), 'utf8')).toBe('{ not json');
    expect(res.skipped.some((p) => p.endsWith('mcp.json'))).toBe(true);
  });
});

describe('npx forms', () => {
  it('writes the package-qualified npx commands', async () => {
    const { mergeClaudeSettings, mergeCursorMcpJson, NPX_CLI, mcpServerEntry } = await import('../../src/core/scaffold.js');
    const claude = mergeClaudeSettings({}) as { mcpServers: Record<string, { command: string; args: string[] }>; hooks: unknown };
    expect(claude.mcpServers['specguard-mcp']).toEqual({ command: 'npx', args: ['-y', '-p', 'specguard-ai', 'specguard-mcp'] });
    expect(JSON.stringify(claude.hooks)).toContain(`${NPX_CLI} status`);
    expect(NPX_CLI).toBe('npx -p specguard-ai specguard');
    expect(mergeCursorMcpJson({}).mcpServers).toEqual({ 'specguard-mcp': mcpServerEntry() });
  });

  it('repairs the broken form written by older versions and leaves customised entries alone', async () => {
    const { mergeClaudeSettings, mergeCursorMcpJson, mcpServerEntry } = await import('../../src/core/scaffold.js');
    const broken = {
      mcpServers: { 'specguard-mcp': { command: 'npx', args: ['specguard-mcp'] } },
      hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'npx specguard status | tail -3' }] }] },
    };
    const fixed = mergeClaudeSettings(broken) as typeof broken;
    expect(fixed.mcpServers['specguard-mcp']).toEqual(mcpServerEntry());
    expect(JSON.stringify(fixed.hooks)).toContain('npx -p specguard-ai specguard status | tail -3');
    expect(JSON.stringify(fixed.hooks)).not.toContain('npx specguard status');
    expect(fixed.hooks.PostToolUse).toHaveLength(1);

    const custom = { mcpServers: { 'specguard-mcp': { command: '/opt/specguard-mcp', args: [] } } };
    expect(mergeCursorMcpJson(custom).mcpServers).toEqual(custom.mcpServers);
    expect(mergeCursorMcpJson({ mcpServers: { 'specguard-mcp': { command: 'npx', args: ['specguard-mcp'] }, other: { command: 'x' } } }).mcpServers).toEqual({
      'specguard-mcp': mcpServerEntry(),
      other: { command: 'x' },
    });
  });
});
