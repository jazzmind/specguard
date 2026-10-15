/**
 * Where a server token comes from: the environment first, then the file `specguard login` writes.
 *
 * Spec: specs/capabilities/team-server.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `~/.config/specguard/credentials.json`, or under `XDG_CONFIG_HOME`. */
export function credentialsFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(base, 'specguard', 'credentials.json');
}

/** A server URL as a key: no trailing slash, lower-case host. */
export function normalizeServerUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

type Store = Record<string, { token: string; savedAt: string }>;

function readStore(file: string): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

export function readSavedToken(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readStore(credentialsFile(env))[normalizeServerUrl(url)]?.token;
}

/** Remember a token for a server. The file is readable by its owner only. */
export function saveToken(url: string, token: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = credentialsFile(env);
  const store = readStore(file);
  store[normalizeServerUrl(url)] = { token, savedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

export function forgetToken(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = credentialsFile(env);
  const store = readStore(file);
  const key = normalizeServerUrl(url);
  if (!(key in store)) return false;
  delete store[key];
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  return true;
}
