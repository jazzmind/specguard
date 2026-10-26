/**
 * Git plumbing of the proof store: the notes ref that holds one proof note per proven commit. Reads the nearest noted
 * ancestor of a commit, fetches the ref, and (in CI) writes and pushes a note. Impure on purpose: every call is `git`
 * through `execFileSync` with an argument array, never a shell, and every ref, remote and commit name that reaches
 * git is checked first so none can be read as an option.
 *
 * Concurrent writers never merge notes with git. They fetch the remote tip, re-apply their note on top of it and push
 * without force; a rejected push repeats the three steps. A line-merging strategy would interleave the lines of two
 * JSON documents and corrupt them.
 *
 * Spec: specs/capabilities/proof-store.md
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isSafeBaseRef } from './change-base.js';
import { SpecGuardError } from './errors.js';
import { ExitCode } from './exit-codes.js';
import { parsePorcelain } from './git-scope.js';
import { fitNote, mergeNotes, noteDigest, parseNote, type NoteParse, type ProofNote } from './proof-note.js';
import { PROOF_STORE_DEFAULTS, type ProofStoreConfig } from './types.js';

export interface NotesConfig {
  /** Notes ref, `refs/notes/specguard` by default. */
  notesRef: string;
  /** Remote notes are fetched from and pushed to. */
  remote: string;
  /** Commits walked looking for the nearest noted ancestor. */
  maxWalk: number;
  /** `off` (default) never checks a note against a CI check run; `check-run` does. */
  verify: 'off' | 'check-run';
}

const NOTES_REF = /^refs\/notes\/[\w][\w./-]*$/;
const REMOTE_NAME = /^[\w][\w.-]*$/;
const COMMIT_SHA = /^[0-9a-f]{4,64}$/i;
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const GIT_BUFFER = 512 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 120_000;
/** Notes read per `cat-file --batch` call, so a notes ref with thousands of notes is never held in memory at once. */
const BLOB_CHUNK = 200;

/** A notes ref that cannot be read as an option and cannot climb out of `refs/notes/`. */
export function isSafeNotesRef(ref: string): boolean {
  return NOTES_REF.test(ref) && !ref.includes('..') && !ref.endsWith('/') && !ref.endsWith('.lock') && !ref.includes('//');
}

/** A remote name (not a URL) that cannot be read as an option. */
export function isSafeRemoteName(name: string): boolean {
  return REMOTE_NAME.test(name) && !name.includes('..');
}

/** A hex object name or a ref name git can resolve to a commit; anything that could be read as an option is refused. */
export function isSafeCommitish(ref: string): boolean {
  return COMMIT_SHA.test(ref) || isSafeBaseRef(ref);
}

/** The settings with defaults filled in. Throws on a value git could read as an option, whatever the config validation let through. */
export function resolveNotesConfig(cfg?: ProofStoreConfig): NotesConfig {
  const notesRef = cfg?.notesRef ?? PROOF_STORE_DEFAULTS.notesRef;
  const remote = cfg?.remote ?? PROOF_STORE_DEFAULTS.remote;
  if (!isSafeNotesRef(notesRef)) throw new SpecGuardError(`proofStore.notesRef "${notesRef.slice(0, 80)}" is not a usable notes ref (it must start with refs/notes/)`, ExitCode.InternalError);
  if (!isSafeRemoteName(remote)) throw new SpecGuardError(`proofStore.remote "${remote.slice(0, 80)}" is not a usable remote name`, ExitCode.InternalError);
  const maxWalk = Number.isInteger(cfg?.maxWalk) && (cfg?.maxWalk as number) >= 1 ? (cfg?.maxWalk as number) : PROOF_STORE_DEFAULTS.maxWalk;
  return { notesRef, remote, maxWalk, verify: cfg?.verify === 'check-run' ? 'check-run' : 'off' };
}

// ---------------------------------------------------------------------------
// Running git
// ---------------------------------------------------------------------------

