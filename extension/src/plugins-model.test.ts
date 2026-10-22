import { describe, expect, it } from 'vitest';
import {
  describeRow,
  enabledPluginCommands,
  parsePluginList,
  pipelineAvailable,
  rowContext,
  suggestPluginId,
  type PluginRow,
} from './plugins-model.js';

const row = (over: Partial<PluginRow>): PluginRow => ({
  id: 'quality', source: 'builtin', title: 'Code quality', description: 'd', provides: ['commands'], commands: ['quality'],
  enabled: true, inherited: false, disabledHere: false, ...over,
});

// [claims: capabilities/integration-surfaces#extension-plugins-view]
describe('plugin list in the extension', () => {
  it('parses the CLI JSON even after other log lines, and rejects anything else', () => {
    const json = JSON.stringify({ rootDir: '/x', plugins: [row({})] }, null, 2);
    expect(parsePluginList(['[warn] something', ...json.split('\n')])?.[0].id).toBe('quality');
    expect(parsePluginList(['no json here'])).toBeUndefined();
    expect(parsePluginList(['{ broken'])).toBeUndefined();
    expect(parsePluginList(['{"other": 1}'])).toBeUndefined();
  });

  it('builds the pipeline actions from the enabled plugins\' commands', () => {
    const rows = [row({}), row({ id: 'git', commands: ['commit'], enabled: false }), row({ id: 'acme', source: 'npm', package: 'acme-plugin', commands: ['acme', 'acme-fix'] }), row({ id: 'bad', commands: ['x'], error: 'boom' })];
    expect(enabledPluginCommands(rows)).toEqual([
      { command: 'quality', plugin: 'quality' },
      { command: 'acme', plugin: 'acme' },
      { command: 'acme-fix', plugin: 'acme' },
    ]);
  });

  it('refuses quality and commit only when their plugin is known to be off', () => {
    const rows = [row({}), row({ id: 'git', commands: ['commit'], enabled: false })];
    expect(pipelineAvailable(rows, 'quality')).toEqual({ ok: true });
    expect(pipelineAvailable(rows, 'commit')).toEqual({ ok: false, plugin: 'git' });
    expect(pipelineAvailable(rows, 'check')).toEqual({ ok: true });
    expect(pipelineAvailable(undefined, 'commit')).toEqual({ ok: true }); // unknown state: let the CLI answer
    expect(pipelineAvailable([row({ id: 'git', commands: ['commit'], error: 'x' })], 'commit')).toEqual({ ok: false, plugin: 'git' });
  });

  it('describes a row and picks the context value the menus match on', () => {
    expect(describeRow(row({}))).toBe('on');
    expect(describeRow(row({ enabled: false, disabledHere: true }))).toBe('off · turned off here');
    expect(describeRow(row({ source: 'npm', package: '@a/b', inherited: true }))).toBe('on · npm: @a/b · inherited');
    expect(describeRow(row({ error: 'x' }))).toBe('error');
    expect(rowContext(row({}))).toBe('plugin-builtin-on');
    expect(rowContext(row({ source: 'npm', enabled: false }))).toBe('plugin-npm-off');
  });

  it('suggests a plugin id from the package name', () => {
    expect(suggestPluginId('@acme/specguard-plugin-checks')).toBe('checks');
    expect(suggestPluginId('specguard-plugin-lint')).toBe('lint');
    expect(suggestPluginId('Weird_Name.js')).toBe('weird-name-js');
    expect(suggestPluginId('123abc')).toBe('p-123abc');
  });
});
