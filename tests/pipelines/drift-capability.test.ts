import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/llm.js', () => ({ llmGenerateObject: vi.fn(), llmGenerateText: vi.fn() }));

import { loadConfig } from '../../src/core/config.js';
import { llmGenerateObject } from '../../src/core/llm.js';
import { runDrift } from '../../src/pipelines/drift.js';
import { chunkChanges, reduceDiff } from '../../src/pipelines/drift-capability.js';
import { ingestVerdicts, walkClaimVerdicts } from '../../src/pipelines/proof.js';
import { gitInit, makeV2Repo } from '../helpers/v2-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

const mocked = llmGenerateObject as unknown as ReturnType<typeof vi.fn>;

const verdict = (over: Record<string, unknown> = {}) => ({
  drifted: true,
  confidence: 0.9,
  reason: 'login now requires a second factor',
  affectedClaims: ['login-valid-code'],
  unspecifiedBehaviour: [],
  ...over,
});

const LOGIN = 'capabilities/auth#login-valid-code';
const LOGOUT = 'capabilities/auth#logout-clears-session';

async function proofs(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await walkClaimVerdicts(await loadConfig(dir), (ref, v) => {
    out[ref.split(':').pop() as string] = v;
  });
  return out;
}

let repo: TmpRepo;

beforeEach(async () => {
  mocked.mockReset();
  repo = makeV2Repo();
  repo.write('.gitignore', '.specguard/\n');
  gitInit(repo.dir);
  // Baseline the registry, then prove both auth claims against the current code.
  await runDrift(await loadConfig(repo.dir), {});
  await ingestVerdicts(
    { runId: 'r1', verdicts: [{ claim: LOGIN, verdict: 'proven', exercised: 1 }, { claim: LOGOUT, verdict: 'proven', exercised: 1 }] },
    repo.dir,
  );
});

describe('chunking [drift-chunks]', () => {
  // [claims: capabilities/traceability-and-drift#drift-chunking]
  it('reduces an oversized diff to headers and declarations [reduce-diff]', () => {
    const diff = ['@@ -1,3 +1,3 @@', '-const a = 1;', '+const a = 2;', '+export function login() {}', ...Array(500).fill('+  body();')].join('\n');
    const out = reduceDiff(diff, 200);
    expect(out).toContain('@@ -1,3 +1,3 @@');
    expect(out).toContain('+export function login() {}');
    expect(out).not.toContain('body();');
  });

  // [claims: capabilities/traceability-and-drift#drift-chunking]
  it('packs files into budgeted chunks, interface files first, and reports overflow [pack]', () => {
    const files = ['src/z/util.ts', 'src/api/route.ts', 'src/a/lib.ts', 'src/b/lib.ts'].map((p) => ({ path: p, diff: 'x'.repeat(60) }));
    const { chunks, overflow } = chunkChanges(files, 100, 2);
    expect(chunks[0][0].path).toBe('src/api/route.ts');
    expect(chunks).toHaveLength(2);
    expect(chunks.map((c) => c.map((f) => f.path))).toEqual([['src/api/route.ts'], ['src/a/lib.ts']]);
    expect(overflow).toEqual(['src/b/lib.ts', 'src/z/util.ts']);
  });
});

