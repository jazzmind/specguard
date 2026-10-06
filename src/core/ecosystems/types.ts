/**
 * Ecosystem adapter contract, the injectable command runner, and shared errors.
 *
 * Spec: specs/core/ecosystems.md
 */
import { spawn } from 'node:child_process';

import type { Advisory, Candidate } from '../advisory.js';

export type EcosystemId = 'npm' | 'pnpm' | 'yarn' | 'pip' | 'poetry' | 'uv' | 'go' | 'cargo' | 'maven' | 'gradle';

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** Exit status; null when the process could not start or was killed. */
  status: number | null;
  /** `ENOENT` when the tool is not installed, `TIMEOUT` when it was killed. */
  error?: 'ENOENT' | 'TIMEOUT' | string;
}

export interface CommandOpts {
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** Every external command goes through this seam so tests can return canned output. */
export type CommandRunner = (cmd: string, args: string[], opts: CommandOpts) => Promise<CommandResult>;

export const defaultRunner: CommandRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: CommandResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      done({ stdout, stderr: String(err), status: null, error: 'ENOENT' });
      return;
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
          done({ stdout, stderr, status: null, error: 'TIMEOUT' });
        }, opts.timeoutMs)
      : undefined;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (timer) clearTimeout(timer);
      done({ stdout, stderr: err.message, status: null, error: err.code === 'ENOENT' ? 'ENOENT' : err.message });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      done({ stdout, stderr, status: code });
    });
  });

export class ToolNotInstalledError extends Error {
  constructor(
    public readonly tool: string,
    public readonly hint: string,
  ) {
    super(`${tool} is not installed. ${hint}`);
    this.name = 'ToolNotInstalledError';
  }
}

/** Run a command and throw ToolNotInstalledError when the binary is missing. */
export async function runTool(
  run: CommandRunner,
  tool: string,
  args: string[],
  opts: CommandOpts,
  hint: string,
): Promise<CommandResult> {
  const res = await run(tool, args, opts);
  if (res.error === 'ENOENT') throw new ToolNotInstalledError(tool, hint);
  return res;
}

export interface InstallResult {
  ok: boolean;
  output: string;
}

export interface EcosystemAdapter {
  id: EcosystemId;
  /** OSV ecosystem name, e.g. `npm`, `PyPI`, `Go`, `crates.io`, `Maven`. */
  osvEcosystem: string;
  detect(repo: string): boolean;
  /** Lockfile names this ecosystem uses (relative to the repo). */
  lockfiles(): string[];
  /** Manifest names this ecosystem uses (relative to the repo). */
  manifests(): string[];
  /** Native audit. Throws ToolNotInstalledError when the audit tool is missing. */
  audit(repo: string): Promise<Advisory[]>;
  /** Fix candidates for an advisory, smallest bump first. */
  resolveFix(advisory: Advisory): Candidate[];
  /** Edit manifests (or run the ecosystem's own pin command). Returns repo-relative changed files. */
  apply(repo: string, candidate: Candidate): Promise<string[]>;
  /** Make the working copy match the manifests: refresh the lockfile and installed packages. */
  install(repo: string): Promise<InstallResult>;
  /** Hash of the lockfiles and manifests. */
  fingerprint(repo: string): string;
}
