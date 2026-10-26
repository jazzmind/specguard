/**
 * `specguard change start|status|report|convert|done|abandon|list`: the spec-first change protocol, end to end.
 *
 * `start` writes one committed record of declared intent (`.specguard/changes/<id>.json`). Everything else is
 * detected: `change status` gathers facts from git, the specs, the test tags and the run records, and hands them to
 * the pure `computeStage`, so a record cannot be edited into a later stage. The facts are:
 *
 * - the changed claims (the capability's spec at the base commit against the working tree);
 * - which of them a person approved at their current wording (history entries, and plan-derived approvals);
 * - the tests tagged to each changed ref and how strong each is;
 * - the hashes of the changed claims, of the tagged test files and of the owned source, now and at the base;
 * - the owned files that differ from base;
 * - the newest red and green runs, read from their run records, and whether those runs still match the files.
 *
 * Red is provisional here: it is judged from local run records, which an agent with write access could forge. CI
 * re-derives red by construction and never reads them (see the spec).
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { approvalsFrom, indexApprovals, type Approval } from '../core/approvals.js';
import { pickBase, type BaseResolution, type BaseSkip, type BaseSource } from '../core/change-base.js';
import { diffClaims, type ChangedClaim } from '../core/change-claims.js';
import { CHANGE_KINDS, derivePlanApprovals, newChangeId, type ChangeKind, type ChangeRecord } from '../core/change-record.js';
import {
  changedClaimsHash,
  computeStage,
  requiredRefs,
  testFilesHash,
  type ChangeStatus,
  type GreenRecord,
  type RedRecord,
  type StageInput,
  type TestStrengthClass,
} from '../core/change-stage.js';
import { parseClaimRef } from '../core/claims.js';
import { hashFile } from '../core/drift-registry.js';
import { effectiveEnforce, newCapabilityEnforce, setEnforceLevel, unknownEnforce } from '../core/enforce.js';
import { ExitCode } from '../core/exit-codes.js';
import { listHistory, type HistoryEntry } from '../core/history.js';
import { intentGaps } from '../core/intent-gap.js';
import { buildPacket, renderPacketMarkdown, type ChangeVerdict, type ClaimEvidence, type PacketApproval, type ProofPacket } from '../core/proof-packet.js';
import { computeStatement } from '../core/proof-statement.js';
import { expandGlobs, readFile } from '../core/reader.js';
import { writeFile } from '../core/writer.js';
import { buildSpecGraph, type SpecGraph, type SpecNode } from '../core/spec-graph.js';
import { appForSpecFile, declaredSources, specsRootDir } from '../core/spec-key.js';
import { parseSpecContent } from '../core/spec-parser.js';
import { analyzeTestFile, diffTestFile, resolveStrengthConfig, type TestStrengthConfig } from '../core/test-strength.js';
import { findUnrequested, type UnrequestedReport } from '../core/unrequested.js';
import type { CoverageEvidence } from '../core/coverage.js';
import { CHANGE_DEFAULTS, emptyResult, type EnforceLevel, type ParsedSpec, type PipelineResult, type SpecGuardConfig } from '../core/types.js';
import { cliVersion } from '../core/version.js';
import { diffConfigPolicy, diffSpecPolicy, scanAddedSource, snapshotRewrites, type WeakeningFinding } from '../core/weakening.js';
import { hashFiles, readCoverageEvidence } from './coverage-ingest.js';
import {
  actorName,
  currentBranch,
  gitBytes,
  gitOut,
  isChangeId,
  loadChanges,
  openOnBranch,
  pickChange,
  pointerTests,
  readPointer,
  readRunRecord,
  saveChange,
  type RunKind,
  type RunPointer,
} from './change-store.js';
import { loadTrace } from './check.js';
import { baseEvidence, buildStatementInput } from './statement-input.js';

const CONFIG_FILE = '.specguard/config.json';
/** A plan captured this recently, and linked to no change yet, is taken as the plan of a new change. */
const PLAN_WINDOW_MS = 2 * 60 * 60 * 1000;

/** `specKey#claim/row` -> `specKey#claim`; a claim ref is returned as is. */
export const claimRefOf = (ref: string): string => {
  const hash = ref.indexOf('#');
  const slash = hash < 0 ? -1 : ref.indexOf('/', hash);
  return slash < 0 ? ref : ref.slice(0, slash);
};

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
export const posixRel = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

