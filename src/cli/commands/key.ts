/**
 * `specguard key set` / `key status`: give SpecGuard the API key its model calls use.
 *
 * `.specguard/config.json` is committed, so it only names the environment variable (`llm.apiKeyEnv`); the key
 * itself lives in a `.env` file that is never committed: the repo's own, the workspace's, or the user's
 * `~/.config/specguard/.env`, which every workspace on the machine shares. The key is read from a hidden prompt,
 * stdin or another environment variable, never from the command line (shell history, `ps`), and is never printed.
 *
 * Spec: specs/capabilities/workspaces.md
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { loadConfig } from '../../core/config.js';
import { dotEnvDefines, envFileFor, setDotEnvValue, type EnvScope } from '../../core/env.js';
import { resolveWorkspaceRoot } from '../../core/workspace.js';
import type { GlobalOpts } from './helpers.js';

const DEFAULT_VAR = 'ANTHROPIC_API_KEY';

interface KeyOpts extends GlobalOpts {
  scope?: string;
  envVar?: string;
  fromEnv?: string;
  workspace?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data.split('\n')[0].trim()));
  });
}

/** Ask on the terminal without echoing what is typed. */
function promptHidden(label: string): Promise<string> {
  return new Promise((resolve) => {
    process.stderr.write(label);
    let value = '';
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(value.trim());
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** The variable the repo's model calls read the key from. */
async function keyVariable(opts: KeyOpts): Promise<string> {
  if (opts.envVar) return opts.envVar;
  const config = await loadConfig(opts.config ?? process.cwd()).catch(() => null);
  return config?.llm.apiKeyEnv ?? DEFAULT_VAR;
}

function workspaceRootFor(opts: KeyOpts): string | undefined {
  const explicit = opts.workspace ?? process.env.SPECGUARD_WORKSPACE;
  return explicit ? (resolveWorkspaceRoot(explicit) ?? undefined) : undefined;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** True when git says `file` is not ignored in its repo (false outside a repo). */
function trackedByGit(file: string): boolean {
  const dir = path.dirname(file);
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8' });
  if (inRepo.status !== 0) return false;
  return spawnSync('git', ['check-ignore', '-q', file], { cwd: dir }).status === 1;
}

export async function keySetCommand(opts: KeyOpts): Promise<void> {
  const scope = (opts.scope ?? 'user') as EnvScope;
  if (!['user', 'workspace', 'repo'].includes(scope)) fail('--scope is one of: user, workspace, repo');
  const name = await keyVariable(opts);
  const file = envFileFor(scope, process.cwd(), workspaceRootFor(opts));
  if (!file) fail(scope === 'workspace' ? 'No workspace found: run inside one, or pass --workspace <workspace.json, folder or .code-workspace>.' : 'Cannot work out where to write the file.');

  let value: string;
  if (opts.fromEnv) value = process.env[opts.fromEnv] ?? '';
  else if (process.stdin.isTTY) value = await promptHidden(`${name} (input hidden): `);
  else value = await readStdin();
  if (!value) fail(opts.fromEnv ? `$${opts.fromEnv} is empty.` : `No key given. Type it at the prompt, pipe it on stdin or use --from-env <VAR>.`);

  try {
    setDotEnvValue(file, name, value);
  } catch (err) {
    fail((err as Error).message);
  }
  process.stdout.write(`Saved ${name} in ${file} (${scope}; mode 600).\n`);
  if (trackedByGit(file)) process.stderr.write(`warning: ${file} is not git-ignored: add it to .gitignore before committing.\n`);
}

export async function keyStatusCommand(opts: KeyOpts): Promise<void> {
  const config = await loadConfig(opts.config ?? process.cwd()).catch(() => null);
  const name = await keyVariable(opts);
  const where: Array<[EnvScope, string | undefined]> = [
    ['repo', envFileFor('repo', process.cwd())],
    ['workspace', envFileFor('workspace', process.cwd(), workspaceRootFor(opts))],
    ['user', envFileFor('user', process.cwd())],
  ];
  process.stdout.write(`model calls: ${config ? `${config.llm.provider} / ${config.llm.model}` : 'no .specguard/config.json here'}\nkey variable: ${name}\n`);
  for (const [scope, file] of where) {
    const state = !file ? 'none found' : dotEnvDefines(file, name) ? 'set' : 'not set';
    process.stdout.write(`  ${scope.padEnd(10)} ${state.padEnd(10)} ${file ?? ''}\n`);
  }
  const present = Boolean(process.env[name]);
  process.stdout.write(`available to SpecGuard now: ${present ? 'yes' : 'no'}${present ? '' : `  (run: specguard key set)`}\n`);
  process.exit(present ? 0 : 1);
}
