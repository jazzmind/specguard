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

/** Spawn the CLI, stream stdout line-by-line via onLine, resolve the exit code. */
export function spawnCli(cliPath: string, args: string[], cwd: string, onLine: (line: string) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const [cmd, cmdArgs] = cliPath.endsWith('.js')
      ? ['node', [cliPath, ...args]]
      : cliPath.endsWith('.ts')
        ? ['npx', ['tsx', cliPath, ...args]]
        : [cliPath, args];
    const proc = cp.spawn(cmd, cmdArgs as string[], { cwd, env: process.env, shell: process.platform === 'win32' });
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
