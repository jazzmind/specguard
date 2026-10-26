import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import type { CapabilityStatement, SystemStatement } from '../../src/core/proof-statement.js';
import { buildServer } from '../../src/mcp/server.js';
import { runSpecApprove } from '../../src/pipelines/approve.js';
import { runCheck, type CheckOpts } from '../../src/pipelines/check.js';
import { runCoverageIngest } from '../../src/pipelines/coverage-ingest.js';
import { runHistoryAdd } from '../../src/pipelines/history.js';
import { runMutationIngest } from '../../src/pipelines/mutation-ingest.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import { assessmentKey, saveAssessments } from '../../src/core/drift-assessments.js';
import { hashFile } from '../../src/core/drift-registry.js';
import type { TmpRepo } from '../helpers/repo.js';
import { AUTH_SPEC, gitCommit, gitInit, makeV2Repo } from '../helpers/v2-repo.js';

const PERSON = { agent: false, tty: true };
const LOGIN = 'capabilities/auth#login-valid-code';
const LOGOUT = 'capabilities/auth#logout-clears-session';
const STRONG = "// [claims: capabilities/auth#login-valid-code]\nit('logs in', () => { expect(1 + 1).toBe(2); });\n// [claims: capabilities/auth#logout-clears-session]\nit('logs out', () => { expect(2 + 2).toBe(4); });\n";
const LCOV = 'SF:src/auth/login.ts\nDA:1,3\nDA:2,1\nend_of_record\nSF:src/auth/logout.ts\nDA:1,1\nend_of_record\n';

const check = async (repo: TmpRepo, opts: CheckOpts = {}) => runCheck(await loadConfig(repo.dir), opts);
const reasons = (c: CapabilityStatement) => Object.values(c.pillars).flatMap((p) => p.reasons);
const statementOf = (r: { statement?: SystemStatement }): SystemStatement => r.statement!;
const capOf = (r: { statement?: SystemStatement }, id: string): CapabilityStatement => statementOf(r).capabilities.find((c) => c.capability === id)!;

/** A repo where every source file has an owner, so the existing exit code is 0. */
function ownedRepo(extra: Record<string, unknown> = {}): TmpRepo {
  const repo = makeV2Repo(extra);
  repo.write('specs/capabilities/auth.md', AUTH_SPEC.replace('  - "src/auth/**"\n', '  - "src/auth/**"\n  - "src/orphan.ts"\n'));
  return repo;
}

/** One capability, approved, proven, covered and meaningfully tested, with the evidence earned at `origin`. Not yet committed. */
async function solidRepo(origin: 'ci' | 'local', extra: Record<string, unknown> = {}): Promise<TmpRepo> {
  const repo = makeV2Repo(extra);
  rmSync(path.join(repo.dir, 'specs/capabilities/shop.md'));
  rmSync(path.join(repo.dir, 'src/shop'), { recursive: true });
  repo.write('specs/capabilities/auth.md', AUTH_SPEC.replace('  - "src/auth/**"\n', '  - "src/auth/**"\n  - "src/orphan.ts"\n  - "src/core/awards.ts"\n'));
  repo.write('tests/auth.test.ts', STRONG);
  repo.write('lcov.info', LCOV);
  const config = await loadConfig(repo.dir);
  await runSpecApprove(config, { all: true, yes: true, by: 'Ada', actor: PERSON });
  await ingestVerdicts({ runId: 'run-1', verdicts: [{ claim: LOGIN, verdict: 'proven' }, { claim: LOGOUT, verdict: 'proven' }] }, repo.dir, { provenance: { origin } });
  await runCoverageIngest(['lcov.info'], repo.dir, { capability: 'auth', selection: 'tests', runId: 'cov-1', origin });
  return repo;
}

