import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ApiCheckRun } from '../../src/ci/github-api.js';
import { loadConfig } from '../../src/core/config.js';
import type { LayerProof } from '../../src/core/proof-ledger.js';
import { noteDigest, serializeNote } from '../../src/core/proof-note.js';
import type { CapabilityStatement } from '../../src/core/proof-statement.js';
import { readNote, resolveNotesConfig } from '../../src/core/proof-store.js';
import { runSpecApprove } from '../../src/pipelines/approve.js';
import { runCheck } from '../../src/pipelines/check.js';
import { runCoverageIngest } from '../../src/pipelines/coverage-ingest.js';
import { ingestVerdicts, walkClaimVerdicts } from '../../src/pipelines/proof.js';
import { chooseRow, evidenceSourceLabel, loadEffectiveLedger, readOnlyStore, rowKey } from '../../src/pipelines/proof-sources.js';
import { runProofPublish } from '../../src/pipelines/proof-store-cmd.js';
import { sh } from '../helpers/notes-git.js';
import type { TmpRepo } from '../helpers/repo.js';
import { AUTH_SPEC, gitCommit, gitInit, makeV2Repo } from '../helpers/v2-repo.js';

const LOGIN = 'capabilities/auth#login-valid-code';
const LOGOUT = 'capabilities/auth#logout-clears-session';
const PERSON = { agent: false, tty: true };
const CI_ENV = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_NAME: 'push' } as NodeJS.ProcessEnv;
// Assembled so this file carries no literal claim tag of its own.
const TAG = (ref: string): string => `// [${'claims'}: ${ref}]`;
const STRONG = `${TAG(LOGIN)}\nit('logs in', () => { expect(1 + 1).toBe(2); });\n${TAG(LOGOUT)}\nit('logs out', () => { expect(2 + 2).toBe(4); });\n`;
const LCOV = 'SF:src/auth/login.ts\nDA:1,3\nDA:2,1\nend_of_record\nSF:src/auth/logout.ts\nDA:1,1\nend_of_record\n';

const row = (over: Partial<LayerProof> = {}): LayerProof => ({ verdict: 'proven', runId: 'r', specHash: 's', fileHashes: {}, exercised: 1, counterexamples: 0, ingestedAt: '2026-10-25T00:00:00.000Z', ...over });

/** A committed repo whose local ledger was earned at `origin`; the note is written for that commit by publish in CI. */
async function provenRepo(origin: 'ci' | 'local', extra: Record<string, unknown> = {}): Promise<TmpRepo> {
  const repo = makeV2Repo(extra);
  await ingestVerdicts({ runId: 'run-1', verdicts: [{ claim: LOGIN, verdict: 'proven' }, { claim: LOGOUT, verdict: 'proven' }] }, repo.dir, { provenance: { origin } });
  gitInit(repo.dir);
  return repo;
}

/** Publish a note for HEAD as a CI job would (local write; the remote is not needed), then drop the local cache and move on one commit. */
async function noteThenMoveOn(repo: TmpRepo, env: NodeJS.ProcessEnv = CI_ENV): Promise<string> {
  const config = await loadConfig(repo.dir);
  const out = await runProofPublish(config, { env, noPush: true });
  expect(out.messages.join('\n')).toContain('proof note for');
  expect(out.exitCode).toBe(0);
  const noted = sh(repo.dir, 'rev-parse', 'HEAD');
  rmSync(path.join(repo.dir, '.specguard/proofs.json'));
  repo.write('docs-note.txt', 'moved on\n');
  gitCommit(repo.dir, 'move on');
  return noted;
}

