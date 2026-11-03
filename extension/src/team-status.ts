import { resolveServer, readServerConfig, type ConnectionSettings } from './api/connection.js';
import { ApiClient, SUPPORTED_API_VERSION } from './api/client.js';
const cache = new Map<string, { at: number; label: string; signature: string }>();
/** The team server a folder points at, and its project, as the extension itself reads them. No network and no cache, so a change to settings shows at once. */
export function resolveTeam(configDir: string, workspace: string | undefined, settings: ConnectionSettings): { url: string; project: string } | null {
  if ((settings.mode ?? readServerConfig(configDir).mode) === 'off') return null;
  const deps = (dir: string) => ({ workspaceRoot: dir, settings, resolveCli: async () => '' });
  const found = resolveServer(deps(configDir)) ?? (workspace ? resolveServer(deps(workspace)) : null);
  return found ? { url: found.url, project: found.project } : null;
}
/** The page for one project on its team server. */
export function teamProjectUrl(server: { url: string; project: string }): string { return `${server.url.replace(/\/+$/, '')}/?project=${encodeURIComponent(server.project)}`; }
export function teamStatus(root: string): string { return cache.get(root)?.label ?? 'not checked'; }
export async function refreshTeamStatus(root: string, configDir: string, workspace: string | undefined, settings: ConnectionSettings): Promise<void> {
  const signature = JSON.stringify(settings);
  if (signature === cache.get(root)?.signature && Date.now() - (cache.get(root)?.at ?? 0) < 30_000) return;
  const deps = (dir: string) => ({ workspaceRoot: dir, settings, resolveCli: async () => '' });
  const disabled = (settings.mode ?? readServerConfig(configDir).mode) === 'off';
  const server = disabled ? null : (resolveServer(deps(configDir)) ?? (workspace ? resolveServer(deps(workspace)) : null));
  let label = disabled ? 'disabled' : 'not configured';
  if (server) {
    try {
      const health = await new ApiClient({ baseUrl: server.url, token: server.token }).health(1000);
      label = health.ok && health.apiVersion === SUPPORTED_API_VERSION ? 'available (project access not checked)' : 'incompatible';
    } catch { label = 'configured · unavailable'; }
  }
  cache.set(root, { at: Date.now(), label, signature });
}
