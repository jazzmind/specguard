/**
 * `specguard ci run`: the CI gate. One deterministic command, no model call, that proves what a pull request changed
 * and decides whether it may merge.
 *
 * It reads the CI context, finds the base and the nearest proof note, re-runs only the claims whose evidence is stale
 * or missing, and shows by construction that each changed requirement's tests detect the change: the same tests run
 * against the base version of the owned code and must fail there and pass at head. Approvals are trusted per
 * `src/ci/pr-approvals.ts` (a recorded approval counts at an `enforce` capability only when a review by another person
 * backs it). The result is one proof packet, one pull request comment kept up to date by its marker, the proof note for
 * the checked-out commit pushed to the notes ref, and an exit code: `enforce` capabilities block, `warn` ones annotate,
 * `observe` ones stay silent.
 *
 * Every write to GitHub or to the remote (comment, note, check run) degrades to an artifact under `.specguard/ci/` and
 * a line in the job summary, and never fails the job; only the packet's verdict does.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { githubApi, type GitHubApi } from '../ci/github-api.js';
import { makeHashAt } from '../ci/claim-hash-at.js';
import { verifyNoteWithConfig, checkRunSummary, NOTE_CHECK_NAME } from '../ci/note-verify.js';
import { pipelineChanges, type ChangedFile as PipelineFile } from '../ci/pipeline-changes.js';
import { qualifyingReviews, REVIEW_STATES, trustApprovals, type ReviewFact } from '../ci/pr-approvals.js';
import { readCiContext, type CiContext } from '../ci/context.js';
import { approvalsFrom } from '../core/approvals.js';
import { HASH_VERSION } from '../core/claim-hash.js';
import { buildClaimTestIndex } from '../core/claim-tags.js';
import { parseClaimRef } from '../core/claims.js';
import { diffClaims, type ChangedClaim } from '../core/change-claims.js';
import { errorCountsAsRed, requiredRefs } from '../core/change-stage.js';
import { enforceSizeCap, mappedCoverageFiles, normalizeCoverage, parseCoverage, selectCapabilityTests, type CoverageEvidence, type CoverageFormat } from '../core/coverage.js';
import { dependencyFingerprint } from '../core/dependency-fingerprint.js';
import { effectiveEnforce } from '../core/enforce.js';
import { ExitCode } from '../core/exit-codes.js';
import { listHistory } from '../core/history.js';
import { intentGaps } from '../core/intent-gap.js';
import { layersOf } from '../core/proof-ledger.js';
import {
  NOTE_SCHEMA,
  NOTE_VERSION,
  compactLedger,
  noteDigest,
  serializeNote,
  type NoteApproval,
  type NoteCountersign,
  type NoteStatementSummary,
  type ProofNote,
} from '../core/proof-note.js';
import {
  PACKET_MARKER,
  PACKET_SCHEMA,
  buildPacket,
  packetDigest,
  renderPacketMarkdown,
  type ChangeVerdict,
  type ClaimEvidence,
  type PipelineChange,
  type ProofPacket,
} from '../core/proof-packet.js';
import { PILLARS, computeStatement, type PillarName, type PillarStatus, type SystemStatement } from '../core/proof-statement.js';
import { commitInfo, deepenUntilNoted, fetchNotes, headCommit, isSafeRemoteName, isShallow, notesWithTree, resolveNotesConfig, writeAndPushNote, type NotesConfig } from '../core/proof-store.js';
import { readFile } from '../core/reader.js';
import type { ParsedSpec } from '../core/types.js';
import { specsRootDir } from '../core/spec-key.js';
import { parseSpecContent } from '../core/spec-parser.js';
import { diffTestFile } from '../core/test-strength.js';
import { findUnrequested, type UnrequestedReport } from '../core/unrequested.js';
import {
  APPROVALS_CI_DEFAULTS,
  CHANGE_DEFAULTS,
  emptyResult,
  type EnforceLevel,
  type PipelineResult,
  type SpecGuardConfig,
} from '../core/types.js';
import { cliVersion } from '../core/version.js';
import { diffConfigPolicy, diffSpecPolicy, scanAddedSource, snapshotRewrites, type WeakeningFinding } from '../core/weakening.js';
import { loadConfig } from '../core/config.js';
import { writeFile } from '../core/writer.js';
import { openRepo, ownedState, type RepoView } from './change.js';
import { gitOut, loadChanges } from './change-store.js';
import { isV2Repo, loadTrace } from './check.js';
import { buildPathContext, expandInputs, hashFiles, readCoverageEvidence, runCoverageIngest } from './coverage-ingest.js';
import { freshLedger, loadEffectiveLedger, noteApprovalsAsApprovals, readOnlyStore, type EffectiveLedger } from './proof-sources.js';
import { baseEvidence, buildStatementInput, type BaseEvidence } from './statement-input.js';
import { runTestRun, type RunRecord, type TestRunPipelineOpts } from './test-run.js';

export interface CiRunOpts {
  /** Re-run every claim with a test, not just the stale or changed ones. */
  full?: boolean;
  /** Run no tests: judge what the notes and the local ledger hold. */
  noTests?: boolean;
  /** Do not build the constructed red tree: sensitivity stays unknown. */
  noRed?: boolean;
  /** Write the note to the local notes ref only. */
  noPush?: boolean;
  /** Do not post or update the pull request comment. */
  noComment?: boolean;
  /** Compute and write the artifacts, but write nothing to the remote, the notes ref or GitHub. */
  dryRun?: boolean;
  /** Artifact directory. Default `.specguard/ci`. */
  out?: string;
  /** Injected for determinism. */
  now?: Date;
}

export interface CiRunDeps {
  /** The GitHub client. Default: built from the context's token. */
  api?: GitHubApi;
  /** The test pipeline. Default `runTestRun`. */
  runTests?: (config: SpecGuardConfig, opts: TestRunPipelineOpts) => Promise<PipelineResult>;
  env?: NodeJS.ProcessEnv;
  /** Injected so tests do not wait between note push attempts. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CiRunResult extends PipelineResult {
  packet?: ProofPacket;
  note?: { written: boolean; pushed: boolean; digest?: string };
  /** `fail` is a blocked packet, `advisory` a packet that only warns. */
  gate: 'pass' | 'fail' | 'advisory';
}

const REMARK_DAYS = 30;
const HEX40 = /^[0-9a-f]{40}$/i;

const claimRefOf = (ref: string): string => {
  const hash = ref.indexOf('#');
  const slash = hash < 0 ? -1 : ref.indexOf('/', hash);
  return slash < 0 ? ref : ref.slice(0, slash);
};
const posix = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split('\n')[0]!.slice(0, 200);
const lineSafe = (text: string): string => text.replace(/[\r\n%]/g, ' ').slice(0, 200);

/** A record left by an earlier run in this checkout must not be read as this run's: remove it before the run. */
function clearRecord(root: string, id: string): void {
  rmSync(path.join(root, '.specguard', 'runs', `${id}.json`), { force: true });
}

function readRecord(root: string, id: string): RunRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(path.join(root, '.specguard', 'runs', `${id}.json`), 'utf8')) as Partial<RunRecord>;
    return Array.isArray(raw.tests) && typeof raw.runId === 'string' ? (raw as RunRecord) : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** The event name a payload implies, for a replay with `--event <file>` where the runner set none. */
