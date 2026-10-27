import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { ExitCode } from '../../src/core/exit-codes.js';
import { readNote, resolveNotesConfig } from '../../src/core/proof-store.js';
import { ingestVerdicts } from '../../src/pipelines/proof.js';
import { evidenceSourceLabel, loadEffectiveLedger, rowKey } from '../../src/pipelines/proof-sources.js';
import { parseDuration, runProofFetch, runProofNotes, runProofPrune, runProofPublish } from '../../src/pipelines/proof-store-cmd.js';
import { bareRemote, cloneOf, sh } from '../helpers/notes-git.js';
import type { TmpRepo } from '../helpers/repo.js';
import { gitInit, makeV2Repo } from '../helpers/v2-repo.js';

const LOGIN = 'capabilities/auth#login-valid-code';
const LOGOUT = 'capabilities/auth#logout-clears-session';
const CI = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '42' } as NodeJS.ProcessEnv;
const noSleep = async (): Promise<void> => undefined;

/** A committed repo; `origins` says where each claim's local proof was earned. */
async function repoWith(origins: { login: 'ci' | 'local'; logout: 'ci' | 'local' }, extra: Record<string, unknown> = {}): Promise<TmpRepo> {
  const repo = makeV2Repo(extra);
  await ingestVerdicts({ runId: 'run-1', verdicts: [{ claim: LOGIN, verdict: 'proven' }] }, repo.dir, { provenance: { origin: origins.login } });
  await ingestVerdicts({ runId: 'run-1', verdicts: [{ claim: LOGOUT, verdict: 'proven' }] }, repo.dir, { provenance: { origin: origins.logout } });
  gitInit(repo.dir);
  return repo;
}

const noteOf = async (repo: TmpRepo, commit: string) => {
  const config = await loadConfig(repo.dir);
  const read = readNote(repo.dir, resolveNotesConfig(config.proofStore), commit);
  if (!read?.ok) throw new Error('no readable note');
  return read.note;
};