describe('chooseRow [proof-store]', () => {
  // [claims: capabilities/proof-store#store-effective-ledger]
  it('a fresh failure beats a fresh CI proven row, which beats a fresh local proven row, which beats a stale one', () => {
    const proven = (origin: 'ci' | 'local', ingestedAt = '2026-10-25T00:00:00.000Z') => ({ row: row({ origin, ingestedAt }), fresh: true });
    const failed = (ingestedAt = '2026-10-24T00:00:00.000Z') => ({ row: row({ verdict: 'failed', origin: 'local', ingestedAt }), fresh: true });
    const stale = (verdict: 'proven' | 'failed', ingestedAt: string) => ({ row: row({ verdict, ingestedAt }), fresh: false });

    expect(chooseRow(failed(), proven('ci'))).toBe('local');
    expect(chooseRow(proven('ci'), { row: row({ verdict: 'error', origin: 'ci' }), fresh: true })).toBe('note');
    expect(chooseRow(failed('2026-10-26T00:00:00.000Z'), { row: row({ verdict: 'failed', origin: 'ci' }), fresh: true })).toBe('local');
    // CI proven wins over a newer local proven
    expect(chooseRow(proven('local', '2026-10-26T00:00:00.000Z'), proven('ci'))).toBe('note');
    // a provisional (local-origin) note row ties with a local row: the newer one
    expect(chooseRow(proven('local', '2026-10-26T00:00:00.000Z'), proven('local'))).toBe('local');
    // fresh beats stale on either side
    expect(chooseRow(proven('local'), stale('proven', '2026-10-27T00:00:00.000Z'))).toBe('local');
    expect(chooseRow(stale('proven', '2026-10-27T00:00:00.000Z'), proven('ci'))).toBe('note');
    // a stale failure does not beat a fresh proof
    expect(chooseRow(stale('failed', '2026-10-27T00:00:00.000Z'), proven('ci'))).toBe('note');
    // both stale: the newer, and on a tie the note
    expect(chooseRow(stale('proven', '2026-10-27T00:00:00.000Z'), stale('proven', '2026-10-26T00:00:00.000Z'))).toBe('local');
    expect(chooseRow(stale('proven', '2026-10-26T00:00:00.000Z'), stale('proven', '2026-10-26T00:00:00.000Z'))).toBe('note');
    expect(chooseRow(undefined, undefined)).toBeUndefined();
    expect(chooseRow(proven('local'), undefined)).toBe('local');
    expect(chooseRow(undefined, proven('ci'))).toBe('note');
  });
});

