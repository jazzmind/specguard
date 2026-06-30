import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

/** Extension directory — set once on activate so the CLI resolver can find the bundled source. */
let _extensionPath: string | undefined;

export function setExtensionPath(extPath: string): void {
  _extensionPath = extPath;
}

/**
 * Resolve the path to the specguard CLI for the given workspace root.
 *
 * Priority:
 *  1. `specguard.cliPath` VS Code setting (explicit override)
 *  2. `{workspace}/node_modules/.bin/specguard` (local npm install in the project)
 *  3. `{workspace}/src/cli/index.ts` (dev: the workspace IS the specguard source repo)
 *  4. `{extensionPath}/dist/cli.js` (bundled CLI baked into every extension build — always available)
 *
 * NOTE: `npx specguard` is intentionally NOT used as a fallback. There is an
 * unrelated npm package named `specguard@0.2.1` that would be fetched instead,
 * causing "unknown command" errors for import, status, reverse, etc.
 */
export async function resolveCliPath(workspaceRoot: string): Promise<string> {
  const cfg = vscode.workspace.getConfiguration('specguard');
  const custom = cfg.get<string>('cliPath', '');
  if (custom) return custom;

  // 2. Local npm install inside the target project
  const localBin = path.join(workspaceRoot, 'node_modules', '.bin', 'specguard');
  if (fs.existsSync(localBin)) return localBin;

  // 3. Dev: the workspace IS the specguard source repo
  const localSrc = path.join(workspaceRoot, 'src', 'cli', 'index.ts');
  if (fs.existsSync(localSrc)) return localSrc;

  // 4. Bundled CLI — always present in the installed extension's dist/
  if (_extensionPath) {
    const bundledCli = path.join(_extensionPath, 'dist', 'cli.js');
    if (fs.existsSync(bundledCli)) return bundledCli;
  }

  // Nothing found — caller will surface an actionable error
  return '';
}

/**
 * Load variables from a `.env`-style file (KEY=VALUE lines, # comments ignored).
 * Returns an object suitable for spreading into `process.env`.
 */
export function loadDotEnv(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
    const vars: Record<string, string> = {};
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (key) vars[key] = val;
    }
    return vars;
  } catch {
    return {};
  }
}

/**
 * Build the environment for spawned CLI processes.
 * Merges process.env with variables from `.specguard/.env` in the workspace,
 * so ANTHROPIC_API_KEY and similar secrets are available even when VS Code
 * was launched without them in the shell environment.
 */
function buildEnv(workspaceRoot: string): NodeJS.ProcessEnv {
  const dotEnvPath = path.join(workspaceRoot, '.specguard', '.env');
  const fromFile = loadDotEnv(dotEnvPath);
  // process.env values take precedence over .env file values.
  return { ...fromFile, ...process.env };
}

/**
 * Handle returned by spawnCli — holds the exit-code promise and a kill()
 * function that terminates the child process immediately.
 */
export interface SpawnHandle {
  /** Resolves with the exit code when the process finishes (or is killed). */
  promise: Promise<number>;
  /** Terminate the child process. The promise resolves with exit code -1. */
  kill: () => void;
}

/**
 * Spawn the CLI and stream stdout/stderr line-by-line via onLine.
 * Returns a SpawnHandle so callers can cancel the run mid-flight.
 */
export function spawnCli(cliPath: string, args: string[], cwd: string, onLine: (line: string) => void): SpawnHandle {
  if (!cliPath) {
    // No CLI found — return a fake handle that immediately rejects so the caller
    // can surface an actionable error message to the user.
    const promise = Promise.reject(new Error(
      'SpecGuard CLI not found.\n' +
      'Options:\n' +
      '  • Set "specguard.cliPath" in VS Code settings to point to the bundled CLI\n' +
      '  • Or run `npm install specguard` in your project to install it locally',
    ));
    return { promise: promise.catch((e: unknown) => { throw e; }), kill: () => {} };
  }

  const [cmd, cmdArgs, useShell] = cliPath.endsWith('.js')
    ? ['node', [cliPath, ...args], false] as const
    : cliPath.endsWith('.ts')
      ? ['npx', ['tsx', cliPath, ...args], true] as const
      : [cliPath, args, false] as const;

  const env = buildEnv(cwd);
  const proc = cp.spawn(cmd, cmdArgs as string[], { cwd, env, shell: useShell || process.platform === 'win32' });

  const promise = new Promise<number>((resolve, reject) => {
    let buf = '';
    const flush = (chunk: string) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) onLine(l);
    };
    proc.stdout.on('data', (d: Buffer) => flush(d.toString()));
    proc.stderr.on('data', (d: Buffer) => flush(d.toString()));
    proc.on('close', (code) => { if (buf) onLine(buf); resolve(code ?? 0); });
    proc.on('error', reject);
  });

  const kill = () => {
    try { proc.kill('SIGTERM'); } catch { /* already exited */ }
  };

  return { promise, kill };
}
