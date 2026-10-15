/**
 * Decides where the extension's data comes from: the team server when one is configured and answers, otherwise a local
 * `specguard serve` over this workspace. Pure logic (no VS Code imports) so every branch is testable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ApiClient, SUPPORTED_API_VERSION, type Health } from './client.js';
import { startLocalServer, type LocalServerHandle } from './local-server.js';

export type Source = 'server' | 'local';

export interface ConnectionSettings {
  /** `specguard.serverUrl`; overrides the project's own `server.url`. */
  url?: string;
  /** `specguard.serverProject`. */
  project?: string;
  /** `auto` (default): use the server if it answers. `off`: always local. */
  mode?: 'auto' | 'off';
}

export interface ConnectionDeps {
  workspaceRoot: string;
  settings: ConnectionSettings;
  /** A token the user stored in the editor's secret storage. */
  storedToken?: string;
  resolveCli: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  /** For tests. Default: start `specguard serve`. */
  startLocal?: (cli: string, cwd: string) => Promise<LocalServerHandle>;
  healthTimeoutMs?: number;
}

export interface Live {
  client: ApiClient;
  source: Source;
  url: string;
  project?: string;
  health?: Health;
  /** Why the team server was not used, when one was configured. */
  notice?: string;
  dispose(): void;
}

interface ProjectServerConfig {
  url?: string;
  project?: string;
  mode?: string;
  tokenEnv?: string;
  timeoutMs?: number;
}

/** The `server` block of `.specguard/config.json`, read without loading the whole config. */
export function readServerConfig(workspaceRoot: string): ProjectServerConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(workspaceRoot, '.specguard', 'config.json'), 'utf8')) as { server?: ProjectServerConfig };
    return raw.server && typeof raw.server === 'object' ? raw.server : {};
  } catch {
    return {};
  }
}

export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

/** Token saved by `specguard login`, the same file the command line reads. */
export function readSavedToken(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  try {
    const store = JSON.parse(fs.readFileSync(path.join(base, 'specguard', 'credentials.json'), 'utf8')) as Record<string, { token?: string }>;
    return store[normalizeUrl(url)]?.token;
  } catch {
    return undefined;
  }
}

/** The server this workspace should use, with its token, or null when none is configured or the mode is off. */
export function resolveServer(deps: ConnectionDeps): { url: string; project: string; token?: string } | null {
  const env = deps.env ?? process.env;
  const cfg = readServerConfig(deps.workspaceRoot);
  if (deps.settings.mode === 'off' || cfg.mode === 'off') return null;
  const url = deps.settings.url || env.SPECGUARD_SERVER || cfg.url;
  if (!url) return null;
  const token = deps.storedToken || env[cfg.tokenEnv ?? 'SPECGUARD_TOKEN'] || readSavedToken(url, env);
  return { url: normalizeUrl(url), project: deps.settings.project || env.SPECGUARD_PROJECT || cfg.project || path.basename(deps.workspaceRoot), ...(token ? { token } : {}) };
}

/** Use the team server if one is configured, reachable, compatible and has this project; otherwise serve the workspace locally. */
export async function connect(deps: ConnectionDeps): Promise<Live> {
  const server = resolveServer(deps);
  let notice: string | undefined;
  if (server) {
    const probe = new ApiClient({ baseUrl: server.url, token: server.token }, deps.fetchImpl);
    try {
      const health = await probe.health(deps.healthTimeoutMs ?? 800);
      if (!health.ok || typeof health.apiVersion !== 'number') throw new Error('that address does not look like a SpecGuard server');
      if (health.apiVersion !== SUPPORTED_API_VERSION) throw new Error(`the server speaks API version ${health.apiVersion}; this extension speaks ${SUPPORTED_API_VERSION}`);
      const client = new ApiClient({ baseUrl: server.url, project: server.project, token: server.token }, deps.fetchImpl);
      // Reading the project proves the token works and that it is on the server.
      await client.get('/system');
      return { client, source: 'server', url: server.url, project: server.project, health, dispose: () => undefined };
    } catch (err) {
      const status = (err as { status?: number }).status;
      notice =
        status === 401 ? `The team server did not accept your credentials (run "SpecGuard: Sign in to Server"). Showing local data.`
        : status === 404 ? `Project "${server.project}" is not on the team server yet. Showing local data.`
        : `Team server unavailable (${(err as Error).message}). Showing local data.`;
    }
  }
  const cli = await deps.resolveCli();
  const local = await (deps.startLocal ?? ((c, cwd) => startLocalServer(c, cwd, deps.env ?? process.env)))(cli, deps.workspaceRoot);
  const localUrl = local.url.replace(/\/+$/, '');
  return { client: new ApiClient({ baseUrl: localUrl }, deps.fetchImpl), source: 'local', url: localUrl, ...(notice ? { notice } : {}), dispose: () => local.dispose() };
}