describe('proof publish [proof-store]', () => {
  // [claims: capabilities/proof-store#store-prune-reachable]
  it('creates the main branch used by pruning fixtures even when Git defaults to master', () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'init.defaultBranch');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'master');
    try {
      const repo = makeV2Repo();
      gitInit(repo.dir);
      expect(sh(repo.dir, 'branch', '--show-current')).toBe('main');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // [claims: capabilities/proof-store#store-publish-ci-only]
  it('refuses outside CI, and with a CI that is not GitHub unless it is allowed; nothing is written', async () => {
    const repo = await repoWith({ login: 'ci', logout: 'ci' });
    const config = await loadConfig(repo.dir);
    const refused = await runProofPublish(config, { env: {} });
    expect(refused.exitCode).toBe(ExitCode.ValidationFailed);
    expect(refused.messages.join('\n')).toMatch(/runs only in CI.*--force-local/);
    expect((await runProofPublish(config, { env: { CI: 'true' } })).exitCode).toBe(ExitCode.ValidationFailed);
    expect(sh(repo.dir, 'for-each-ref', 'refs/notes')).toBe('');

    const allowed = await runProofPublish(config, { env: { CI: 'true' }, allowNonGithub: true, noPush: true });
    expect(allowed.exitCode).toBe(0);
    expect(sh(repo.dir, 'for-each-ref', 'refs/notes')).toContain('refs/notes/specguard');
  });

  // [claims: capabilities/proof-store#store-publish-ci-only]
  it('in CI writes and pushes the note for HEAD with only the CI-origin rows, the file hashes once, and the run it came from', async () => {
    const repo = await repoWith({ login: 'ci', logout: 'local' });
    const remote = bareRemote();
    sh(repo.dir, 'remote', 'add', 'origin', remote);
    const head = sh(repo.dir, 'rev-parse', 'HEAD');
    const out = await runProofPublish(await loadConfig(repo.dir), { env: CI, sleep: noSleep });
    expect(out.exitCode).toBe(0);
    expect(out.messages.join('\n')).toMatch(/pushed refs\/notes\/specguard to origin \(1 attempt\)/);
    expect(sh(remote, 'notes', '--ref=refs/notes/specguard', 'list')).toContain(head);

    const note = await noteOf(repo, head);
    expect(note.rows.map((r) => r.claim)).toEqual([LOGIN]);
    expect(note.commit).toBe(head);
    expect(note.tree).toBe(sh(repo.dir, 'rev-parse', 'HEAD^{tree}'));
    expect(note.ci).toMatchObject({ provider: 'github', event: 'push', repo: 'o/r', runId: '42' });
    expect(Object.keys(note.files).every((f) => note.rows[0].files.includes(f))).toBe(true);
    expect(note.statement.capabilities.map((c) => c.id)).toEqual(['auth', 'shop']);
    expect(note.statement.capabilities[0]).toMatchObject({ enforce: 'observe' });
  });

  // [claims: capabilities/proof-store#store-publish-ci-only]
  it('--force-local writes a provisional note that is not pushed and that readers treat as local evidence', async () => {
    const repo = await repoWith({ login: 'local', logout: 'local' });
    const remote = bareRemote();
    sh(repo.dir, 'remote', 'add', 'origin', remote);
    const config = await loadConfig(repo.dir);
    const head = sh(repo.dir, 'rev-parse', 'HEAD');
    // a local-origin row is not CI evidence: in CI it would not be written
    expect((await runProofPublish(config, { env: CI })).exitCode).toBe(ExitCode.ValidationFailed);

    const out = await runProofPublish(config, { env: {}, forceLocal: true });
    expect(out.exitCode).toBe(0);
    expect(out.messages.join('\n')).toContain('provisional (local evidence)');
    expect(sh(remote, 'for-each-ref', 'refs/notes')).toBe('');
    expect((await noteOf(repo, head)).ci.event).toBe('local');

    const eff = await loadEffectiveLedger(config);
    expect(eff.note).toMatchObject({ commit: head, provisional: true });
    expect(eff.ledger.proofs[LOGIN].origin).toBe('local');
    expect(evidenceSourceLabel(eff, 'capabilities/auth')).toBe('local (provisional)');
    expect(eff.sourceOf.get(rowKey(LOGIN, 'unclassified'))).toMatchObject({ kind: 'note' });
  });

  // [claims: capabilities/proof-store#store-publish-ci-only]
  it('refuses a commit that is not checked out, a tree whose proof files differ from the commit, and a run with nothing fresh', async () => {
    const repo = await repoWith({ login: 'ci', logout: 'ci' });
    const config = await loadConfig(repo.dir);
    repo.write('extra.txt', 'x');
    sh(repo.dir, 'add', '-A');
    sh(repo.dir, 'commit', '-q', '-m', 'second');
    const previous = sh(repo.dir, 'rev-parse', 'HEAD~1');
    const notHead = await runProofPublish(config, { env: CI, noPush: true, commit: previous });
    expect(notHead.exitCode).toBe(ExitCode.ValidationFailed);
    expect(notHead.messages.join('\n')).toMatch(/checked-out commit/);
    expect((await runProofPublish(config, { env: CI, noPush: true, commit: '--output=x' })).exitCode).toBe(ExitCode.ValidationFailed);

    // edited without new proof: nothing is fresh
    repo.write('src/auth/login.ts', 'export const login = 2;\n');
    const nothing = await runProofPublish(config, { env: CI, noPush: true });
    expect(nothing.exitCode).toBe(ExitCode.ValidationFailed);
    expect(nothing.messages.join('\n')).toMatch(/no CI evidence is fresh/);
    // proved on the edited file: fresh, but the note would not describe the commit
    await ingestVerdicts({ runId: 'run-2', verdicts: [{ claim: LOGIN, verdict: 'proven' }, { claim: LOGOUT, verdict: 'proven' }] }, repo.dir, { provenance: { origin: 'ci' } });
    const dirty = await runProofPublish(config, { env: CI, noPush: true });
    expect(dirty.exitCode).toBe(ExitCode.ValidationFailed);
    expect(dirty.messages.join('\n')).toMatch(/differ from commit .*src\/auth\/login\.ts/);
    expect(sh(repo.dir, 'for-each-ref', 'refs/notes')).toBe('');
  });

  // [claims: capabilities/proof-store#store-concurrent-writers]
  it('a second publish for the same commit merges into the note rather than replacing it, and refreshes the statement', async () => {
    const repo = await repoWith({ login: 'ci', logout: 'ci' });
    const config = await loadConfig(repo.dir);
    const head = sh(repo.dir, 'rev-parse', 'HEAD');
    expect((await runProofPublish(config, { env: CI, noPush: true })).exitCode).toBe(0);
    const again = await runProofPublish(config, { env: CI, noPush: true });
    expect(again.messages.join('\n')).toContain('merged with an existing note on this commit');
    const note = await noteOf(repo, head);
    expect(note.rows.map((r) => r.claim).sort()).toEqual([LOGIN, LOGOUT]);
    expect(note.statement.level).toBeDefined();
  });
});

