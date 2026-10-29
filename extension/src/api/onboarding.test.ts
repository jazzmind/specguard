import type { SecretStorage } from 'vscode';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ fetch: vi.fn(), store: vi.fn(), save: vi.fn(), pick: vi.fn() }));
vi.mock('vscode', () => ({
  EventEmitter: class { event = vi.fn(); fire() {} dispose() {} },
  workspace: { onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: { showInputBox: vi.fn().mockResolvedValueOnce('https://team.test').mockResolvedValueOnce('secret').mockResolvedValueOnce('new-app'), showInformationMessage: vi.fn().mockResolvedValue('I have a token'), showQuickPick: state.pick, showErrorMessage: vi.fn() },
}));
vi.mock('../settings.js', () => ({ settingsLayers: () => ({ effective: { server: { url: '', mode: 'auto' } }, repo: {} }), saveSettings: state.save, serverToken: vi.fn(), runtimeEnvironment: vi.fn() }));
vi.mock('../project-config.js', () => ({ configDirFor: (r: string) => r }));
vi.mock('../dashboard/cli.js', () => ({ resolveCliPath: vi.fn() }));
import { ApiHub } from './hub.js';
// [claims: capabilities/team-server#project-onboarding]
it('creates a project with a verified credential and saves the repo connection and secret separately', async () => {
  state.pick.mockResolvedValue({ label: 'Create a new project…', create: true });
  state.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [] }) }).mockResolvedValueOnce({ ok: true });
  vi.stubGlobal('fetch', state.fetch);
  const hub = new ApiHub({ store: state.store } as unknown as SecretStorage);
  try {
    await hub.signIn('/repo');
    expect(state.fetch.mock.calls[1][0]).toBe('https://team.test/api/v1/projects');
    expect(JSON.parse(state.fetch.mock.calls[1][1].body)).toEqual({ name: 'new-app' });
    expect(state.store).toHaveBeenCalledWith('specguard.token:https://team.test', 'secret');
    expect(state.save).toHaveBeenCalledWith('/repo', { server: { url: 'https://team.test', project: 'new-app', mode: 'auto' } });
  } finally { hub.dispose(); vi.unstubAllGlobals(); }
});