/** A title as the runner reports it: escapes in the source literal are resolved (the same rule `test run --claims` applies). */
const plainTitle = (title: string): string => title.replace(/\\(['"`\\])/g, '$1').trim();

// ---------------------------------------------------------------------------
// What the repository holds: specs and tests, read once per command
// ---------------------------------------------------------------------------

export interface ScannedTest {
  /** `file::title`, the id a run record uses. */
  id: string;
  file: string;
  title: string;
  strength: TestStrengthClass;
  /** `specKey#claim` and, for a row tag, `specKey#claim/row`: every ref the test counts for. */
  keys: Set<string>;
}

export interface RepoView {
  config: SpecGuardConfig;
  root: string;
  graph: SpecGraph;
  /** Every test file the specs and apps name, by repo-relative path, with its source. */
  sources: Map<string, string>;
  tests: ScannedTest[];
  strengthCfg: TestStrengthConfig;
}

export async function openRepo(config: SpecGuardConfig): Promise<RepoView> {
  const root = config.rootDir ?? process.cwd();
  const graph = await buildSpecGraph(config);
  const globs = new Set<string>();
  for (const n of graph.nodes.values()) for (const t of n.spec.meta.tests ?? []) globs.add(t);
  for (const app of config.apps) for (const t of [...(app.sources.tests ?? []), ...(app.extraTestSources ?? [])]) globs.add(t);
  const files = (await expandGlobs([...globs], root)).map((abs) => posixRel(root, abs));

  const strengthCfg = resolveStrengthConfig(config.testStrength);
  // An app's `test.conditional` gates apply to that app's test files only.
  const perFile = new Map<string, TestStrengthConfig>();
  for (const app of config.apps) {
    if (!app.test?.conditional?.length) continue;
    const cfg = resolveStrengthConfig(config.testStrength, app.test);
    for (const abs of await expandGlobs([...(app.sources.tests ?? []), ...(app.extraTestSources ?? [])], root)) perFile.set(posixRel(root, abs), cfg);
  }

  const sources = new Map<string, string>();
  const tests: ScannedTest[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = await readFile(path.join(root, file));
    } catch {
      continue;
    }
    sources.set(file, source);
    for (const t of analyzeTestFile(source, file, perFile.get(file) ?? strengthCfg)) {
      const keys = new Set<string>();
      for (const ref of t.claims) {
        const p = parseClaimRef(ref);
        if (!p) continue;
        keys.add(`${p.specKey}#${p.claimId}`);
        if (p.exampleId) keys.add(`${p.specKey}#${p.claimId}/${p.exampleId}`);
      }
      if (keys.size === 0) continue;
      const title = plainTitle(t.test.title);
      tests.push({ id: `${file}::${title}`, file, title, strength: t.class, keys });
    }
  }
  return { config, root, graph, sources, tests, strengthCfg };
}

const capabilityNode = (view: RepoView, id: string): SpecNode | undefined => {
  const n = view.graph.nodes.get(id);
  return n && (n.kind === 'capability' || n.kind === 'component') ? n : undefined;
};

// ---------------------------------------------------------------------------
// Base
// ---------------------------------------------------------------------------

/** The base commit of a change: `merge-base(HEAD, <first ref that resolves>)` (see `change-base.ts` for the order). */
export function resolveChangeBase(root: string, config: SpecGuardConfig, record: ChangeRecord | undefined, flag?: string): BaseResolution {
  const originHead = gitOut(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])?.trim() || undefined;
  return pickBase(
    { flag, recordBaseRef: record?.baseRef, configBaseRef: config.change?.baseRef, originHead },
    (ref) => gitOut(root, ['merge-base', 'HEAD', ref])?.trim() || undefined,
  );
}

// ---------------------------------------------------------------------------
// Owned files and hashes
// ---------------------------------------------------------------------------

/** One hash over (path, content hash) pairs, `absent` for a file that does not exist: the same shape `test run --record` uses. */
export function treeHash(entries: Array<[string, string | null]>): string {
  const h = createHash('sha256');
  for (const [file, hash] of [...entries].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) h.update(`${file}\0${hash ?? 'absent'}\n`);
  return h.digest('hex');
}

/** A glob (`**`, `*`, `?`, `{a,b}`) as a regular expression over a repo-relative POSIX path. Only used for files deleted since base. */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{' && glob.indexOf('}', i) > i) {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map((p) => p.replace(/[.+^$()|[\]\\*?]/g, '\\$&')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Files changed since `sha` in the working tree: git's own view plus untracked files. `A`/`M`/`D`/`U` (untracked). Repo-root-relative paths of the cwd. */
function changedSinceBase(root: string, sha: string): Map<string, 'A' | 'M' | 'D' | 'U'> {
  const out = new Map<string, 'A' | 'M' | 'D' | 'U'>();
  const diff = gitOut(root, ['diff', '--name-status', '--no-renames', '--relative', '-z', sha, '--']);
  if (diff) {
    const parts = diff.split('\0').filter((p) => p.length > 0);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const code = parts[i]![0];
      if (code === 'A' || code === 'M' || code === 'D') out.set(parts[i + 1]!, code);
      else if (code) out.set(parts[i + 1]!, 'M');
    }
  }
  for (const f of (gitOut(root, ['ls-files', '-z', '--others', '--exclude-standard']) ?? '').split('\0').filter(Boolean)) if (!out.has(f)) out.set(f, 'U');
  return out;
}

export interface OwnedState {
  /** Owned files of the change's capabilities (test files excluded), plus owned files deleted since base. */
  files: string[];
  /** Those that differ from base. */
  codeFiles: string[];
  ownedHash: string;
  baseOwnedHash: string;
  /** Owned files that are new and untracked, so a diff against base does not list them. */
  untracked: string[];
  /** Those of `files` that exist at the base commit. */
  presentAtBase: string[];
}

export function ownedState(view: RepoView, record: ChangeRecord, baseSha: string): OwnedState {
  const { root, config } = view;
  const nodes = record.capabilities.map((c) => capabilityNode(view, c)).filter((n): n is SpecNode => n !== undefined);
  const owned = new Set<string>();
  const patterns: RegExp[] = [];
  for (const n of nodes) {
    for (const f of n.ownedFiles) if (!view.sources.has(f)) owned.add(f);
    const app = appForSpecFile(config, n.spec.filePath) ?? config.apps[0];
    for (const p of declaredSources(n.spec)) {
      patterns.push(globToRegExp(p));
      if (app && app.repo && app.repo !== '.') patterns.push(globToRegExp(path.posix.join(app.repo.split(path.sep).join('/'), p)));
    }
  }
  const changed = changedSinceBase(root, baseSha);
  for (const [file, kind] of changed) if (kind === 'D' && !view.sources.has(file) && patterns.some((re) => re.test(file))) owned.add(file);

  const files = [...owned].sort();
  const now: Array<[string, string | null]> = [];
  const base: Array<[string, string | null]> = [];
  const codeFiles: string[] = [];
  const untracked: string[] = [];
  const presentAtBase: string[] = [];
  for (const f of files) {
    const cur = hashFile(path.join(root, f));
    const kind = changed.get(f);
    let was: string | null;
    if (kind === undefined) was = cur;
    else if (kind === 'A' || kind === 'U') was = null;
    else {
      const bytes = gitBytes(root, ['show', `${baseSha}:./${f}`]);
      was = bytes ? sha256(bytes) : null;
    }
    if (kind === 'U') untracked.push(f);
    now.push([f, cur]);
    base.push([f, was]);
    if (was !== null) presentAtBase.push(f);
    if (cur !== was) codeFiles.push(f);
  }
  return { files, codeFiles, ownedHash: treeHash(now), baseOwnedHash: treeHash(base), untracked, presentAtBase };
}

