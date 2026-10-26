import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { gitInit, SYSTEM_SPEC, AUTH_SPEC, makeV2Repo } from './v2-repo.js';
import { makeRepo, type TmpRepo } from './repo.js';

/** A proof ledger row; `origin` left out reads as "claims no origin" (rows written before provenance existed). */
export function ledgerRow(claim: string, origin?: 'ci' | 'local'): Record<string, unknown> {
  return {
    claim,
    verdict: 'proven',
    runId: 'run-1',
    specHash: 'h',
    fileHashes: {},
    exercised: 1,
    counterexamples: 0,
    ingestedAt: '2026-01-01T00:00:00.000Z',
    ...(origin ? { origin } : {}),
  };
}

export function ledgerText(rows: Array<Record<string, unknown>>): string {
  return `${JSON.stringify({ version: 1, proofs: Object.fromEntries(rows.map((r) => [r.claim as string, r])) }, null, 2)}\n`;
}

/**
 * A v0.2/0.3-style repository, committed: capability specs, a tracked proof ledger (one row claiming CI, one with no
 * origin, one local) and a tracked trace file. The seed's empty per-file spec file stays, as a stray note would.
 */
export function makeV02Repo(): TmpRepo {
  const repo = makeV2Repo();
  repo.write('.specguard/proofs.json', ledgerText([ledgerRow('capabilities/auth#login-valid-code', 'ci'), ledgerRow('capabilities/auth#logout-clears-session'), ledgerRow('capabilities/shop#cart-totals', 'local')]));
  repo.write('.specguard/trace.json', '{}\n');
  gitInit(repo.dir);
  return repo;
}

const V1_USERS = `# Users

<!--
  module: src/users.ts
  type: core
-->

## Overview

Users.

## Acceptance Criteria

- [ ] Users can be listed <!-- claim: list-users -->
`;

/** A v0.1-style repository, committed: per-file specs (two), a tracked ledger keyed to them, and no capability specs. */
export function makeV01Repo(): TmpRepo {
  const repo = makeRepo();
  repo.write('specs/api/users.md', V1_USERS);
  repo.write('src/users.ts', 'export const users = 1;\n');
  repo.write('tests/awards.test.ts', "it('awards once', () => {});\n");
  repo.write('.specguard/proofs.json', ledgerText([ledgerRow('core/awards#award-once', 'ci'), ledgerRow('api/users#list-users', 'ci'), ledgerRow('capabilities/auth#login-valid-code', 'ci')]));
  gitInit(repo.dir);
  return repo;
}

/** What a host agent leaves after `spec draft`: a system spec and one capability spec. */
export function draftCapabilities(repo: TmpRepo): void {
  repo.write('specs/system.md', SYSTEM_SPEC);
  repo.write('specs/capabilities/auth.md', AUTH_SPEC);
  repo.write('src/auth/login.ts', 'export const login = 1;\n');
  repo.write('tests/auth.test.ts', "it('logs in', () => {});\n");
}

export const git = (dir: string, ...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

/** One hash of every file under `dir` (except `.git`), plus the index and the status: equal hashes mean nothing changed. */
export function treeHash(dir: string, sub = '.'): string {
  const hash = createHash('sha256');
  const walk = (rel: string): void => {
    for (const name of readdirSync(path.join(dir, rel)).sort()) {
      if (name === '.git') continue;
      const r = path.join(rel, name);
      if (statSync(path.join(dir, r)).isDirectory()) walk(r);
      else hash.update(`${r}\0${readFileSync(path.join(dir, r), 'utf8')}\0`);
    }
  };
  walk(sub);
  return hash.digest('hex');
}

/** `treeHash` plus the git index and status, for the whole repository. */
export function repoHash(dir: string): string {
  let extra = '';
  try {
    extra = git(dir, 'ls-files', '-s') + git(dir, 'status', '--porcelain=v1', '-uall');
  } catch {
    /* not a git repository */
  }
  return createHash('sha256').update(treeHash(dir)).update(extra).digest('hex');
}
