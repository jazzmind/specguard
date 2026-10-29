import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ root: '/overlay', switched: () => {}, getPlugins: vi.fn() }));
vi.mock('vscode', () => ({
  EventEmitter: class { event = vi.fn(); fire = vi.fn(); dispose = vi.fn(); },
}));
vi.mock('./workspace-state.js', () => ({
  getActiveWorkspaceRoot: () => state.root,
  onDidChangeActiveWorkspaceRoot: (fn: () => void) => { state.switched = fn; return { dispose() {} }; },
}));
vi.mock('./plugins-state.js', () => ({
  getPlugins: state.getPlugins,
  onDidChangePlugins: () => ({ dispose() {} }),
}));
vi.mock('./dashboard/panel.js', () => ({}));

import { PluginsProvider } from './plugins-view.js';

// [claims: capabilities/integration-surfaces#extension-plugins-view]
describe('plugins follow the selected project', () => {
  it('replaces a previous no-config error on switching and ignores an older in-flight response', async () => {
    let finishOld!: (value: unknown) => void;
    state.getPlugins.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const provider = new PluginsProvider();
    const old = provider.refresh();
    state.root = '/app';
    const row = { id: 'feature-catalog', enabled: true };
    state.getPlugins.mockResolvedValue({ rows: [row] });
    state.switched();
    await vi.waitFor(async () => expect(await provider.getChildren()).toEqual([{ kind: 'row', row }]));
    finishOld({ rows: undefined, error: 'No config found' });
    await old;
    expect(await provider.getChildren()).toEqual([{ kind: 'row', row }]);
    expect(state.getPlugins).toHaveBeenCalledWith('/app', { fresh: true });
    provider.dispose();
  });
});