describe('capability drift [drift-capability]', () => {
  // [claims: capabilities/traceability-and-drift#capability-drift-assessments, capabilities/traceability-and-drift#claim-scoped-file-staleness]
  it('without a drift run, a changed owned file stales every claim of the capability [unassessed]', async () => {
    expect(await proofs(repo.dir)).toMatchObject({ [LOGIN]: 'proven', [LOGOUT]: 'proven' });
    writeFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'export const login = 2;\n');
    expect(await proofs(repo.dir)).toMatchObject({ [LOGIN]: 'stale', [LOGOUT]: 'stale' });
  });

  // [claims: capabilities/traceability-and-drift#capability-drift-assessments, capabilities/traceability-and-drift#planned-capability-drift]
  it('stales only the claims the change affects, one model call for the capability [claim-level]', async () => {
    writeFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'export const login = 2; // second factor\n');
    mocked.mockResolvedValue(verdict());
    const r = await runDrift(await loadConfig(repo.dir), {});
    expect(r.exitCode).toBe(3);
    expect(r.messages.join('\n')).toContain('[drift] auth: affects login-valid-code');
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0][0].prompt).toContain('login-valid-code: Login succeeds with a valid code');
    expect(mocked.mock.calls[0][0].prompt).toContain('Only approved people sign in.');
    expect(await proofs(repo.dir)).toMatchObject({ [LOGIN]: 'stale', [LOGOUT]: 'proven' });
  });

  // [claims: capabilities/traceability-and-drift#capability-drift-assessments]
  it('keeps proofs when the change affects no requirement [unaffected]', async () => {
    writeFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'export const login = 1; // renamed nothing, comment only\n');
    mocked.mockResolvedValue(verdict({ drifted: false, affectedClaims: [], reason: 'comment only' }));
    const r = await runDrift(await loadConfig(repo.dir), {});
    expect(r.exitCode).toBe(0);
    expect(await proofs(repo.dir)).toMatchObject({ [LOGIN]: 'proven', [LOGOUT]: 'proven' });
  });

  // [claims: capabilities/traceability-and-drift#capability-drift-assessments]
  it('assumes every claim is affected when no verdict can be obtained [no-verdict]', async () => {
    writeFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'export const login = 3;\n');
    mocked.mockRejectedValue(new Error('provider down'));
    const r = await runDrift(await loadConfig(repo.dir), {});
    expect(r.exitCode).toBe(3);
    expect(await proofs(repo.dir)).toMatchObject({ [LOGIN]: 'stale', [LOGOUT]: 'stale' });
  });

  // [claims: capabilities/traceability-and-drift#capability-drift-assessments]
  it('is idempotent: a second run with no new changes makes no model calls [idempotent]', async () => {
    writeFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'export const login = 4;\n');
    mocked.mockResolvedValue(verdict());
    await runDrift(await loadConfig(repo.dir), {});
    mocked.mockClear();
    const r = await runDrift(await loadConfig(repo.dir), {});
    expect(mocked).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(0);
  });

  // [claims: capabilities/traceability-and-drift#drift-exit-and-orphans]
  it('surfaces unspecified behaviour and changes to files no capability owns [gaps-from-drift]', async () => {
    writeFileSync(path.join(repo.dir, 'src/auth/logout.ts'), 'export const logout = 2; export const exportAll = () => {};\n');
    writeFileSync(path.join(repo.dir, 'src/orphan.ts'), 'export const orphan = 2;\n');
    mocked.mockResolvedValue(verdict({ drifted: false, affectedClaims: [], unspecifiedBehaviour: ['bulk export of sessions'] }));
    const r = await runDrift(await loadConfig(repo.dir), {});
    const text = r.messages.join('\n');
    expect(text).toContain('unspecified behaviour: bulk export of sessions');
    expect(text).toContain('[unowned-change] src/orphan.ts');
    expect(r.exitCode).toBe(3);
  });

  // [claims: capabilities/traceability-and-drift#capability-drift-assessments]
  it('ignores claim ids the model invented and treats the change as affecting every claim [invented-ids]', async () => {
    writeFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'export const login = 5;\n');
    mocked.mockResolvedValue(verdict({ affectedClaims: ['auth-flow', 'capabilities/auth#nothing-here'] }));
    const r = await runDrift(await loadConfig(repo.dir), {});
    expect(r.exitCode).toBe(3);
    expect(await proofs(repo.dir)).toMatchObject({ [LOGIN]: 'stale', [LOGOUT]: 'stale' });
  });

  // [claims: capabilities/traceability-and-drift#capability-drift-assessments]
  it('accepts a claim named as spec#id and keeps the others proven [ref-form-ids]', async () => {
    writeFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'export const login = 6;\n');
    mocked.mockResolvedValue(verdict({ affectedClaims: [LOGIN] }));
    await runDrift(await loadConfig(repo.dir), {});
    expect(await proofs(repo.dir)).toMatchObject({ [LOGIN]: 'stale', [LOGOUT]: 'proven' });
  });

  // [claims: capabilities/traceability-and-drift#claim-scoped-file-staleness]
  it('a later "unaffected" assessment does not clear an earlier "affects this claim" one [assessment-chain]', async () => {
    writeFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'export const login = 7; // second factor\n');
    mocked.mockResolvedValue(verdict());
    await runDrift(await loadConfig(repo.dir), {});
    expect(await proofs(repo.dir)).toMatchObject({ [LOGIN]: 'stale' });
    writeFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'export const login = 7; // second factor, tidied\n');
    mocked.mockResolvedValue(verdict({ drifted: false, affectedClaims: [], reason: 'comment only' }));
    await runDrift(await loadConfig(repo.dir), {});
    // The proof predates the behavioural change; tidying afterwards does not re-prove it.
    expect(await proofs(repo.dir)).toMatchObject({ [LOGIN]: 'stale', [LOGOUT]: 'proven' });
  });

  // [claims: capabilities/traceability-and-drift#capability-drift-assessments]
  it('sends changes under src/build/ to the model, because only top-level build output is skipped [real-source-build-dir]', async () => {
    repo.write('specs/capabilities/shop.md', readFileSync(path.join(repo.dir, 'specs/capabilities/shop.md'), 'utf8').replace('  - "src/shop/**"', '  - "src/shop/**"\n  - "src/build/**"'));
    repo.write('src/build/plan.ts', 'export const plan = 1;\n');
    mocked.mockResolvedValue(verdict({ drifted: false, affectedClaims: [] }));
    await runDrift(await loadConfig(repo.dir), {});
    mocked.mockClear();
    writeFileSync(path.join(repo.dir, 'src/build/plan.ts'), 'export const plan = 2;\n');
    await runDrift(await loadConfig(repo.dir), {});
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  // [claims: capabilities/traceability-and-drift#capability-drift-assessments]
  it('skips lockfile-style files without a model call [ignored-files]', async () => {
    const config = await loadConfig(repo.dir);
    repo.write('specs/capabilities/shop.md', readFileSync(path.join(repo.dir, 'specs/capabilities/shop.md'), 'utf8').replace('  - "src/shop/**"', '  - "src/shop/**"\n  - "package-lock.json"'));
    await runDrift(config, {});
    mocked.mockClear();
    writeFileSync(path.join(repo.dir, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
    const r = await runDrift(await loadConfig(repo.dir), {});
    expect(mocked).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(0);
  });
});