describe('check leads with the proof statement [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#check-leads-with-statement, capabilities/traceability-and-drift#statement-degradation, capabilities/traceability-and-drift#check-exit-unchanged-without-gates]
  it('a repo using none of the new features: STATEMENT lines first, its own lines and exit code as before, not certified with exact reasons, nothing blocking', async () => {
    const repo = ownedRepo();
    const r = await check(repo);
    expect(r.exitCode).toBe(0);
    expect(r.failed).toBe(0);

    const lines = r.messages;
    const firstOther = lines.findIndex((l) => !l.startsWith('STATEMENT:'));
    expect(lines.slice(0, firstOther).map((l) => l.split(' ').slice(0, 3).join(' '))).toEqual(['STATEMENT: auth NOT-CERTIFIED', 'STATEMENT: shop NOT-CERTIFIED', 'STATEMENT: system NOT-CERTIFIED']);
    expect(lines[firstOther]).toContain('# auth [capability] 3 files, 1 tests, 2 claims');
    expect(lines.join('\n')).toMatch(/TOTAL: 5 source files, 5 specs \(100%\)/);
    expect(lines.join('\n')).toContain('ORPHANS: 0');

    const s = statementOf(r);
    expect(s.level).toBe('not-certified');
    expect(s.exitCode).toBe(0);
    const shop = capOf(r, 'shop');
    expect(reasons(shop).filter((x) => x.outcome !== 'note').map((x) => x.code).sort()).toEqual(['APPROVALS_NOT_IN_USE', 'CLAIM_UNPROVEN', 'NO_COVERAGE_EVIDENCE', 'NO_TAGGED_TESTS']);
    expect(reasons(shop).every((x) => !x.blocking)).toBe(true);
    expect(s.capabilities.every((c) => c.blocking.length === 0)).toBe(true);
    expect(readFileSync(path.join(repo.dir, '.specguard/trace.json'), 'utf8')).toContain('"statement"');
    expect(JSON.parse(readFileSync(path.join(repo.dir, '.specguard/trace.json'), 'utf8')).version).toBe(1);
  });

  // [claims: capabilities/traceability-and-drift#check-exit-unchanged-without-gates]
  it('every gate off gives the exit codes of a repo that never heard of the statement', async () => {
    const unowned = await check(makeV2Repo());
    expect(unowned.exitCode).toBe(ExitCode.MissingSpecs);
    expect(unowned.statement?.exitCode).toBe(0);
    const bad = makeV2Repo();
    bad.write('specs/system.md', '# no frontmatter\n');
    expect((await check(bad)).exitCode).toBe(ExitCode.ValidationFailed);
  });
});

