import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

export async function resolveCliPath(workspaceRoot: string): Promise<string> {
  const cfg = vscode.workspace.getConfiguration('specguard');
  const custom = cfg.get<string>('cliPath', '');
  if (custom) return custom;
  const localBin = path.join(workspaceRoot, 'node_modules', '.bin', 'specguard');
  if (fs.existsSync(localBin)) return localBin;
  const localSrc = path.join(workspaceRoot, 'src', 'cli', 'index.ts');
  return fs.existsSync(localSrc) ? localSrc : localBin;
}

/**
 * Load variables from a `.env`-style file (KEY=VALUE lines, # comments ignored).
 * Returns an object suitable for spreading into `process.env`.
 */
function loadDotEnv(filePath: string): Record<string, string> {
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
  // process.env values take precedence over .env file values, so existing
  // shell env vars are not overwritten.
  return { ...fromFile, ...process.env };
}

/** Spawn the CLI, stream stdout/stderr line-by-line via onLine, resolve the exit code. */
export function spawnCli(cliPath: string, args: string[], cwd: string, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const [cmd, cmdArgs] = cliPath.endsWith('.js')
      ? ['node', [cliPath, ...args]]
      : cliPath.endsWith('.ts')
        ? ['npx', ['tsx', cliPath, ...args]]
        : [cliPath, args];
    const env = buildEnv(cwd);
    const proc = cp.spawn(cmd, cmdArgs as string[], { cwd, env, shell: process.platform === 'win32' });
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
}
