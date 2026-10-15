/**
 * Loads `.specguard/.env` into the process environment so secrets are available even when the user has not
 * exported them in their shell.
 *
 * Precedence, highest first: the real environment, the repo's own `.specguard/.env`, then the workspace's.
 * Existing variables are never overwritten.
 *
 * Spec: specs/capabilities/workspaces.md
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

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
export function loadSpecGuardEnv(dir: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  const repoEnv = path.join(dir, '.specguard', '.env');
  if (existsSync(repoEnv)) applyDotEnv(repoEnv, env);
  const workspaceEnv = workspaceEnvFile(dir);
  if (workspaceEnv && workspaceEnv !== repoEnv) applyDotEnv(workspaceEnv, env);
}
