/**
 * `specguard proof fetch|publish|notes|prune`: the commands around the proof notes in git. `fetch` brings the notes
 * ref, `publish` writes the note for HEAD (CI only, unless `--force-local` writes a provisional one for this machine),
 * `notes` summarizes what the nearest note holds, `prune` removes notes of commits nothing reaches.
 *
 * Spec: specs/capabilities/proof-store.md
 */
import { readFileSync } from 'node:fs';

import { readCiContext } from '../ci/context.js';
import { HASH_VERSION } from '../core/claim-hash.js';
import { dependencyFingerprint } from '../core/dependency-fingerprint.js';
import { defaultEnforce, effectiveEnforce } from '../core/enforce.js';
import { ExitCode } from '../core/exit-codes.js';
import type { ProofLedger } from '../core/proof-ledger.js';
import { NOTE_SCHEMA, NOTE_VERSION, compactLedger, expandNote, type NoteStatementSummary, type ProofNote } from '../core/proof-note.js';
import { PILLARS, computeStatement, type PillarName, type PillarStatus } from '../core/proof-statement.js';
import {
  changedFiles,
  commitInfo,
  configureNotesFetch,
  fetchNotes,
  hasNotesRef,
  headCommit,
  isShallow,
  listNoted,
  nearestNoted,
  notesFetchedAt,
  pruneNotes,
  pushNotes,
  readNote,
  resolveNotesConfig,
  writeAndPushNote,
} from '../core/proof-store.js';
import { buildSpecGraph } from '../core/spec-graph.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { cliVersion } from '../core/version.js';
import { loadTrace } from './check.js';
import { freshLedger, loadEffectiveLedger, readOnlyLedgerStore } from './proof-sources.js';
import { buildStatementInput } from './statement-input.js';

const rootOf = (config: SpecGuardConfig): string => config.rootDir ?? process.cwd();

/** `30s`, `10m`, `2h`, `1d` in milliseconds; undefined for anything else. */
export function parseDuration(text: string): number | undefined {
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(text.trim());
  if (!m) return undefined;
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase() as 's' | 'm' | 'h' | 'd'];
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

export interface ProofFetchOpts {
  /** Add the notes refspec to `remote.<r>.fetch`, so a plain `git fetch` brings the notes. */
  configure?: boolean;
  /** Background use: no messages, and never a failure. */
  quiet?: boolean;
  /** Skip the fetch when the last one is younger than this (`10m`). Also skipped when `proofStore.autoFetch` is `off`. */
  ifOlder?: string;
  now?: Date;
}

export async function runProofFetch(config: SpecGuardConfig, opts: ProofFetchOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('proof-fetch');
  const root = rootOf(config);
  const log = (line: string): void => void result.messages.push(line);
  let notes;
  try {
    notes = resolveNotesConfig(config.proofStore);
  } catch (err) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    log((err as Error).message);
    return result;
  }
  if (opts.configure) log(configureNotesFetch(root, notes).changed ? `added +${notes.notesRef}:${notes.notesRef} to remote.${notes.remote}.fetch` : `remote.${notes.remote}.fetch already brings ${notes.notesRef} (or there is no remote)`);
  if (opts.ifOlder !== undefined) {
    const window = parseDuration(opts.ifOlder);
    if (window === undefined) {
      result.failed = 1;
      result.exitCode = ExitCode.ValidationFailed;
      log(`--if-older "${opts.ifOlder}" is not a duration (use 30s, 10m, 2h or 1d)`);
      return result;
    }
    const last = notesFetchedAt(root);
    if (config.proofStore?.autoFetch === 'off') {
      result.skipped = 1;
      log('proofStore.autoFetch is off: not fetching in the background');
      return finish(result, opts);
    }
    if (last && (opts.now ?? new Date()).getTime() - last.getTime() < window) {
      result.skipped = 1;
      log(`notes were fetched ${Math.round(((opts.now ?? new Date()).getTime() - last.getTime()) / 1000)}s ago: nothing to do`);
      return finish(result, opts);
    }
  }
  const out = fetchNotes(root, notes);
  if (out.fetched) {
    result.created = 1;
    log(`fetched ${notes.notesRef} from ${notes.remote}: ${listNoted(root, notes).size} commit(s) have a proof note`);
    if (out.shallow) log('this is a shallow clone: notes of commits before the boundary are only found after deepening (specguard check says when)');
    return finish(result, opts);
  }
  switch (out.reason) {
    case 'no-remote':
      result.skipped = 1;
      log(`no remote "${notes.remote}": nothing to fetch`);
      break;
    case 'no-ref-on-remote':
      result.skipped = 1;
      log('proofs: no CI notes yet; they appear after the first CI run (specguard proof fetch to update)');
      break;
    default:
      result.failed = 1;
      result.exitCode = ExitCode.InternalError;
      log(out.reason === 'auth' ? `could not fetch notes from "${notes.remote}": the login was refused${out.detail ? ` (${out.detail})` : ''}` : `could not fetch notes from "${notes.remote}": it did not answer${out.detail ? ` (${out.detail})` : ''}`);
  }
  return finish(result, opts);
}