interface GitOut {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Credentials a remote URL or a header may carry never reach a message. */
export function redactGitText(text: string): string {
  return text
    .replace(/(\w+:\/\/)[^\s/@]+@/g, '$1***@')
    .replace(/(authorization:\s*\S+\s+)\S+/gi, '$1***')
    .replace(/(x-access-token:)\S+/gi, '$1***');
}

function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Never ask for a password, and keep messages in English so failures can be classified.
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...extra };
}

function git(root: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv; network?: boolean } = {}): GitOut {
  try {
    const stdout = execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      input: opts.input,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: GIT_BUFFER,
      env: gitEnv(opts.env),
      ...(opts.network ? { timeout: NETWORK_TIMEOUT_MS } : {}),
    });
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const e = err as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return { ok: false, stdout: String(e.stdout ?? ''), stderr: redactGitText(String(e.stderr ?? e.message ?? '')) };
  }
}

const lines = (text: string): string[] => text.split('\n').map((l) => l.trim()).filter((l) => l !== '');

/** The commit `ref` names, as a full object name; undefined when it does not resolve or could be read as an option. */
export function resolveCommit(root: string, ref: string): string | undefined {
  if (!isSafeCommitish(ref)) return undefined;
  const out = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = out.stdout.trim();
  return out.ok && FULL_SHA.test(sha) ? sha : undefined;
}

export function headCommit(root: string): string | undefined {
  return resolveCommit(root, 'HEAD');
}

export function isShallow(root: string): boolean {
  return git(root, ['rev-parse', '--is-shallow-repository']).stdout.trim() === 'true';
}

/** A commit's tree and parents, as a note records them. */
export function commitInfo(root: string, commit: string): { commit: string; tree: string; parents: string[] } | undefined {
  const sha = resolveCommit(root, commit);
  if (!sha) return undefined;
  const tree = git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]).stdout.trim();
  const parents = lines(git(root, ['rev-list', '--parents', '-n', '1', sha]).stdout)[0]?.split(/\s+/).slice(1) ?? [];
  return tree ? { commit: sha, tree, parents } : undefined;
}

/** Files the working tree changes against HEAD (modified, staged, untracked), as git names them. */
export function changedFiles(root: string): string[] {
  const out = git(root, ['status', '--porcelain', '-z', '--untracked-files=all']);
  return out.ok ? parsePorcelain(out.stdout) : [];
}

function remoteUrl(root: string, remote: string): string | undefined {
  const out = git(root, ['config', '--get', `remote.${remote}.url`]);
  return out.ok && out.stdout.trim() ? out.stdout.trim() : undefined;
}

export const hasNotesRef = (root: string, c: NotesConfig): boolean => git(root, ['rev-parse', '--verify', '--quiet', c.notesRef]).ok;

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

export type FetchOutcome = { fetched: boolean; reason?: 'no-remote' | 'no-ref-on-remote' | 'offline' | 'auth'; shallow: boolean; detail?: string };

