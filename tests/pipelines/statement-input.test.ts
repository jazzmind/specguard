import { readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { assessmentKey, saveAssessments } from '../../src/core/drift-assessments.js';
import { hashFile } from '../../src/core/drift-registry.js';
import { loadConfig } from '../../src/core/config.js';
import type { CapabilityInput, ClaimInput } from '../../src/core/proof-statement.js';
import { runSpecApprove } from '../../src/pipelines/approve.js';
import { loadTrace } from '../../src/pipelines/check.js';
import { runCoverageIngest } from '../../src/pipelines/coverage-ingest.js';
import { runMutationIngest } from '../../src/pipelines/mutation-ingest.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import { buildStatementInput, type StatementInputOpts } from '../../src/pipelines/statement-input.js';
import { AUTH_SPEC, gitInit, makeV2Repo } from '../helpers/v2-repo.js';
import type { TmpRepo } from '../helpers/repo.js';

// Counts reads of test files, to show each is read once however many capabilities cite it.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const LOGIN = 'capabilities/auth#login-valid-code';
const LOGOUT = 'capabilities/auth#logout-clears-session';
const STRONG = "// [claims: capabilities/auth#login-valid-code]\nit('logs in', () => { expect(1 + 1).toBe(2); });\n// [claims: capabilities/auth#logout-clears-session]\nit('logs out', () => { expect(2 + 2).toBe(4); });\n";

async function assemble(repo: TmpRepo, opts: StatementInputOpts = {}) {
  const config = await loadConfig(repo.dir);
  const { model } = await loadTrace(config);
  return buildStatementInput(config, { model }, { generated: '2026-10-25T00:00:00.000Z', ...opts });
}
const cap = async (repo: TmpRepo, id: string, opts: StatementInputOpts = {}) => {
  const built = await assemble(repo, opts);
  return { ...built, cap: built.input.capabilities.find((c) => c.id === id)! };
};
const claim = (c: CapabilityInput, ref: string): ClaimInput => c.claims.find((x) => x.ref === ref)!;

describe('statement input: approvals and testability [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#statement-input-assembly]
  it('names the approval of each claim at its current wording, and the older approval of an edited one', async () => {
    const repo = makeV2Repo();
    await runSpecApprove(await loadConfig(repo.dir), { all: true, yes: true, by: 'Ada', actor: { agent: false, tty: true } });
    const now = (await cap(repo, 'auth')).cap;
    expect(now.approvalsInUse).toBe(true);
    expect(claim(now, LOGIN).approval).toMatchObject({ method: 'command', by: 'Ada' });
    expect(claim(now, LOGIN).lastApprovedHash).toBeUndefined();

    repo.write('specs/capabilities/auth.md', AUTH_SPEC.replace('Login succeeds with a valid code', 'Login succeeds with a valid one-time code'));
    const edited = (await cap(repo, 'auth')).cap;
    expect(claim(edited, LOGIN).approval).toBeUndefined();
    expect(claim(edited, LOGIN).lastApprovedHash).toMatch(/^[0-9a-f]{16}$/);
    expect(claim(edited, LOGOUT).approval).toBeDefined();
  });

  // [claims: capabilities/traceability-and-drift#statement-input-assembly]
  it('reports no approvals in use for a repo that has none, and lints each claim with the project config', async () => {
    const repo = makeV2Repo();
    repo.write('specs/capabilities/auth.md', AUTH_SPEC.replace('Login succeeds with a valid code', 'Login works properly'));
    const { cap: auth } = await cap(repo, 'auth');
    expect(auth.approvalsInUse).toBe(false);
    expect(claim(auth, LOGIN).testability.testable).toBe(false);
    expect(claim(auth, LOGIN).testability.findings.map((f) => f.rule)).toContain('T-VAGUE');
    expect(claim(auth, LOGOUT).testability.testable).toBe(true);

    const relaxed = makeV2Repo({ testability: { rules: { 'T-VAGUE': 'warn' } } });
    relaxed.write('specs/capabilities/auth.md', AUTH_SPEC.replace('Login succeeds with a valid code', 'Login works properly'));
    expect(claim((await cap(relaxed, 'auth')).cap, LOGIN).testability.testable).toBe(true);
  });
});

