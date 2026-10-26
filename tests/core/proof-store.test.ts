import { createHash } from 'node:crypto';
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { NOTE_HARD_LIMIT, NOTE_SOFT_LIMIT, noteDigest, parseNote, serializeNote, type NoteRow } from '../../src/core/proof-note.js';
import {
  configureNotesFetch,
  deepenUntilNoted,
  fetchNotes,
  listNoted,
  nearestNoted,
  notesWithTree,
  pruneNotes,
  readNote,
  redactGitText,
  resolveCommit,
  resolveNotesConfig,
  writeAndPushNote,
} from '../../src/core/proof-store.js';
import { addRemote, bareRemote, cloneOf, newRepo, sh, testNote } from '../helpers/notes-git.js';

const cfg = resolveNotesConfig();
const noSleep = async (): Promise<void> => undefined;

/** Store a raw text as the note of `commit`, the way a writer of any version would. */
function putRaw(dir: string, commit: string, text: string): void {
  const file = path.join(dir, '.git', 'raw-note.txt');
  writeFileSync(file, text);
  const blob = sh(dir, 'hash-object', '-w', file);
  sh(dir, 'notes', `--ref=${cfg.notesRef}`, 'add', '-f', '-C', blob, commit);
}

describe('proof store git plumbing [proof-store]', () => {
  // [claims: capabilities/proof-store#store-git-safe-args]
  it('refuses a notes ref, a remote or a commit name that git could read as an option', async () => {
    expect(() => resolveNotesConfig({ notesRef: '--upload-pack=touch-x' })).toThrow(/notes ref/);
    expect(() => resolveNotesConfig({ notesRef: 'refs/notes/../heads/main' })).toThrow(/notes ref/);
    expect(() => resolveNotesConfig({ remote: '--upload-pack=touch-x' })).toThrow(/remote/);
    expect(resolveNotesConfig({})).toEqual({ notesRef: 'refs/notes/specguard', remote: 'origin', maxWalk: 500, verify: 'off' });
    expect(resolveNotesConfig({ verify: 'check-run', maxWalk: 7 })).toMatchObject({ verify: 'check-run', maxWalk: 7 });

    const repo = newRepo();
    const victim = path.join(repo.dir, 'pwned');
    for (const bad of [`--output=${victim}`, '-n', '--all', 'HEAD --output=x', '']) {
      expect(resolveCommit(repo.dir, bad), bad).toBeUndefined();
      expect(readNote(repo.dir, cfg, bad), bad).toBeUndefined();
      expect(nearestNoted(repo.dir, cfg, bad).commit, bad).toBeUndefined();
    }
    const refused = await writeAndPushNote(repo.dir, cfg, testNote('--output=pwned'), { push: false });
    expect(refused).toMatchObject({ written: false });
    expect(existsSync(victim)).toBe(false);
  });

  // [claims: capabilities/proof-store#store-git-safe-args]
  it('never lets a credential in a git message reach the output', () => {
    expect(redactGitText('fatal: unable to access https://user:s3cret@host/o/r.git/: failed')).toBe('fatal: unable to access https://***@host/o/r.git/: failed');
    expect(redactGitText('Authorization: Bearer abc123')).toBe('Authorization: Bearer ***');
  });

  // [claims: capabilities/proof-store#store-fetch-and-configure]
  it('fetchNotes reports no-remote, no-ref-on-remote, offline, and then fetches once a note is pushed; the missing ref reads as no notes', async () => {
    const repo = newRepo();
    expect(fetchNotes(repo.dir, cfg)).toMatchObject({ fetched: false, reason: 'no-remote' });
    expect(listNoted(repo.dir, cfg).size).toBe(0);
    expect(nearestNoted(repo.dir, cfg, repo.head())).toEqual({ truncated: false, warnings: [] });

    const remote = bareRemote();
    addRemote(repo, remote);
    expect(fetchNotes(repo.dir, cfg)).toMatchObject({ fetched: false, reason: 'no-ref-on-remote', shallow: false });

    const writer = cloneOf(remote);
    const commit = writer.commit('a.txt', 'a');
    expect(await writeAndPushNote(writer.dir, cfg, testNote(commit), { push: true, sleep: noSleep })).toMatchObject({ written: true, pushed: true });
    expect(fetchNotes(repo.dir, cfg)).toMatchObject({ fetched: true });
    expect(listNoted(repo.dir, cfg).has(commit)).toBe(true);

    sh(repo.dir, 'remote', 'set-url', 'origin', path.join(remote, 'nope'));
    expect(fetchNotes(repo.dir, cfg)).toMatchObject({ fetched: false, reason: 'offline' });
  });

  // [claims: capabilities/proof-store#store-fetch-and-configure]
  it('configureNotesFetch adds the notes refspec once and is idempotent', () => {
    const repo = newRepo();
    expect(configureNotesFetch(repo.dir, cfg)).toEqual({ changed: false });
    addRemote(repo, bareRemote());
    expect(configureNotesFetch(repo.dir, cfg)).toEqual({ changed: true });
    expect(configureNotesFetch(repo.dir, cfg)).toEqual({ changed: false });
    const specs = sh(repo.dir, 'config', '--get-all', 'remote.origin.fetch').split('\n');
    expect(specs.filter((s) => s === '+refs/notes/specguard:refs/notes/specguard')).toHaveLength(1);
  });

  // [claims: capabilities/proof-store#store-write-and-limits]
  it('writeAndPushNote creates the ref, stores the bytes serializeNote wrote (so the digest matches) and pushes', async () => {
    const remote = bareRemote();
    const repo = cloneOf(remote);
    const commit = repo.commit('a.txt', 'a');
    const note = testNote(commit, { tree: repo.tree() });
    const out = await writeAndPushNote(repo.dir, cfg, note, { push: true, sleep: noSleep });
    expect(out).toMatchObject({ written: true, pushed: true, attempts: 1, merged: false });
    if (!out.written) throw new Error('unreachable');
    expect(out.digest).toBe(noteDigest(serializeNote(note)));
    // the stored blob hashes to the digest, and the remote has the ref
    const stored = sh(repo.dir, 'notes', `--ref=${cfg.notesRef}`, 'show', commit);
    expect(createHash('sha256').update(`${stored}\n`).digest('hex')).toBe(out.digest);
    expect(sh(remote, 'notes', `--ref=${cfg.notesRef}`, 'list')).toContain(commit);
    const read = readNote(repo.dir, cfg, commit);
    expect(read?.ok && read.note.commit).toBe(commit);
  });

  // [claims: capabilities/proof-store#store-write-and-limits]
  it('a note over the soft limit is written trimmed with a warning, and one over the hard limit is refused', async () => {
    const repo = newRepo();
    const commit = repo.head();
    const heavy = testNote(commit);
    heavy.rows = Array.from({ length: 20 }, (_, i) => ({ ...heavy.rows[0], claim: `capabilities/cart#c${i}`, evidencePath: 'x'.repeat(60_000) }) as NoteRow);
    expect(Buffer.byteLength(serializeNote(heavy))).toBeGreaterThan(NOTE_SOFT_LIMIT);
    const out = await writeAndPushNote(repo.dir, cfg, heavy, { push: false });
    expect(out.written && out.warnings.join(' ')).toMatch(/soft limit/);
    const stored = readNote(repo.dir, cfg, commit);
    expect(stored?.ok && stored.note.rows).toHaveLength(20);
    expect(stored?.ok && 'evidencePath' in stored.note.rows[0]).toBe(false);

    const other = repo.commit('b.txt', 'b');
    const huge = testNote(other);
    huge.ci.workflow = 'x'.repeat(NOTE_HARD_LIMIT + 10);
    const refused = await writeAndPushNote(repo.dir, cfg, huge, { push: false });
    expect(refused).toMatchObject({ written: false });
    expect(!refused.written && refused.reason).toMatch(/hard limit/);
    expect(readNote(repo.dir, cfg, other)).toBeUndefined();
  });

  // [claims: capabilities/proof-store#store-concurrent-writers]
  it('two writers on different commits both land: a push that loses the race is fetched, re-applied and pushed again', async () => {
    const remote = bareRemote();
    const a = cloneOf(remote);
    const b = cloneOf(remote);
    const a1 = a.commit('a.txt', '1');
    const a2 = a.commit('a.txt', '2');
    const b1 = b.commit('b.txt', '1');
    expect(await writeAndPushNote(a.dir, cfg, testNote(a1), { push: true, sleep: noSleep })).toMatchObject({ pushed: true });

    // Between b's fetch and b's push, a pushes another note: b's first push is not a fast-forward.
    const marker = path.join(b.dir, '.git', 'raced');
    const hook = path.join(b.dir, '.git', 'hooks', 'pre-push');
    writeFileSync(
      hook,
      `#!/bin/sh\nif [ ! -f "${marker}" ]; then\n  : > "${marker}"\n  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE\n  git -C "${a.dir}" notes --ref=${cfg.notesRef} add -f -m raced ${a2}\n  git -C "${a.dir}" push -q origin ${cfg.notesRef}:${cfg.notesRef}\nfi\nexit 0\n`,
    );
    chmodSync(hook, 0o755);

    let waits = 0;
    const out = await writeAndPushNote(b.dir, cfg, testNote(b1), { push: true, sleep: async () => void (waits += 1) });
    expect(out).toMatchObject({ written: true, pushed: true, attempts: 2 });
    expect(waits).toBe(1);
    const landed = sh(remote, 'notes', `--ref=${cfg.notesRef}`, 'list').split('\n').map((l) => l.split(' ')[1]);
    expect(landed.sort()).toEqual([a1, a2, b1].sort());
  });

  // [claims: capabilities/proof-store#store-concurrent-writers]
  it('a same-commit re-run merges rows rather than replacing, refreshes the summary, and the result does not depend on who lands first', async () => {
    const repo = newRepo();
    const commit = repo.head();
    const first = testNote(commit, { createdAt: '2026-10-25T00:00:00.000Z' });
    const second = testNote(commit, { createdAt: '2026-10-25T01:00:00.000Z' });
    second.rows = [{ ...second.rows[0], claim: 'capabilities/cart#tax', runId: 'run-2', ingestedAt: '2026-10-25T01:00:00.000Z' }];
    await writeAndPushNote(repo.dir, cfg, first, { push: false });
    let refreshed = 0;
    const out = await writeAndPushNote(repo.dir, cfg, second, {
      push: false,
      refresh: (merged) => {
        refreshed += 1;
        return { ...merged, statement: { ...merged.statement, level: 'provisional' } };
      },
    });
    expect(out).toMatchObject({ written: true, merged: true });
    expect(refreshed).toBe(1);
    const stored = readNote(repo.dir, cfg, commit);
    if (!stored?.ok) throw new Error('note missing');
    expect(stored.note.rows.map((r) => r.claim)).toEqual(['capabilities/cart#fee', 'capabilities/cart#tax']);
    expect(stored.note.statement.level).toBe('provisional');

    // the other order gives the same rows
    const other = newRepo();
    const c2 = other.head();
    await writeAndPushNote(other.dir, cfg, testNote(c2, { createdAt: second.createdAt, rows: second.rows.map((r) => ({ ...r, provedAt: c2 })) }), { push: false });
    await writeAndPushNote(other.dir, cfg, testNote(c2, { createdAt: first.createdAt }), { push: false });
    const swapped = readNote(other.dir, cfg, c2);
    expect(swapped?.ok && swapped.note.rows.map((r) => r.claim)).toEqual(['capabilities/cart#fee', 'capabilities/cart#tax']);
  });

  // [claims: capabilities/proof-store#store-nearest-ancestor]
  it('nearestNoted finds the note two commits back with its distance, and reads a note on HEAD at distance 0', () => {
    const repo = newRepo();
    const c1 = repo.commit('a.txt', '1');
    putRaw(repo.dir, c1, serializeNote(testNote(c1)));
    repo.commit('a.txt', '2');
    const head = repo.commit('a.txt', '3');
    const found = nearestNoted(repo.dir, cfg, head);
    expect(found.commit).toBe(c1);
    expect('distance' in found && found.distance).toBe(2);
    putRaw(repo.dir, head, serializeNote(testNote(head)));
    const own = nearestNoted(repo.dir, cfg, head);
    expect('distance' in own && own.distance).toBe(0);
  });

  // [claims: capabilities/proof-store#store-nearest-ancestor]
  it('stops at maxWalk and reports the walk as truncated, and never reads a note on a commit that is not an ancestor (a fork pull request head)', () => {
    const repo = newRepo();
    const base = repo.head();
    putRaw(repo.dir, base, serializeNote(testNote(base)));
    repo.commit('a.txt', '1');
    repo.commit('a.txt', '2');
    const head = repo.commit('a.txt', '3');
    const short = nearestNoted(repo.dir, resolveNotesConfig({ maxWalk: 2 }), head);
    expect(short).toEqual({ truncated: true, warnings: [] });

    // a side branch the checkout does not contain, as a fork's pull request head would be
    sh(repo.dir, 'checkout', '-q', '-b', 'fork-pr', base);
    const forkHead = repo.commit('f.txt', 'fork');
    putRaw(repo.dir, forkHead, serializeNote(testNote(forkHead)));
    sh(repo.dir, 'checkout', '-q', 'main');
    const mainHead = repo.head();
    expect(mainHead).toBe(head);
    const seen = nearestNoted(repo.dir, cfg, mainHead);
    expect(seen.commit).toBe(base);
  });

  // [claims: capabilities/proof-store#store-nearest-ancestor]
  it('skips a note of a newer version, a corrupt note and a note filed under another commit, each with a warning, and walks on to an older note', () => {
    const repo = newRepo();
    const c1 = repo.commit('a.txt', '1');
    putRaw(repo.dir, c1, serializeNote(testNote(c1)));
    const c2 = repo.commit('a.txt', '2');
    putRaw(repo.dir, c2, JSON.stringify({ ...testNote(c2), version: 99, shape: 'unknown' }));
    const c3 = repo.commit('a.txt', '3');
    putRaw(repo.dir, c3, '{not json');
    const c4 = repo.commit('a.txt', '4');
    putRaw(repo.dir, c4, serializeNote(testNote(c1)));
    const head = repo.commit('a.txt', '5');

    const found = nearestNoted(repo.dir, cfg, head);
    expect(found.commit).toBe(c1);
    expect(found.warnings).toHaveLength(3);
    expect(found.warnings.join('\n')).toMatch(/newer SpecGuard wrote the proof note on .*upgrade/);
    expect(found.warnings.join('\n')).toMatch(/not readable \(not-json/);
    expect(found.warnings.join('\n')).toMatch(/says it is for/);
    // the newer note keeps what the reader cannot parse: it is reported by name, not misread
    const newer = readNote(repo.dir, cfg, c2);
    expect(newer).toMatchObject({ ok: false, reason: 'newer-version' });
    expect(parseNote(serializeNote(testNote(c1))).ok).toBe(true);
  });

  // [claims: capabilities/proof-store#store-shallow-clone]
  it('in a shallow clone the walk is truncated; deepenUntilNoted finds the noted ancestor', async () => {
    const remote = bareRemote();
    const author = cloneOf(remote);
    const c1 = author.commit('a.txt', '1');
    author.commit('a.txt', '2');
    author.commit('a.txt', '3');
    sh(author.dir, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    await writeAndPushNote(author.dir, cfg, testNote(c1), { push: true, sleep: noSleep });

    const shallow = cloneOf(remote, { depth: 1 });
    expect(fetchNotes(shallow.dir, cfg)).toMatchObject({ fetched: true, shallow: true });
    const before = nearestNoted(shallow.dir, cfg, shallow.head());
    expect(before).toMatchObject({ truncated: true });
    expect(before.commit).toBeUndefined();

    const deepened = deepenUntilNoted(shallow.dir, cfg, shallow.head());
    expect(deepened.found).toBe(true);
    expect(deepened.deepenedBy).toBeGreaterThan(0);
    expect(nearestNoted(shallow.dir, cfg, shallow.head()).commit).toBe(c1);
  });

  // [claims: capabilities/proof-store#store-squash-import]
  it('notesWithTree finds the pull request head note for a squash commit with the same tree, and only newer notes when asked', () => {
    const repo = newRepo();
    sh(repo.dir, 'checkout', '-q', '-b', 'feature');
    const f1 = repo.commit('f.txt', 'one');
    const f2 = repo.commit('f.txt', 'two');
    putRaw(repo.dir, f2, serializeNote(testNote(f2, { tree: repo.tree(f2), createdAt: '2026-10-20T00:00:00.000Z' })));
    putRaw(repo.dir, f1, serializeNote(testNote(f1, { tree: repo.tree(f1) })));

    sh(repo.dir, 'checkout', '-q', 'main');
    sh(repo.dir, 'merge', '--squash', 'feature');
    sh(repo.dir, 'commit', '-q', '-m', 'squash');
    const squash = repo.head();
    expect(squash).not.toBe(f2);
    expect(repo.tree(squash)).toBe(repo.tree(f2));

    const hits = notesWithTree(repo.dir, cfg, repo.tree(squash));
    expect(hits.map((h) => h.commit)).toEqual([f2]);
    expect(notesWithTree(repo.dir, cfg, repo.tree(squash), '2026-10-21T00:00:00.000Z')).toEqual([]);
    expect(notesWithTree(repo.dir, cfg, '--not-a-tree')).toEqual([]);
  });

  // [claims: capabilities/proof-store#store-prune-reachable]
  it('pruneNotes removes only old notes of unreachable commits, and a dry run removes nothing', () => {
    const repo = newRepo();
    const reachable = repo.commit('a.txt', '1');
    sh(repo.dir, 'checkout', '-q', '-b', 'old');
    const orphan = repo.commit('o.txt', 'o');
    sh(repo.dir, 'checkout', '-q', 'main');
    sh(repo.dir, 'branch', '-D', 'old');
    const young = (() => {
      sh(repo.dir, 'checkout', '-q', '-b', 'tmp');
      const c = repo.commit('y.txt', 'y');
      sh(repo.dir, 'checkout', '-q', 'main');
      sh(repo.dir, 'branch', '-D', 'tmp');
      return c;
    })();
    putRaw(repo.dir, reachable, serializeNote(testNote(reachable, { createdAt: '2026-01-01T00:00:00.000Z' })));
    putRaw(repo.dir, orphan, serializeNote(testNote(orphan, { createdAt: '2026-01-01T00:00:00.000Z' })));
    putRaw(repo.dir, young, serializeNote(testNote(young, { createdAt: '2026-10-20T00:00:00.000Z' })));
    const now = new Date('2026-10-25T00:00:00.000Z');

    expect(pruneNotes(repo.dir, cfg, 90, { dryRun: true, now })).toEqual({ removed: [orphan] });
    expect(listNoted(repo.dir, cfg).size).toBe(3);
    expect(pruneNotes(repo.dir, cfg, 90, { now })).toEqual({ removed: [orphan] });
    const left = [...listNoted(repo.dir, cfg).keys()].sort();
    expect(left).toEqual([reachable, young].sort());
  });
});