describe('the effective ledger [proof-store]', () => {
  // [claims: capabilities/proof-store#store-effective-ledger]
  it('note rows from an ancestor prove unchanged claims at HEAD with no local ledger, as CI evidence', async () => {
    const repo = await provenRepo('ci');
    const noted = await noteThenMoveOn(repo);
    const config = await loadConfig(repo.dir);
    const eff = await loadEffectiveLedger(config);
    expect(eff.note).toMatchObject({ commit: noted, distance: 1, verified: 'unverified', provisional: false });
    expect(eff.ledger.proofs[LOGIN]).toMatchObject({ verdict: 'proven', origin: 'ci' });
    expect(eff.sourceOf.get(rowKey(LOGIN, 'unclassified'))).toMatchObject({ kind: 'note', commit: noted, distance: 1, fresh: true });

    const verdicts = new Map<string, string>();
    await walkClaimVerdicts(config, (ref, verdict) => void verdicts.set(ref, verdict), { store: readOnlyStore(eff) });
    expect(verdicts.get(LOGIN)).toBe('proven');
    expect(verdicts.get(LOGOUT)).toBe('proven');
    // the same repo without notes has nothing to read
    expect((await loadEffectiveLedger(config, { noNotes: true })).ledger.proofs).toEqual({});
  });

  // [claims: capabilities/proof-store#store-effective-ledger]
  it('a changed owned file stales the note row and the fresh local row decides', async () => {
    const repo = await provenRepo('ci');
    const noted = await noteThenMoveOn(repo);
    repo.write('src/auth/login.ts', 'export const login = 2;\n');
    const config = await loadConfig(repo.dir);

    const stale = await loadEffectiveLedger(config);
    expect(stale.sourceOf.get(rowKey(LOGIN, 'unclassified'))).toMatchObject({ kind: 'note', fresh: false });
    const walked = new Map<string, string>();
    await walkClaimVerdicts(config, (ref, v) => void walked.set(ref, v), { store: readOnlyStore(stale), deterministic: true });
    expect(walked.get(LOGIN)).toBe('stale');
    // both claims own the changed file
    expect(walked.get(LOGOUT)).toBe('stale');

    await ingestVerdicts({ runId: 'run-2', verdicts: [{ claim: LOGIN, verdict: 'proven' }] }, repo.dir, { provenance: { origin: 'local' } });
    const eff = await loadEffectiveLedger(config);
    expect(eff.sourceOf.get(rowKey(LOGIN, 'unclassified'))).toMatchObject({ kind: 'local', fresh: true });
    expect(eff.sourceOf.get(rowKey(LOGOUT, 'unclassified'))).toMatchObject({ kind: 'note', commit: noted, fresh: false });
    expect(eff.ledger.proofs[LOGIN]).toMatchObject({ runId: 'run-2', origin: 'local' });
    // only fresh rows count towards the source: the one fresh row is local
    expect(evidenceSourceLabel(eff, 'capabilities/auth')).toBe('local (provisional)');
  });

  // [claims: capabilities/proof-store#store-effective-ledger]
  it('local rows are always local evidence whatever origin they say, unless the CI job that wrote them asks to keep it', async () => {
    const repo = await provenRepo('ci');
    const config = await loadConfig(repo.dir);
    const stored = JSON.parse(readFileSync(path.join(repo.dir, '.specguard/proofs.json'), 'utf8'));
    expect(stored.proofs[LOGIN].origin).toBe('ci');

    const eff = await loadEffectiveLedger(config);
    expect(eff.note).toBeUndefined();
    expect(eff.ledger.proofs[LOGIN].origin).toBe('local');
    for (const layer of Object.values(eff.ledger.proofs[LOGIN].layers ?? {})) expect(layer?.origin).toBe('local');
    expect((await loadEffectiveLedger(config, { localOrigin: 'stored' })).ledger.proofs[LOGIN].origin).toBe('ci');
  });

  // [claims: capabilities/proof-store#store-effective-ledger]
  it('a note of a newer version is ignored with a warning and the local cache is read', async () => {
    const repo = await provenRepo('local');
    const head = sh(repo.dir, 'rev-parse', 'HEAD');
    const file = path.join(repo.dir, '.git', 'newer.json');
    writeFileSync(file, JSON.stringify({ schema: 'specguard.proof-note', version: 99, commit: head }));
    sh(repo.dir, 'notes', '--ref=refs/notes/specguard', 'add', '-C', sh(repo.dir, 'hash-object', '-w', file), head);
    const eff = await loadEffectiveLedger(await loadConfig(repo.dir));
    expect(eff.note).toBeUndefined();
    expect(eff.warnings.join('\n')).toMatch(/newer SpecGuard wrote the proof note on .*upgrade/);
    expect(eff.ledger.proofs[LOGIN]).toMatchObject({ verdict: 'proven', origin: 'local' });
  });

  // [claims: capabilities/proof-store#store-effective-ledger]
  it('read only: update throws, so no pipeline can write a merged view back', async () => {
    const repo = await provenRepo('local');
    const eff = await loadEffectiveLedger(await loadConfig(repo.dir));
    const store = readOnlyStore(eff);
    expect(await store.read()).toBe(eff.ledger);
    expect(() => store.update(() => undefined)).toThrow(/read-only/);
  });

  // [claims: capabilities/proof-store#store-effective-ledger]
  it('with proofStore.verify check-run a note is verified only by a matching check run, and a mismatch is ignored; off by default makes no call', async () => {
    const repo = await provenRepo('ci', { proofStore: { verify: 'check-run' } });
    const noted = await noteThenMoveOn(repo);
    const config = await loadConfig(repo.dir);
    const parsed = readNote(repo.dir, resolveNotesConfig(config.proofStore), noted);
    if (!parsed?.ok) throw new Error('note missing');
    const digest = noteDigest(serializeNote(parsed.note));
    const run = (summary: string, slug = 'github-actions'): ApiCheckRun => ({ id: 5, app: { slug }, output: { summary } }) as unknown as ApiCheckRun;
    const apiOf = (runs: ApiCheckRun[]) => ({ listCheckRuns: async () => runs });

    const verified = await loadEffectiveLedger(config, { api: apiOf([run(`note-sha256: ${digest}\nschema: 1`)]) });
    expect(verified.note?.verified).toBe('verified');
    expect(evidenceSourceLabel(verified, 'capabilities/auth')).toBe(`ci note @${noted.slice(0, 7)} (1 commit back, verified)`);

    const mismatch = await loadEffectiveLedger(config, { api: apiOf([run(`note-sha256: ${'0'.repeat(64)}`)]) });
    expect(mismatch.note).toBeUndefined();
    expect(mismatch.warnings.join('\n')).toMatch(/does not match its CI check run/);

    const other = await loadEffectiveLedger(config, { api: apiOf([run(`note-sha256: ${digest}`, 'some-other-app')]) });
    expect(other.note?.verified).toBe('unverified');

    // off by default: the client is never asked
    const offConfig = { ...config, proofStore: { ...config.proofStore, verify: 'off' as const } };
    let calls = 0;
    const off = await loadEffectiveLedger(offConfig, { api: { listCheckRuns: async () => { calls += 1; return []; } } });
    expect(off.note?.verified).toBe('unverified');
    expect(calls).toBe(0);
  });
});