describe('statement input: test strength [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#statement-input-assembly]
  it('grades the tests tagged to each claim: weak, skipped and strong', async () => {
    const repo = makeV2Repo();
    repo.write(
      'tests/auth.test.ts',
      "// [claims: capabilities/auth#login-valid-code]\nit('logs in', () => {});\n// [claims: capabilities/auth#logout-clears-session]\nit.skip('logs out', () => { expect(1).toBe(1); });\n",
    );
    const { cap: auth } = await cap(repo, 'auth');
    expect(claim(auth, LOGIN).strength).toMatchObject({ meaningful: false, reasons: [{ code: 'WEAK_ONLY' }] });
    expect(claim(auth, LOGOUT).strength).toMatchObject({ meaningful: false, reasons: [{ code: 'ALL_SKIPPED' }] });

    repo.write('tests/auth.test.ts', STRONG);
    const strong = (await cap(repo, 'auth')).cap;
    expect(claim(strong, LOGIN).strength?.meaningful).toBe(true);
    // A claim no test is tagged to has an empty analysis, not an absent one.
    expect(claim((await cap(repo, 'shop')).cap, 'capabilities/shop#cart-totals').strength?.reasons).toEqual([{ code: 'NO_TAGGED_TESTS' }]);
  });

  // [claims: capabilities/traceability-and-drift#statement-input-assembly]
  it('treats a test that skipped in the proving run as skipped whatever the source says', async () => {
    const repo = makeV2Repo();
    repo.write('tests/auth.test.ts', STRONG);
    const { cap: auth } = await cap(repo, 'auth', { testStatuses: new Map([['tests/auth.test.ts::logs in', 'skip' as const]]) });
    expect(claim(auth, LOGIN).strength).toMatchObject({ meaningful: false, reasons: [{ code: 'ALL_SKIPPED' }] });
    expect(claim(auth, LOGOUT).strength?.meaningful).toBe(true);
  });

  // [claims: capabilities/traceability-and-drift#statement-input-reads-tests-once]
  it('reads each test file once, however many capabilities and claims cite it', async () => {
    const repo = makeV2Repo();
    repo.write('specs/capabilities/shop.md', readFileSync(path.join(repo.dir, 'specs/capabilities/shop.md'), 'utf8').replace('sources:', 'tests:\n  - "tests/auth.test.ts"\nsources:'));
    repo.write('tests/auth.test.ts', STRONG + "// [claims: capabilities/shop#cart-totals]\nit('adds', () => { expect(2).toBe(2); });\n");
    const config = await loadConfig(repo.dir);
    const { model } = await loadTrace(config);
    const reads = vi.mocked(fsp.readFile);
    reads.mockClear();
    await buildStatementInput(config, { model });
    const target = path.join(repo.dir, 'tests/auth.test.ts');
    expect(reads.mock.calls.filter(([p]) => String(p) === target)).toHaveLength(1);
  });
});

describe('statement input: the ledger [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#statement-input-deterministic-ledger]
  it('judges the ledger by hashes alone: a changed owned file stales the claim even when an assessment says unaffected', async () => {
    const repo = makeV2Repo();
    await ingestVerdicts({ runId: 'r1', verdicts: [{ claim: LOGIN, verdict: 'proven', exercised: 1 }] }, repo.dir, { provenance: { origin: 'ci' } });
    repo.write('src/auth/login.ts', 'export const login = 2;\n');
    const now = hashFile(path.join(repo.dir, 'src/auth/login.ts'))!;
    saveAssessments(repo.dir, { 'capabilities/auth': { [assessmentKey('src/auth/login.ts', now)]: { affectedClaims: [], at: '2999-01-01T00:00:00.000Z', reason: 'comment only' } } });

    const { model, verdicts } = await loadTrace(await loadConfig(repo.dir));
    expect(verdicts.get(LOGIN)).toBe('proven'); // the trace keeps the assessment's opinion
    const built = await buildStatementInput(await loadConfig(repo.dir), { model });
    expect(claim(built.input.capabilities.find((c) => c.id === 'auth')!, LOGIN).proof.verdict).toBe('stale');
  });

  // [claims: capabilities/traceability-and-drift#statement-input-assembly]
  it('carries the origin, commit and evidence kind of each layer row the verdict rests on, and skips stale rows', async () => {
    const repo = makeV2Repo();
    await ingestVerdicts({ runId: 'r1', verdicts: [{ claim: LOGIN, verdict: 'proven', layer: 'unit' }, { claim: LOGOUT, verdict: 'proven', layer: 'unit' }] }, repo.dir, { provenance: { origin: 'ci', commit: 'abc123' } });
    await ingestVerdicts({ runId: 'r2', verdicts: [{ claim: LOGIN, verdict: 'proven', layer: 'functional', evidence: 'manual' }] }, repo.dir, { provenance: { origin: 'server' } });
    let auth = (await cap(repo, 'auth')).cap;
    expect(claim(auth, LOGIN)).toMatchObject({ proofOrigins: ['ci', 'server'], layerEvidence: { unit: 'test', functional: 'manual' } });
    expect(claim(auth, LOGIN).proof.layers).toMatchObject({ unit: 'proven', functional: 'proven' });
    expect(claim(auth, LOGOUT).proofOrigins).toEqual(['ci']);

    repo.write('src/auth/login.ts', 'export const login = 2;\n');
    auth = (await cap(repo, 'auth')).cap;
    expect(claim(auth, LOGIN).proof.verdict).toBe('stale');
    expect(claim(auth, LOGIN).proofOrigins).toEqual([]);
  });

  // [claims: capabilities/traceability-and-drift#statement-input-absent-is-unknown]
  it('passes everything it cannot find as absent: no ledger, coverage, mutation, base or git', async () => {
    const repo = makeV2Repo();
    const { input, cap: auth } = await cap(repo, 'auth');
    expect(claim(auth, LOGIN).proof).toEqual({ verdict: 'unproven', layers: {}, missing: [], complete: false });
    expect(claim(auth, LOGIN).proofOrigins).toEqual([]);
    expect(claim(auth, LOGIN).change).toBeUndefined();
    expect(auth.coverage).toBeUndefined();
    expect(auth.mutation).toBeUndefined();
    expect(auth.weakening).toEqual([]);
    expect(auth.changeMode).toBe(false);
    expect(input.head).toEqual({ dirty: [] });
    expect(input.unowned).toEqual(['src/orphan.ts']);
    expect(auth.inputs).toEqual(expect.arrayContaining(['specs/capabilities/auth.md', 'src/auth/login.ts', 'tests/auth.test.ts']));
  });
});