// ---------------------------------------------------------------------------
// Facts and status
// ---------------------------------------------------------------------------

export interface ChangeFacts {
  record: ChangeRecord;
  base: { ref: string; sha: string; source: BaseSource; skipped: BaseSkip[] };
  /** What `computeStage` decides from. */
  input: StageInput;
  /** Approvals that count locally, by changed ref (recorded entries and plan-derived ones). */
  approvals: Map<string, Approval>;
  owned: OwnedState;
  /** Refs the tests and spec hashes cover: the changed refs, or every claim of the capabilities for a refactor. */
  trackedRefs: string[];
  /** Test files tagged to a tracked ref, sorted. */
  trackedTests: string[];
}

export interface GatherOpts {
  base?: string;
  /** What CI said about this commit, when the caller knows (the proof store reads it from notes). Absent: not validated. */
  ci?: StageInput['ci'];
}

/** The red or green record of a run: the verdicts come from the run record's content, the hashes from the pointer taken when it ran. */
function runRecordOf(root: string, kind: RunKind, p: RunPointer | undefined): RedRecord | GreenRecord | undefined {
  if (!p) return undefined;
  const run = readRunRecord(root, p.runRecord);
  if (!run) return undefined;
  const tests = pointerTests(run);
  const common = { version: 1 as const, changeId: p.changeId, runId: run.runId, at: run.finishedAt ?? p.at, claimsHash: p.claimsHash, testsHash: p.testsHash, ownedHash: p.ownedHash, tests };
  return kind === 'red' ? { ...common, mode: p.mode, baseOwnedHash: p.baseOwnedHash, origin: 'local' } : common;
}

/** Every claim ref (`specKey#claim`) of the change's capabilities. */
function allClaimRefs(view: RepoView, record: ChangeRecord): string[] {
  return record.capabilities.flatMap((c) => {
    const n = capabilityNode(view, c);
    return n ? n.spec.claims.filter((cl) => cl.id).map((cl) => `${n.spec.specKey}#${cl.id}`) : [];
  });
}

export async function gatherFacts(view: RepoView, record: ChangeRecord, opts: GatherOpts = {}): Promise<{ ok: true; facts: ChangeFacts } | { ok: false; error: string }> {
  const { config, root } = view;
  const resolved = resolveChangeBase(root, config, record, opts.base);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  // Changed claims: the specs at base against the working tree.
  const specsRoot = specsRootDir(config);
  const was = new Map<string, ParsedSpec | undefined>();
  const now = new Map<string, ParsedSpec | undefined>();
  for (const cap of record.capabilities) {
    const node = capabilityNode(view, cap);
    now.set(cap, node?.spec);
    let before: ParsedSpec | undefined;
    if (node) {
      const text = gitOut(root, ['show', `${resolved.sha}:./${posixRel(root, node.spec.filePath)}`]);
      if (text !== undefined) before = { ...parseSpecContent(text, node.spec.filePath, specsRoot), specKey: node.spec.specKey };
    }
    was.set(cap, before);
  }
  const changed = diffClaims(was, now);
  const required = requiredRefs(changed);

  // Approvals: a person's recorded entries, and the plans linked to this change (dated on or after the base commit).
  const history = listHistory(config);
  const recorded = indexApprovals(approvalsFrom(history));
  const baseDate = gitOut(root, ['show', '-s', '--format=%cI', resolved.sha])?.trim().slice(0, 10) ?? '';
  const plans = record.plans.map((id) => history.find((e) => e.id === id)).filter((e): e is HistoryEntry => e !== undefined && e.date >= baseDate);
  const planned = indexApprovals(derivePlanApprovals(record, plans, changed));
  const approvals = new Map<string, Approval>();
  const approved: StageInput['approved'] = new Map();
  for (const c of required) {
    const a = c.hash ? (recorded.find(c.ref, c.hash) ?? planned.find(c.ref, c.hash)) : undefined;
    if (a) approvals.set(c.ref, a);
    approved.set(c.ref, a ? { method: a.method, by: a.by } : undefined);
  }

  // Tests tagged to each changed ref, and the hashes that tie a run to the files it ran against.
  const tagged: StageInput['tagged'] = new Map();
  for (const c of required) tagged.set(c.ref, view.tests.filter((t) => t.keys.has(c.ref)).map((t) => ({ id: t.id, file: t.file, strength: t.strength })));
  const trackedRefs = record.kind === 'refactor' ? allClaimRefs(view, record) : required.map((c) => c.ref);
  const trackedTests = [...new Set(view.tests.filter((t) => trackedRefs.some((r) => t.keys.has(r))).map((t) => t.file))].sort();
  const testsHash = testFilesHash(trackedTests.map((f) => ({ path: f, sha256: sha256(view.sources.get(f) ?? '') })));
  const owned = ownedState(view, record, resolved.sha);
  const red = runRecordOf(root, 'red', readPointer(root, record.id, 'red')) as RedRecord | undefined;
  const green = runRecordOf(root, 'green', readPointer(root, record.id, 'green')) as GreenRecord | undefined;

  const input: StageInput = {
    record,
    changed,
    approved,
    tagged,
    current: { claimsHash: changedClaimsHash(changed), testsHash, ownedHash: owned.ownedHash, baseOwnedHash: owned.baseOwnedHash },
    codeFiles: owned.codeFiles,
    ...(red ? { red } : {}),
    ...(green ? { green } : {}),
    ...(opts.ci ? { ci: opts.ci } : {}),
    policy: { redAcceptsErrors: config.change?.redAcceptsErrors ?? CHANGE_DEFAULTS.redAcceptsErrors },
  };
  return {
    ok: true,
    facts: { record, base: { ref: resolved.ref, sha: resolved.sha, source: resolved.source, skipped: resolved.skipped }, input, approvals, owned, trackedRefs, trackedTests },
  };
}

