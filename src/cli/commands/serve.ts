/**
 * `specguard serve`: docs and audit API plus web UI.
 */
import { DEFAULT_PORT, startServer } from '../../server/index.js';
import { loadCliConfig, type GlobalOpts } from './helpers.js';

export async function serveCommand(opts: GlobalOpts & { port?: string; host?: string; cors?: string }): Promise<void> {
  const config = await loadCliConfig(opts);
  const port = opts.port === undefined ? DEFAULT_PORT : Number(opts.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`invalid --port '${opts.port}'\n`);
    process.exit(1);
  }
  const server = await startServer(config, { port, host: opts.host, cors: opts.cors });
  process.stdout.write(`specguard serving ${server.url}\n  UI    ${server.url}/\n  API   ${server.url}/api/v1/system\n`);
  if (opts.host && opts.host !== '127.0.0.1' && opts.host !== 'localhost') {
    process.stdout.write('  note: bound beyond loopback; the API is read-only but has no authentication\n');
  }
  const stop = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