describe('statement input: ingested evidence [traceability-and-drift]', () => {
  const lcov = 'SF:src/auth/login.ts\nDA:1,3\nDA:2,0\nend_of_record\nSF:src/shop/cart.ts\nDA:1,1\nend_of_record\n';

  // [claims: capabilities/traceability-and-drift#statement-input-assembly]
  it('reads coverage scoped to a capability first, then the suite, and notices when the capability\'s tests changed since', async () => {
    const repo = makeV2Repo();
    repo.write('tests/auth.test.ts', STRONG);
    repo.write('lcov.info', lcov);
    await runCoverageIngest(['lcov.info'], repo.dir, { capability: 'auth', selection: 'tests', runId: 'ci-1', origin: 'ci' });
    let built = await assemble(repo);
    let auth = built.input.capabilities.find((c) => c.id === 'auth')!;
    expect(auth.coverage).toMatchObject({ source: 'capability', selection: 'tests', testsStale: false, evidence: { runId: 'ci-1', origin: 'ci' } });
    expect(auth.coverage?.lines).toEqual({ executable: 2, hit: 1, pct: 50 });
    expect(built.input.capabilities.find((c) => c.id === 'shop')!.coverage).toBeUndefined();

    await runCoverageIngest(['lcov.info'], repo.dir, { runId: 'suite-1' });
    built = await assemble(repo);
    expect(built.input.capabilities.find((c) => c.id === 'shop')!.coverage).toMatchObject({ source: 'suite', evidence: { runId: 'suite-1' } });

    repo.write('tests/auth.test.ts', STRONG + "// [claims: capabilities/auth#login-valid-code]\nit('logs in twice', () => { expect(1).toBe(1); });\n");
    auth = (await assemble(repo)).input.capabilities.find((c) => c.id === 'auth')!;
    expect(auth.coverage?.testsStale).toBe(true);
  });

  // [claims: capabilities/traceability-and-drift#statement-input-assembly]
  it('scores ingested mutation results per claim from the tests tagged to it', async () => {
    const repo = makeV2Repo();
    repo.write('tests/auth.test.ts', "// [claims: capabilities/auth#login-valid-code]\nit('logs in', () => { expect(1).toBe(1); });\n");
    repo.write(
      'mutation.json',
      JSON.stringify({
        schemaVersion: '1',
        files: {
          'src/auth/login.ts': {
            language: 'typescript',
            source: 'export const login = 1;\n',
            mutants: [
              { id: '1', mutatorName: 'BooleanLiteral', location: { start: { line: 1, column: 1 }, end: { line: 1, column: 5 } }, status: 'Killed', killedBy: ['t1'], coveredBy: ['t1'] },
              { id: '2', mutatorName: 'BooleanLiteral', location: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } }, status: 'Survived', coveredBy: ['t1'] },
            ],
          },
        },
        testFiles: { 'tests/auth.test.ts': { tests: [{ id: 't1', name: 'logs in' }] } },
      }),
    );
    await runMutationIngest(['mutation.json'], repo.dir, { runId: 'm-1', origin: 'ci' });
    const { cap: auth } = await cap(repo, 'auth');
    expect(auth.mutation).toMatchObject({ origin: 'ci', tool: 'stryker' });
    expect(claim(auth, LOGIN).mutation).toMatchObject({ killed: 1, survived: 1, considered: 2, stale: false });
    expect(claim(auth, LOGOUT).mutation).toMatchObject({ killed: 0 });

    // The code changed since the run: the evidence is stale.
    repo.write('src/auth/login.ts', 'export const login = 2;\n');
    expect(claim((await cap(repo, 'auth')).cap, LOGIN).mutation?.stale).toBe(true);
  });
});