describe('check exits 13 only under a gate [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#check-exit-13-only-with-gate, capabilities/traceability-and-drift#check-explain]
  it('an unapproved claim under requireApproval exits 13, and --explain lists the reason with the command that fixes it', async () => {
    const repo = ownedRepo({ proof: { requireApproval: true } });
    await runSpecApprove(await loadConfig(repo.dir), { targets: [LOGIN], yes: true, by: 'Ada', actor: PERSON });
    const r = await check(repo);
    expect(r.exitCode).toBe(ExitCode.NotCertified);
    expect(r.messages.join('\n')).toContain('NOT CERTIFIED:');
    const blocking = capOf(r, 'auth').blocking;
    expect(blocking.map((b) => `${b.code} ${b.claim}`)).toEqual([`APPROVAL_MISSING ${LOGOUT}`]);

    const explained = await check(repo, { explain: 'auth' });
    expect(explained.exitCode).toBe(ExitCode.NotCertified);
    const text = explained.messages.join('\n');
    expect(text).toContain('auth (Auth): NOT CERTIFIED');
    expect(text).toContain('policy: approval');
    expect(text).toMatch(/Blocking:\n {2}1\. APPROVAL_MISSING capabilities\/auth#logout-clears-session/);
    expect(text).toContain('fix: specguard spec approve capabilities/auth#logout-clears-session');
    expect(text).toContain('Advisory:');
    expect(text.indexOf('Blocking:')).toBeLessThan(text.indexOf('Advisory:'));
    // scoped to one capability: shop's unapproved claim is not in this statement
    expect(statementOf(explained).capabilities.map((c) => c.capability)).toEqual(['auth']);
    expect(statementOf(explained).exitCode).toBe(ExitCode.NotCertified);
  });

  // [claims: capabilities/traceability-and-drift#check-explain]
  it('--explain exits per the explained capability, and an unknown capability is an error', async () => {
    const repo = ownedRepo({ proof: { requireApproval: true } });
    await runSpecApprove(await loadConfig(repo.dir), { targets: ['auth'], yes: true, by: 'Ada', actor: PERSON });
    const auth = await check(repo, { explain: 'auth' });
    expect(auth.exitCode).toBe(0);
    expect(auth.statement?.capabilities[0]?.level).toBe('not-certified');
    expect((await check(repo, { explain: 'shop' })).exitCode).toBe(ExitCode.NotCertified);
    expect((await check(repo, { explain: 'capabilities/shop' })).exitCode).toBe(ExitCode.NotCertified);
    const unknown = await check(repo, { explain: 'nope' });
    expect(unknown.exitCode).toBe(ExitCode.InternalError);
    expect(unknown.messages.join('\n')).toContain('no capability "nope"; known: auth, shop');
  });

  // [claims: capabilities/traceability-and-drift#check-exit-13-only-with-gate]
  it('a repo with no approvals at all and requireApproval gets the one APPROVALS_NOT_IN_USE reason', async () => {
    const r = await check(ownedRepo({ proof: { requireApproval: true } }));
    expect(r.exitCode).toBe(13);
    expect(capOf(r, 'auth').blocking.map((b) => b.code)).toEqual(['APPROVALS_NOT_IN_USE']);
  });

  // [claims: capabilities/traceability-and-drift#check-exit-13-only-with-gate]
  it('a vague claim fails Testable, and blocks under requireTestable', async () => {
    const spec = AUTH_SPEC.replace('Login succeeds with a valid code', 'Login works properly').replace('  - "src/auth/**"\n', '  - "src/auth/**"\n  - "src/orphan.ts"\n');
    const open = ownedRepo();
    open.write('specs/capabilities/auth.md', spec);
    const off = await check(open);
    expect(off.exitCode).toBe(0);
    expect(capOf(off, 'auth').pillars.testable.status).toBe('fail');

    const gated = ownedRepo({ proof: { requireTestable: true } });
    gated.write('specs/capabilities/auth.md', spec);
    const r = await check(gated);
    expect(r.exitCode).toBe(13);
    expect(capOf(r, 'auth').blocking.map((b) => b.code)).toEqual(['LINT_ERROR']);
    const text = (await check(gated, { explain: 'auth' })).messages.join('\n');
    expect(text).toContain('LINT_ERROR capabilities/auth#login-valid-code');
    expect(text).toContain('T-VAGUE');
  });

  // [claims: capabilities/traceability-and-drift#check-exit-13-only-with-gate]
  it('a skipped or assertion-free test is a strength reason, and blocks under requireStrength', async () => {
    const files = "// [claims: capabilities/auth#login-valid-code]\nit('logs in', () => {});\n// [claims: capabilities/auth#logout-clears-session]\nit.skip('logs out', () => { expect(1).toBe(1); });\n";
    const open = ownedRepo();
    open.write('tests/auth.test.ts', files);
    const off = await check(open);
    expect(off.exitCode).toBe(0);
    expect(reasons(capOf(off, 'auth')).filter((x) => x.pillar === 'conforms' && x.outcome === 'fail').map((x) => x.code).sort()).toEqual(['TESTS_SKIPPED_ONLY', 'WEAK_ONLY']);

    const gated = ownedRepo({ proof: { requireStrength: true } });
    gated.write('tests/auth.test.ts', files);
    const r = await check(gated);
    expect(r.exitCode).toBe(13);
    expect(capOf(r, 'auth').blocking.map((b) => b.code).sort()).toEqual(['TESTS_SKIPPED_ONLY', 'WEAK_ONLY']);
  });

  // [claims: capabilities/traceability-and-drift#check-exit-13-only-with-gate]
  it('2, 3 and 4 keep their precedence over 13', async () => {
    const gate = { proof: { requireApproval: true } };
    expect((await check(makeV2Repo(gate))).exitCode).toBe(ExitCode.MissingSpecs);
    const broken = makeV2Repo(gate);
    broken.write('specs/system.md', '# no frontmatter\n');
    expect((await check(broken)).exitCode).toBe(ExitCode.ValidationFailed);

    const repo = ownedRepo({ ...gate, history: { failOnIntentGap: true } });
    gitInit(repo.dir, '2020-01-01T12:00:00Z');
    await runHistoryAdd(await loadConfig(repo.dir), { decision: 'long ago', affects: ['shop'], date: '2000-01-01' });
    writeFileSync(path.join(repo.dir, 'src/auth/login.ts'), 'export const login = 2;\n');
    gitCommit(repo.dir, 'change login', '2021-06-01T12:00:00Z');
    const r = await check(repo);
    expect(r.exitCode).toBe(ExitCode.DriftDetected);
    expect(statementOf(r).exitCode).toBe(ExitCode.NotCertified);
  }, 30_000);

  // [claims: capabilities/traceability-and-drift#check-strict]
  it('--strict turns every gate on without touching the config', async () => {
    const repo = ownedRepo();
    expect((await check(repo)).exitCode).toBe(0);
    const r = await check(repo, { strict: true });
    expect(r.exitCode).toBe(ExitCode.NotCertified);
    expect(statementOf(r).policy).toMatchObject({ requireApproval: true, requireTestable: true, requireStrength: true, requireSensitivity: true, requireConforms: true, requireAlignment: true, requireCi: true, enforceLayers: 'fail' });
    expect(JSON.parse(readFileSync(path.join(repo.dir, '.specguard/config.json'), 'utf8')).proof).toBeUndefined();
    expect((await check(repo)).exitCode).toBe(0);
  });
});

