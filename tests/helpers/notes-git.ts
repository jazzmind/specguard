import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ProofNote } from '../../src/core/proof-note.js';

/** Run git in `dir` and return trimmed stdout. Throws on failure, so a broken fixture fails loudly. */
export function sh(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

const tmp = (prefix: string): string => mkdtempSync(path.join(os.tmpdir(), prefix));

export interface NotesRepo {
  dir: string;
  /** Write a file and commit it; returns the new commit. */
  commit(rel: string, content: string, message?: string): string;
  head(): string;
  tree(commit?: string): string;
}

/** Point `dir` at a git identity that does not depend on the machine's global config. */
export function configureGit(dir: string): void {
  sh(dir, 'config', 'user.email', 't@example.com');
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'commit.gpgsign', 'false');
}

export function wrapRepo(dir: string): NotesRepo {
  return {
    dir,
    commit(rel, content, message = `edit ${rel}`) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      sh(dir, 'add', '-A');
      sh(dir, 'commit', '-q', '-m', message);
      return sh(dir, 'rev-parse', 'HEAD');
    },
    head: () => sh(dir, 'rev-parse', 'HEAD'),
    tree: (commit = 'HEAD') => sh(dir, 'rev-parse', `${commit}^{tree}`),
  };
}

/** A fresh repo on branch `main` with one commit. */
export function newRepo(): NotesRepo {
  const dir = tmp('sg-notes-');
  sh(dir, 'init', '-q', '-b', 'main');
  configureGit(dir);
  const repo = wrapRepo(dir);
  repo.commit('README.md', 'x\n', 'base');
  return repo;
}

/** An empty bare repository to act as the remote. */
export function bareRemote(): string {
  const dir = tmp('sg-remote-');
  sh(dir, 'init', '-q', '--bare', '-b', 'main');
  return dir;
}

export function addRemote(repo: NotesRepo, remote: string, name = 'origin'): void {
  sh(repo.dir, 'remote', 'add', name, remote);
}

/** A clone of `remote`; `depth` makes it shallow (through file://, which git needs for --depth). */
export function cloneOf(remote: string, opts: { depth?: number } = {}): NotesRepo {
  const dir = tmp('sg-clone-');
  if (opts.depth) sh(os.tmpdir(), 'clone', '-q', '--depth', String(opts.depth), `file://${remote}`, dir);
  else sh(os.tmpdir(), 'clone', '-q', remote, dir);
  configureGit(dir);
  return wrapRepo(dir);
}

export const hex = (c: string, n = 40): string => c.repeat(n);

/** A valid proof note for `commit` with one proven row. Override any field. */
export function testNote(commit: string, over: Partial<ProofNote> = {}): ProofNote {
  return {
    schema: 'specguard.proof-note',
    version: 1,
    commit,
    tree: hex('b'),
    parents: [],
    createdAt: '2026-10-25T00:00:00.000Z',
    tool: { specguard: '0.6.0', node: '22.0.0', hashVersion: 1 },
    ci: { provider: 'github', event: 'push', repo: 'o/r', runId: '1' },
    files: { 'src/cart.ts': hex('d', 64) },
    rows: [
      {
        claim: 'capabilities/cart#fee',
        layer: 'unit',
        verdict: 'proven',
        runId: 'run-1',
        specHash: hex('f', 64),
        hashVersion: 1,
        files: ['src/cart.ts'],
        exercised: 2,
        counterexamples: 0,
        provedAt: commit,
        ingestedAt: '2026-10-25T00:00:00.000Z',
      },
    ],
    approvals: [],
    countersigns: [],
    statement: { level: 'certified', counts: { certified: 1, provisional: 0, 'not-certified': 0, planned: 0 }, capabilities: [] },
    changes: [],
    ...over,
  };
}