describe('statement input: git [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#statement-input-assembly]
  it('records the head commit and only the uncommitted files some capability depends on', async () => {
    const repo = makeV2Repo();
    gitInit(repo.dir);
    repo.write('notes.txt', 'unrelated\n');
    let built = await assemble(repo);
    expect(built.input.head.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(built.input.head.dirty).toEqual([]);

    repo.write('src/auth/login.ts', 'export const login = 2;\n');
    repo.write('tests/auth.test.ts', STRONG);
    built = await assemble(repo);
    expect(built.input.head.dirty).toEqual(['src/auth/login.ts', 'tests/auth.test.ts']);
  });

  // [claims: capabilities/traceability-and-drift#statement-input-change-mode]
  it('with a base ref classifies claims as added, modified or unchanged and finds the policy the change relaxed', async () => {
    const repo = makeV2Repo({ proof: { requireApproval: true } });
    repo.write('specs/capabilities/auth.md', AUTH_SPEC.replace('sources:', 'layers:\n  - unit\nsources:'));
    gitInit(repo.dir);
    repo.write('.specguard/config.json', JSON.stringify({ ...JSON.parse(readFileSync(path.join(repo.dir, '.specguard/config.json'), 'utf8')), proof: {} }));
    repo.write(
      'specs/capabilities/auth.md',
      AUTH_SPEC.replace('Login succeeds with a valid code', 'Login succeeds with a valid one-time code').replace('## Scenarios', '- [ ] Locked users cannot log in <!-- claim: locked-users-refused -->\n\n## Scenarios'),
    );

    const built = await assemble(repo, { base: 'HEAD' });
    const auth = built.input.capabilities.find((c) => c.id === 'auth')!;
    expect(built.warnings).toEqual([]);
    expect(built.input.head.base).toBe('HEAD');
    expect(auth.changeMode).toBe(true);
    expect(Object.fromEntries(auth.claims.map((c) => [c.id, c.change]))).toEqual({ 'login-valid-code': 'modified', 'logout-clears-session': 'unchanged', 'locked-users-refused': 'added' });
    expect(auth.weakening.map((w) => w.kind)).toEqual(expect.arrayContaining(['policy-layer-removed', 'config-weakened']));
    // The config finding names no claim, so it is attributed through the config file being an input of every capability.
    expect(built.input.capabilities.every((c) => c.inputs.includes('.specguard/config.json'))).toBe(true);
  });

  // [claims: capabilities/traceability-and-drift#statement-input-change-mode]
  it('finds a test that was weakened since the base', async () => {
    const repo = makeV2Repo();
    repo.write('tests/auth.test.ts', STRONG);
    gitInit(repo.dir);
    repo.write('tests/auth.test.ts', STRONG.replace("it('logs in', () => { expect(1 + 1).toBe(2); });", "it.skip('logs in', () => { expect(1 + 1).toBe(2); });"));
    const { cap: auth } = await cap(repo, 'auth', { base: 'HEAD' });
    expect(auth.weakening.map((w) => w.kind)).toContain('skip-added');
  });

  // [claims: capabilities/traceability-and-drift#statement-input-absent-is-unknown]
  it('says so and judges no change when the base does not resolve', async () => {
    const repo = makeV2Repo();
    gitInit(repo.dir);
    for (const base of ['no-such-ref', '--output=x']) {
      const built = await assemble(repo, { base });
      expect(built.warnings.join('\n')).toContain('does not resolve to a commit');
      expect(built.input.head.base).toBeUndefined();
      expect(built.input.capabilities.every((c) => !c.changeMode)).toBe(true);
    }
  });
});