describe('check reads the notes [proof-store]', () => {
  // [claims: capabilities/proof-store#store-evidence-source]
  it('reports the evidence source per capability and on the headline when proofs come from an ancestor note', async () => {
    const repo = await provenRepo('ci');
    const noted = await noteThenMoveOn(repo);
    const config = await loadConfig(repo.dir);
    const result = await runCheck(config);
    const auth = result.statement!.capabilities.find((c) => c.capability === 'auth') as CapabilityStatement;
    expect(auth.evidence.source).toBe(`ci note @${noted.slice(0, 7)} (1 commit back, unverified)`);
    expect(auth.evidence.origins).toEqual(['ci']);
    const lines = result.messages.filter((l) => l.startsWith('STATEMENT:'));
    expect(lines.find((l) => l.startsWith('STATEMENT: auth'))).toContain(` · ci note @${noted.slice(0, 7)} (1 commit back, unverified)`);
    expect(lines.find((l) => l.startsWith('STATEMENT: system'))).toContain(` · proofs from note @${noted.slice(0, 7)}`);
    // shop has no evidence at all: no source
    expect(result.statement!.capabilities.find((c) => c.capability === 'shop')!.evidence.source).toBeUndefined();

    const explained = await runCheck(config, { explain: 'auth' });
    expect(explained.messages.join('\n')).toContain(`Evidence source: ci note @${noted.slice(0, 7)}`);

    // --no-notes ignores the note: with no local ledger nothing is proven
    const without = await runCheck(config, { noNotes: true });
    expect(without.statement!.capabilities.find((c) => c.capability === 'auth')!.evidence.source).toBeUndefined();
    expect(without.statement!.capabilities.find((c) => c.capability === 'auth')!.evidence.origins).toEqual([]);
  });

  // [claims: capabilities/proof-store#store-evidence-source]
  it('certified at HEAD from the evidence in an ancestor note, with no local ledger', async () => {
    const repo = makeV2Repo();
    rmSync(path.join(repo.dir, 'specs/capabilities/shop.md'));
    rmSync(path.join(repo.dir, 'src/shop'), { recursive: true });
    repo.write('specs/capabilities/auth.md', AUTH_SPEC.replace('  - "src/auth/**"\n', '  - "src/auth/**"\n  - "src/orphan.ts"\n  - "src/core/awards.ts"\n'));
    repo.write('tests/auth.test.ts', STRONG);
    repo.write('lcov.info', LCOV);
    const config = await loadConfig(repo.dir);
    await runSpecApprove(config, { all: true, yes: true, by: 'Ada', actor: PERSON });
    await ingestVerdicts({ runId: 'run-1', verdicts: [{ claim: LOGIN, verdict: 'proven' }, { claim: LOGOUT, verdict: 'proven' }] }, repo.dir, { provenance: { origin: 'ci' } });
    await runCoverageIngest(['lcov.info'], repo.dir, { capability: 'auth', selection: 'tests', runId: 'cov-1', origin: 'ci' });
    gitInit(repo.dir);
    const noted = await noteThenMoveOn(repo);

    const result = await runCheck(await loadConfig(repo.dir));
    const auth = result.statement!.capabilities.find((c) => c.capability === 'auth') as CapabilityStatement;
    expect(auth.level).toBe('certified');
    expect(auth.certifiedAt).toBe(sh(repo.dir, 'rev-parse', 'HEAD'));
    expect(auth.evidence.source).toContain(`ci note @${noted.slice(0, 7)}`);
  });

  // [claims: capabilities/proof-store#store-evidence-source]
  it('with no notes ref check is unchanged: same lines and exit code with or without --no-notes, and no mention of notes', async () => {
    const repo = await provenRepo('ci');
    const config = await loadConfig(repo.dir);
    const plain = await runCheck(config);
    const off = await runCheck(config, { noNotes: true });
    expect(plain.messages.filter((l) => !l.includes('generated'))).toEqual(off.messages.filter((l) => !l.includes('generated')));
    expect(plain.exitCode).toBe(off.exitCode);
    expect(plain.messages.join('\n')).not.toMatch(/note/i);
    // the local file ledger keeps the origin it was written with, as before
    expect(plain.statement!.capabilities.find((c) => c.capability === 'auth')!.evidence.origins).toEqual(['ci']);
    expect(plain.statement!.capabilities.every((c) => c.evidence.source === undefined)).toBe(true);
  });
});