/** Why a fetch or push failed, from git's message. Anything unrecognised reads as `offline`, the case a retry can fix. */
function classifyFailure(stderr: string): 'no-ref-on-remote' | 'auth' | 'offline' {
  if (/couldn't find remote ref/i.test(stderr)) return 'no-ref-on-remote';
  if (/authentication failed|could not read username|could not read password|permission denied|access denied|\b40[13]\b|invalid credentials/i.test(stderr)) return 'auth';
  return 'offline';
}

/** Where `proof fetch` records when it last succeeded (inside the git directory, so nothing is tracked). */
function fetchMarker(root: string): string | undefined {
  const out = git(root, ['rev-parse', '--git-path', 'specguard-notes-fetched']);
  return out.ok && out.stdout.trim() ? path.resolve(root, out.stdout.trim()) : undefined;
}

/** When the notes were last fetched by `proof fetch`; undefined when never (they may still have arrived through a configured refspec). */
export function notesFetchedAt(root: string): Date | undefined {
  const marker = fetchMarker(root);
  if (!marker) return undefined;
  try {
    return statSync(marker).mtime;
  } catch {
    return undefined;
  }
}

function markFetched(root: string, now: Date): void {
  const marker = fetchMarker(root);
  if (!marker) return;
  try {
    mkdirSync(path.dirname(marker), { recursive: true });
    writeFileSync(marker, `${now.toISOString()}\n`);
  } catch {
    /* the marker only drives an advisory reminder */
  }
}

/**
 * `git fetch <remote> +<ref>:<ref>`. Local runs never write notes, so a forced update loses nothing; CI re-applies its
 * note on top of the fetched tip. Never throws: a missing remote or ref, no network and a refused login are outcomes.
 */
export function fetchNotes(root: string, c: NotesConfig): FetchOutcome {
  const shallow = isShallow(root);
  if (!remoteUrl(root, c.remote)) return { fetched: false, reason: 'no-remote', shallow };
  const out = git(root, ['fetch', '--no-tags', '--quiet', '--no-recurse-submodules', '--', c.remote, `+${c.notesRef}:${c.notesRef}`], { network: true });
  if (!out.ok) return { fetched: false, reason: classifyFailure(out.stderr), shallow, detail: out.stderr.trim().slice(0, 300) };
  markFetched(root, new Date());
  return { fetched: true, shallow };
}

/** Adds `+<ref>:<ref>` to `remote.<r>.fetch` once, so a plain `git fetch` brings the notes. Opt-in and idempotent. */
export function configureNotesFetch(root: string, c: NotesConfig): { changed: boolean } {
  if (!remoteUrl(root, c.remote)) return { changed: false };
  const spec = `+${c.notesRef}:${c.notesRef}`;
  const existing = lines(git(root, ['config', '--get-all', `remote.${c.remote}.fetch`]).stdout);
  if (existing.includes(spec)) return { changed: false };
  return { changed: git(root, ['config', '--add', `remote.${c.remote}.fetch`, spec]).ok };
}

/** Deepens a shallow clone by `by` commits from its boundary. Returns whether git made progress. */
function deepen(root: string, c: NotesConfig, by: number): boolean {
  if (!remoteUrl(root, c.remote)) return false;
  return git(root, ['fetch', '--no-tags', '--quiet', `--deepen=${by}`, '--', c.remote], { network: true }).ok;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Commits with a note: `git notes list` parsed into commit -> note blob. Empty when the notes ref does not exist. */
export function listNoted(root: string, c: NotesConfig): Map<string, string> {
  const out = new Map<string, string>();
  if (!hasNotesRef(root, c)) return out;
  for (const line of lines(git(root, ['notes', `--ref=${c.notesRef}`, 'list']).stdout)) {
    const [blob, commit] = line.split(/\s+/);
    if (blob && commit && FULL_SHA.test(blob) && FULL_SHA.test(commit)) out.set(commit.toLowerCase(), blob.toLowerCase());
  }
  return out;
}

/** Blob contents by object name, one `cat-file --batch` call per chunk. Missing blobs are absent from the map. */
function readBlobs(root: string, shas: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < shas.length; i += BLOB_CHUNK) {
    const chunk = shas.slice(i, i + BLOB_CHUNK).filter((s) => FULL_SHA.test(s));
    if (chunk.length === 0) continue;
    let buf: Buffer;
    try {
      buf = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: `${chunk.join('\n')}\n`, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: GIT_BUFFER, env: gitEnv() });
    } catch {
      continue;
    }
    let pos = 0;
    while (pos < buf.length) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) break;
      const header = buf.toString('utf8', pos, nl).split(' ');
      pos = nl + 1;
      const size = Number.parseInt(header[2] ?? '', 10);
      if (header[1] !== 'blob' || !Number.isInteger(size) || size < 0) continue;
      out.set((header[0] ?? '').toLowerCase(), buf.toString('utf8', pos, pos + size));
      pos += size + 1;
    }
  }
  return out;
}

/** The note on `commit`: undefined when it has none, otherwise the parse (which may be a named failure). */
export function readNote(root: string, c: NotesConfig, commit: string): NoteParse | undefined {
  const sha = FULL_SHA.test(commit) ? commit.toLowerCase() : resolveCommit(root, commit);
  if (!sha || !hasNotesRef(root, c)) return undefined;
  const blob = git(root, ['notes', `--ref=${c.notesRef}`, 'list', sha]);
  const name = blob.stdout.trim();
  if (!blob.ok || !FULL_SHA.test(name)) return undefined;
  const text = readBlobs(root, [name]).get(name.toLowerCase());
  return text === undefined ? undefined : parseNote(text);
}

