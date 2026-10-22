/**
 * The local fallback: a `specguard serve` child process on an ephemeral port, serving this workspace's working tree
 * through the same API a team server does.
 */
import { nodeRuntime, planSpawn, type SpawnPlan } from '../safe-spawn.js';
import * as cp from 'child_process';

const SERVING = /specguard serving (https?:\/\/\S+)/;

export interface LocalServerHandle {
  url: string;
  dispose(): void;
}

/**
 * Start `serve --port 0` with the given CLI and resolve with its address, read from the line it prints. Rejects if it
 * exits first or says nothing within `timeoutMs`.
 */
export function startLocalServer(cliPath: string, cwd: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 20_000): Promise<LocalServerHandle> {
  return new Promise((resolve, reject) => {
    if (!cliPath) return reject(new Error('no SpecGuard command line was found to serve this workspace'));
    let plan: SpawnPlan;
    try {
      plan = planSpawn(cliPath, ['serve', '--port', '0'], { node: nodeRuntime().command });
    } catch (err) {
      return reject(err);
    }
    // No shell: see `planSpawn`.
    // nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
    const child = cp.spawn(plan.command, plan.args, { cwd, env: { ...env, ...nodeRuntime().env }, stdio: ['ignore', 'pipe', 'pipe'], ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}) });
    let settled = false;
    let output = '';
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      done(() => {
        child.kill();
        reject(new Error(`the local SpecGuard server did not start within ${timeoutMs / 1000}s${output ? `: ${output.trim().slice(-300)}` : ''}`));
      });
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      const match = SERVING.exec(output);
      if (match) done(() => resolve({ url: match[1].replace(/\/+$/, ''), dispose: () => void child.kill() }));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (err) => done(() => reject(err)));
    child.on('exit', (code) => done(() => reject(new Error(`the local SpecGuard server exited (${code})${output ? `: ${output.trim().slice(-300)}` : ''}`))));
  });
}
