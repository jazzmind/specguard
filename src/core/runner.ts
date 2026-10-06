/**
 * Resolve how generated MCP wiring and hooks invoke SpecGuard.
 *
 * `npx -p specguard-ai ...` can hang offline or under load, so a local binary
 * is preferred and npx is the last resort.
 *
 * Spec: specs/cli/commands/init.md (runner-resolution)
 */
import fs from 'node:fs';
import path from 'node:path';

export type RunnerKind = 'node' | 'npx' | 'path';

export interface RunnerChoice {
  runner?: RunnerKind;
  /** CLI entry for `--runner path` (a `specguard` executable or a `.js`/`.mjs`/`.ts` entry). */
  runnerPath?: string;
}

export interface ResolvedRunner {
  /** Where the runner came from, for messages. */
  source: 'npx' | 'env' | 'local-bin' | 'node-module' | 'global' | 'path';
  /** Shell prefix that runs the CLI; append ` status` etc. */
  cli: string;
  mcp: { command: string; args: string[] };
  /** One-line explanation for output and the hook comment. */
  comment: string;
}

export const NPX_CLI = 'npx -p specguard-ai specguard';

export const NPX_RUNNER: ResolvedRunner = {
  source: 'npx',
  cli: NPX_CLI,
  mcp: { command: 'npx', args: ['-y', '-p', 'specguard-ai', 'specguard-mcp'] },
  comment: 'npx fallback: no local specguard found (install specguard-ai, or set SPECGUARD_CLI); npx can hang offline or under load',
};

const isFile = (p: string): boolean => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function entryCommand(file: string): { command: string; args: string[] } {
  if (/\.(mjs|cjs|js)$/.test(file)) return { command: 'node', args: [file] };
  if (/\.ts$/.test(file)) return { command: 'node', args: ['--import', 'tsx', file] };
  return { command: file, args: [] };
}

const shell = (c: { command: string; args: string[] }): string => [c.command, ...c.args].join(' ');

/** `<dir>/cli/index.js` -> `<dir>/mcp/server.js`; `<dir>/specguard` -> `<dir>/specguard-mcp`. */
function mcpSibling(cliFile: string): string | undefined {
  const dir = path.dirname(cliFile);
  const base = path.basename(cliFile);
  const ext = path.extname(cliFile);
  const candidates = [
    base === 'index' + ext ? path.join(dir, '..', 'mcp', 'server' + ext) : '',
    path.join(dir, `${base}-mcp`),
  ].filter(Boolean);
  return candidates.map((c) => path.normalize(c)).find(isFile);
}

function fromEntry(source: ResolvedRunner['source'], display: string, mcpDisplay: string | undefined): ResolvedRunner {
  return {
    source,
    cli: shell(entryCommand(display)),
    mcp: mcpDisplay ? entryCommand(mcpDisplay) : NPX_RUNNER.mcp,
    comment: `using ${source === 'env' ? 'SPECGUARD_CLI' : source} (${display})`,
  };
}

function findLocalBin(cwd: string): string | undefined {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 6; i += 1) {
    const bin = path.join(dir, 'node_modules', '.bin', 'specguard');
    if (isFile(bin)) return bin;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function findGlobal(env: NodeJS.ProcessEnv): string | undefined {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir || dir.includes(`${path.sep}node_modules${path.sep}.bin`)) continue;
    const bin = path.join(dir, 'specguard');
    if (isFile(bin)) return bin;
  }
  return undefined;
}

function nodeModuleEntry(cwd: string): string | undefined {
  const file = path.join(cwd, 'node_modules', 'specguard-ai', 'dist', 'cli', 'index.js');
  return isFile(file) ? file : undefined;
}

/**
 * Pick the runner. Explicit `runner` wins; otherwise `SPECGUARD_CLI`,
 * `node_modules/.bin/specguard`, a global `specguard`, then npx.
 * Local paths in the generated files are relative to `cwd` when inside it.
 */
export function resolveRunner(
  cwd: string,
  choice: RunnerChoice = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedRunner {
  const rel = (abs: string): string => {
    const r = path.relative(cwd, abs);
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : abs;
  };

  if (choice.runner === 'npx') return NPX_RUNNER;

  if (choice.runner === 'path') {
    if (!choice.runnerPath) throw new Error('--runner path needs --runner-path <file>');
    const abs = path.resolve(cwd, choice.runnerPath);
    if (!isFile(abs)) throw new Error(`--runner-path ${choice.runnerPath} is not a file`);
    const sib = mcpSibling(abs);
    return fromEntry('path', rel(abs), sib ? rel(sib) : undefined);
  }

  if (choice.runner === 'node') {
    const entry = nodeModuleEntry(cwd);
    if (entry) {
      const sib = mcpSibling(entry);
      return fromEntry('node-module', rel(entry), sib ? rel(sib) : undefined);
    }
    return { ...NPX_RUNNER, comment: `${NPX_RUNNER.comment} (--runner node: node_modules/specguard-ai not installed)` };
  }

  if (env.SPECGUARD_CLI && isFile(path.resolve(cwd, env.SPECGUARD_CLI))) {
    const abs = path.resolve(cwd, env.SPECGUARD_CLI);
    const sib = mcpSibling(abs);
    return fromEntry('env', abs, sib);
  }
  const local = findLocalBin(cwd);
  if (local) {
    const sib = path.join(path.dirname(local), 'specguard-mcp');
    return fromEntry('local-bin', rel(local), isFile(sib) ? rel(sib) : undefined);
  }
  const global = findGlobal(env);
  if (global) {
    const sib = path.join(path.dirname(global), 'specguard-mcp');
    return {
      source: 'global',
      cli: 'specguard',
      mcp: isFile(sib) ? { command: 'specguard-mcp', args: [] } : NPX_RUNNER.mcp,
      comment: `using global specguard (${global})`,
    };
  }
  return NPX_RUNNER;
}