export type NearestNoted =
  | { commit: string; note: ProofNote; distance: number; warnings: string[] }
  | { commit?: undefined; truncated: boolean; warnings: string[] };

/**
 * Nearest noted ancestor of `head`, `head` itself first: walks `git rev-list --topo-order --max-count=<maxWalk>` and
 * returns the first commit whose note this reader supports. A note of a newer version, one that is not a proof note and
 * one filed under the wrong commit are skipped with a warning and the walk goes on. `truncated` is true when the walk
 * hit `maxWalk` or the shallow boundary before it found a note.
 */
export function nearestNoted(root: string, c: NotesConfig, head: string): NearestNoted {
  const warnings: string[] = [];
  const sha = resolveCommit(root, head);
  if (!sha) return { truncated: false, warnings };
  const noted = listNoted(root, c);
  const shallow = isShallow(root);
  if (noted.size === 0) return { truncated: false, warnings };
  const walk = lines(git(root, ['rev-list', '--topo-order', `--max-count=${c.maxWalk}`, sha]).stdout);
  for (let distance = 0; distance < walk.length; distance += 1) {
    const commit = walk[distance].toLowerCase();
    const blob = noted.get(commit);
    if (!blob) continue;
    const text = readBlobs(root, [blob]).get(blob);
    if (text === undefined) continue;
    const parsed = parseNote(text);
    const short = commit.slice(0, 7);
    if (!parsed.ok) {
      warnings.push(
        parsed.reason === 'newer-version'
          ? `a newer SpecGuard wrote the proof note on ${short}; upgrade to read it (looking further back)`
          : `the proof note on ${short} is not readable (${parsed.reason}: ${parsed.detail.slice(0, 120)}); skipped`,
      );
      continue;
    }
    if (parsed.note.commit.toLowerCase() !== commit) {
      warnings.push(`the proof note on ${short} says it is for ${parsed.note.commit.slice(0, 7)}; skipped`);
      continue;
    }
    return { commit, note: parsed.note, distance, warnings };
  }
  return { truncated: walk.length >= c.maxWalk || shallow, warnings };
}

/**
 * Notes recorded for a commit whose tree is `tree`, newest first: the squash and rebase merge import. `since` (an ISO
 * date) drops older notes. Notes are read in chunks and matched by a cheap text test before they are parsed.
 */
export function notesWithTree(root: string, c: NotesConfig, tree: string, since?: string): Array<{ commit: string; note: ProofNote }> {
  if (!/^[0-9a-f]{40,64}$/i.test(tree)) return [];
  const noted = listNoted(root, c);
  const needle = `"tree":"${tree.toLowerCase()}"`;
  const found: Array<{ commit: string; note: ProofNote }> = [];
  const entries = [...noted.entries()];
  for (let i = 0; i < entries.length; i += BLOB_CHUNK) {
    const chunk = entries.slice(i, i + BLOB_CHUNK);
    const texts = readBlobs(root, chunk.map(([, blob]) => blob));
    for (const [commit, blob] of chunk) {
      const text = texts.get(blob);
      if (text === undefined || !text.includes(needle)) continue;
      const parsed = parseNote(text);
      if (!parsed.ok || parsed.note.tree.toLowerCase() !== tree.toLowerCase() || parsed.note.commit.toLowerCase() !== commit) continue;
      if (since !== undefined && parsed.note.createdAt < since) continue;
      found.push({ commit, note: parsed.note });
    }
  }
  return found.sort((a, b) => (a.note.createdAt < b.note.createdAt ? 1 : a.note.createdAt > b.note.createdAt ? -1 : a.commit < b.commit ? -1 : 1));
}

/**
 * Deepens a shallow clone in steps of 50 commits until a noted ancestor of `head` appears or `maxWalk` commits were
 * added. A clone that is not shallow is left alone.
 */