describe('proof fetch, notes and prune [proof-store]', () => {
  // [claims: capabilities/proof-store#store-fetch-and-configure]
  it('fetch brings the notes a CI job pushed; a quiet fetch says nothing; --if-older skips a fresh fetch; autoFetch off skips the background form', async () => {
    const author = await repoWith({ login: 'ci', logout: 'ci' });
    const remote = bareRemote();
    sh(author.dir, 'remote', 'add', 'origin', remote);
    sh(author.dir, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    expect((await runProofPublish(await loadConfig(author.dir), { env: CI, sleep: noSleep })).exitCode).toBe(0);

    const reader = cloneOf(remote);
    const config = await loadConfig(reader.dir);
    expect(sh(reader.dir, 'for-each-ref', 'refs/notes')).toBe('');
    const first = await runProofFetch(config, { configure: true });
    expect(first.exitCode).toBe(0);
    expect(first.messages.join('\n')).toMatch(/added \+refs\/notes\/specguard.*\n.*fetched refs\/notes\/specguard from origin: 1 commit\(s\)/);
    expect((await runProofFetch(config, { configure: true })).messages[0]).toMatch(/already brings/);
    expect((await loadEffectiveLedger(config)).note).toMatchObject({ commit: reader.head(), distance: 0 });

    const quiet = await runProofFetch(config, { quiet: true });
    expect(quiet).toMatchObject({ messages: [], exitCode: 0 });
    const skipped = await runProofFetch(config, { ifOlder: '10m' });
    expect(skipped.skipped).toBe(1);
    expect(skipped.messages.join('\n')).toMatch(/nothing to do/);
    const later = await runProofFetch(config, { ifOlder: '10m', now: new Date(Date.now() + 3_600_000) });
    expect(later.created).toBe(1);
    expect((await runProofFetch({ ...config, proofStore: { ...config.proofStore, autoFetch: 'off' } }, { ifOlder: '1s', now: new Date(Date.now() + 3_600_000) })).messages.join('\n')).toMatch(/autoFetch is off/);
    expect((await runProofFetch(config, { ifOlder: 'soon' })).exitCode).toBe(ExitCode.ValidationFailed);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('2 weeks')).toBeUndefined();
  });

  // [claims: capabilities/proof-store#store-fetch-and-configure]
  it('with no notes on the remote fetch says CI has not written any yet and succeeds; an unreachable remote fails, and a quiet one does not', async () => {
    const repo = await repoWith({ login: 'local', logout: 'local' });
    const config = await loadConfig(repo.dir);
    expect((await runProofFetch(config)).messages.join('\n')).toMatch(/no remote "origin"/);
    sh(repo.dir, 'remote', 'add', 'origin', bareRemote());
    const none = await runProofFetch(config);
    expect(none.exitCode).toBe(0);
    expect(none.messages.join('\n')).toContain('proofs: no CI notes yet; they appear after the first CI run');
    sh(repo.dir, 'remote', 'set-url', 'origin', path.join(repo.dir, 'no-such-remote'));
    const down = await runProofFetch(config);
    expect(down.exitCode).toBe(ExitCode.InternalError);
    expect(down.messages.join('\n')).toMatch(/did not answer/);
    expect((await runProofFetch(config, { quiet: true })).exitCode).toBe(0);
  });

  // [claims: capabilities/proof-store#store-fetch-and-configure]
  it('notes summarizes the nearest note, the note on a commit, and says so when there is none', async () => {
    const repo = await repoWith({ login: 'ci', logout: 'ci' });
    const config = await loadConfig(repo.dir);
    const head = sh(repo.dir, 'rev-parse', 'HEAD');
    const none = await runProofNotes(config);
    expect(none.skipped).toBe(1);
    expect(none.messages.join('\n')).toContain('no CI notes yet');

    await runProofPublish(config, { env: CI, noPush: true });
    const shown = await runProofNotes(config);
    const text = shown.messages.join('\n');
    expect(text).toContain('1 commit(s) have a proof note');
    expect(text).toContain(`note @${head.slice(0, 7)} (HEAD)`);
    expect(text).toMatch(/rows: 2 \(2 proven\)/);
    expect(text).toMatch(/effective evidence here: 2 row\(s\) from the note, 0 from the local cache/);
    expect(shown.items.map((i) => i.key)).toEqual(['auth', 'shop']);

    expect((await runProofNotes(config, { commit: head })).messages.join('\n')).toContain('statement:');
    expect((await runProofNotes(config, { commit: 'HEAD~0' })).exitCode).toBe(0);
    expect((await runProofNotes(config, { commit: '--all' })).exitCode).toBe(ExitCode.ValidationFailed);
  });

  // [claims: capabilities/proof-store#store-prune-reachable]
  it('prune lists notes of unreachable old commits without --yes, removes them with it, and keeps notes on branches', async () => {
    const repo = await repoWith({ login: 'ci', logout: 'ci' });
    const config = await loadConfig(repo.dir);
    await runProofPublish(config, { env: CI, noPush: true });
    sh(repo.dir, 'checkout', '-q', '-b', 'gone');
    repo.write('g.txt', 'g');
    sh(repo.dir, 'add', '-A');
    sh(repo.dir, 'commit', '-q', '-m', 'gone');
    const orphan = sh(repo.dir, 'rev-parse', 'HEAD');
    const note = await noteOf(repo, sh(repo.dir, 'rev-parse', 'HEAD~1'));
    const copy = path.join(repo.dir, '.git', 'orphan-note.json');
    writeFileSync(copy, JSON.stringify({ ...note, commit: orphan, tree: sh(repo.dir, 'rev-parse', 'HEAD^{tree}'), createdAt: '2026-01-01T00:00:00.000Z' }));
    sh(repo.dir, 'notes', '--ref=refs/notes/specguard', 'add', '-C', sh(repo.dir, 'hash-object', '-w', copy), orphan);
    sh(repo.dir, 'checkout', '-q', 'main');
    sh(repo.dir, 'branch', '-D', 'gone');

    const dry = await runProofPrune(config, { days: 30 });
    expect(dry.messages.join('\n')).toMatch(/1 proof note\(s\).*run with --yes/);
    expect(dry.items.map((i) => i.key)).toEqual([orphan]);
    expect(sh(repo.dir, 'notes', '--ref=refs/notes/specguard', 'list').split('\n')).toHaveLength(2);

    const done = await runProofPrune(config, { days: 30, yes: true });
    expect(done.updated).toBe(1);
    expect(sh(repo.dir, 'notes', '--ref=refs/notes/specguard', 'list').split('\n')).toHaveLength(1);
    expect((await runProofPrune(config, { days: 0 })).exitCode).toBe(ExitCode.ValidationFailed);
  });
});