describe('the statement reads the evidence the repo holds [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#statement-input-deterministic-ledger]
  it('a changed owned file shows the claim not conforming even though a drift assessment says unaffected', async () => {
    const repo = ownedRepo();
    await ingestVerdicts({ runId: 'r1', verdicts: [{ claim: LOGIN, verdict: 'proven', exercised: 1 }] }, repo.dir, { provenance: { origin: 'ci' } });
    repo.write('src/auth/login.ts', 'export const login = 2;\n');
    const now = hashFile(path.join(repo.dir, 'src/auth/login.ts'))!;
    saveAssessments(repo.dir, { 'capabilities/auth': { [assessmentKey('src/auth/login.ts', now)]: { affectedClaims: [], at: '2999-01-01T00:00:00.000Z', reason: 'comment only' } } });
    const r = await check(repo);
    expect(r.messages.join('\n')).toContain('# auth [capability] 3 files, 1 tests, 2 claims (1 proven'); // the summary keeps the assessment's opinion
    const stale = reasons(capOf(r, 'auth')).filter((x) => x.code === 'CLAIM_STALE');
    expect(stale.map((x) => x.claim)).toEqual([LOGIN]);
    expect(capOf(r, 'auth').pillars.conforms.status).toBe('fail');
  });

  // [claims: capabilities/traceability-and-drift#statement-input-absent-is-unknown]
  it('absent evidence is unknown, never fail: no ledger, no coverage, no mutation', async () => {
    const repo = ownedRepo({ proof: { requireConforms: true, requireAlignment: true } });
    repo.write('tests/auth.test.ts', STRONG);
    const r = await check(repo);
    const auth = capOf(r, 'auth');
    expect(auth.pillars.aligned.status).toBe('unknown');
    expect(reasons(auth).filter((x) => x.pillar === 'conforms' && x.outcome === 'fail')).toEqual([]);
    expect(reasons(auth).filter((x) => x.pillar === 'conforms' && x.outcome === 'unknown').map((x) => x.code)).toContain('CLAIM_UNPROVEN');
    expect(auth.metrics).toMatchObject({ lineCoverage: null, diffCoverage: null, mutationScore: null });
  });

  // [claims: capabilities/traceability-and-drift#statement-input-assembly]
  it('ingested coverage and mutation evidence show in the capability metrics and evidence', async () => {
    const repo = await solidRepo('ci');
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
              { id: '2', mutatorName: 'BooleanLiteral', location: { start: { line: 2, column: 1 }, end: { line: 2, column: 5 } }, status: 'Survived', coveredBy: ['t2'] },
            ],
          },
        },
        testFiles: { 'tests/auth.test.ts': { tests: [{ id: 't1', name: 'logs in' }, { id: 't2', name: 'logs out' }] } },
      }),
    );
    await runMutationIngest(['mutation.json'], repo.dir, { runId: 'm-1', origin: 'ci' });
    const auth = capOf(await check(repo), 'auth');
    expect(auth.metrics.lineCoverage).toBe(100);
    expect(auth.metrics.mutationScore).toBe(50);
    expect(auth.evidence).toMatchObject({ coverageRunId: 'cov-1', mutationTool: 'stryker' });
  });

  // [claims: capabilities/traceability-and-drift#statement-certified-rule]
  it('CI evidence on a clean commit is certified at that commit; the same evidence from a local run is provisional', async () => {
    const ci = await solidRepo('ci');
    gitInit(ci.dir);
    const certified = capOf(await check(ci), 'auth');
    expect(certified.pillars).toMatchObject({ approved: { status: 'ok' }, testable: { status: 'ok' }, aligned: { status: 'ok' }, conforms: { status: 'ok' } });
    expect(certified.level).toBe('certified');
    expect(certified.certifiedAt).toMatch(/^[0-9a-f]{40}$/);
    const whole = statementOf(await check(ci));
    expect(whole.level).toBe('certified');
    expect(whole.certifiedAt).toBe(certified.certifiedAt);

    const local = await solidRepo('local');
    gitInit(local.dir);
    const provisional = capOf(await check(local), 'auth');
    expect(provisional.level).toBe('provisional');
    expect(provisional.certifiedAt).toBeUndefined();
    expect(reasons(provisional).filter((x) => x.code === 'LOCAL_EVIDENCE').length).toBeGreaterThan(0);
    expect(provisional.evidence.origins).toEqual(['local']);
  });

  // [claims: capabilities/traceability-and-drift#statement-certified-rule, capabilities/traceability-and-drift#check-exit-13-only-with-gate]
  it('local evidence is provisional but not blocking, until requireCi makes it blocking', async () => {
    const repo = await solidRepo('local');
    gitInit(repo.dir);
    expect((await check(repo)).exitCode).toBe(0);
    const gated = await solidRepo('local', { proof: { requireCi: true } });
    gitInit(gated.dir);
    const r = await check(gated);
    expect(r.exitCode).toBe(13);
    expect(capOf(r, 'auth').blocking.map((b) => b.code)).toEqual(['CI_EVIDENCE_REQUIRED', 'CI_EVIDENCE_REQUIRED']);
  });

  // [claims: capabilities/traceability-and-drift#statement-certified-rule]
  it('an uncommitted change to a file the capability depends on makes a certificate provisional', async () => {
    const repo = await solidRepo('ci');
    gitInit(repo.dir);
    writeFileSync(path.join(repo.dir, 'tests/auth.test.ts'), STRONG + '// a note\n');
    const auth = capOf(await check(repo), 'auth');
    expect(auth.level).toBe('provisional');
    expect(reasons(auth).find((x) => x.code === 'DIRTY_TREE')?.message).toContain('tests/auth.test.ts');
    // a file no capability depends on does not
    const clean = await solidRepo('ci');
    gitInit(clean.dir);
    clean.write('notes.txt', 'unrelated\n');
    expect(capOf(await check(clean), 'auth').level).toBe('certified');
  });

  // [claims: capabilities/traceability-and-drift#statement-input-change-mode]
  it('--since compares with a base: a changed claim needs evidence that its tests detect a change', async () => {
    const repo = await solidRepo('ci', { proof: { requireSensitivity: true } });
    gitInit(repo.dir);
    expect((await check(repo, { since: 'HEAD' })).exitCode).toBe(0); // nothing changed since HEAD
    repo.write('specs/capabilities/auth.md', readFileSync(path.join(repo.dir, 'specs/capabilities/auth.md'), 'utf8').replace('Logout clears the session', 'Logout clears the session and the cookie'));
    const r = await check(repo, { since: 'HEAD' });
    expect(r.exitCode).toBe(13);
    expect(capOf(r, 'auth').blocking.map((b) => `${b.code} ${b.claim}`)).toEqual([`SENSITIVITY_MISSING ${LOGOUT}`]);
    expect(statementOf(r).base).toBe('HEAD');
    const noBase = await check(repo);
    expect(noBase.exitCode).toBe(0);
  });
});

