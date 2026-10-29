import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_AI, resolveSettings, validateLayer } from './settings-model.js';

const state = vi.hoisted(() => ({ config: {} as Record<string, unknown>, overlay: '', root: '/code/app', prompt: '', writes: [] as unknown[] }));
vi.mock('vscode', () => ({
  workspace: {
    workspaceFile: { toString: () => 'file:///workspace/work.code-workspace' },
    workspaceFolders: [{ name: 'app', uri: { fsPath: '/code/app', toString: () => 'file:///code/app' } }],
    getConfiguration: () => ({ get: (key: string, fallback: unknown) => state.config[key] ?? fallback,
      update: async (key: string, value: unknown) => { state.config[key] = value; state.writes.push(value); } }),
  },
  window: { showInputBox: async () => state.prompt },
  ConfigurationTarget: { Workspace: 2 },
}));
vi.mock('./project-config.js', () => ({ configDirFor: () => state.overlay, configFileFor: () => path.join(state.overlay, '.specguard/config.json') }));
import { initSettings, saveSettings, settingsLayers, settingsSnapshot, setAiCredential, setServerToken, runtimeEnvironment, resetRepoSettings, testConnection } from './settings.js';

const store = new Map<string, string>();
let temp = '';
beforeEach(() => {
  state.config = {}; state.writes = []; state.prompt = ''; store.clear();
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-editor-settings-')); state.overlay = temp;
  vi.stubEnv('XDG_CONFIG_HOME', path.join(temp, 'user-config'));
  fs.mkdirSync(path.join(temp, '.specguard'));
  fs.writeFileSync(path.join(temp, '.specguard/config.json'), JSON.stringify({ llm: DEFAULT_AI, server: { url: 'https://legacy.test', project: 'mapped-app', mode: 'auto' } }));
  initSettings({ get: async (key: string) => store.get(key), store: async (key: string, value: string) => { store.set(key, value); }, delete: async (key: string) => { store.delete(key); } } as never);
});
afterEach(() => { fs.rmSync(temp, { recursive: true, force: true }); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// [claims: capabilities/integration-surfaces#extension-workspace-settings]
describe('workspace defaults and secure repo overrides', () => {
  it('inherits workspace AI and server defaults while preserving the repo project mapping', async () => {
    await saveSettings(undefined, { llm: { ...DEFAULT_AI, model: 'shared-model' }, server: { url: 'https://team.test', mode: 'auto' } });
    const result = settingsLayers(state.root).effective;
    expect(result.llm.model).toBe('shared-model');
    expect(result.llmSource).toBe('Inherited from workspace');
    expect(result.server).toEqual({ url: 'https://team.test', mode: 'auto', project: 'mapped-app' });
    await saveSettings(state.root, { llm: { ...DEFAULT_AI, model: 'repo-model' }, server: { url: 'https://other.test', project: 'other', mode: 'off' } });
    expect(settingsLayers(state.root).effective.llm.model).toBe('repo-model');
    expect(settingsLayers('/code/other').effective.llm.model).toBe('shared-model');
    expect(settingsLayers(state.root).effective.server.mode).toBe('off');
    await resetRepoSettings(state.root);
    expect(settingsLayers(state.root).effective.llm.model).toBe('shared-model');
    expect(state.config.repositoryOverrides).toEqual({});
  });
  it('keeps new keys out of files, shareable settings and webview snapshots, and injects them into child environments', async () => {
    const original = fs.readFileSync(path.join(temp, '.specguard/config.json'), 'utf8');
    await saveSettings(undefined, { llm: DEFAULT_AI });
    state.prompt = 'test-workspace-secret'; await setAiCredential(undefined, DEFAULT_AI);
    const snapshot = await settingsSnapshot(state.root, false);
    expect(snapshot.hasKey).toBe(true); expect(snapshot.keySource).toBe('Workspace secure storage');
    expect(JSON.stringify(snapshot)).not.toContain(state.prompt);
    expect(JSON.stringify(state.writes)).not.toContain(state.prompt);
    expect(fs.existsSync(path.join(temp, '.specguard/.env'))).toBe(false);
    expect(fs.readFileSync(path.join(temp, '.specguard/config.json'), 'utf8')).toBe(original);
    const env = await runtimeEnvironment(state.root);
    expect(env.ANTHROPIC_API_KEY).toBe(state.prompt);
    expect(JSON.parse(env.SPECGUARD_IDE_LLM!)).toEqual(DEFAULT_AI);
  });
  it('uses a repo key only for that repo and provider endpoint, and reset restores the workspace credential', async () => {
    state.prompt = 'workspace-secret'; await setAiCredential(undefined, DEFAULT_AI);
    state.prompt = 'repo-secret'; await setAiCredential(state.root, DEFAULT_AI);
    expect((await runtimeEnvironment(state.root)).ANTHROPIC_API_KEY).toBe('repo-secret');
    expect((await runtimeEnvironment('/code/other')).ANTHROPIC_API_KEY).toBe('workspace-secret');
    await saveSettings(state.root, { llm: { ...DEFAULT_AI, baseUrl: 'https://different.test' } });
    expect((await settingsSnapshot(state.root, false)).hasKey).toBe(false);
    await resetRepoSettings(state.root);
    expect((await runtimeEnvironment(state.root)).ANTHROPIC_API_KEY).toBe('workspace-secret');
  });
  it('reads existing overlay dotenv values, with process environment taking precedence', async () => {
    fs.writeFileSync(path.join(temp, '.specguard/.env'), 'SG_EXISTING_KEY=file-value\n');
    await saveSettings(undefined, { llm: { ...DEFAULT_AI, apiKeyEnv: 'SG_EXISTING_KEY' } });
    expect((await runtimeEnvironment(state.root)).SG_EXISTING_KEY).toBe('file-value');
    vi.stubEnv('SG_EXISTING_KEY', 'process-value');
    expect((await runtimeEnvironment(state.root)).SG_EXISTING_KEY).toBe('process-value');
  });
  it('uses the endpoint shown in editor settings instead of an old dotenv endpoint', async () => {
    fs.writeFileSync(path.join(temp, '.specguard/.env'), 'OPENAI_BASE_URL=https://old-endpoint.test\n');
    await saveSettings(undefined, { llm: { provider: 'openai', model: 'shared-model', apiKeyEnv: 'OPENAI_API_KEY' } });
    expect((await runtimeEnvironment(state.root)).OPENAI_BASE_URL).toBeUndefined();
    await saveSettings(undefined, { llm: { provider: 'openai', model: 'shared-model', apiKeyEnv: 'OPENAI_API_KEY', baseUrl: 'https://new-endpoint.test/v1' } });
    expect((await runtimeEnvironment(state.root)).OPENAI_BASE_URL).toBe('https://new-endpoint.test/v1');
  });
  it('verifies server health and project access and never displays echoed tokens from errors', async () => {
    state.prompt = 'test-server-token'; await setServerToken('https://team.test');
    const mockFetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, apiVersion: 1 }))).mockResolvedValueOnce(new Response('{}')).mockResolvedValueOnce(new Response('{}'));
    vi.stubGlobal('fetch', mockFetch);
    const draft = { server: { url: 'https://team.test', mode: 'auto' as const, project: 'mapped-app' } };
    expect(await testConnection(state.root, 'server', draft)).toContain('project access verified');
    expect(mockFetch.mock.calls[2][0]).toBe('https://team.test/api/v1/projects/mapped-app/system');
    expect(mockFetch.mock.calls[2][1].headers.Authorization).toBe('Bearer test-server-token');
    mockFetch.mockRejectedValue(new Error('test-server-token'));
    expect(await testConnection(state.root, 'server', draft)).not.toContain('test-server-token');
  });
  it('tests AI credentials without generation, refuses redirects, and reports status rather than response bodies', async () => {
    state.prompt = 'ai-test-secret'; await setAiCredential(undefined, DEFAULT_AI);
    const mockFetch = vi.fn().mockResolvedValue(new Response('ai-test-secret', { status: 401 })); vi.stubGlobal('fetch', mockFetch);
    expect(await testConnection(state.root, 'ai', { llm: DEFAULT_AI }, true)).toBe('Connection failed (HTTP 401).');
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/models');
    expect(mockFetch.mock.calls[0][1]).toMatchObject({ redirect: 'error', headers: { 'x-api-key': 'ai-test-secret' } });
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: 'example-model' }] })));
    expect(await testConnection(state.root, 'ai', { llm: DEFAULT_AI }, true)).toContain('generation was not run');
  });
  it('rejects invalid settings and strips unrelated values before saving', () => {
    expect(() => validateLayer({ llm: { ...DEFAULT_AI, model: '' } })).toThrow();
    expect(() => validateLayer({ server: { url: 'https://user:password@server.test', mode: 'auto' } })).toThrow();
    expect(validateLayer({ llm: { ...DEFAULT_AI, secret: 'never-persist' } })).toEqual({ llm: DEFAULT_AI });
    expect(resolveSettings({}, {}, {}).llm).toEqual(DEFAULT_AI);
  });
  it('never exposes unknown legacy credential fields in settings snapshots', async () => {
    fs.writeFileSync(path.join(temp, '.specguard/config.json'), JSON.stringify({ llm: { ...DEFAULT_AI, apiKey: 'legacy-secret' }, server: { url: '', mode: 'auto', token: 'legacy-token' } }));
    const snapshot = JSON.stringify(await settingsSnapshot(state.root, false));
    expect(snapshot).not.toContain('legacy-secret');
    expect(snapshot).not.toContain('legacy-token');
  });
});

