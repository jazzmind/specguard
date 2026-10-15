/**
 * `specguard login` / `logout`: remember a team server's token for this machine.
 */
import { forgetToken, normalizeServerUrl, saveToken } from '../../client/credentials.js';
import { serverTarget } from '../../client/index.js';
import { loadConfig } from '../../core/config.js';
import type { GlobalOpts } from './helpers.js';

function readStdinToken(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

/** The server to act on: `--server`, else the project's configured one. */
async function serverUrl(opts: { server?: string } & GlobalOpts): Promise<string | undefined> {
  if (opts.server) return normalizeServerUrl(opts.server);
  const config = await loadConfig(process.cwd()).catch(() => null);
  return serverTarget(config)?.url;
}

export async function loginCommand(opts: GlobalOpts & { server?: string; token?: string }): Promise<void> {
  const url = await serverUrl(opts);
  if (!url) {
    process.stderr.write('Say which server: specguard login --server <url>, or set "server.url" in .specguard/config.json.\n');
    process.exit(1);
  }
  const token = opts.token ?? (await readStdinToken());
  if (!token) {
    process.stdout.write(
      `Create a token on the server, then give it to SpecGuard:\n  1. Open ${url}/ in your browser (signed in to the sandbox) and choose Tokens.\n  2. Run: specguard login --server ${url} --token <token>\n     or pipe it: echo <token> | specguard login --server ${url}\n`,
    );
    process.exit(1);
  }
  // A token that does not work must not be saved: it would turn every later command into a refusal.
  try {
    const res = await fetch(`${url}/api/v1/projects`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (res.status === 401) {
      process.stderr.write('The server did not accept that token.\n');
      process.exit(1);
    }
    if (!res.ok) {
      process.stderr.write(`The server answered ${res.status}; the token was not saved.\n`);
      process.exit(1);
    }
  } catch (err) {
    process.stderr.write(`Cannot reach ${url} (${(err as Error).message}); the token was not saved.\n`);
    process.exit(1);
  }
  const file = saveToken(url, token);
  process.stdout.write(`Saved a token for ${url} in ${file}.\n`);
}

export async function logoutCommand(opts: GlobalOpts & { server?: string }): Promise<void> {
  const url = await serverUrl(opts);
  if (!url) {
    process.stderr.write('Say which server: specguard logout --server <url>.\n');
    process.exit(1);
  }
  process.stdout.write(forgetToken(url) ? `Forgot the token for ${url}.\n` : `No saved token for ${url}.\n`);
}
