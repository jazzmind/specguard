/**
 * `specguard serve`: docs and audit API plus web UI.
 */
import { DEFAULT_PORT, startServer } from '../../server/index.js';
import { workspaceRegistry } from '../../server/project.js';
import { loadWorkspace, workspaceHint } from '../../core/workspace.js';
import { rollupManifest } from '../../core/workspace-rollup.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

/** Whether `host` keeps the server reachable from this machine only. */
export const isLoopbackHost = (host: string): boolean => host === 'localhost' || host === '::1' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

export async function serveCommand(opts: GlobalOpts & { port?: string; host?: string; cors?: string; workspace?: string | true; allowRemote?: boolean }): Promise<void> {
  // `serve` has no authentication: it is a read-only view for the person who started it. Anything wider than loopback
  // must be asked for, in those words, because everyone who can reach the port can then read specs, plans and findings.
  if (opts.host && !isLoopbackHost(opts.host) && !opts.allowRemote) {
    process.stderr.write(`refusing to bind ${opts.host}: \`specguard serve\` has no authentication, so anyone who can reach that address could read your specs, security plans and findings.\nPass --allow-remote to do it anyway, or run \`specguard server\` (the team server, with sign-in and tokens) to share a project.\n`);
    process.exit(1);
  }
  const port = opts.port === undefined ? DEFAULT_PORT : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`invalid --port '${opts.port}'\n`);
    process.exit(1);
  }
  let server;
  if (opts.workspace !== undefined) {
    const hint = workspaceHint(typeof opts.workspace === 'string' ? opts.workspace : undefined);
    let manifest;
    try {
      manifest = await loadWorkspace(process.cwd(), hint);
    } catch {
      process.stderr.write('No workspace.json found. Run `specguard workspace init`, or pass --workspace <path>.\n');
      process.exit(1);
    }
    const registry = await workspaceRegistry(manifest);
    server = await startServer(registry, { port, host: opts.host, cors: opts.cors, workspace: async () => rollupManifest(await loadWorkspace(process.cwd(), hint)) });
    process.stdout.write(`specguard serving workspace ${manifest.name} at ${server.url}\n  API   ${server.url}/api/v1/workspace\n  Repos ${server.url}/api/v1/projects\n`);
  } else {
    const config = await loadCliConfig(opts);
    server = await startServer(config, { port, host: opts.host, cors: opts.cors });
    process.stdout.write(`specguard serving ${server.url}\n  UI    ${server.url}/\n  API   ${server.url}/api/v1/system\n`);
  }
  if (opts.host && !isLoopbackHost(opts.host)) {
    process.stdout.write('  note: bound beyond loopback by --allow-remote; the API is read-only but has no authentication\n');
  }
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
