/**
 * Loads `.specguard/.env` into the process environment so secrets are available even when the user has not
 * exported them in their shell.
 *
 * Precedence, highest first: the real environment, the repo's own `.specguard/.env`, the workspace's, then the
 * user's own `~/.config/specguard/.env` (one place for a key every workspace should share).
 * Existing variables are never overwritten.
 *
 * Spec: specs/capabilities/workspaces.md
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** A warning when `file` holds secrets and other users on the machine can read it. POSIX only; Windows has no such mode. */
export function envFilePermissionWarning(file: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  try {
    const mode = statSync(file).mode & 0o777;
    return mode & 0o077 ? `${file} is readable by other users (mode ${mode.toString(8)}): run chmod 600 on it, it holds secrets` : undefined;
  } catch {
    return undefined;
  }
}

/** Set the variables in `file` that are not already set. Best effort: an unreadable file is ignored. */
function applyDotEnv(file: string, env: NodeJS.ProcessEnv): void {
  try {
    for (const raw of readFileSync(file, 'utf-8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !(key in env)) env[key] = val;
    }
  } catch {
    /* best effort */
  }
}

/** The `.specguard/.env` of the workspace that contains `dir`, found through its `workspace.json`. */
function workspaceEnvFile(dir: string): string | undefined {
  try {
    let current = path.resolve(dir);
    for (;;) {
      if (existsSync(path.join(current, '.specguard', 'workspace.json'))) {
        const file = path.join(current, '.specguard', '.env');
        return existsSync(file) ? file : undefined;
      }
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
  } catch {
    return undefined;
  }
}

/**
 * Load the environment files that apply to `dir`. The repo's file is applied first, so where both name a
 * variable the repo wins; the workspace's file only fills in what is still missing.
 */
export function loadSpecGuardEnv(dir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];
  const repoEnv = path.join(dir, '.specguard', '.env');
  if (existsSync(repoEnv)) {
    applyDotEnv(repoEnv, env);
    const w = envFilePermissionWarning(repoEnv);
    if (w) warnings.push(w);
  }
  const workspaceEnv = workspaceEnvFile(dir);
  if (workspaceEnv && workspaceEnv !== repoEnv) {
    applyDotEnv(workspaceEnv, env);
    const w = envFilePermissionWarning(workspaceEnv);
    if (w) warnings.push(w);
  }
  const userEnv = userEnvFile(env);
  if (userEnv && userEnv !== repoEnv && existsSync(userEnv)) {
    applyDotEnv(userEnv, env);
    const w = envFilePermissionWarning(userEnv);
    if (w) warnings.push(w);
  }
  return warnings;
}

export type EnvScope = 'repo' | 'workspace' | 'user';

/**
 * The per-user env file: `$XDG_CONFIG_HOME/specguard/.env`, else `~/.config/specguard/.env`. Undefined when the
 * given environment names no home (so a test that passes its own `env` never reads the real one).
 */
export function userEnvFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.HOME ?? env.USERPROFILE;
  const base = env.XDG_CONFIG_HOME || (home ? path.join(home, '.config') : undefined);
  return base ? path.join(base, 'specguard', '.env') : undefined;
}

/** The env file for `scope` as seen from `dir`. `workspaceRoot` names the workspace when it is not an ancestor of `dir`. */
export function envFileFor(scope: EnvScope, dir: string, workspaceRoot?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (scope === 'repo') return path.join(dir, '.specguard', '.env');
  if (scope === 'user') return userEnvFile(env);
  return workspaceRoot ? path.join(workspaceRoot, '.specguard', '.env') : (workspaceEnvFile(dir) ?? undefined);
}

/** Whether `file` defines `name` (never returns the value). */
export function dotEnvDefines(file: string, name: string): boolean {
  try {
    return readFileSync(file, 'utf-8')
      .split('\n')
      .some((raw) => {
        const line = raw.trim();
        const eq = line.indexOf('=');
        return !line.startsWith('#') && eq > 0 && line.slice(0, eq).trim() === name && line.slice(eq + 1).trim() !== '';
      });
  } catch {
    return false;
  }
}

/**
 * Set `name` in the env file `file`, replacing an existing line and keeping the rest. The file is written
 * atomically with mode 600 (its folder 700 when created), because it holds secrets.
 * @throws when the name or value could not be read back as one line.
 */
export function setDotEnvValue(file: string, name: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`"${name}" is not an environment variable name`);
  if (value === '' || /[\r\n\0]/.test(value)) throw new Error('the value must be one non-empty line');
  const dir = path.dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  const lines = existing === '' ? [] : existing.replace(/\n$/, '').split('\n');
  const at = lines.findIndex((l) => {
    const eq = l.indexOf('=');
    return eq > 0 && !l.trim().startsWith('#') && l.slice(0, eq).trim() === name;
  });
  const entry = `${name}=${value}`;
  if (at === -1) lines.push(entry);
  else lines[at] = entry;
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