// [claims: capabilities/integration-surfaces#overlay-clients, capabilities/platform-foundation#config-editor-ai-defaults]
it('starts the real bundled CLI for overlay discovery and plugin listing with Anthropic workspace defaults', async () => {
  fs.writeFileSync(path.join(temp, '.specguard/config.json'), JSON.stringify({ apps: [{ name: 'app', repo: '.', specDir: 'specs', sources: {}, framework: 'vitest', testOutput: 'tests/' }], llm: DEFAULT_AI }));
  await saveSettings(undefined, { llm: { ...DEFAULT_AI, provider: 'anthropic' } });
  vi.stubEnv('OPENAI_BASE_URL', 'https://legacy.test/v1');
  vi.stubEnv('LITELLM_BASE_URL', 'https://legacy-gateway.test');
  const env = await runtimeEnvironment(temp);
  expect(env.OPENAI_BASE_URL).toBeUndefined();
  expect(env.LITELLM_BASE_URL).toBeUndefined();
  const cli = path.join(temp, 'cli.cjs');
  execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/build.mjs'), 'cli', '--out', cli], { stdio: 'pipe' });
  for (const args of [['overlay', 'resolve', temp, '--json'], ['plugin', 'list', '--json']]) {
    const output = execFileSync(process.execPath, [cli, ...args], { cwd: temp, env, encoding: 'utf8' });
    expect(() => JSON.parse(output)).not.toThrow();
  }
}, 30_000);
