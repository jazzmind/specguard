import { resolveServer, readServerConfig, type ConnectionSettings } from './api/connection.js';
import { ApiClient, SUPPORTED_API_VERSION } from './api/client.js';
const cache = new Map<string, { at: number; label: string; signature: string }>();
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
