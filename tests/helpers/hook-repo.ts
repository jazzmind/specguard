import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { testFilesHash } from '../../src/core/change-stage.js';
import { serializeChangeRecord, type ChangeKind } from '../../src/core/change-record.js';
import type { EnforceLevel } from '../../src/core/types.js';
import { gitInit, makeV2Repo } from './v2-repo.js';
import type { TmpRepo } from './repo.js';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
/** The committed bundle the plugin runs: the tests spawn exactly that file. */
export const BUNDLE = path.join(ROOT, 'plugins', 'specguard', 'hooks', 'dist', 'specguard-hook.mjs');

export const CHANGE_ID = '20261025-cart-totals-a1b2';

/** A v2 repo (auth, shop) whose shop capability sits at `level` and auth at `auth`, committed so changes have a base. */
export function hookRepo(opts: { shop?: EnforceLevel; auth?: EnforceLevel; config?: Record<string, unknown> } = {}): TmpRepo {
  const repo = makeV2Repo(opts.config ?? {});
  const setLevel = (rel: string, level: EnforceLevel | undefined): void => {
    if (!level) return;
    const file = path.join(repo.dir, rel);
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: active', `status: active\nenforce: ${level}`));
  };
  setLevel('specs/capabilities/shop.md', opts.shop);
  setLevel('specs/capabilities/auth.md', opts.auth);
  repo.write('tests/shop.test.ts', "it('totals @claim:capabilities/shop#cart-totals', () => {});\n");
  gitInit(repo.dir);
  return repo;
}

export function writeChange(repo: TmpRepo, kind: ChangeKind = 'feature', id = CHANGE_ID, capabilities = ['shop']): string {
  return repo.write(
    `.specguard/changes/${id}.json`,
    serializeChangeRecord({ version: 1, id, kind, capabilities, why: 'test', createdAt: '2026-10-25T00:00:00.000Z', createdBy: 'tester', baseRef: 'HEAD', plans: [] }),
  );
}

/** A red record whose test hash matches the files' current content. */
export function writeRed(repo: TmpRepo, files: string[], id = CHANGE_ID): void {
  const hashed = files.map((f) => ({ path: f, sha256: createHash('sha256').update(readFileSync(path.join(repo.dir, f))).digest('hex') }));
  repo.write(
    `.specguard/cache/changes/${id}/red.json`,
    JSON.stringify({
      version: 1,
      changeId: id,
      runId: 'r1',
      at: '2026-10-25T00:00:00.000Z',
      mode: 'working-tree',
      claimsHash: 'c',
      testsHash: testFilesHash(hashed),
      ownedHash: 'same',
      baseOwnedHash: 'same',
      tests: files.map((f) => ({ id: `${f}::totals`, claims: ['capabilities/shop#cart-totals'], status: 'fail' })),
      origin: 'local',
    }),
  );
}

export interface Payload {
  tool: string;
  input: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/** Claude Code's PreToolUse payload. */
export function claudePayload(repo: TmpRepo, p: Payload): string {
  return JSON.stringify({ session_id: 's-1', cwd: repo.dir, hook_event_name: 'PreToolUse', tool_name: p.tool, tool_input: p.input, tool_use_id: 't-1', ...p.extra });
}

export const editOf = (repo: TmpRepo, rel: string): string =>
  claudePayload(repo, { tool: 'Edit', input: { file_path: path.join(repo.dir, rel), old_string: 'a', new_string: 'b' } });

export interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  json?: { hookSpecificOutput: Record<string, unknown> };
  ms: number;
}

/** Spawn the committed bundle as a real process, as the host would. */
export function runBundle(stdin: string, opts: { cwd?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {}): Ran {
  const started = performance.now();
  const r = spawnSync(process.execPath, [BUNDLE, ...(opts.args ?? ['pre-tool-use'])], { input: stdin, encoding: 'utf8', cwd: opts.cwd, timeout: 20_000, env: opts.env ?? { PATH: process.env.PATH ?? '' } });
  const ms = performance.now() - started;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, ms, ...(r.stdout.trim() ? { json: JSON.parse(r.stdout) as Ran['json'] } : {}) };
}

export function readLog(repo: TmpRepo): Array<Record<string, unknown>> {
  try {
    return readFileSync(path.join(repo.dir, '.specguard', 'cache', 'hooks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}