/** A quiet fetch says nothing and never fails: it runs in the background of a session. */
function finish(result: PipelineResult, opts: { quiet?: boolean }): PipelineResult {
  if (!opts.quiet) return result;
  result.messages = [];
  result.failed = 0;
  result.exitCode = ExitCode.Success;
  return result;
}

// ---------------------------------------------------------------------------
// publish
// ---------------------------------------------------------------------------

export interface ProofPublishOpts {
  /** Commit to record. Must be the checked-out commit, because the rows are judged against the working tree. */
  commit?: string;
  /** Write the local ref only. */
  noPush?: boolean;
  /** With `forceLocal`: push the provisional note too (it is not pushed by default). */
  push?: boolean;
  /** Write a provisional note from this machine's local ledger. Readers treat its rows as local evidence. */
  forceLocal?: boolean;
  /** Allow a CI that is not GitHub Actions (needs `CI=true`). */
  allowNonGithub?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injected so tests do not wait between push attempts. */
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}

/** The statement summary a note carries, computed from the evidence `ledger` holds. */
export async function summarizeStatement(config: SpecGuardConfig, ledger: ProofLedger): Promise<NoteStatementSummary> {
  const store = readOnlyLedgerStore('the proof note rows', ledger);
  const { model } = await loadTrace(config, { store });
  const statement = computeStatement((await buildStatementInput(config, { model }, { store })).input);
  const graph = await buildSpecGraph(config);
  const specs = [...graph.nodes.values()];
  return {
    level: statement.level,
    counts: statement.counts,
    capabilities: statement.capabilities.map((c) => {
      const spec = specs.find((n) => n.id === c.capability);
      return {
        id: c.capability,
        level: c.level,
        enforce: spec ? effectiveEnforce(spec.spec.meta, config.enforce) : defaultEnforce(config.enforce),
        pillars: Object.fromEntries(PILLARS.map((p) => [p, c.pillars[p].status])) as Record<PillarName, PillarStatus>,
      };
    }),
  };
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

export async function runProofPublish(config: SpecGuardConfig, opts: ProofPublishOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('proof-publish');
  const root = rootOf(config);
  const env = opts.env ?? process.env;
  const log = (line: string): void => void result.messages.push(line);
  const refuse = (message: string, code: number = ExitCode.ValidationFailed): PipelineResult => {
    result.failed = 1;
    result.exitCode = code;
    log(message);
    return result;
  };

  const inCi = env.GITHUB_ACTIONS === 'true' || (opts.allowNonGithub === true && (env.CI === 'true' || env.CI === '1'));
  if (!inCi && !opts.forceLocal) {
    return refuse('proof publish writes CI evidence and runs only in CI (GITHUB_ACTIONS=true, or CI=true with --allow-non-github); --force-local writes a provisional note for this machine that readers treat as local evidence');
  }
  const provisional = opts.forceLocal === true && !inCi;
  let notes;
  try {
    notes = resolveNotesConfig(config.proofStore);
  } catch (err) {
    return refuse((err as Error).message, ExitCode.InternalError);
  }
  const head = headCommit(root);
  const info = head ? commitInfo(root, opts.commit ?? 'HEAD') : undefined;
  if (!head || !info) return refuse(opts.commit ? `"${opts.commit.slice(0, 80)}" does not resolve to a commit here` : 'this is not a git checkout with a commit');
  if (info.commit !== head) return refuse('proof publish records the checked-out commit: its rows are judged against the working tree, so check out the commit first');

  const eff = await loadEffectiveLedger(config, { localOrigin: inCi ? 'stored' : 'local', withFreshness: true, head: info.commit });
  const fresh = freshLedger(eff, { includeLocal: provisional });
  const compact = compactLedger(fresh, { commit: info.commit, deps: dependencyFingerprint(root) });
  if (compact.rows.length === 0) return refuse(`no ${provisional ? '' : 'CI '}evidence is fresh at ${info.commit.slice(0, 7)}: run the tests and ingest the results first (specguard test run)`);

  const dirty = changedFiles(root).filter((f) => compact.files[f] !== undefined);
  if (dirty.length > 0) {
    const names = `${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ` and ${dirty.length - 5} more` : ''}`;
    if (!provisional) return refuse(`${dirty.length} file(s) the proofs depend on differ from commit ${info.commit.slice(0, 7)} (${names}): the note would not describe that commit`);
    log(`warning: ${dirty.length} file(s) the proofs depend on differ from the commit (${names})`);
  }

  const ci = readCiContext(env, readJson);
  const note: ProofNote = {
    schema: NOTE_SCHEMA,
    version: NOTE_VERSION,
    commit: info.commit,
    tree: info.tree,
    parents: info.parents,
    createdAt: (opts.now ?? new Date()).toISOString(),
    tool: { specguard: cliVersion(), node: process.versions.node, hashVersion: HASH_VERSION },
    ci: {
      provider: ci.provider,
      event: provisional ? 'local' : ci.event,
      ...(ci.repo ? { repo: ci.repo } : {}),
      ...(ci.ref ? { ref: ci.ref } : {}),
      ...(ci.actor ? { actor: ci.actor } : {}),
      ...(ci.runId ? { runId: ci.runId } : {}),
      ...(ci.runAttempt !== undefined ? { runAttempt: ci.runAttempt } : {}),
      ...(ci.runUrl ? { runUrl: ci.runUrl } : {}),
      ...(ci.workflow ? { workflow: ci.workflow } : {}),
      ...(ci.pr ? { pr: ci.pr.number } : {}),
    },
    ...(eff.note && eff.note.commit !== info.commit ? { carriedFrom: eff.note.commit } : {}),
    files: compact.files,
    ...(compact.deps !== undefined ? { deps: compact.deps } : {}),
    rows: compact.rows,
    approvals: eff.noteApprovals,
    countersigns: eff.countersigns,
    statement: await summarizeStatement(config, expandNote({ ...emptyBody(info), files: compact.files, deps: compact.deps, rows: compact.rows })),
    changes: [],
  };

  const push = !opts.noPush && (!provisional || opts.push === true);
  const out = await writeAndPushNote(root, notes, note, {
    push,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    refresh: async (merged) => ({ ...merged, statement: await summarizeStatement(config, expandNote(merged)) }),
  });
  if (!out.written) return refuse(`proof note not written: ${out.reason}`, ExitCode.InternalError);

  for (const w of out.warnings) log(`warning: ${w}`);
  result.created = 1;
  log(`proof note for ${info.commit.slice(0, 7)}: ${note.rows.length} row(s), ${Object.keys(note.files).length} file hash(es), sha256 ${out.digest.slice(0, 12)}${out.merged ? ', merged with an existing note on this commit' : ''}${provisional ? '; provisional (local evidence), overwritten by the next proof fetch unless pushed' : ''}`);
  if (out.pushed) log(`pushed ${notes.notesRef} to ${notes.remote} (${out.attempts} attempt${out.attempts === 1 ? '' : 's'})`);
  else if (push) log(`note written locally but not pushed: ${out.pushError ?? 'unknown reason'}`);
  else log('note written locally (not pushed)');
  return result;
}

/** A note shell with no rows, for expanding the rows alone. */
function emptyBody(info: { commit: string; tree: string; parents: string[] }): ProofNote {
  return {
    schema: NOTE_SCHEMA,
    version: NOTE_VERSION,
    commit: info.commit,
    tree: info.tree,
    parents: info.parents,
    createdAt: '',
    tool: { specguard: '', node: '', hashVersion: HASH_VERSION },
    ci: { provider: 'other', event: 'other' },
    files: {},
    rows: [],
    approvals: [],
    countersigns: [],
    statement: { level: 'not-certified', counts: { certified: 0, provisional: 0, 'not-certified': 0, planned: 0 }, capabilities: [] },
    changes: [],
  };
}

// ---------------------------------------------------------------------------
// notes
// ---------------------------------------------------------------------------

export interface ProofNotesOpts {
  /** A commit to show the note of. Default: the nearest noted ancestor of HEAD. */
  commit?: string;
}

/** What the proof notes hold: the nearest note (or the one on `commit`), its rows by verdict, its statement and where the effective evidence comes from. */
export async function runProofNotes(config: SpecGuardConfig, opts: ProofNotesOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('proof-notes');
  const root = rootOf(config);
  const log = (line: string): void => void result.messages.push(line);
  let notes;
  try {
    notes = resolveNotesConfig(config.proofStore);
  } catch (err) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    log((err as Error).message);
    return result;
  }
  const head = headCommit(root);
  if (!head) {
    log('not a git checkout with a commit: there are no proof notes to show');
    result.skipped = 1;
    return result;
  }
  if (!hasNotesRef(root, notes)) {
    log(`no ${notes.notesRef} here: proofs: no CI notes yet; they appear after the first CI run (specguard proof fetch to update)`);
    result.skipped = 1;
    return result;
  }
  log(`${notes.notesRef}: ${listNoted(root, notes).size} commit(s) have a proof note${isShallow(root) ? ' (shallow clone)' : ''}`);

  let note: ProofNote | undefined;
  let distance = 0;
  if (opts.commit !== undefined) {
    const info = commitInfo(root, opts.commit);
    const parsed = info ? readNote(root, notes, info.commit) : undefined;
    if (!info) {
      result.failed = 1;
      result.exitCode = ExitCode.ValidationFailed;
      log(`"${opts.commit.slice(0, 80)}" does not resolve to a commit here`);
      return result;
    }
    if (!parsed) {
      log(`no proof note on ${info.commit.slice(0, 7)}`);
      result.skipped = 1;
      return result;
    }
    if (!parsed.ok) {
      result.failed = 1;
      result.exitCode = ExitCode.ValidationFailed;
      log(`the proof note on ${info.commit.slice(0, 7)} is not readable (${parsed.reason}): ${parsed.detail.slice(0, 160)}`);
      return result;
    }
    note = parsed.note;
  } else {
    const nearest = nearestNoted(root, notes, head);
    for (const w of nearest.warnings) log(`warning: ${w}`);
    if (nearest.commit === undefined) {
      log(`no proof note within ${notes.maxWalk} commits of HEAD${nearest.truncated ? ' (the walk was cut short; fetch or deepen)' : ''}`);
      result.skipped = 1;
      return result;
    }
    note = nearest.note;
    distance = nearest.distance;
  }

  const short = note.commit.slice(0, 7);
  log(`note @${short}${opts.commit === undefined ? ` (${distance === 0 ? 'HEAD' : `${distance} commit${distance === 1 ? '' : 's'} back`})` : ''}: written ${note.createdAt} by ${note.ci.event === 'local' ? 'a local run (provisional)' : `CI (${note.ci.event})`}${note.ci.runUrl ? `, ${note.ci.runUrl}` : ''}`);
  if (note.importedFrom) log(`imported from ${note.importedFrom.commit.slice(0, 7)} (${note.importedFrom.reason})`);
  if (note.carriedFrom) log(`carries rows forward from ${note.carriedFrom.slice(0, 7)}`);
  const byVerdict = new Map<string, number>();
  for (const row of note.rows) byVerdict.set(row.verdict, (byVerdict.get(row.verdict) ?? 0) + 1);
  log(`rows: ${note.rows.length} (${[...byVerdict].sort().map(([v, n]) => `${n} ${v}`).join(', ') || 'none'}); ${Object.keys(note.files).length} file hash(es) listed once; ${note.approvals.length} review approval(s)`);
  log(`statement: ${note.statement.level}`);
  for (const cap of note.statement.capabilities) {
    log(`  ${cap.id}: ${cap.level} (enforce ${cap.enforce})`);
    result.items.push({ key: cap.id, status: 'ok', message: cap.level });
  }
  if (opts.commit === undefined) {
    const eff = await loadEffectiveLedger(config);
    const counts = [...eff.sourceOf.values()].reduce((n, s) => ({ ci: n.ci + (s.kind === 'note' && !eff.note?.provisional ? 1 : 0), local: n.local + (s.kind === 'local' ? 1 : 0) }), { ci: 0, local: 0 });
    log(`effective evidence here: ${counts.ci} row(s) from the note, ${counts.local} from the local cache`);
    for (const w of eff.warnings) if (!result.messages.includes(`warning: ${w}`)) log(`warning: ${w}`);
  }
  result.created = 1;
  return result;
}