function inferEventName(payload: unknown): string {
  const p = (payload !== null && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  if (p.pull_request !== undefined) return 'pull_request';
  if (p.merge_group !== undefined) return 'merge_group';
  if (p.after !== undefined || p.before !== undefined) return 'push';
  return 'workflow_dispatch';
}

/**
 * The CI context for this process. With `eventFile` (a replay of a recorded event on a developer's machine) the context
 * is a read-only one: the token is dropped, so a replay never writes to GitHub whatever the environment holds.
 */
export function ciContextFromEnv(env: NodeJS.ProcessEnv = process.env, eventFile?: string): CiContext {
  const read = (p: string): unknown => JSON.parse(readFileSync(p, 'utf8'));
  if (!eventFile) return readCiContext(env, read);
  const replay = env.GITHUB_ACTIONS !== 'true';
  const merged: NodeJS.ProcessEnv = { ...env, GITHUB_EVENT_PATH: eventFile, ...(replay ? { GITHUB_ACTIONS: 'true' } : {}) };
  if (!merged.GITHUB_EVENT_NAME) {
    try {
      merged.GITHUB_EVENT_NAME = inferEventName(read(eventFile));
    } catch {
      /* an unreadable payload reads as an event the context cannot use */
    }
  }
  const ctx = readCiContext(merged, read);
  if (!replay) return ctx;
  const { token: _token, ...rest } = ctx;
  return { ...rest, canWrite: { notes: false, comment: false, checks: false } };
}

// ---------------------------------------------------------------------------
// Git helpers (argument arrays only)
// ---------------------------------------------------------------------------

const git = (root: string, args: string[]): string | undefined => gitOut(root, args)?.trim() || undefined;

function mergeBase(root: string, head: string, base: string, remote: string): string | undefined {
  const find = (): string | undefined => git(root, ['merge-base', head, base]);
  let sha = find();
  if (!sha && HEX40.test(base) && isSafeRemoteName(remote)) {
    try {
      execFileSync('git', ['fetch', '--no-tags', '--quiet', '--', remote, base], { cwd: root, stdio: 'ignore', timeout: 120_000 });
    } catch {
      /* the base stays unreachable: the caller says so */
    }
    sha = find();
  }
  return sha;
}

/** Files a diff between two commits touches, as a pull request lists them (renames carry the old name). */
function diffFiles(root: string, base: string, head: string): PipelineFile[] {
  const out = gitOut(root, ['diff', '--name-status', '--find-renames', '-z', base, head, '--']);
  if (!out) return [];
  const parts = out.split('\0').filter((p) => p.length > 0);
  const files: PipelineFile[] = [];
  for (let i = 0; i < parts.length; ) {
    const code = parts[i]![0];
    if (code === 'R' || code === 'C') {
      files.push({ filename: parts[i + 2]!, status: 'renamed', previous_filename: parts[i + 1]! });
      i += 3;
    } else {
      files.push({ filename: parts[i + 1]!, status: code === 'A' ? 'added' : code === 'D' ? 'removed' : 'modified' });
      i += 2;
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Changed claims and the weakening checks (base against head)
// ---------------------------------------------------------------------------

function changedClaimsOf(view: RepoView, baseSha: string): ChangedClaim[] {
  const { root, config } = view;
  const specsRoot = specsRootDir(config);
  const was = new Map<string, ParsedSpec | undefined>();
  const now = new Map<string, ParsedSpec | undefined>();
  for (const n of view.graph.nodes.values()) {
    if (n.kind !== 'capability' && n.kind !== 'component') continue;
    now.set(n.id, n.spec);
    const text = gitOut(root, ['show', `${baseSha}:./${posix(root, n.spec.filePath)}`]);
    was.set(n.id, text === undefined ? undefined : { ...parseSpecContent(text, n.spec.filePath, specsRoot), specKey: n.spec.specKey });
  }
  return diffClaims(was, now);
}

function weakeningOf(view: RepoView, bev: BaseEvidence): WeakeningFinding[] {
  const { config, root } = view;
  const out: WeakeningFinding[] = [];
  const specsRoot = specsRootDir(config);
  const projectLayers = config.proof?.requiredLayers ?? [];
  for (const n of view.graph.nodes.values()) {
    if (n.kind !== 'capability' && n.kind !== 'component') continue;
    const text = bev.show(posix(root, n.spec.filePath));
    if (text === undefined) continue;
    out.push(...diffSpecPolicy({ ...parseSpecContent(text, n.spec.filePath, specsRoot), specKey: n.spec.specKey }, n.spec, projectLayers, config.enforce?.default));
  }
  const configFile = '.specguard/config.json';
  const before = bev.show(configFile);
  if (before !== undefined) {
    try {
      out.push(...diffConfigPolicy(JSON.parse(before), JSON.parse(readFileSync(path.join(root, configFile), 'utf8'))));
    } catch {
      /* an unreadable config on either side is not a weakening we can name */
    }
  }
  const live = new Set([...view.graph.nodes.values()].flatMap((n) => n.spec.claims.filter((c) => c.id).map((c) => `${n.spec.specKey}#${c.id}`)));
  const changed = new Set(bev.changed.filter((c) => c.status !== 'added').map((c) => c.file));
  for (const [file, source] of view.sources) if (changed.has(file)) out.push(...diffTestFile(bev.show(file), source, file, view.strengthCfg, live));
  out.push(...scanAddedSource(bev.changed, (f) => view.sources.has(f)), ...snapshotRewrites(bev.changed));
  return out;
}

// ---------------------------------------------------------------------------
// Red by construction
// ---------------------------------------------------------------------------

type Sens = ClaimEvidence['sensitivity'] & { kind: 'red-green' };

interface RedOutcome {
  /** Per claim ref. Absent when no judgement was attempted. */
  byClaim: Map<string, Sens>;
  note?: string;
}

function linkDependencies(config: SpecGuardConfig, root: string, tmpRoot: string): void {
  for (const name of config.change?.worktreeLinks ?? ['node_modules', '.venv', 'vendor']) {
    const from = path.resolve(root, name);
    const to = path.resolve(tmpRoot, name);
    if (!to.startsWith(`${path.resolve(tmpRoot)}${path.sep}`) || !existsSync(from) || existsSync(to)) continue;
    mkdirSync(path.dirname(to), { recursive: true });
    symlinkSync(from, to, 'dir');
  }
}

/**
 * Run the changed claims' tests against the base version of the owned code: a detached worktree of head, the owned files
 * of the change's capabilities taken from the base commit (files added since base removed), the dependency directories
 * linked in. Returns the run record, or why none could be made. The tree is always removed.
 */
async function constructedRun(
  view: RepoView,
  runTests: NonNullable<CiRunDeps['runTests']>,
  args: { baseSha: string; presentAtBase: string[]; owned: string[]; refs: string[]; runId: string },
): Promise<{ ok: true; record: RunRecord } | { ok: false; error: string }> {
  const { root, config } = view;
  const prefix = git(root, ['rev-parse', '--show-prefix']) ?? '';
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'specguard-ci-red-'));
  const run = (cwd: string, a: string[]): void => void execFileSync('git', a, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
  let added = false;
  try {
    try {
      run(root, ['worktree', 'add', '--detach', tmp, 'HEAD']);
      added = true;
    } catch (err) {
      return { ok: false, error: `could not build the constructed tree (git worktree add failed): ${errText(err)}` };
    }
    const tmpRoot = path.join(tmp, prefix);
    // A config that is not committed is still the config the tests run under.
    if (!existsSync(path.join(tmpRoot, '.specguard', 'config.json')) && existsSync(path.join(root, '.specguard', 'config.json'))) {
      mkdirSync(path.join(tmpRoot, '.specguard'), { recursive: true });
      copyFileSync(path.join(root, '.specguard', 'config.json'), path.join(tmpRoot, '.specguard', 'config.json'));
    }
    for (let i = 0; i < args.presentAtBase.length; i += 200) run(tmpRoot, ['checkout', args.baseSha, '--', ...args.presentAtBase.slice(i, i + 200)]);
    for (const f of args.owned) if (!args.presentAtBase.includes(f)) rmSync(path.join(tmpRoot, f), { force: true });
    linkDependencies(config, root, tmpRoot);
    const res = await runTests(await loadConfig(tmpRoot), { claims: args.refs, record: 'ci-red', runId: `${args.runId}-red`, ingest: false });
    const record = readRecord(tmpRoot, 'ci-red');
    if (!record) return { ok: false, error: `the red run produced no record (${res.messages.filter((m) => m.startsWith('[')).slice(-1)[0] ?? 'see the test output'})` };
    return { ok: true, record };
  } finally {
    if (added) {
      try {
        run(root, ['worktree', 'remove', '--force', tmp]);
      } catch {
        /* removed below */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
    try {
      run(root, ['worktree', 'prune']);
    } catch {
      /* nothing to prune */
    }
  }
}

/** Judge each required claim: red on the base code and green at head, from the run records alone. */
function judgeSensitivity(claims: ChangedClaim[], head: RunRecord | undefined, red: RunRecord | undefined, redNote: string | undefined, accepts: 'never' | 'added-only' | 'always'): RedOutcome {
  const byClaim = new Map<string, Sens>();
  const claimLevel = new Map<string, ChangedClaim['change']>();
  for (const c of requiredRefs(claims)) {
    const ref = claimRefOf(c.ref);
    if (c.ref === ref || !claimLevel.has(ref)) claimLevel.set(ref, c.ref === ref ? c.change : 'modified');
  }
  for (const [ref, change] of claimLevel) {
    const headTests = head?.tests.filter((t) => t.refs.includes(ref)) ?? [];
    const green = headTests.length > 0 && headTests.every((t) => t.verdict === 'pass');
    const redTests = red?.tests.filter((t) => t.refs.includes(ref)) ?? [];
    if (!red || !green || redTests.length === 0) {
      byClaim.set(ref, { kind: 'red-green', status: 'unknown', redTests: 0 });
      continue;
    }
    const failing = redTests.filter((t) => t.verdict === 'fail' || (t.verdict === 'missing' && errorCountsAsRed(accepts, change)));
    byClaim.set(ref, { kind: 'red-green', status: failing.length > 0 ? 'ok' : 'fail', redTests: failing.length });
  }
  return { byClaim, ...(redNote ? { note: redNote } : {}) };
}

// ---------------------------------------------------------------------------
// Coverage for the unrequested-code check
// ---------------------------------------------------------------------------

const coverageReports = (record: RunRecord | undefined): string[] => [...new Set((record?.coverage ?? []).flatMap((c) => c.reports))];

/**
 * Coverage of the changed claims' own tests (kept in memory, scope `claims`), and of each touched capability's claim
 * tests (stored as the capability's evidence, as `coverage ingest` does). Anything missing leaves the lines `unknown`.
 */
async function collectCoverage(
  view: RepoView,
  runTests: NonNullable<CiRunDeps['runTests']>,
  args: { claims: string[]; capabilities: string[]; runId: string; head: string; log: (line: string) => void; includeCapabilities: boolean },
): Promise<{ change?: CoverageEvidence }> {
  const { config, root } = view;
  const index = buildClaimTestIndex({ testFiles: view.tests.map((t) => path.join(root, t.file)), rootDir: root });
  const out: { change?: CoverageEvidence } = {};

  if (args.claims.length > 0) {
    try {
      clearRecord(root, 'ci-change-cov');
      await runTests(config, { claims: args.claims, coverage: true, record: 'ci-change-cov', runId: `${args.runId}-cov`, ingest: false });
      const record = readRecord(root, 'ci-change-cov');
      const files = await expandInputs(root, coverageReports(record));
      if (!record || files.length === 0) throw new Error('the run left no coverage report');
      const raws = [];
      for (const f of files) raws.push(parseCoverage(await readFile(f), ((record.coverage ?? []).find((c) => c.format)?.format as CoverageFormat | undefined) ?? 'auto'));
      const ctx = await buildPathContext(root, config);
      const refs = [...index.keys()].filter((k) => args.claims.some((c) => claimRefOf(k) === c));
      const selection = selectCapabilityTests(refs, index);
      out.change = enforceSizeCap(
        normalizeCoverage(raws, ctx, hashFiles(root, mappedCoverageFiles(raws, ctx)), {
          scope: { kind: 'claims', claims: args.claims, tests: selection.tests, testsHash: selection.testsHash, selection: record.selection === 'tests' ? 'tests' : 'files' },
          runId: `${args.runId}-cov`,
          repoSha: args.head,
          origin: 'ci',
          ingestedAt: new Date().toISOString(),
        }),
      );
    } catch (err) {
      args.log(`coverage of the changed claims' tests could not be read (${errText(err)}): changed lines stay unknown`);
    }
  }

  if (args.includeCapabilities) {
    for (const cap of args.capabilities) {
      try {
        const node = view.graph.nodes.get(cap);
        const refs = node ? node.spec.claims.filter((c) => c.id).map((c) => `${node.spec.specKey}#${c.id}`).filter((r) => view.tests.some((t) => t.keys.has(r))) : [];
        if (refs.length === 0) continue;
        clearRecord(root, `ci-cov-${cap}`);
        await runTests(config, { claims: refs, coverage: true, record: `ci-cov-${cap}`, runId: `${args.runId}-cov-${cap}`, ingest: false });
        const record = readRecord(root, `ci-cov-${cap}`);
        const reports = coverageReports(record);
        if (!record || reports.length === 0) continue;
        const res = await runCoverageIngest(reports, root, { capability: cap, selection: record.selection === 'tests' ? 'tests' : 'files', runId: `${args.runId}-cov-${cap}`, origin: 'ci' });
        if (res.failed > 0) args.log(`coverage of ${cap}'s claim tests could not be ingested`);
      } catch (err) {
        args.log(`coverage of ${cap}'s claim tests could not be collected (${errText(err)})`);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The note
// ---------------------------------------------------------------------------

function summaryOf(statement: SystemStatement, enforce: Map<string, EnforceLevel>): NoteStatementSummary {
  return {
    level: statement.level,
    counts: statement.counts,
    capabilities: statement.capabilities.map((c) => ({
      id: c.capability,
      level: c.level,
      enforce: enforce.get(c.capability) ?? 'observe',
      pillars: Object.fromEntries(PILLARS.map((p) => [p, c.pillars[p].status])) as Record<PillarName, PillarStatus>,
    })),
  };
}

function ciOf(ctx: CiContext): ProofNote['ci'] {
  return {
    provider: ctx.provider,
    event: ctx.event,
    ...(ctx.repo ? { repo: ctx.repo } : {}),
    ...(ctx.ref ? { ref: ctx.ref } : {}),
    ...(ctx.actor ? { actor: ctx.actor } : {}),
    ...(ctx.runId ? { runId: ctx.runId } : {}),
    ...(ctx.runAttempt !== undefined ? { runAttempt: ctx.runAttempt } : {}),
    ...(ctx.runUrl ? { runUrl: ctx.runUrl } : {}),
    ...(ctx.workflow ? { workflow: ctx.workflow } : {}),
    ...(ctx.pr ? { pr: ctx.pr.number } : {}),
  };
}

/** A removed claim that needs a covering review at `enforce` and has none blocks the capability, as an unapproved claim does. */
function gateRemovals(packet: ProofPacket, removals: string[], enforce: Map<string, EnforceLevel>): void {
  const caps = new Set<string>();
  for (const ref of removals) {
    const intent = packet.intent.find((i) => i.ref === ref);
    if (!intent || enforce.get(intent.capability) !== 'enforce') continue;
    caps.add(intent.capability);
    const verdict = packet.capabilities.find((c) => c.capability === intent.capability);
    verdict?.blocking.push({ code: 'REMOVAL_NEEDS_REVIEW', message: `${ref} was removed and no review covers the removal`, fix: 'a reviewer other than the author approves this pull request' });
    packet.fixes.push('A reviewer approves this pull request (the removal of a requirement is a change of intent).');
  }
  for (const c of packet.capabilities) {
    if (!caps.has(c.capability)) continue;
    c.verdict = 'fail';
    c.effect = 'blocks';
  }
  if (caps.size > 0) packet.verdict = 'blocked';
}

const appendSummary = (env: NodeJS.ProcessEnv, text: string): void => {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  } catch {
    /* the job summary is a convenience */
  }
};

// ---------------------------------------------------------------------------
// ci run
// ---------------------------------------------------------------------------

export async function runCi(config: SpecGuardConfig, ctx: CiContext, opts: CiRunOpts = {}, deps: CiRunDeps = {}): Promise<CiRunResult> {
  const result: CiRunResult = { ...emptyResult('ci-run'), gate: 'pass' };
  const root = config.rootDir ?? process.cwd();
  const env = deps.env ?? process.env;
  const now = opts.now ?? new Date();
  const outDir = path.resolve(root, opts.out ?? '.specguard/ci');
  const log = (line: string): void => void result.messages.push(`[ci] ${line}`);
  const limits: string[] = [];
  const runTests = deps.runTests ?? runTestRun;
  const dry = opts.dryRun === true;

  const head = headCommit(root);
  if (!head) {
    log('this is not a git checkout with a commit: nothing to prove');
    return result;
  }
  if (!(await isV2Repo(config))) {
    log('v1 specs: run `specguard migrate`, then `specguard ci run` has requirements to prove');
    return result;
  }
  let notes: NotesConfig;
  try {
    notes = resolveNotesConfig(config.proofStore);
  } catch (err) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    log(errText(err));
    return result;
  }
  const api: GitHubApi | undefined = deps.api ?? (ctx.token && ctx.provider === 'github' ? githubApi(ctx.token, ctx.apiUrl) : undefined);
  const canNotes = ctx.canWrite.notes && !dry;
  // Without the right to push, the note is an artifact only; `--no-push` asks for the local notes ref on purpose.
  const canLocal = !dry && (ctx.canWrite.notes || opts.noPush === true);
  const canComment = ctx.canWrite.comment && !dry && !opts.noComment && api !== undefined;
  const canChecks = ctx.canWrite.checks && !dry && api !== undefined && ctx.repo !== undefined;
  const pr = ctx.event === 'pull_request' ? ctx.pr : undefined;
  const judging = pr !== undefined;
  const short = (sha: string): string => sha.slice(0, 7);

  log(`${ctx.event}${pr ? ` #${pr.number}${pr.isFork ? ' (fork)' : ''}` : ''} at ${short(head)}${dry ? ' (dry run: nothing is written to the remote or to GitHub)' : ''}`);
  mkdirSync(outDir, { recursive: true });

  // The note describes the checked-out commit. A checkout of GitHub's merge ref is not the commit under review.
  let writeNote = true;
  if (ctx.head && ctx.head.toLowerCase() !== head.toLowerCase() && ctx.event === 'pull_request') {
    log(`the checkout (${short(head)}) is not the pull request head (${short(ctx.head)}): proving the checkout, writing no note (the generated workflow checks out the head)`);
    limits.push('the checkout is not the pull request head; no proof note was written for it');
    writeNote = false;
  }

  // ---- 2. notes and base ---------------------------------------------------
  const fetched = fetchNotes(root, notes);
  if (fetched.fetched) log(`fetched ${notes.notesRef}`);
  else log(`no notes fetched (${fetched.reason ?? 'unknown'}): proving from what is here`);
  if (isShallow(root)) {
    const deep = deepenUntilNoted(root, notes, head);
    log(deep.found ? `shallow clone deepened by ${deep.deepenedBy} to reach a noted ancestor` : 'shallow clone: no noted ancestor reachable, running every claim');
    if (!deep.found) limits.push('shallow clone: no noted ancestor reachable; full run');
  }

  let baseSha: string | undefined;
  if (judging && !ctx.baseSha) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    log('the pull request event names no base commit: the pull request cannot be compared with its base');
    return result;
  }
  if (ctx.baseSha) {
    baseSha = mergeBase(root, head, ctx.baseSha, notes.remote);
    if (!baseSha) {
      if (judging) {
        result.failed = 1;
        result.exitCode = ExitCode.InternalError;
        log(`the base commit ${short(ctx.baseSha)} is not in this checkout: check out with fetch-depth: 0 so the pull request can be compared with its base`);
        return result;
      }
      log(`the previous commit ${short(ctx.baseSha)} is not in this checkout: no change is judged`);
    }
  }

  // ---- 3. import shortcut (a squash, rebase or queue commit with a proven tree) --
  const info = commitInfo(root, head);
  if ((ctx.event === 'push' || ctx.event === 'merge_group') && !opts.full && info) {
    const since = new Date(now.getTime() - REMARK_DAYS * 86_400_000).toISOString();
    for (const cand of notesWithTree(root, notes, info.tree, since)) {
      if (cand.commit.toLowerCase() === head.toLowerCase()) continue;
      const verified = await verifyNoteWithConfig(notes.verify, api, cand.note.ci.repo ?? ctx.repo, cand.commit, noteDigest(serializeNote(cand.note)));
      if (notes.verify === 'check-run' && verified.status !== 'verified') {
        log(`the note on ${short(cand.commit)} has the same tree but is ${verified.status}: not imported`);
        continue;
      }
      const imported: ProofNote = { ...cand.note, commit: info.commit, tree: info.tree, parents: info.parents, createdAt: now.toISOString(), ci: ciOf(ctx), importedFrom: { commit: cand.commit, reason: 'tree-equal' } };
      log(`the tree of ${short(head)} equals the tree of ${short(cand.commit)}: importing its proof note, running no tests`);
      result.note = await publishNote({ root, notes, note: imported, ctx, api, canNotes: canNotes && writeNote && !opts.noPush, canLocal: canLocal && writeNote, canChecks, verify: notes.verify, outDir, log, sleep: deps.sleep, statement: imported.statement });
      result.created = 1;
      return result;
    }
  }

  // ---- 4. carried-forward ledger and the affected claims -----------------------
  const runId = `ci-${ctx.runId ?? String(now.getTime())}-${ctx.runAttempt ?? 1}`;
  const loadEff = (noNotes: boolean): Promise<EffectiveLedger> => loadEffectiveLedger(config, { localOrigin: 'stored', withFreshness: true, head, noNotes, ...(api ? { api } : {}) });
  let eff = await loadEff(false);
  for (const w of eff.warnings) log(`warning: ${w}`);
  if (eff.note && notes.verify === 'check-run' && eff.note.verified !== 'verified') {
    log(`the note on ${short(eff.note.commit)} is ${eff.note.verified}, not verified: ignoring it and re-proving every claim`);
    limits.push(`the proof note on ${short(eff.note.commit)} was not verified; claims were re-proved`);
    eff = await loadEff(true);
  }
  if (!eff.note) log('no usable proof note: every claim with a test is proven in this run');
  else log(`carrying proofs from the note on ${short(eff.note.commit)} (${eff.note.distance} commit${eff.note.distance === 1 ? '' : 's'} back)`);

  const view = await openRepo(config);
  const nodes = [...view.graph.nodes.values()].filter((n) => n.kind === 'capability' || n.kind === 'component');
  const enforce = new Map<string, EnforceLevel>(nodes.map((n) => [n.id, effectiveEnforce(n.spec.meta, config.enforce)]));
  const capabilityOfKey = new Map(nodes.map((n) => [n.specKey, n.id]));
  const capabilityOf = (ref: string): string => capabilityOfKey.get(parseClaimRef(ref)?.specKey ?? '') ?? '';
  const tested = new Set<string>();
  for (const t of view.tests) for (const k of t.keys) tested.add(claimRefOf(k));
  const allClaims = nodes.flatMap((n) => n.spec.claims.filter((c) => c.id).map((c) => `${n.spec.specKey}#${c.id}`)).filter((r) => tested.has(r));

  const changed = baseSha ? changedClaimsOf(view, baseSha) : [];
  const required = requiredRefs(changed);
  const requiredClaims = [...new Set(required.map((c) => claimRefOf(c.ref)))].filter((r) => tested.has(r));
  const freshClaims = new Set<string>();
  for (const [key, source] of eff.sourceOf) if (source.fresh === true) freshClaims.add(claimRefOf(key.slice(0, key.indexOf('\u0000'))));
  const affected = opts.full || !eff.note ? allClaims : [...new Set([...allClaims.filter((r) => !freshClaims.has(r)), ...requiredClaims])];

  // ---- 5. run the affected claims' tests -----------------------------------
  let headRecord: RunRecord | undefined;
  if (opts.noTests) log('--no-tests: judging what the notes and the ledger hold');
  else if (affected.length === 0) log('every claim is fresh in the note: no tests run');
  else {
    log(`running the tests of ${affected.length} claim${affected.length === 1 ? '' : 's'}${eff.note ? ' (stale, missing or changed)' : ''}`);
    clearRecord(root, 'ci-head');
    const run = await runTests(config, { claims: affected, record: 'ci-head', runId });
    headRecord = readRecord(root, 'ci-head');
    for (const line of run.messages.filter((m) => m.startsWith('[run]') || m.startsWith('[fail]') || m.startsWith('[skip]'))) log(line.replace(/^\[/, '').replace(/^(\w+)]/, '$1:'));
    if (!headRecord) {
      log('the test run left no record: no test could be selected or run');
      limits.push('no test run was recorded; proofs are the carried ones only');
    }
    eff = await loadEff(eff.note === undefined);
    if (eff.note && notes.verify === 'check-run' && eff.note.verified !== 'verified') eff = await loadEff(true);
  }
  // Rows this process just earned are CI evidence by definition; whatever a laptop wrote earlier stays local.
  for (const record of Object.values(eff.ledger.proofs)) {
    for (const row of Object.values(layersOf(record))) if (row.runId === runId) row.origin = 'ci';
    if (record.runId === runId) record.origin = 'ci';
  }

  // ---- 6. red by construction ----------------------------------------------
  let sens: RedOutcome = { byClaim: new Map() };
  const touchedCaps = [...new Set(required.map((c) => c.capability))];
  const records = judging || baseSha ? loadChanges(root).records : [];
  const changeFiles = baseSha ? new Set((gitOut(root, ['diff', '--name-only', baseSha, head, '--', '.specguard/changes']) ?? '').split('\n').filter(Boolean).map((f) => path.posix.basename(f, '.json'))) : new Set<string>();
  const touchedRecords = records.filter((r) => changeFiles.has(r.id));
  const owned = baseSha && judging ? ownedState(view, { capabilities: [...new Set([...touchedCaps, ...touchedRecords.flatMap((r) => r.capabilities)])] } as Parameters<typeof ownedState>[1], baseSha) : undefined;
  if (judging && baseSha && requiredClaims.length > 0) {
    const accepts = config.change?.redAcceptsErrors ?? CHANGE_DEFAULTS.redAcceptsErrors;
    if (opts.noRed || opts.noTests) sens = judgeSensitivity(required, headRecord, undefined, opts.noRed ? '--no-red: sensitivity not judged' : '--no-tests: sensitivity not judged', accepts);
    else if (!owned || owned.codeFiles.length === 0) sens = judgeSensitivity(required, headRecord, undefined, 'no owned code differs from the base: there is nothing to see fail on the base code', accepts);
    else {
      log(`building the constructed red tree: ${owned.codeFiles.length} owned file${owned.codeFiles.length === 1 ? '' : 's'} at ${short(baseSha)}, head's tests and specs`);
      const red = await constructedRun(view, runTests, { baseSha, presentAtBase: owned.presentAtBase, owned: owned.files, refs: requiredClaims, runId });
      if (!red.ok) log(red.error);
      sens = judgeSensitivity(required, headRecord, red.ok ? red.record : undefined, red.ok ? undefined : red.error, accepts);
      if (red.ok && red.record.selection !== 'tests') limits.push('this runner cannot select tests by title: red and green are judged only on the tests the claims name');
    }
    for (const [ref, s] of sens.byClaim) log(`sensitivity ${ref}: ${s.status}${s.status === 'ok' ? ` (${s.redTests} test${s.redTests === 1 ? '' : 's'} fail on the base code)` : s.status === 'fail' ? ' (its tests pass on the base code)' : ''}`);
    if (sens.note) limits.push(sens.note);
  }

  // ---- coverage for unrequested code ----------------------------------------
  const hasCoverage = config.apps.some((a) => a.test?.coverage);
  let changeCoverage: CoverageEvidence | undefined;
  const changeCaps = new Set<string>([...touchedCaps, ...touchedRecords.flatMap((r) => r.capabilities)]);
  if (judging && baseSha && !opts.noTests) {
    if (!hasCoverage) {
      log('no apps[].test.coverage configured: changed lines are not judged for unrequested code');
      limits.push('coverage is not configured (apps[].test.coverage): code no requirement asked for is not judged');
    } else {
      const got = await collectCoverage(view, runTests, { claims: requiredClaims, capabilities: [...changeCaps], runId, head, log, includeCapabilities: config.ci?.capabilityCoverage !== false });
      changeCoverage = got.change;
    }
  }

  // ---- 8. approvals ---------------------------------------------------------
  const policy = { ...APPROVALS_CI_DEFAULTS, ...(config.approvals?.ci ?? {}) };
  const hashAt = makeHashAt(config, view.graph);
  const historyDir = path.relative(root, path.join(specsRootDir(config), 'history')).split(path.sep).join('/');
  const onBase = new Set((baseSha ? (gitOut(root, ['ls-tree', '-r', '--name-only', baseSha, '--', `${historyDir}/`]) ?? '') : '').split('\n').filter(Boolean).map((f) => path.posix.basename(f, '.md')));
  const recorded = approvalsFrom(listHistory(config)).map((a) => ({ ...a, onBase: onBase.has(a.entry) }));
  let reviewFacts: ReviewFact[] = [];
  if (judging && pr) {
    if (api && ctx.repo) {
      try {
        reviewFacts = (await api.listReviews(ctx.repo, pr.number)).map((r) => {
          const state = String(r.state).toUpperCase();
          return {
            id: r.id,
            login: r.user?.login ?? '',
            isBot: r.user?.type === 'Bot',
            state: (REVIEW_STATES as readonly string[]).includes(state) ? (state as ReviewFact['state']) : 'COMMENTED',
            commitId: r.commit_id,
            submittedAt: r.submitted_at,
            association: r.author_association ?? 'NONE',
          };
        });
      } catch (err) {
        log(`reviews could not be read (${errText(err)}): approvals added in this pull request cannot be countersigned`);
        limits.push('pull request reviews could not be read; approvals added in this pull request were not countersigned');
      }
    } else {
      log('no GitHub token: reviews are not read, so approvals added in this pull request are not countersigned');
      limits.push('no GitHub token: pull request reviews were not read; approvals added in this pull request were not countersigned');
    }
  }
  const reviews = qualifyingReviews(reviewFacts, pr?.author ?? '');
  const trust = trustApprovals({
    changed,
    recorded,
    reviews,
    noteApprovals: eff.noteApprovals,
    enforce,
    capabilityOf,
    policy,
    hashAt,
    ...(pr ? { pr: { number: pr.number, author: pr.author } } : {}),
  });

  // ---- 9. statement and packet ---------------------------------------------
  const specsRel = posix(root, specsRootDir(config));
  const store = readOnlyStore(eff);
  const { model } = await loadTrace(config, { store });
  const gaps = intentGaps(root, model.nodes, listHistory(config), specsRel);
  const statementWarnings: string[] = [];
  const sensitivityMap = new Map<string, 'ok' | 'fail'>();
  for (const [ref, s] of sens.byClaim) if (s.status === 'ok' || s.status === 'fail') sensitivityMap.set(ref, s.status);
  const assembled = await buildStatementInput(config, { model, gaps }, {
    generated: now.toISOString(),
    store,
    ...(baseSha ? { base: baseSha } : {}),
    ...(judging ? { approvals: trust.effective } : {}),
    extraApprovals: noteApprovalsAsApprovals(eff),
    ...(sensitivityMap.size > 0 ? { sensitivity: sensitivityMap } : {}),
  });
  statementWarnings.push(...assembled.warnings);
  const statement = computeStatement(assembled.input);
  for (const w of statementWarnings) log(`warning: ${w}`);
  log(`statement: ${statement.level} (${statement.counts.certified} certified, ${statement.counts.provisional} provisional, ${statement.counts['not-certified']} not certified)`);
  writeJson(outDir, 'statement.json', statement);

  let packet: ProofPacket | undefined;
  let changeVerdicts: ChangeVerdict[] = [];
  if (judging && pr && baseSha) {
    const bev = baseEvidence(root, baseSha, statementWarnings);
    if (!bev) {
      result.failed = 1;
      result.exitCode = ExitCode.InternalError;
      log(`the base ${short(baseSha)} could not be read for the diff`);
      return result;
    }
    let prFiles: PipelineFile[] = diffFiles(root, baseSha, head);
    if (api && ctx.repo) {
      try {
        prFiles = await api.listPrFiles(ctx.repo, pr.number);
      } catch {
        /* the git diff stands in */
      }
    }
    const pipeline: PipelineChange[] = pipelineChanges(prFiles);

    const ownedBy = new Map<string, string[]>();
    for (const n of nodes) for (const f of n.ownedFiles) ownedBy.set(f, [...(ownedBy.get(f) ?? []), n.id]);
    if (config.change?.requireChangeRecord === false) for (const n of nodes) changeCaps.add(n.id);
    const changedFiles = bev.changed;
    const capEvidence = new Map<string, CoverageEvidence>();
    for (const cap of changeCaps) {
      const ev = await readCoverageEvidence(root, cap);
      if (ev?.origin === 'ci') capEvidence.set(cap, ev);
    }
    const full = findUnrequested({
      changed: changedFiles,
      ownedBy,
      changeCaps,
      ...(changeCoverage ? { changeCoverage } : {}),
      ...(capEvidence.size > 0 ? { capabilityCoverage: capEvidence } : {}),
      currentHashes: hashFiles(root, changedFiles.map((c) => c.file)),
    });
    // With no coverage evidence every changed line reads unknown: the packet's limits say so once instead of listing them.
    const unrequested: UnrequestedReport = changeCoverage || capEvidence.size > 0 ? full : { ...full, lines: [] };

    changeVerdicts = touchedRecords.map((r): ChangeVerdict => {
      const mine = required.filter((c) => r.capabilities.includes(c.capability));
      const claims = [...new Set(mine.map((c) => claimRefOf(c.ref)))];
      const allOk = claims.length > 0 && claims.every((c) => sens.byClaim.get(c)?.status === 'ok');
      let verdict: ChangeVerdict['verdict'];
      if (r.kind === 'spike') verdict = 'spike';
      else if (r.kind === 'refactor') verdict = claims.length === 0 && r.capabilities.every((c) => statement.capabilities.find((s) => s.capability === c)?.pillars.conforms.status === 'ok') ? 'pass' : 'fail';
      else verdict = allOk ? 'pass' : 'fail';
      return { id: r.id, kind: r.kind, capabilities: r.capabilities, verdict, claims, chronology: { testsBeforeCode: null, note: 'order is enforced locally; CI proves sensitivity by construction' } };
    });

    const approvals = trust.byRef;
    const sensitivity = new Map<string, ClaimEvidence['sensitivity']>();
    for (const claim of new Set(required.map((c) => claimRefOf(c.ref)))) sensitivity.set(claim, sens.byClaim.get(claim) ?? { kind: 'red-green', status: 'unknown', redTests: 0 });
    packet = buildPacket({
      statement,
      changed,
      approvals,
      sensitivity,
      changes: changeVerdicts,
      weakening: weakeningOf(view, bev),
      unrequested,
      pipeline,
      enforce,
      meta: {
        generated: now.toISOString(),
        head,
        base: baseSha,
        ...(env.GITHUB_BASE_REF ? { baseRef: env.GITHUB_BASE_REF } : {}),
        pr: { number: pr.number, author: pr.author, ...(ctx.repo ? { url: `https://github.com/${ctx.repo}/pull/${pr.number}` } : {}) },
        ...(ctx.runId ? { run: { id: ctx.runId, ...(ctx.runUrl ? { url: ctx.runUrl } : {}) } } : {}),
        tool: cliVersion(),
        provisional: false,
      },
      policy: { unrequested: config.unrequested?.severity ?? 'error' },
    });
    gateRemovals(packet, trust.removalsNeedingReview ?? [], enforce);
    for (const line of limits) if (!packet.limits.includes(line)) packet.limits.push(line);
    if (eff.note) packet.limits.push(`proofs carried from the note on ${short(eff.note.commit)}${eff.note.verified === 'verified' ? ' (verified)' : ''}`);
    if (!policy.allowSelf && recorded.some((a) => !a.onBase && enforce.get(capabilityOf(a.claim)) !== 'enforce') && policy.requireReview === 'enforce') {
      packet.limits.push('approvals below enforce are accepted as recorded, without a countersigning review');
    }
    result.packet = packet;
    writeJson(outDir, 'packet.json', packet);
    const markdown = renderPacketMarkdown(packet);
    await writeFile(path.join(outDir, 'packet.md'), `${markdown}\n`);
    log(`packet: ${packet.verdict} (${packet.headline})`);

    // ---- 11. report -------------------------------------------------------
    let commented = false;
    if (canComment && api && ctx.repo) {
      const res = await api.upsertComment(ctx.repo, pr.number, PACKET_MARKER, markdown);
      commented = res.posted;
      log(res.posted ? `pull request comment ${res.updated ? 'updated' : 'posted'}` : `no pull request comment (${res.reason ?? 'unknown'}): the job summary has the packet`);
    } else if (pr.isFork) log('fork pull request: no comment is posted; the job summary and the packet artifact have the result');
    else if (!ctx.token) log('no GitHub token: no comment is posted; the job summary has the packet');
    appendSummary(env, markdown);
    if (!commented) for (const line of ['packet.md and packet.json are in the evidence artifact']) log(line);
  }

  // ---- 10. the note -----------------------------------------------------------
  if (info && writeNote) {
    const compact = compactLedger(freshLedger(eff), { commit: info.commit, deps: dependencyFingerprint(root) });
    const carried = eff.noteApprovals.filter((a) => {
      const now2 = hashAt(info.commit, a.claim);
      return now2 !== undefined && now2.slice(0, 16) === a.hash;
    });
    const approvals: NoteApproval[] = [...carried, ...trust.newNoteApprovals].filter((a, i, all) => all.findIndex((b) => b.claim === a.claim && b.hash === a.hash && b.reviewId === a.reviewId) === i);
    const countersigns: NoteCountersign[] = [...eff.countersigns, ...trust.countersigns].filter((c, i, all) => all.findIndex((d) => d.entry === c.entry && d.status === c.status && d.by === c.by) === i);
    const rows = compact.rows.map((r) => {
      const s = sens.byClaim.get(claimRefOf(r.claim));
      return s && s.status === 'ok' ? { ...r, sensitivity: { kind: 'red-green' as const, red: 'fail' as const, tests: s.redTests } } : r;
    });
    const note: ProofNote = {
      schema: NOTE_SCHEMA,
      version: NOTE_VERSION,
      commit: info.commit,
      tree: info.tree,
      parents: info.parents,
      createdAt: now.toISOString(),
      tool: { specguard: cliVersion(), node: process.versions.node, hashVersion: HASH_VERSION },
      ci: ciOf(ctx),
      ...(eff.note && eff.note.commit !== info.commit ? { carriedFrom: eff.note.commit } : {}),
      files: compact.files,
      ...(compact.deps !== undefined ? { deps: compact.deps } : {}),
      rows,
      approvals,
      countersigns,
      statement: summaryOf(statement, enforce),
      changes: changeVerdicts.map((c) => ({ id: c.id, kind: c.kind, verdict: c.verdict, claims: c.claims })),
      ...(packet ? { packet: { ...(pr ? { pr: pr.number } : {}), verdict: packet.verdict, sha256: packetDigest(packet) } } : {}),
    };
    if (rows.length === 0 && approvals.length === 0 && countersigns.length === 0) log('no proof row is fresh: no note written');
    else result.note = await publishNote({ root, notes, note, ctx, api, canNotes: canNotes && !opts.noPush, canLocal, canChecks, verify: notes.verify, outDir, log, sleep: deps.sleep, statement: note.statement, packetVerdict: packet?.verdict });
  }

  if (!packet) appendSummary(env, `### SpecGuard\n\nProof statement at \`${short(head)}\`: **${statement.level}** (${statement.counts.certified} certified, ${statement.counts.provisional} provisional, ${statement.counts['not-certified']} not certified).${result.note?.pushed ? ' The proof note was pushed.' : ''}`);

  // ---- 12. gate --------------------------------------------------------------
  if (packet) {
    if (packet.verdict === 'blocked') {
      result.gate = 'fail';
      result.exitCode = ExitCode.NotCertified;
      result.failed = 1;
      for (const c of packet.capabilities.filter((x) => x.effect === 'blocks')) log(`blocked: ${c.capability} (${c.blocking.slice(0, 2).map((b) => b.code).join(', ') || 'not proven'})`);
    } else if (packet.verdict === 'advisory') {
      result.gate = 'advisory';
      if (ctx.provider === 'github') for (const c of packet.capabilities.filter((x) => x.effect === 'warns')) result.messages.push(`::warning title=SpecGuard::${lineSafe(`${c.capability} warns: ${c.blocking[0]?.message ?? 'see the proof packet'}`)}`);
    }
    result.items.push({ key: 'packet', status: result.gate === 'fail' ? 'failed' : 'ok', message: packet.verdict });
    result.created += 1;
    if (canChecks && api && ctx.repo && notes.verify === 'check-run') {
      try {
        await api.createCheckRun(ctx.repo, {
          name: 'specguard/proof',
          head_sha: head,
          status: 'completed',
          conclusion: packet.verdict === 'blocked' ? 'failure' : packet.verdict === 'advisory' ? 'neutral' : 'success',
          output: { title: `SpecGuard proof packet: ${packet.verdict}`, summary: packet.headline },
        });
      } catch (err) {
        log(`the specguard/proof check run was not created (${errText(err)})`);
      }
    }
  }
  return result;
}

function writeJson(dir: string, name: string, value: unknown): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
  } catch {
    /* an artifact is a convenience */
  }
}

interface PublishArgs {
  root: string;
  notes: NotesConfig;
  note: ProofNote;
  ctx: CiContext;
  api: GitHubApi | undefined;
  canNotes: boolean;
  canLocal: boolean;
  canChecks: boolean;
  verify: NotesConfig['verify'];
  outDir: string;
  log: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  statement: NoteStatementSummary;
  packetVerdict?: string;
}

/** Write the note artifact, then the notes ref (pushed when allowed), then the check run that binds its digest. Never throws. */
async function publishNote(a: PublishArgs): Promise<NonNullable<CiRunResult['note']>> {
  const serialized = serializeNote(a.note);
  try {
    mkdirSync(a.outDir, { recursive: true });
    writeFileSync(path.join(a.outDir, 'note.json'), serialized);
  } catch {
    /* the artifact is a convenience */
  }
  if (!a.canLocal) {
    a.log(`proof note kept as ${path.relative(a.root, path.join(a.outDir, 'note.json')) || 'note.json'} (nothing is written to the notes ref in this run)`);
    return { written: false, pushed: false, digest: noteDigest(serialized) };
  }
  try {
    const out = await writeAndPushNote(a.root, a.notes, a.note, {
      push: a.canNotes,
      ...(a.sleep ? { sleep: a.sleep } : {}),
      refresh: (merged) => ({ ...merged, statement: a.statement }),
    });
    if (!out.written) {
      a.log(`proof note not written: ${out.reason}`);
      return { written: false, pushed: false };
    }
    for (const w of out.warnings) a.log(`warning: ${w}`);
    if (out.pushed) a.log(`proof note for ${a.note.commit.slice(0, 7)} pushed to ${a.notes.remote} (sha256 ${out.digest.slice(0, 12)}${out.merged ? ', merged with an existing note' : ''})`);
    else if (a.canNotes) a.log(`proof note written locally, not pushed: ${out.pushError ?? 'unknown reason'}`);
    else a.log(`proof note for ${a.note.commit.slice(0, 7)} written locally (no token or push right: not pushed; sha256 ${out.digest.slice(0, 12)})`);
    if (out.pushed && a.canChecks && a.api && a.ctx.repo && a.verify === 'check-run') {
      try {
        await a.api.createCheckRun(a.ctx.repo, {
          name: NOTE_CHECK_NAME,
          head_sha: a.note.commit,
          status: 'completed',
          conclusion: 'neutral',
          output: { title: 'SpecGuard proof note', summary: checkRunSummary(out.digest, a.note) },
        });
      } catch (err) {
        a.log(`the ${NOTE_CHECK_NAME} check run was not created (${errText(err)}): readers will see the note as unverified`);
      }
    }
    return { written: true, pushed: out.pushed, digest: out.digest };
  } catch (err) {
    a.log(`proof note not written (${errText(err)})`);
    return { written: false, pushed: false };
  }
}

// ---------------------------------------------------------------------------
// ci packet and ci doctor
// ---------------------------------------------------------------------------

/** Render a saved `packet.json` as the pull request markdown. */
export function renderSavedPacket(text: string): { ok: true; markdown: string; packet: ProofPacket } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'the file is not JSON' };
  }
  const p = parsed as Partial<ProofPacket> | null;
  if (!p || p.schema !== PACKET_SCHEMA) return { ok: false, error: `not a proof packet (schema ${String(p?.schema ?? 'missing')}, expected ${PACKET_SCHEMA})` };
  if (typeof p.version === 'number' && p.version > 1) return { ok: false, error: `a newer SpecGuard wrote this packet (version ${p.version}); upgrade to render it` };
  if (!Array.isArray(p.capabilities) || !Array.isArray(p.intent) || !Array.isArray(p.evidence)) return { ok: false, error: 'the packet is missing its capabilities, intent or evidence' };
  return { ok: true, markdown: renderPacketMarkdown(p as ProofPacket), packet: p as ProofPacket };
}

export interface CiDoctorOpts {
  env?: NodeJS.ProcessEnv;
  eventFile?: string;
}

/** What `ci run` would do here, and what stands in its way. Reads the environment and the repo; calls no network. */
export async function runCiDoctor(config: SpecGuardConfig, opts: CiDoctorOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('ci-doctor');
  const root = config.rootDir ?? process.cwd();
  const env = opts.env ?? process.env;
  const line = (status: 'ok' | 'warn' | 'fail', text: string): void => {
    result.messages.push(`${status === 'ok' ? 'ok  ' : status === 'warn' ? 'warn' : 'FAIL'}  ${text}`);
    if (status === 'fail') result.failed += 1;
    else result.created += status === 'ok' ? 1 : 0;
    if (status === 'warn') result.skipped += 1;
  };

  const head = headCommit(root);
  const shallow = head !== undefined && isShallow(root);
  if (!head) line('fail', 'this is not a git checkout with a commit');
  else line(shallow ? 'warn' : 'ok', `git checkout at ${head.slice(0, 7)}${shallow ? ' (shallow: use fetch-depth: 0 so the base and the notes are reachable)' : ''}`);
  const v2 = await isV2Repo(config);
  line(v2 ? 'ok' : 'warn', v2 ? 'v2 specs found' : 'v1 specs only: run `specguard migrate`; ci run proves nothing yet');

  let ctx: CiContext;
  try {
    ctx = ciContextFromEnv(env, opts.eventFile);
  } catch (err) {
    line('fail', `the event payload could not be read: ${errText(err)}`);
    result.exitCode = ExitCode.InternalError;
    return result;
  }
  if (ctx.provider !== 'github') line('warn', 'not running in GitHub Actions: notes are written locally, no comment or check run is posted (proof publish writes notes from another CI)');
  else {
    line('ok', `event ${ctx.event}${ctx.pr ? ` for pull request #${ctx.pr.number}${ctx.pr.isFork ? ' from a fork' : ''}` : ''}, repository ${ctx.repo ?? 'unknown'}`);
    if (ctx.event === 'pull_request' && ctx.head && head && ctx.head.toLowerCase() !== head.toLowerCase()) line('warn', 'the checkout is not the pull request head: check out github.event.pull_request.head.sha, not the merge ref');
    if (ctx.event === 'pull_request' && !ctx.baseSha) line('warn', 'the event names no base commit');
    line(ctx.token ? 'ok' : 'warn', ctx.token ? 'a GitHub token is present (SG_GITHUB_TOKEN)' : 'no GitHub token: reviews are not read, nothing is posted or pushed through GitHub, approvals added in a pull request cannot be countersigned');
    line(ctx.canWrite.comment ? 'ok' : 'warn', ctx.canWrite.comment ? 'would post or update the proof packet comment' : 'would not comment (a fork, no token, or not a pull request): the packet goes to the job summary');
    line(ctx.canWrite.notes ? 'ok' : 'warn', ctx.canWrite.notes ? 'would push the proof note to the notes ref (needs contents: write)' : 'would not push the note: it stays in .specguard/ci/note.json');
    const attest = config.proofStore?.verify === 'check-run';
    line('ok', attest ? (ctx.canWrite.checks ? 'attestation is on: would record the specguard/proof-note check run (needs checks: write)' : 'attestation is on but no check run can be written here') : 'attestation is off (proofStore.verify): no check run is written, so the workflow needs no checks: write');
  }

  let notes: NotesConfig | undefined;
  try {
    notes = resolveNotesConfig(config.proofStore);
    line('ok', `notes ref ${notes.notesRef} on remote ${notes.remote}`);
  } catch (err) {
    line('fail', errText(err));
  }
  if (notes && head && !gitOut(root, ['config', '--get', `remote.${notes.remote}.url`])?.trim()) line('warn', `no remote named ${notes.remote}: notes cannot be fetched or pushed`);
  const graph = (await openRepo(config)).graph;
  const levels = new Map<EnforceLevel, number>();
  for (const n of graph.nodes.values()) if (n.kind === 'capability' || n.kind === 'component') levels.set(effectiveEnforce(n.spec.meta, config.enforce), (levels.get(effectiveEnforce(n.spec.meta, config.enforce)) ?? 0) + 1);
  line('ok', `capabilities: ${levels.get('enforce') ?? 0} enforce, ${levels.get('warn') ?? 0} warn, ${levels.get('observe') ?? 0} observe`);
  if ((levels.get('enforce') ?? 0) === 0) line('warn', 'no capability enforces yet: the packet only advises (specguard enforce raise <capability>)');
  line(config.apps.some((a) => a.test?.command || a.test?.suites?.length) ? 'ok' : 'warn', config.apps.some((a) => a.test?.command || a.test?.suites?.length) ? 'a test command is configured' : 'no apps[].test.command: no test runs, sensitivity stays unknown');
  line(config.apps.some((a) => a.test?.coverage) ? 'ok' : 'warn', config.apps.some((a) => a.test?.coverage) ? 'coverage is configured: code no requirement asked for can be judged' : 'no apps[].test.coverage: code no requirement asked for is not judged');
  if (!existsSync(path.join(root, '.github', 'workflows')) && ctx.provider === 'github') line('warn', 'no .github/workflows directory in this checkout');
  result.messages.push('');
  result.messages.push(result.failed > 0 ? 'ci run would not be able to start until the failures above are fixed' : 'ci run can start here');
  result.exitCode = result.failed > 0 ? ExitCode.InternalError : ExitCode.Success;
  return result;
}