export interface ChangeStatusEntry extends ChangeStatus {
  capabilities: string[];
  base: { ref: string; sha: string };
}

/** The status of one change, from the facts of the repository as it is now. */
export async function statusOf(view: RepoView, record: ChangeRecord, opts: GatherOpts = {}): Promise<{ ok: true; entry: ChangeStatusEntry; facts: ChangeFacts } | { ok: false; error: string }> {
  const gathered = await gatherFacts(view, record, opts);
  if (!gathered.ok) return gathered;
  const computed = computeStage(gathered.facts.input);
  // A closed change has nothing left to do: its blocks would only mislead, so it has no next step.
  const status: ChangeStatus = record.closed ? { ...computed, blocks: [], next: 'nothing: the change is closed' } : computed;
  return { ok: true, entry: { ...status, capabilities: record.capabilities, base: { ref: gathered.facts.base.ref, sha: gathered.facts.base.sha } }, facts: gathered.facts };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const short = (sha: string): string => sha.slice(0, 7);

export function statusLines(s: ChangeStatusEntry): string[] {
  const lines = [`${s.id}  [${s.kind}]  ${s.capabilities.join(', ')}`, `  base: ${s.base.ref} (${short(s.base.sha)})`];
  if (s.closed) {
    lines.push(`  closed: ${s.closed.reason} by ${s.closed.by} at ${s.closed.at}${s.closed.note ? ` (${s.closed.note})` : ''}`);
    return lines;
  }
  lines.push(`  stage: ${s.stage}${s.done.length > 0 ? ` (done: ${s.done.join(', ')})` : ''}${s.kind === 'spike' ? '  [code-first allowed; cannot merge as a spike]' : ''}`);
  if (s.changed.length > 0) lines.push(`  changed requirements (${s.changed.length}): ${s.changed.slice(0, 6).map((c) => `${c.ref} (${c.change})`).join(', ')}${s.changed.length > 6 ? ', ...' : ''}`);
  if (s.codeFiles.length > 0) lines.push(`  owned code differing from base: ${s.codeFiles.slice(0, 6).join(', ')}${s.codeFiles.length > 6 ? ', ...' : ''}`);
  if (s.red !== 'none' || s.lockedTests.length > 0) lines.push(`  red: ${s.red}${s.lockedTests.length > 0 ? `; editing these tests sends the change back to red: ${s.lockedTests.join(', ')}` : ''}`);
  for (const b of s.blocks) {
    lines.push(`  [${b.code}] ${b.message}`);
    lines.push(`      fix: ${b.fix}`);
  }
  lines.push(`  next: ${s.next}`);
  return lines;
}

function fail(result: PipelineResult, message: string, exitCode: number = ExitCode.InternalError): PipelineResult {
  result.failed += 1;
  result.exitCode = exitCode;
  result.messages.push(message);
  return result;
}

// ---------------------------------------------------------------------------
// Which change(s) a command means
// ---------------------------------------------------------------------------

type Selection = { ok: true; records: ChangeRecord[] } | { ok: false; error: string };

/** The named change, or (with no id) every open change on this branch. */
export function selectChanges(root: string, id: string | undefined, opts: { includeClosed?: boolean } = {}): Selection {
  const { records, errors } = loadChanges(root);
  if (id !== undefined) {
    const picked = pickChange(records, id);
    return picked.ok ? { ok: true, records: [picked.record] } : { ok: false, error: picked.error };
  }
  const branch = currentBranch(root);
  const open = records.filter((r) => (opts.includeClosed ? true : openOnBranch(r, branch)));
  if (open.length === 0) return { ok: false, error: errors.length > 0 ? errors.join('; ') : 'no open change on this branch: specguard change start <capability>' };
  return { ok: true, records: open };
}

/** Exactly one change, for the commands that act on one. */
export function selectOneChange(root: string, id: string | undefined): { ok: true; record: ChangeRecord } | { ok: false; error: string } {
  const sel = selectChanges(root, id);
  if (!sel.ok) return sel;
  if (sel.records.length > 1) return { ok: false, error: `${sel.records.length} changes are open on this branch (${sel.records.map((r) => r.id).join(', ')}): name one` };
  return { ok: true, record: sel.records[0]! };
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

export interface ChangeStartOpts {
  capabilities: string[];
  kind?: ChangeKind;
  why?: string;
  base?: string;
  /** A history entry id of an approved plan to link. */
  plan?: string;
  /** Injected for tests. */
  now?: Date;
  random?: () => string;
}

export async function runChangeStart(config: SpecGuardConfig, opts: ChangeStartOpts): Promise<PipelineResult> {
  const result = emptyResult('change');
  const log = (line: string): void => void result.messages.push(line);
  const root = config.rootDir ?? process.cwd();
  const kind = opts.kind ?? 'feature';
  if (!(CHANGE_KINDS as readonly string[]).includes(kind)) return fail(result, `unknown change kind "${kind}"`);
  const capabilities = [...new Set(opts.capabilities.map((c) => c.trim()).filter(Boolean))];
  if (capabilities.length === 0) return fail(result, 'name at least one capability: specguard change start <capability...>');

  const view = await openRepo(config);
  const unknown = capabilities.filter((c) => !capabilityNode(view, c));
  if (unknown.length > 0) {
    const known = [...view.graph.nodes.values()].filter((n) => n.kind === 'capability' || n.kind === 'component').map((n) => n.id).sort();
    return fail(result, `no capability named ${unknown.join(', ')}; known: ${known.join(', ') || 'none'}`);
  }

  const startSha = gitOut(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])?.trim();
  if (!startSha) return fail(result, 'this is not a git repository with a commit: a change needs a base commit to be judged against');
  const branch = currentBranch(root);
  const base = resolveChangeBase(root, config, undefined, opts.base);
  if (!base.ok) return fail(result, base.error);
  // On the branch the base ref names, the merge-base would move with every commit: pin the commit instead.
  const baseRef = base.ref === branch ? startSha : base.ref;

  const history = listHistory(config);
  const existing = loadChanges(root).records;
  let plans: string[] = [];
  if (opts.plan !== undefined) {
    if (!history.some((e) => e.id === opts.plan)) return fail(result, `no history entry "${opts.plan}"`);
    plans = [opts.plan];
  } else {
    const linked = new Set(existing.flatMap((r) => r.plans));
    const system = view.graph.system?.id;
    const candidate = [...history]
      .reverse()
      .find((e) => (e.kind === 'plan' || e.kind === 'prompt+plan') && !linked.has(e.id) && (e.affects.some((a) => capabilities.includes(a)) || (system !== undefined && e.affects.length === 1 && e.affects[0] === system)) && Date.now() - mtimeOf(e.file) <= PLAN_WINDOW_MS);
    if (candidate) {
      plans = [candidate.id];
      log(`[plan] linked the plan captured moments ago: ${candidate.id}`);
    }
  }

  for (const other of existing.filter((r) => openOnBranch(r, branch) && r.capabilities.some((c) => capabilities.includes(c)))) {
    log(`[warn] change ${other.id} is open on this branch for ${other.capabilities.filter((c) => capabilities.includes(c)).join(', ')}; both will be judged on the same changed claims`);
  }

  // A capability born in this change takes the configured starting level (a one-line frontmatter edit no claim hash covers).
  for (const cap of capabilities) {
    const node = capabilityNode(view, cap)!;
    const rel = posixRel(root, node.spec.filePath);
    if (gitOut(root, ['show', `${base.sha}:./${rel}`]) !== undefined || node.spec.meta.enforce || unknownEnforce(node.spec.meta)) continue;
    const level = newCapabilityEnforce(config.enforce);
    const before = readFileSync(node.spec.filePath, 'utf8');
    const after = setEnforceLevel(before, level);
    if (after !== before) {
      await writeFile(node.spec.filePath, after);
      log(`[enforce] ${cap} is new in this change: enforce: ${level} written to ${rel}`);
    }
  }

  const random = opts.random ?? ((): string => randomBytes(2).toString('hex'));
  const now = opts.now ?? new Date();
  let id = newChangeId(now, opts.why ?? capabilities.join('-'), random);
  for (let tries = 0; existsSync(path.join(root, '.specguard', 'changes', `${id}.json`)) && tries < 8; tries += 1) id = newChangeId(now, opts.why ?? capabilities.join('-'), random);
  if (!isChangeId(id)) return fail(result, `could not make a change id from "${opts.why ?? capabilities.join('-')}"`);

  const record: ChangeRecord = {
    version: 1,
    id,
    kind,
    capabilities,
    ...(opts.why?.trim() ? { why: opts.why.trim() } : {}),
    createdAt: now.toISOString(),
    createdBy: actorName(root),
    baseRef,
    startSha,
    ...(branch ? { branch } : {}),
    plans,
  };
  await saveChange(root, record);
  result.created = 1;
  result.items.push({ key: id, status: 'created', path: `.specguard/changes/${id}.json` });
  log(`change ${id} started (${kind}) for ${capabilities.join(', ')}; base ${baseRef === startSha ? `${short(startSha)} (this commit)` : `${base.ref} (${short(base.sha)})`}`);
  for (const skip of base.skipped) log(`[info] base ${skip.ref} skipped (${skip.reason})`);
  const status = await statusOf(view, record, { base: opts.base });
  if (status.ok) log(`next: ${status.entry.next}`);
  return result;
}

function mtimeOf(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// status, list
// ---------------------------------------------------------------------------

export interface ChangeStatusOpts {
  id?: string;
  base?: string;
  ci?: StageInput['ci'];
  /** `list`: closed changes too. */
  all?: boolean;
}

/** Status of the named change, or of every open change on the branch; the JSON shape of `change status --json`. */
export async function changeStatuses(config: SpecGuardConfig, opts: ChangeStatusOpts = {}): Promise<{ ok: true; changes: ChangeStatusEntry[]; errors: string[] } | { ok: false; error: string }> {
  const root = config.rootDir ?? process.cwd();
  const sel = selectChanges(root, opts.id, { includeClosed: opts.all });
  if (!sel.ok) return sel;
  const view = await openRepo(config);
  const changes: ChangeStatusEntry[] = [];
  const errors: string[] = [];
  for (const record of sel.records) {
    const status = await statusOf(view, record, { base: opts.base, ci: opts.ci });
    if (status.ok) changes.push(status.entry);
    else errors.push(`${record.id}: ${status.error}`);
  }
  return { ok: true, changes, errors };
}

export async function runChangeStatus(config: SpecGuardConfig, opts: ChangeStatusOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('change');
  const got = await changeStatuses(config, opts);
  if (!got.ok) return fail(result, got.error);
  for (const entry of got.changes) {
    result.messages.push(...statusLines(entry));
    result.created += 1;
    result.items.push({ key: entry.id, status: entry.done.includes('validated') ? 'ok' : 'skipped', message: entry.closed ? `closed (${entry.closed.reason})` : `${entry.stage}: ${entry.next}` });
  }
  for (const e of got.errors) {
    result.failed += 1;
    result.messages.push(`[error] ${e}`);
  }
  if (result.failed > 0) result.exitCode = ExitCode.InternalError;
  return result;
}

/** `change list`: every open change (and closed ones with `all`) with its derived stage, on one line each. */
export async function runChangeList(config: SpecGuardConfig, opts: { all?: boolean; base?: string } = {}): Promise<PipelineResult> {
  const result = emptyResult('change');
  const root = config.rootDir ?? process.cwd();
  const { records, errors } = loadChanges(root);
  const view = await openRepo(config);
  const shown = records.filter((r) => opts.all || !r.closed);
  if (shown.length === 0) result.messages.push('no open change: specguard change start <capability>');
  for (const record of shown) {
    const status = await statusOf(view, record, { base: opts.base });
    const stage = record.closed ? `closed (${record.closed.reason})` : status.ok ? status.entry.stage : 'unknown';
    result.messages.push(`${record.id}  [${record.kind}]  ${record.capabilities.join(', ')}  ${stage}${record.branch ? `  @${record.branch}` : ''}`);
    result.items.push({ key: record.id, status: 'ok', message: stage });
    result.created += 1;
  }
  for (const e of errors) result.messages.push(`[error] ${e}`);
  result.failed = errors.length;
  if (errors.length > 0) result.exitCode = ExitCode.InternalError;
  return result;
}

// ---------------------------------------------------------------------------
// done, abandon, convert
// ---------------------------------------------------------------------------

const closedMessage = (r: ChangeRecord): string => `change ${r.id} is closed (${r.closed?.reason}): a closed record is never edited`;

export async function runChangeDone(config: SpecGuardConfig, opts: { id?: string; force?: boolean; why?: string; base?: string; ci?: StageInput['ci']; now?: Date } = {}): Promise<PipelineResult> {
  const result = emptyResult('change');
  const root = config.rootDir ?? process.cwd();
  const one = selectOneChange(root, opts.id);
  if (!one.ok) return fail(result, one.error);
  const record = one.record;
  if (record.closed) return fail(result, closedMessage(record));
  const status = await statusOf(await openRepo(config), record, { base: opts.base, ci: opts.ci });
  if (!status.ok) return fail(result, status.error);
  // `stage: validated` with a NOT_VALIDATED block means green and waiting for CI: only a satisfied last stage is validated.
  const validated = status.entry.done.includes('validated');
  if (!validated && !opts.force) {
    result.messages.push(...statusLines(status.entry));
    return fail(result, `change ${record.id} is at ${status.entry.stage === 'validated' ? 'green and waiting for CI' : status.entry.stage}, not validated: finish it (next: ${status.entry.next}), or close it anyway with --force --why <text>`, ExitCode.ValidationFailed);
  }
  if (!validated && !opts.why?.trim()) return fail(result, '--force needs --why <text>: a forced close is labelled in the packet');
  const at = (opts.now ?? new Date()).toISOString();
  await saveChange(root, {
    ...record,
    closed: {
      at,
      by: actorName(root),
      reason: 'done',
      ...(validated ? { validatedAt: at } : { note: `forced at ${status.entry.stage}: ${opts.why!.trim()}` }),
    },
  });
  result.updated = 1;
  result.items.push({ key: record.id, status: 'updated', message: validated ? 'done' : 'done (forced)' });
  result.messages.push(`change ${record.id} closed as done${validated ? '' : ` (forced at ${status.entry.stage})`}`);
  return result;
}

export async function runChangeAbandon(config: SpecGuardConfig, opts: { id?: string; why?: string; now?: Date } = {}): Promise<PipelineResult> {
  const result = emptyResult('change');
  const root = config.rootDir ?? process.cwd();
  const one = selectOneChange(root, opts.id);
  if (!one.ok) return fail(result, one.error);
  if (one.record.closed) return fail(result, closedMessage(one.record));
  if (!opts.why?.trim()) return fail(result, 'abandoning a change needs --why <text>');
  await saveChange(root, { ...one.record, closed: { at: (opts.now ?? new Date()).toISOString(), by: actorName(root), reason: 'abandoned', note: opts.why.trim() } });
  result.updated = 1;
  result.items.push({ key: one.record.id, status: 'updated', message: 'abandoned' });
  result.messages.push(`change ${one.record.id} abandoned: ${opts.why.trim()} (hooks and CI now ignore it; its requirement edits stay in the working tree)`);
  return result;
}

/** `change convert <id> --to feature`: a spike with approved-able requirements and tagged tests becomes a feature; CI then decides. */
export async function runChangeConvert(config: SpecGuardConfig, opts: { id?: string; to?: string; base?: string; now?: Date } = {}): Promise<PipelineResult> {
  const result = emptyResult('change');
  const root = config.rootDir ?? process.cwd();
  if ((opts.to ?? 'feature') !== 'feature') return fail(result, `a spike can only be converted to a feature (--to feature), not "${opts.to}"`);
  const one = selectOneChange(root, opts.id);
  if (!one.ok) return fail(result, one.error);
  const record = one.record;
  if (record.closed) return fail(result, closedMessage(record));
  if (record.kind !== 'spike') return fail(result, `change ${record.id} is a ${record.kind}, not a spike`);
  const status = await statusOf(await openRepo(config), record, { base: opts.base });
  if (!status.ok) return fail(result, status.error);
  const { changed, tagged } = status.facts.input;
  if (changed.length === 0) return fail(result, `change ${record.id} has no changed requirement yet: state what the spike established in the spec first`, ExitCode.ValidationFailed);
  const untested = requiredRefs(changed).filter((c) => (tagged.get(c.ref) ?? []).length === 0).map((c) => c.ref);
  if (untested.length > 0) return fail(result, `no test is tagged to ${untested.join(', ')}: write and tag tests before converting`, ExitCode.ValidationFailed);
  const now = (opts.now ?? new Date()).toISOString();
  await saveChange(root, { ...record, kind: 'feature', convertedFrom: { kind: 'spike', at: now, by: actorName(root) } });
  result.updated = 1;
  result.items.push({ key: record.id, status: 'updated', message: 'converted to feature' });
  result.messages.push(`change ${record.id} is now a feature; it still needs approved requirements, a valid red and green run, and a CI pass`);
  return result;
}

// ---------------------------------------------------------------------------
// report: the PR proof packet, built locally (provisional)
// ---------------------------------------------------------------------------

export interface ChangeReportOpts {
  id?: string;
  base?: string;
  ci?: StageInput['ci'];
  generated?: string;
}

/** Added lines of a new untracked file, so a diff-shaped record exists for code that git has not seen. */
function untrackedAsDiff(root: string, file: string): { file: string; status: 'added'; added: number[]; removed: number[]; addedText: Array<{ line: number; text: string }>; binary: boolean } {
  const lines = readFileSync(path.join(root, file), 'utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return { file, status: 'added', added: lines.map((_, i) => i + 1), removed: [], addedText: lines.map((text, i) => ({ line: i + 1, text })), binary: false };
}

function weakeningOf(view: RepoView, bev: NonNullable<ReturnType<typeof baseEvidence>>): WeakeningFinding[] {
  const { config, root } = view;
  const out: WeakeningFinding[] = [];
  const specsRoot = specsRootDir(config);
  const projectLayers = config.proof?.requiredLayers ?? [];
  for (const n of view.graph.nodes.values()) {
    if (n.kind !== 'capability' && n.kind !== 'component') continue;
    const text = bev.show(posixRel(root, n.spec.filePath));
    if (text === undefined) continue;
    out.push(...diffSpecPolicy({ ...parseSpecContent(text, n.spec.filePath, specsRoot), specKey: n.spec.specKey }, n.spec, projectLayers, config.enforce?.default));
  }
  const before = bev.show(CONFIG_FILE);
  if (before !== undefined) {
    try {
      out.push(...diffConfigPolicy(JSON.parse(before), JSON.parse(readFileSync(path.join(root, CONFIG_FILE), 'utf8'))));
    } catch {
      /* an unreadable config on either side is not a weakening we can name */
    }
  }
  const live = new Set([...view.graph.nodes.values()].flatMap((n) => n.spec.claims.filter((c) => c.id).map((c) => `${n.spec.specKey}#${c.id}`)));
  const changed = new Set(bev.changed.filter((c) => c.status !== 'added').map((c) => c.file));
  for (const [file, source] of view.sources) {
    if (changed.has(file)) out.push(...diffTestFile(bev.show(file), source, file, view.strengthCfg, live));
  }
  out.push(...scanAddedSource(bev.changed, (f) => view.sources.has(f)), ...snapshotRewrites(bev.changed));
  return out;
}

function sensitivityOf(facts: ChangeFacts, status: ChangeStatus): Map<string, ClaimEvidence['sensitivity']> {
  const out = new Map<string, ClaimEvidence['sensitivity']>();
  const { input } = facts;
  const red = input.red;
  const greenOk = !status.blocks.some((b) => b.code === 'GREEN_MISSING' || b.code === 'GREEN_STALE' || b.code === 'GREEN_FAILING') && status.done.includes('green');
  const byClaim = new Map<string, ChangedClaim[]>();
  for (const c of requiredRefs(input.changed)) byClaim.set(claimRefOf(c.ref), [...(byClaim.get(claimRefOf(c.ref)) ?? []), c]);
  for (const [claim, refs] of byClaim) {
    let failing = 0;
    let notRed = false;
    let allRed = red !== undefined && status.red === 'valid';
    for (const c of refs) {
      const fails = red?.tests.filter((t) => t.claims.includes(c.ref) && (t.status === 'fail' || t.status === 'error')).length ?? 0;
      failing += fails;
      if (red && fails === 0) notRed = true;
      if (fails === 0) allRed = false;
    }
    const redStatus: 'ok' | 'fail' | 'unknown' = notRed && status.red !== 'valid' ? 'fail' : allRed && greenOk ? 'ok' : 'unknown';
    out.set(claim, { kind: 'red-green', status: redStatus, redTests: failing });
  }
  return out;
}

/** The provisional proof packet of the named change, or of every open change on the branch, with its markdown. */
export async function buildChangePacket(config: SpecGuardConfig, opts: ChangeReportOpts = {}): Promise<{ ok: true; packet: ProofPacket; markdown: string; warnings: string[] } | { ok: false; error: string }> {
  const root = config.rootDir ?? process.cwd();
  const sel = selectChanges(root, opts.id);
  if (!sel.ok) return sel;
  const view = await openRepo(config);
  const warnings: string[] = [];

  const entries: ChangeStatusEntry[] = [];
  const factsOf: ChangeFacts[] = [];
  for (const record of sel.records) {
    const s = await statusOf(view, record, { base: opts.base, ci: opts.ci });
    if (!s.ok) return { ok: false, error: `${record.id}: ${s.error}` };
    entries.push(s.entry);
    factsOf.push(s.facts);
  }
  const base = factsOf[0]!.base;
  const bev = baseEvidence(root, base.sha, warnings);
  if (!bev) return { ok: false, error: warnings.join('; ') || `base ${base.ref} could not be read` };

  const { model } = await loadTrace(config);
  const specsRel = path.relative(root, specsRootDir(config)).split(path.sep).join('/');
  const gaps = intentGaps(root, model.nodes, listHistory(config), specsRel);
  const assembled = await buildStatementInput(config, { model, gaps }, { base: base.sha, generated: opts.generated });
  warnings.push(...assembled.warnings);
  const statement = computeStatement(assembled.input);

  // Changed claims, once each, whichever change covers them.
  const changedByRef = new Map<string, ChangedClaim>();
  const approvals = new Map<string, PacketApproval>();
  const sensitivity = new Map<string, ClaimEvidence['sensitivity']>();
  for (const [i, facts] of factsOf.entries()) {
    for (const c of facts.input.changed) changedByRef.set(c.ref, c);
    for (const [ref, a] of facts.approvals) approvals.set(ref, { method: a.method, by: a.by, trust: a.method === 'pr' ? 'verified' : 'recorded', source: a.entry, date: a.date });
    for (const [claim, s] of sensitivityOf(facts, entries[i]!)) if (!sensitivity.has(claim) || s.kind === 'red-green') sensitivity.set(claim, s);
  }
  const changed = [...changedByRef.values()];

  const changes: ChangeVerdict[] = entries.map((e) => ({
    id: e.id,
    kind: e.kind,
    capabilities: e.capabilities,
    verdict: e.kind === 'spike' ? 'spike' : e.done.includes('green') ? 'pass' : 'fail',
    claims: [...new Set(e.changed.filter((c) => c.change !== 'removed').map((c) => claimRefOf(c.ref)))],
    chronology: { testsBeforeCode: null, note: 'order is checked locally by stage detection; the commit chronology is not read here' },
  }));

  // Unrequested code: judged from coverage evidence when a run left some, and from the diff alone otherwise.
  const files = bev.changed;
  const untrackedOwned = new Set(factsOf.flatMap((f) => f.owned.untracked));
  const changedFiles = [...files, ...[...untrackedOwned].filter((f) => !files.some((c) => c.file === f)).map((f) => untrackedAsDiff(root, f))];
  const ownedBy = new Map<string, string[]>();
  for (const n of view.graph.nodes.values()) for (const f of n.ownedFiles) ownedBy.set(f, [...(ownedBy.get(f) ?? []), n.id]);
  const openCaps = new Set([...entries.flatMap((e) => e.capabilities), ...loadChanges(root).records.filter((r) => openOnBranch(r, currentBranch(root))).flatMap((r) => r.capabilities)]);
  const suite = await readCoverageEvidence(root);
  const capEvidence = new Map<string, CoverageEvidence>();
  for (const cap of openCaps) {
    const ev = await readCoverageEvidence(root, cap);
    if (ev) capEvidence.set(cap, ev);
  }
  const unrequestedFull = findUnrequested({
    changed: changedFiles,
    ownedBy,
    changeCaps: openCaps,
    ...(suite ? { changeCoverage: suite } : {}),
    ...(capEvidence.size > 0 ? { capabilityCoverage: capEvidence } : {}),
    currentHashes: hashFiles(root, changedFiles.map((c) => c.file)),
  });
  // With no coverage evidence at all every changed line reads `unknown`: say so once (the packet's limits do) instead of listing them.
  const unrequested: UnrequestedReport = suite || capEvidence.size > 0 ? unrequestedFull : { ...unrequestedFull, lines: [] };

  const enforce = new Map<string, EnforceLevel>();
  for (const n of view.graph.nodes.values()) if (n.kind === 'capability' || n.kind === 'component') enforce.set(n.id, effectiveEnforce(n.spec.meta, config.enforce));

  const packet = buildPacket({
    statement,
    changed,
    approvals,
    sensitivity,
    changes,
    weakening: weakeningOf(view, bev),
    unrequested,
    pipeline: [],
    enforce,
    meta: { generated: opts.generated ?? new Date().toISOString(), head: gitOut(root, ['rev-parse', 'HEAD'])?.trim() ?? '', base: base.sha, baseRef: base.ref, tool: cliVersion(), provisional: true },
    policy: { unrequested: config.unrequested?.severity ?? 'error' },
  });
  return { ok: true, packet, markdown: renderPacketMarkdown(packet), warnings };
}

export async function runChangeReport(config: SpecGuardConfig, opts: ChangeReportOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('change');
  const built = await buildChangePacket(config, opts);
  if (!built.ok) return fail(result, built.error);
  result.messages.push(...built.markdown.split('\n'));
  for (const w of built.warnings) result.messages.push(`[warn] ${w}`);
  result.created = 1;
  result.items.push({ key: 'packet', status: 'ok', message: `${built.packet.verdict} (provisional)` });
  return result;
}