export function deepenUntilNoted(root: string, c: NotesConfig, head: string): { deepenedBy: number; found: boolean } {
  let deepenedBy = 0;
  const found = (): boolean => nearestNoted(root, c, head).commit !== undefined;
  if (found()) return { deepenedBy, found: true };
  while (isShallow(root) && deepenedBy < c.maxWalk) {
    const step = Math.min(50, c.maxWalk - deepenedBy);
    if (!deepen(root, c, step)) break;
    deepenedBy += step;
    if (found()) return { deepenedBy, found: true };
  }
  return { deepenedBy, found: false };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface WriteOptions {
  /** Push to the remote after writing. False writes the local ref only. */
  push: boolean;
  /**
   * Re-derive the note-level fields that depend on the rows (the statement summary) after the note was merged with
   * another note of the same commit. Without it the merged note keeps the newer note's summary.
   */
  refresh?: (merged: ProofNote) => ProofNote | Promise<ProofNote>;
  /** Fetch, re-apply, push rounds. Default 5. */
  maxAttempts?: number;
  /** Jittered wait between rounds, in ms. Default 500 to 4000, doubling per round. */
  backoffMs?: { min: number; max: number };
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

export type WriteOutcome =
  | { written: true; pushed: boolean; attempts: number; digest: string; merged: boolean; warnings: string[]; pushError?: string }
  | { written: false; reason: string; bytes?: number };

/** A push git refused because the remote moved: worth fetching and trying again. Permission and hook refusals are not. */
const RETRYABLE_PUSH = /\(non-fast-forward\)|\(fetch first\)|\(stale info\)|cannot lock ref|failed to update ref|non-fast-forward/i;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Committing a note needs an identity; a runner that has none gets a neutral one, a configured one is never overridden. */
function identityEnv(root: string): NodeJS.ProcessEnv {
  const has = (key: string): boolean => git(root, ['config', key]).stdout.trim() !== '';
  const env: NodeJS.ProcessEnv = {};
  if (!has('user.name')) Object.assign(env, { GIT_AUTHOR_NAME: 'specguard', GIT_COMMITTER_NAME: 'specguard' });
  if (!has('user.email')) Object.assign(env, { GIT_AUTHOR_EMAIL: 'specguard@users.noreply.invalid', GIT_COMMITTER_EMAIL: 'specguard@users.noreply.invalid' });
  return env;
}

/**
 * CI only. Fetch the remote notes tip, merge with an existing note on the same commit (`mergeNotes`), add the note and
 * push without force; a push refused because the remote moved is fetched, re-applied and pushed again, at most
 * `maxAttempts` times with jittered backoff. The note is stored byte for byte as `serializeNote` wrote it, so its digest
 * is the one a check run can carry. A note over the hard size limit is not written. A push that fails for another reason
 * (a ruleset, no credentials) leaves the note written locally and reports the cause in `pushError`.
 */
export async function writeAndPushNote(root: string, c: NotesConfig, note: ProofNote, opts: WriteOptions): Promise<WriteOutcome> {
  const commit = note.commit.toLowerCase();
  if (!FULL_SHA.test(commit)) return { written: false, reason: `the note's commit "${note.commit.slice(0, 80)}" is not a full object name` };
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const sleep = opts.sleep ?? defaultSleep;
  const range = opts.backoffMs ?? { min: 500, max: 4000 };
  const env = identityEnv(root);
  let pushError: string | undefined;
  let last: { digest: string; merged: boolean; warnings: string[] } | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // The remote tip first, so the note is applied on top of whatever another job pushed. A failed fetch (no ref yet, offline) is not fatal here: the push says what is wrong.
    if (opts.push) fetchNotes(root, c);
    const existing = readNote(root, c, commit);
    let merged = false;
    let body: ProofNote = note;
    if (existing?.ok) {
      body = existing.note.commit.toLowerCase() === commit ? mergeNotes(existing.note, note) : note;
      merged = body !== note;
      if (merged && opts.refresh) body = await opts.refresh(body);
    } else if (existing?.reason === 'newer-version') {
      return { written: false, reason: `a newer SpecGuard wrote the proof note on ${commit.slice(0, 7)}; it is not overwritten` };
    }
    const fitted = fitNote(body);
    if ('refused' in fitted) return { written: false, reason: `the proof note is ${fitted.bytes} bytes, over the hard limit; keep it as a CI artifact instead`, bytes: fitted.bytes };

    const blob = git(root, ['hash-object', '-w', '--stdin'], { input: fitted.serialized });
    const blobName = blob.stdout.trim();
    if (!blob.ok || !FULL_SHA.test(blobName)) return { written: false, reason: `could not store the note: ${blob.stderr.trim().slice(0, 200)}` };
    const add = git(root, ['notes', `--ref=${c.notesRef}`, 'add', '-f', '-C', blobName, commit], { env });
    if (!add.ok) return { written: false, reason: `could not add the note: ${add.stderr.trim().slice(0, 200)}` };
    last = { digest: noteDigest(fitted.serialized), merged, warnings: fitted.warnings };
    if (!opts.push) return { written: true, pushed: false, attempts: attempt, ...last };

    const push = git(root, ['push', '--quiet', '--', c.remote, `${c.notesRef}:${c.notesRef}`], { network: true });
    if (push.ok) return { written: true, pushed: true, attempts: attempt, ...last };
    pushError = push.stderr.trim().slice(0, 400);
    if (!RETRYABLE_PUSH.test(push.stderr) || attempt === maxAttempts) {
      if (RETRYABLE_PUSH.test(push.stderr)) pushError = `gave up after ${attempt} attempts: ${pushError}`;
      break;
    }
    const ceiling = Math.min(range.max, range.min * 2 ** (attempt - 1));
    await sleep(Math.round(ceiling * (0.5 + Math.random() * 0.5)));
  }
  return { written: true, pushed: false, attempts: maxAttempts, ...(last as NonNullable<typeof last>), ...(pushError ? { pushError } : {}) };
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * Removes the notes of commits no branch, remote branch or tag reaches, when the note is older than `days`. A note on a
 * reachable commit is never touched, and a shallow clone (where reachability cannot be known) prunes nothing. With
 * `dryRun` it only reports what it would remove. A note that cannot be read is kept.
 */
export function pruneNotes(root: string, c: NotesConfig, days: number, opts: { dryRun?: boolean; now?: Date } = {}): { removed: string[]; skipped?: string } {
  if (isShallow(root)) return { removed: [], skipped: 'this is a shallow clone, so which commits are reachable is unknown' };
  const noted = listNoted(root, c);
  if (noted.size === 0) return { removed: [] };
  const reachable = new Set(lines(git(root, ['rev-list', '--branches', '--remotes', '--tags']).stdout).map((s) => s.toLowerCase()));
  const cutoff = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000).toISOString();
  const candidates = [...noted.entries()].filter(([commit]) => !reachable.has(commit));
  const removed: string[] = [];
  for (let i = 0; i < candidates.length; i += BLOB_CHUNK) {
    const chunk = candidates.slice(i, i + BLOB_CHUNK);
    const texts = readBlobs(root, chunk.map(([, blob]) => blob));
    for (const [commit, blob] of chunk) {
      const text = texts.get(blob);
      const parsed = text === undefined ? undefined : parseNote(text);
      if (parsed?.ok && parsed.note.createdAt < cutoff) removed.push(commit);
    }
  }
  removed.sort();
  if (!opts.dryRun && removed.length > 0) git(root, ['notes', `--ref=${c.notesRef}`, 'remove', '--ignore-missing', '--stdin'], { input: `${removed.join('\n')}\n`, env: identityEnv(root) });
  return { removed };
}

/** Pushes the notes ref without force (after a prune, so the removal reaches the remote). */
export function pushNotes(root: string, c: NotesConfig): { pushed: boolean; error?: string } {
  const out = git(root, ['push', '--quiet', '--', c.remote, `${c.notesRef}:${c.notesRef}`], { network: true });
  return out.ok ? { pushed: true } : { pushed: false, error: out.stderr.trim().slice(0, 300) };
}