// ---------------------------------------------------------------------------
// prune
// ---------------------------------------------------------------------------

export interface ProofPruneOpts {
  /** Notes older than this many days. Default `proofStore.pruneDays` (90). */
  days?: number;
  /** Remove. Without it the command lists what it would remove. */
  yes?: boolean;
  /** Push the notes ref afterwards, so the removal reaches the remote. */
  push?: boolean;
}

export async function runProofPrune(config: SpecGuardConfig, opts: ProofPruneOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('proof-prune');
  const root = rootOf(config);
  const log = (line: string): void => void result.messages.push(line);
  let notes;
  try {
    notes = resolveNotesConfig(config.proofStore);
  } catch (err) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    log((err as Error).message);
    return result;
  }
  const days = opts.days ?? config.proofStore?.pruneDays ?? 90;
  if (!Number.isInteger(days) || days < 1) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    log('--days must be a whole number of days, at least 1');
    return result;
  }
  const out = pruneNotes(root, notes, days, { dryRun: opts.yes !== true });
  if (out.skipped) {
    result.skipped = 1;
    log(`nothing pruned: ${out.skipped}`);
    return result;
  }
  for (const commit of out.removed) result.items.push({ key: commit, status: opts.yes ? 'updated' : 'skipped', message: 'note on an unreachable commit' });
  if (opts.yes) {
    result.updated = out.removed.length;
    log(`removed ${out.removed.length} proof note(s) of commits no branch or tag reaches, older than ${days} days`);
    if (opts.push && out.removed.length > 0) {
      const pushed = pushNotes(root, notes);
      log(pushed.pushed ? `pushed ${notes.notesRef} to ${notes.remote}` : `not pushed: ${pushed.error ?? 'unknown reason'}`);
    }
  } else {
    result.skipped = out.removed.length;
    log(`${out.removed.length} proof note(s) of commits no branch or tag reaches are older than ${days} days; run with --yes to remove them`);
  }
  return result;
}