describe('the statement in the JSON result and the MCP tool [traceability-and-drift]', () => {
  // [claims: capabilities/traceability-and-drift#statement-json-and-explain, capabilities/traceability-and-drift#check-leads-with-statement]
  it('--json carries the statement in its documented shape', async () => {
    const r = JSON.parse(JSON.stringify(await check(ownedRepo({ proof: { requireApproval: true } })))) as { pipeline: string; exitCode: number; statement: SystemStatement };
    expect(r.pipeline).toBe('check');
    expect(Object.keys(r.statement)).toEqual(['version', 'generated', 'policy', 'level', 'capabilities', 'system', 'counts', 'exitCode']);
    expect(r.statement).toMatchObject({ version: 1, level: 'not-certified', exitCode: 13, counts: { 'not-certified': 2 } });
    expect(r.statement.policy).toMatchObject({ requireApproval: true, requireConforms: false, enforceLayers: 'warn', minDiffCoverage: 80 });
    const auth = r.statement.capabilities.find((c) => c.capability === 'auth')!;
    expect(Object.keys(auth.pillars)).toEqual(['approved', 'testable', 'aligned', 'conforms']);
    expect(auth.pillars.approved.reasons[0]).toMatchObject({ code: 'APPROVALS_NOT_IN_USE', pillar: 'approved', outcome: 'fail', gate: 'requireApproval', blocking: true });
    expect(auth.claims.map((c) => c.ref)).toEqual([LOGIN, LOGOUT]);
    expect(r.exitCode).toBe(13);
  });

  // [claims: capabilities/traceability-and-drift#check-explain, capabilities/traceability-and-drift#check-strict]
  it('the specguard_check tool takes explain and strict and returns the statement', async () => {
    const repo = ownedRepo();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildServer().connect(b);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(a);
    const text = (res: unknown) => ((res as { content: Array<{ text: string }> }).content[0]?.text ?? '');

    const schema = (await client.listTools()).tools.find((t) => t.name === 'specguard_check')!.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(schema)).toEqual(expect.arrayContaining(['explain', 'strict']));

    const explained = text(await client.callTool({ name: 'specguard_check', arguments: { explain: 'auth', strict: true, cwd: repo.dir } }));
    expect(explained).toContain('exitCode=13');
    expect(explained).toContain('auth (Auth): NOT CERTIFIED');
    expect(explained).toContain('APPROVALS_NOT_IN_USE');
    const raw = JSON.parse(explained.slice(explained.indexOf('Raw result:') + 'Raw result:'.length)) as { statement: SystemStatement };
    expect(raw.statement.capabilities.map((c) => c.capability)).toEqual(['auth']);
    expect(raw.statement.policy.requireApproval).toBe(true);

    const plain = text(await client.callTool({ name: 'specguard_check', arguments: { cwd: repo.dir } }));
    expect(plain).toContain('STATEMENT: auth NOT-CERTIFIED');
    expect(plain).toContain('exitCode=0');
  });
});
