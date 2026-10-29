import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { configFileFor, configDirFor } from './project-config.js';
import { loadDotEnv } from './env-file.js';
import { DEFAULT_SERVER, resolveSettings, validateLayer, type SettingsLayer, type AiSettings } from './settings-model.js';
import { ApiClient, SUPPORTED_API_VERSION } from './api/client.js';
import { normalizeUrl, readSavedToken } from './api/connection.js';

let secrets: vscode.SecretStorage | undefined;
export function initSettings(store: vscode.SecretStorage): void { secrets = store; }
const cfg = () => vscode.workspace.getConfiguration('specguard');
export function repoSettingsKey(root: string): string {
  return vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === root)?.name ?? root;
}
function scopeId(root?: string): string {
  const workspace = vscode.workspace.workspaceFile?.toString() ?? vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? 'empty';
  return createHash('sha256').update(workspace + (root ? `\n${root}` : '')).digest('hex');
}
function credentialId(llm: AiSettings, root?: string): string {
  return `specguard.ai:${scopeId(root)}:${llm.provider}:${llm.apiKeyEnv}:${llm.baseUrl ?? ''}`;
}
export function settingsLayers(root: string) {
  let legacy: SettingsLayer = {};
  try { legacy = JSON.parse(fs.readFileSync(configFileFor(root), 'utf8')) as SettingsLayer; } catch { /* uninitialized project */ }
  const config = cfg();
  const defaults = config.get<SettingsLayer>('workspaceDefaults', {});
  const oldUrl = config.get<string>('serverUrl', '');
  const oldProject = config.get<string>('serverProject', '');
  const oldMode = config.get<'auto' | 'off'>('serverMode', 'auto');
  const workspace: SettingsLayer = { ...defaults };
  if (!workspace.server && (oldUrl || oldProject || oldMode === 'off')) workspace.server = { ...DEFAULT_SERVER, url: oldUrl || legacy.server?.url || '', project: oldProject || legacy.server?.project, mode: oldMode };
  const repo = config.get<Record<string, SettingsLayer>>('repositoryOverrides', {})[repoSettingsKey(root)] ?? {};
  const effective = resolveSettings(legacy, workspace, repo);
  if (!repo.llm && !workspace.llm && !effective.llm.baseUrl) {
    const envName = effective.llm.provider === 'openai' ? 'OPENAI_BASE_URL' : effective.llm.provider === 'litellm' ? 'LITELLM_BASE_URL' : '';
    const fromEnv = envName ? process.env[envName] || loadDotEnv(path.join(configDirFor(root), '.specguard', '.env'))[envName] : undefined;
    if (fromEnv) effective.llm.baseUrl = fromEnv;
  }
  return { legacy, workspace, repo, effective };
}
export async function saveSettings(root: string | undefined, value: unknown): Promise<void> {
  const layer = validateLayer(value);
  if (!root) await cfg().update('workspaceDefaults', layer, vscode.ConfigurationTarget.Workspace);
  else {
    const overrides = { ...cfg().get<Record<string, SettingsLayer>>('repositoryOverrides', {}) };
    const key = repoSettingsKey(root);
    if (layer.llm || layer.server) overrides[key] = layer; else delete overrides[key];
    await cfg().update('repositoryOverrides', overrides, vscode.ConfigurationTarget.Workspace);
  }
}
export async function resetRepoSettings(root: string): Promise<void> {
  const layers = settingsLayers(root);
  await secrets?.delete(credentialId(layers.effective.llm, root));
  await secrets?.delete(credentialId(resolveSettings({}, layers.workspace, {}).llm, root));
  await saveSettings(root, {});
}
export async function aiCredential(root: string, llm = settingsLayers(root).effective.llm): Promise<{ value?: string; source: string }> {
  const own = await secrets?.get(credentialId(llm, root));
  if (own) return { value: own, source: 'Repo secure storage' };
  const shared = await secrets?.get(credentialId(llm));
  if (shared) return { value: shared, source: 'Workspace secure storage' };
  const env = process.env[llm.apiKeyEnv];
  if (env) return { value: env, source: 'Environment' };
  const file = loadDotEnv(path.join(configDirFor(root), '.specguard', '.env'))[llm.apiKeyEnv];
  if (file) return { value: file, source: 'Existing project .env' };
  const base = process.env.XDG_CONFIG_HOME || (process.env.HOME ? path.join(process.env.HOME, '.config') : undefined);
  const user = base ? loadDotEnv(path.join(base, 'specguard', '.env'))[llm.apiKeyEnv] : undefined;
  return user ? { value: user, source: 'Existing user .env' } : { source: 'Not configured' };
}
export async function setAiCredential(root: string | undefined, llm: AiSettings, remove = false): Promise<void> {
  if (!secrets) throw new Error('Secure storage is unavailable.');
  const id = credentialId(llm, root);
  if (remove) { await secrets.delete(id); return; }
  const value = await vscode.window.showInputBox({ title: root ? 'Repository API key' : 'Workspace API key', prompt: `Store ${llm.apiKeyEnv} securely in VS Code`, password: true, ignoreFocusOut: true });
  if (value?.trim()) await secrets.store(id, value.trim());
}
export async function serverToken(url: string, root: string): Promise<string | undefined> {
  const raw = settingsLayers(root).legacy as SettingsLayer & { server?: { tokenEnv?: string } };
  return await secrets?.get(`specguard.token:${normalizeUrl(url)}`) || process.env[raw.server?.tokenEnv ?? 'SPECGUARD_TOKEN'] || readSavedToken(url);
}
export async function setServerToken(url: string, remove = false): Promise<void> {
  if (!secrets) throw new Error('Secure storage is unavailable.');
  if (!url) throw new Error('Enter the server URL first.');
  const key = `specguard.token:${normalizeUrl(url)}`;
  if (remove) { await secrets.delete(key); return; }
  const token = await vscode.window.showInputBox({ title: 'Team server token', prompt: `Token for ${url}`, password: true, ignoreFocusOut: true });
  if (token?.trim()) await secrets.store(key, token.trim());
}
export async function settingsSnapshot(root: string, workspaceScope: boolean) {
  const layers = settingsLayers(root);
  const effective = workspaceScope ? resolveSettings({}, layers.workspace, {}) : layers.effective;
  const credential = workspaceScope ? { value: await secrets?.get(credentialId(effective.llm)), source: 'Workspace secure storage' } : await aiCredential(root, effective.llm);
  // The webview needs override flags, not the raw persisted config (which may contain legacy secret fields).
  const layer = workspaceScope ? layers.workspace : layers.repo;
  return { ...effective, layer: { ...(layer.llm ? { llm: effective.llm } : {}), ...(layer.server ? { server: effective.server } : {}) }, hasKey: !!credential.value,
    keySource: credential.value ? credential.source : 'Not configured', hasToken: effective.server.url ? !!(await serverToken(effective.server.url, root)) : false };
}
/** All spawned extension CLIs use these values; credentials never enter argv or config files. */
export async function runtimeEnvironment(root: string): Promise<NodeJS.ProcessEnv> {
  const layers = settingsLayers(root);
  const { llm, server } = layers.effective;
  const credential = await aiCredential(root, llm);
  const env: NodeJS.ProcessEnv = { ...loadDotEnv(path.join(configDirFor(root), '.specguard', '.env')), ...process.env };
  if (credential.value) env[llm.apiKeyEnv] = credential.value;
  if (layers.workspace.llm || layers.repo.llm) {
    env.SPECGUARD_IDE_LLM = JSON.stringify(llm);
    // Explicit editor endpoints (including provider defaults) must also supersede legacy endpoint env vars.
    env.OPENAI_BASE_URL = llm.provider === 'openai' ? llm.baseUrl ?? '' : '';
    env.LITELLM_BASE_URL = llm.provider === 'litellm' ? llm.baseUrl ?? '' : '';
  }
  if (layers.workspace.server || layers.repo.server) {
    env.SPECGUARD_SERVER = server.mode === 'off' ? '' : server.url;
    env.SPECGUARD_PROJECT = server.project ?? path.basename(root);
  }
  return env;
}
export async function testConnection(root: string, kind: 'ai' | 'server', draft: SettingsLayer, workspaceScope = false): Promise<string> {
  const layers = settingsLayers(root);
  const { llm, server } = resolveSettings(layers.legacy, layers.workspace, validateLayer(draft));
  try {
    if (kind === 'server') {
      if (!server.url || server.mode === 'off') return 'Team server is not enabled.';
      const client = new ApiClient({ baseUrl: server.url, project: server.project ?? path.basename(root), token: await serverToken(server.url, root) });
      const health = await client.health(5000);
      if (!health.ok || health.apiVersion !== SUPPORTED_API_VERSION) return 'Server responded, but its API is incompatible.';
      await client.projects();
      await client.get('/system', 5000);
      return 'Connected. Server and project access verified.';
    }
    const value = workspaceScope ? await secrets?.get(credentialId(llm)) || process.env[llm.apiKeyEnv] : (await aiCredential(root, llm)).value;
    if (!value && llm.provider !== 'litellm') return 'Set an API key first.';
    const base = llm.baseUrl || (llm.provider === 'anthropic' ? 'https://api.anthropic.com/v1' : llm.provider === 'openai' ? 'https://api.openai.com/v1' : 'http://localhost:4000/v1');
    const url = `${base.replace(/\/+$/, '')}${base.endsWith('/v1') ? '' : '/v1'}/models`;
    const headers: Record<string, string> = llm.provider === 'anthropic' ? { 'anthropic-version': '2023-06-01', ...(value ? { 'x-api-key': value } : {}) } : value ? { Authorization: `Bearer ${value}` } : {};
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) return `Connection failed (HTTP ${response.status}).`;
    const data = await response.json() as { data?: unknown };
    return Array.isArray(data?.data) ? 'Connected. Model listing is accessible; generation was not run.' : 'Endpoint responded, but did not return a model list.';
  } catch { return 'Connection failed. Check the address, credentials and project access.'; }
}
