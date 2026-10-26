/**
 * `specguard migrate`: bring a repository from an older SpecGuard layout to the current one.
 *
 * `gatherFacts` reads the repository (git index, ignore block, ledger, spec frontmatter, a resume state file) without
 * changing it, and `src/core/migrate-plan.ts` turns the facts into ordered steps. A dry run, the default, only prints
 * them. With `--yes` this module applies the steps the tool may do itself, each one idempotent: refresh the ignore
 * block, stop tracking the generated proof files (they stay on disk), mark committed proof rows provisional, archive
 * per-file specs with `git mv`, add config keys and guard hooks only where absent. Steps that need the host agent
 * (drafting and tagging capability specs) and steps that are a person's decision (approving what the code does,
 * committing, pushing) are printed as exact commands and never run here.
 *
 * Exit codes: 0 when nothing is left, 12 while agent work is pending (rerun `migrate --yes` once it is done), 14
 * (`MIGRATE_PERSON_PENDING`) when only steps for a person remain, 2 when it refuses a dirty working tree.
 *
 * Spec: specs/capabilities/platform-foundation.md
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../core/config.js';
import { ConfigNotFoundError, SpecGuardError } from '../core/errors.js';
import { ExitCode } from '../core/exit-codes.js';
import { scanSourceForClaimTags } from '../core/claim-tags.js';
import {
  detectFormat,
  planMigration,
  renderMigrationPlan,
  type MigrateStep,
  type MigrateStepId,
  type RepoFacts,
  type RepoFormat,
} from '../core/migrate-plan.js';
import { expandGlobs, fileExists, readFile } from '../core/reader.js';
import { loadRepoSpecs } from '../core/spec-graph.js';
import { applyIgnoreBlock, IGNORE_END, IGNORE_START } from '../core/state-ignore.js';
import { PROOF_STORE_DEFAULTS, type ParsedSpec, type PipelineResult, type SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { writeFile } from '../core/writer.js';
import { loadAllSpecs } from '../legacy/index.js';
import { approvalStatus } from './approve.js';
import { ledgerPath } from './proof.js';

/** Exit code when the tool has done what it can and only steps for a person remain. 12 is agent work, 2 a refusal. */
export const MIGRATE_PERSON_PENDING = 14;

export interface MigrateOpts {
  /** The repository directory (default: the current directory). */
  cwd?: string;
  /** Apply the steps the tool may do itself. Without it the run only prints the plan. */
  yes?: boolean;
  /** v0.1 route for hand-written intent: print `spec consolidate` instead of archive, draft and tag. */
  consolidate?: boolean;
  /** Apply on a working tree with uncommitted changes. */
  allowDirty?: boolean;
}

export interface MigrateResult extends PipelineResult {
  format: RepoFormat;
  /** The plan as it stands after this run: the steps applied are `done`. */
  steps: MigrateStep[];
  /** Steps this run applied. */
  applied: MigrateStepId[];
}

const CONFIG_REL = '.specguard/config.json';
const GITIGNORE_REL = '.gitignore';
const LEDGER_REL = '.specguard/proofs.json';
const TRACE_REL = '.specguard/trace.json';
const SETTINGS_REL = '.claude/settings.json';
const WORKFLOW_REL = '.github/workflows/specguard.yml';
const MIGRATE_DIR_REL = '.specguard/cache/migrate';
const STATE_REL = `${MIGRATE_DIR_REL}/state.json`;
const CACHE_PREFIX = '.specguard/cache/';

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function gitTry(root: string, args: string[]): string | undefined {
  try {
    return git(root, args);
  } catch {
    return undefined;
  }
}

function isWorkTree(root: string): boolean {
  return gitTry(root, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

function isTracked(root: string, rel: string): boolean {
  return (gitTry(root, ['ls-files', '--', rel]) ?? '').trim().length > 0;
}

/** `git status --porcelain` paths under the repository directory, relative to it. */
function dirtyPaths(root: string): string[] {
  const out = gitTry(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']) ?? '';
  const prefix = (gitTry(root, ['rev-parse', '--show-prefix']) ?? '').trim();
  const parts = out.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    paths.push(prefix && entry.slice(3).startsWith(prefix) ? entry.slice(3 + prefix.length) : entry.slice(3));
    // A rename or copy is followed by its source path as a separate entry.
    if (entry[0] === 'R' || entry[0] === 'C') i += 1;
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

interface SpecEntry {
  /** Repo-relative, POSIX. */
  path: string;
  /** Canonical spec key (the part of a claim ref before `#`). */
  key: string;
}

/** What an earlier `migrate --yes` of this repository left behind: enough to resume, and the proof it is not over. */
interface MigrateState {
  version: 1;
  startedAt: string;
  completedAt?: string;
  format: RepoFormat;
  /** Per-file specs already moved to the archive, so a repository with neither v1 nor v2 specs still reads as v0.1. */
  archived: Array<SpecEntry & { target: string }>;
}

interface Survey {
  root: string;
  config?: SpecGuardConfig;
  facts: RepoFacts;
  /** The state of a migration in progress. Absent when there is none or the last one finished. */
  state?: MigrateState;
  /** Per-file specs still in place. */
  v1: SpecEntry[];
  /** Keys of the capability and component specs. */
  v2Keys: string[];
}

/** Where a v1 spec goes: the planner's rule, `specs/<rel>` becomes `specs/_archive/v1/<rel>`. */
function archiveTarget(file: string): string {
  const rel = file.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^specs\//, '');
  return `specs/_archive/v1/${rel}`;
}

const posix = (root: string, abs: string): string => path.relative(root, abs).split(path.sep).join('/');

async function readState(root: string): Promise<MigrateState | undefined> {
  const file = path.join(root, STATE_REL);
  if (!(await fileExists(file))) return undefined;
  try {
    const parsed = JSON.parse(await readFile(file)) as Partial<MigrateState>;
    if (parsed.version !== 1 || !Array.isArray(parsed.archived) || typeof parsed.startedAt !== 'string') return undefined;
    return parsed as MigrateState;
  } catch {
    return undefined;
  }
}

async function writeState(root: string, state: MigrateState): Promise<void> {
  await writeFile(path.join(root, STATE_REL), `${JSON.stringify(state, null, 2)}\n`);
}

async function loadConfigQuietly(cwd: string): Promise<{ config?: SpecGuardConfig; root: string; hasConfig: boolean }> {
  try {
    const config = await loadConfig(cwd);
    return { config, root: config.rootDir ?? cwd, hasConfig: true };
  } catch (err) {
    if (err instanceof ConfigNotFoundError) return { root: cwd, hasConfig: false };
    // A config that does not validate is still a config: migrate adds keys to its text and never reads past them.
    if (err instanceof SpecGuardError) return { root: cwd, hasConfig: fs.existsSync(path.join(cwd, CONFIG_REL)) };
    throw err;
  }
}

function loadSpecs(root: string, config: SpecGuardConfig | undefined): Array<SpecEntry & { v2: boolean }> {
  const rows: Array<{ spec: ParsedSpec; abs: string }> = [];
  if (config) {
    for (const r of loadRepoSpecs(config)) rows.push({ spec: r.spec, abs: r.abs });
  } else {
    const dir = path.join(root, 'specs');
    if (fs.existsSync(dir)) for (const spec of loadAllSpecs(dir)) rows.push({ spec, abs: path.join(dir, `${spec.specKey}.md`) });
  }
  return rows
    // A markdown file without `kind:` is a per-file spec only when it reads like one (acceptance criteria or a `module:`):
    // a stray note in specs/ must not start a v0.1 migration or be moved. `system` is the old overview, never a spec.
    .filter((r) => r.spec.meta.kind || (r.spec.specKey !== 'system' && (r.spec.claims.length > 0 || Boolean(r.spec.meta.module))))
    .map((r) => ({ path: posix(root, r.abs), key: r.spec.specKey, v2: Boolean(r.spec.meta.kind) }));
}

interface RawLedger {
  text: string;
  doc: Record<string, unknown>;
  rows: Record<string, Record<string, unknown>>;
}

/** The ledger as plain JSON, so fields this version does not know survive a rewrite. */
async function readLedger(file: string): Promise<RawLedger | undefined> {
  if (!(await fileExists(file))) return undefined;
  const text = await readFile(file);
  try {
    const doc = JSON.parse(text) as Record<string, unknown>;
    const rows = doc?.proofs;
    if (rows && typeof rows === 'object' && !Array.isArray(rows)) return { text, doc, rows: rows as Record<string, Record<string, unknown>> };
  } catch {
    /* an unreadable ledger has no rows to migrate */
  }
  return undefined;
}

const claimsOrigin = (row: Record<string, unknown>): boolean => row.origin === undefined || row.origin === 'ci';

async function allClaimsApproved(config: SpecGuardConfig | undefined): Promise<boolean> {
  if (!config) return false;
  try {
    const { claims } = await approvalStatus(config);
    return claims.length > 0 && claims.every((c) => c.approval);
  } catch {
    return false;
  }
}

async function survey(cwd: string): Promise<Survey> {
  const { config, root, hasConfig } = await loadConfigQuietly(cwd);
  const inGit = isWorkTree(root);
  const state = await readState(root);
  const resuming = state && !state.completedAt ? state : undefined;

  const specs = loadSpecs(root, config);
  const v1 = specs.filter((s) => !s.v2).map(({ path: p, key }) => ({ path: p, key }));
  const v2 = specs.filter((s) => s.v2);
  // Archived specs of a migration under way still count as per-file specs: without them the repository between the
  // archive and the end of the draft step has neither kind and would read as `none`.
  const v1Specs = [...new Set([...v1.map((s) => s.path), ...(resuming?.archived.map((a) => a.path) ?? [])])].sort();

  const ledgerFile = ledgerPath(root, config?.paths?.proofLedger);
  const ledger = await readLedger(ledgerFile);
  const rows = ledger ? Object.values(ledger.rows) : [];

  const gitignore = (await fileExists(path.join(root, GITIGNORE_REL))) ? await readFile(path.join(root, GITIGNORE_REL)) : '';
  const hasBlock = gitignore.includes(IGNORE_START) && gitignore.indexOf(IGNORE_END) > gitignore.indexOf(IGNORE_START);

  const notesRef = config?.proofStore?.notesRef ?? PROOF_STORE_DEFAULTS.notesRef;
  const remote = config?.proofStore?.remote ?? PROOF_STORE_DEFAULTS.remote;
  const workflowFile = path.join(root, WORKFLOW_REL);
  const workflowText = (await fileExists(workflowFile)) ? await readFile(workflowFile) : undefined;

  const facts: RepoFacts = {
    hasConfig,
    v1Specs,
    v2Specs: v2.map((s) => s.path).sort(),
    tracked: {
      proofs: inGit && isTracked(root, LEDGER_REL),
      trace: inGit && isTracked(root, TRACE_REL),
      publishSnapshot: false,
    },
    gitignoreBlock: !hasBlock ? 'missing' : applyIgnoreBlock(gitignore) === gitignore ? 'current' : 'outdated',
    hasApprovals: await allClaimsApproved(config),
    notes: {
      localRef: inGit && gitTry(root, ['rev-parse', '--verify', '--quiet', notesRef]) !== undefined,
      fetchRefspec: inGit && (gitTry(root, ['config', '--get-all', `remote.${remote}.fetch`]) ?? '').includes(notesRef),
    },
    workflow: {
      path: workflowText === undefined ? undefined : WORKFLOW_REL,
      generatedBySpecguard: workflowText !== undefined && /generated by `?specguard/i.test(workflowText),
      hasProve: workflowText !== undefined && /\bprove\b/.test(workflowText),
    },
    dirty: inGit ? dirtyPaths(root) : [],
    ledgerRows: rows.length,
    ledgerOriginCi: rows.filter(claimsOrigin).length,
    git: inGit,
  };
  return { root, config, facts, state: resuming, v1, v2Keys: v2.map((s) => s.key) };
}

/** Facts about the repository at `cwd`, gathered without changing anything. A migration under way keeps reading as v0.1. */
export async function gatherFacts(cwd: string): Promise<RepoFacts> {
  return (await survey(cwd)).facts;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

type PlanOpts = { consolidate: boolean; fetchNotes: boolean; workflow: boolean };

interface Plan {
  survey: Survey;
  planOpts: PlanOpts;
  format: RepoFormat;
  steps: MigrateStep[];
  /** True when a step differs from what the pure planner printed (resume knowledge or a missing config). */
  adjusted: boolean;
}

/** `tagged`: a test file of a capability carries a claim tag of that capability; `none`: no capability has test files to tag. */
async function tagState(s: Survey): Promise<'tagged' | 'untagged' | 'none'> {
  if (!s.config) return 'none';
  let anyTests = false;
  for (const r of loadRepoSpecs(s.config)) {
    if (r.spec.meta.kind !== 'capability' && r.spec.meta.kind !== 'component') continue;
    const owners = new Set([r.spec.specKey, r.spec.meta.id]);
    for (const abs of await expandGlobs(r.spec.meta.tests ?? [], s.root)) {
      anyTests = true;
      for (const hit of scanSourceForClaimTags(await readFile(abs), abs)) if (owners.has(hit.ref.split('#')[0])) return 'tagged';
    }
  }
  return anyTests ? 'untagged' : 'none';
}

async function buildPlan(s: Survey, opts: MigrateOpts): Promise<Plan> {
  const planOpts: PlanOpts = { consolidate: opts.consolidate === true, fetchNotes: false, workflow: false };
  const format = detectFormat(s.facts);
  const steps = planMigration(s.facts, planOpts).map((step) => ({ ...step }));
  const step = (id: MigrateStepId): MigrateStep => steps.find((x) => x.id === id) as MigrateStep;
  let adjusted = false;
  const settle = (id: MigrateStepId, state: MigrateStep['state'], description: string, commands?: string[]): void => {
    const target = step(id);
    target.state = state;
    target.description = description;
    target.commands = commands;
    delete target.changes;
    adjusted = true;
  };

  // Resume: per-file specs that an earlier run archived are no longer in place, so the planner's `todo` is really done.
  const archive = step('archive-v1');
  if (archive.state === 'todo' && s.state && s.state.archived.length > 0 && s.v1.length === 0) {
    settle('archive-v1', 'done', `${s.state.archived.length} per-file spec(s) were archived under specs/_archive/v1 earlier in this migration.`);
  }
  // The tag step is the agent's: it counts as done once a capability's tests carry its claim tags, or there are none to tag.
  if (format === 'v0.1' && step('tag').state === 'agent' && s.facts.v2Specs.length > 0) {
    const tags = await tagState(s);
    if (tags === 'tagged') settle('tag', 'done', 'Tests carry claim tags for the drafted capabilities.');
    else if (tags === 'none') settle('tag', 'done', 'No capability lists test files, so there is nothing to tag.');
  }
  // A config of only the new keys would not validate (apps are required): leave creating one to `init`.
  if (!s.facts.hasConfig && step('config').state === 'todo') {
    settle('config', 'person', 'No .specguard/config.json: migrate cannot write a valid one. Create it, then rerun `specguard migrate --yes` to add the new keys.', ['specguard init']);
  }
  return { survey: s, planOpts, format, steps, adjusted };
}

function exitFor(steps: MigrateStep[]): number {
  if (steps.some((s) => s.state === 'agent')) return ExitCode.AgentWorkPending;
  if (steps.some((s) => s.state === 'person' || s.state === 'todo')) return MIGRATE_PERSON_PENDING;
  return ExitCode.Success;
}

function renderSteps(head: string, steps: MigrateStep[]): string[] {
  const lines = [head, ''];
  for (const s of steps) {
    lines.push(`[${s.state}] ${s.id}: ${s.description}`);
    for (const c of s.changes ?? []) lines.push(`    ${c.op} ${c.path}`);
    for (const c of s.commands ?? []) lines.push(`    $ ${c}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

type Undo =
  | { op: 'retrack'; path: string }
  | { op: 'move-back'; from: string; to: string }
  | { op: 'restore'; path: string; backup: string }
  | { op: 'remove'; path: string };

interface Manifest {
  version: 1;
  startedAt: string;
  format: RepoFormat;
  applied: MigrateStepId[];
  backups: string[];
  /** The inverse of each change, for undoing before a commit. */
  undo: Undo[];
}

interface Ctx {
  root: string;
  inGit: boolean;
  survey: Survey;
  state: MigrateState;
  manifest: Manifest;
  /** Save `text` as `name` in this run's backup folder, once: the first copy is the untouched original. */
  backup(name: string, text: string, original: string): Promise<void>;
}

/** Indentation of the first indented key, so an inserted key matches the file. */
function indentOf(text: string): string {
  return /^([ \t]+)"/m.exec(text)?.[1] ?? '  ';
}

/** Add top-level keys to JSON text before its closing brace, leaving every other byte as it was. */
function addTopLevelKeys(text: string, entries: Array<[string, unknown]>): string {
  const close = text.lastIndexOf('}');
  const indent = indentOf(text);
  const before = text.slice(0, close).replace(/\s+$/, '');
  const body = entries
    .map(([key, value]) => `${indent}${JSON.stringify(key)}: ${JSON.stringify(value, null, indent).replace(/\n/g, `\n${indent}`)}`)
    .join(',\n');
  return `${before}${before.endsWith('{') ? '' : ','}\n${body}\n${text.slice(close)}`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function failStep(what: string, err: unknown): SpecGuardError {
  const detail = err instanceof Error ? err.message.trim() : String(err);
  return new SpecGuardError(`migrate: ${what} failed: ${detail}. Nothing after it ran; fix the cause and rerun \`specguard migrate --yes\`.`, ExitCode.InternalError, err);
}

async function applyGitignore(c: Ctx): Promise<boolean> {
  const file = path.join(c.root, GITIGNORE_REL);
  const old = (await fileExists(file)) ? await readFile(file) : undefined;
  const next = applyIgnoreBlock(old ?? '');
  if (next === old) return false;
  if (old === undefined) c.manifest.undo.push({ op: 'remove', path: GITIGNORE_REL });
  else {
    await c.backup('gitignore', old, GITIGNORE_REL);
    c.manifest.undo.push({ op: 'restore', path: GITIGNORE_REL, backup: 'gitignore' });
  }
  await writeFile(file, next);
  return true;
}

async function applyUntrack(c: Ctx, rel: string): Promise<boolean> {
  if (!c.inGit || !isTracked(c.root, rel)) return false;
  try {
    git(c.root, ['rm', '--cached', '--quiet', '--', rel]);
  } catch (err) {
    throw failStep(`\`git rm --cached ${rel}\``, err);
  }
  c.manifest.undo.push({ op: 'retrack', path: rel });
  return true;
}

function ledgerSha(c: Ctx): string {
  if (!c.inGit) return 'untracked';
  return (gitTry(c.root, ['log', '-n1', '--format=%H', '--', LEDGER_REL]) ?? '').trim() || (gitTry(c.root, ['rev-parse', 'HEAD']) ?? '').trim() || 'untracked';
}

async function applyProvisional(c: Ctx): Promise<boolean> {
  const file = ledgerPath(c.root, c.survey.config?.paths?.proofLedger);
  const ledger = await readLedger(file);
  const rows = ledger ? Object.values(ledger.rows).filter(claimsOrigin) : [];
  if (!ledger || rows.length === 0) return false;
  await c.backup('proofs.json', ledger.text, posix(c.root, file));
  c.manifest.undo.push({ op: 'restore', path: posix(c.root, file), backup: 'proofs.json' });
  const marker = `tracked-ledger@${ledgerSha(c)}`;
  for (const row of rows) {
    row.origin = 'local';
    row.imported ??= marker;
  }
  await writeFile(file, `${JSON.stringify(ledger.doc, null, 2)}\n`);
  return true;
}

async function applyArchive(c: Ctx): Promise<boolean> {
  const entries = c.survey.v1.filter((e) => fs.existsSync(path.join(c.root, e.path)));
  for (const e of entries) {
    if (fs.existsSync(path.join(c.root, archiveTarget(e.path)))) {
      throw new SpecGuardError(`migrate: ${archiveTarget(e.path)} already exists; refusing to overwrite an archived spec. Move one of them aside and rerun.`, ExitCode.InternalError);
    }
  }
  // Recorded before anything moves, so an interruption still resumes as v0.1.
  const known = new Set(c.state.archived.map((a) => a.path));
  for (const e of entries) if (!known.has(e.path)) c.state.archived.push({ ...e, target: archiveTarget(e.path) });
  await writeState(c.root, c.state);
  for (const e of entries) {
    const from = path.join(c.root, e.path);
    const to = path.join(c.root, archiveTarget(e.path));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (c.inGit && isTracked(c.root, e.path)) {
      try {
        git(c.root, ['mv', '--', e.path, archiveTarget(e.path)]);
      } catch (err) {
        throw failStep(`\`git mv ${e.path}\``, err);
      }
    } else fs.renameSync(from, to);
    c.manifest.undo.push({ op: 'move-back', from: archiveTarget(e.path), to: e.path });
  }
  return entries.length > 0;
}

async function applyDropV1Ledger(c: Ctx): Promise<boolean> {
  const file = ledgerPath(c.root, c.survey.config?.paths?.proofLedger);
  const ledger = await readLedger(file);
  if (!ledger) return false;
  // Rows of archived spec keys cannot prove a capability claim; a key a capability spec now uses stays.
  const live = new Set(c.survey.v2Keys);
  const archivedKeys = new Set(c.state.archived.map((a) => a.key).filter((k) => !live.has(k)));
  const doomed = Object.keys(ledger.rows).filter((claim) => archivedKeys.has(claim.split('#')[0]));
  if (doomed.length === 0) return false;
  await c.backup('proofs.json', ledger.text, posix(c.root, file));
  c.manifest.undo.push({ op: 'restore', path: posix(c.root, file), backup: 'proofs.json' });
  for (const claim of doomed) delete ledger.rows[claim];
  await writeFile(file, `${JSON.stringify(ledger.doc, null, 2)}\n`);
  return true;
}

async function applyConfig(c: Ctx): Promise<boolean> {
  const file = path.join(c.root, CONFIG_REL);
  if (!(await fileExists(file))) return false;
  const text = await readFile(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw failStep(`reading ${CONFIG_REL}`, err);
  }
  if (!isObject(parsed)) throw failStep(`reading ${CONFIG_REL}`, new Error('it is not a JSON object'));
  const missing: Array<[string, unknown]> = [];
  if (!('proofStore' in parsed)) missing.push(['proofStore', {}]);
  if (!('enforce' in parsed)) missing.push(['enforce', { default: 'observe' }]);
  if (missing.length === 0) return false;
  const next = addTopLevelKeys(text, missing);
  JSON.parse(next);
  await c.backup('config.json', text, CONFIG_REL);
  c.manifest.undo.push({ op: 'restore', path: CONFIG_REL, backup: 'config.json' });
  await writeFile(file, next);
  return true;
}

/**
 * Guard hooks, by event: `markers` say an entry is already there (ours or the plugin's bundle). One PreToolUse entry,
 * the command the edit guard ships as (`specguard hook pre-tool-use`); there is no PostToolUse guard.
 */
const GUARD_HOOKS: Array<{ event: string; markers: string[]; entries: Array<{ matcher: string; command: string }> }> = [
  {
    event: 'PreToolUse',
    markers: ['hook pre-tool', 'specguard-hook'],
    entries: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', command: 'specguard hook pre-tool-use' }],
  },
];

async function applyHooks(c: Ctx): Promise<boolean> {
  const file = path.join(c.root, SETTINGS_REL);
  if (!(await fileExists(file))) return false;
  const text = await readFile(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false; // not valid JSON: a person's file in a state migrate does not guess at
  }
  if (!isObject(parsed) || !isObject(parsed.hooks) || !JSON.stringify(parsed.hooks).includes('specguard')) return false;
  const hooks = parsed.hooks;
  let changed = false;
  for (const guard of GUARD_HOOKS) {
    const list = Array.isArray(hooks[guard.event]) ? [...(hooks[guard.event] as unknown[])] : [];
    const present = guard.markers.some((m) => JSON.stringify(list).includes(m));
    if (present) continue;
    for (const e of guard.entries) list.push({ matcher: e.matcher, hooks: [{ type: 'command', command: e.command }] });
    hooks[guard.event] = list;
    changed = true;
  }
  if (!changed) return false;
  await c.backup('claude-settings.json', text, SETTINGS_REL);
  c.manifest.undo.push({ op: 'restore', path: SETTINGS_REL, backup: 'claude-settings.json' });
  await writeFile(file, `${JSON.stringify(parsed, null, indentOf(text))}\n`);
  return true;
}

/** The steps the tool applies itself, in the order it applies them. */
/** Each applier returns whether it changed anything: a step with nothing left to do is done without being reported as applied. */
const APPLIERS: Array<[MigrateStepId, (c: Ctx) => Promise<boolean>]> = [
  ['gitignore', applyGitignore],
  ['untrack-ledger', (c) => applyUntrack(c, LEDGER_REL)],
  ['untrack-trace', (c) => applyUntrack(c, TRACE_REL)],
  ['provisional-rows', applyProvisional],
  ['archive-v1', applyArchive],
  ['drop-v1-ledger', applyDropV1Ledger],
  ['config', applyConfig],
  ['hooks', applyHooks],
];

const stampOf = (d: Date): string => d.toISOString().replace(/[-:.]/g, '');

export async function runMigrate(opts: MigrateOpts = {}): Promise<MigrateResult> {
  const cwd = opts.cwd ?? process.cwd();
  const s = await survey(cwd);
  const plan = await buildPlan(s, opts);
  const result: MigrateResult = { ...emptyResult('migrate'), format: plan.format, steps: plan.steps, applied: [] };
  const blocking = s.facts.dirty.filter((p) => !p.startsWith(CACHE_PREFIX));

  if (!opts.yes) {
    const text = plan.adjusted ? renderSteps(`specguard migrate: dry run, nothing was changed. Detected format: ${plan.format}.`, plan.steps) : renderMigrationPlan(s.facts, plan.planOpts).split('\n');
    result.messages.push(...text);
    if (blocking.length > 0) {
      result.messages.push('', `The working tree has ${blocking.length} uncommitted change(s); --yes refuses to run on it unless you pass --allow-dirty.`);
    }
    result.exitCode = exitFor(plan.steps);
    return result;
  }

  const toApply = APPLIERS.filter(([id]) => plan.steps.find((x) => x.id === id)?.state === 'todo');
  // A migration already under way leaves the tree dirty by its own doing, so only a fresh start refuses.
  if (toApply.length > 0 && !s.state && !opts.allowDirty && blocking.length > 0) {
    result.failed = 1;
    result.exitCode = ExitCode.ValidationFailed;
    result.messages.push(
      `migrate: refusing to run on a working tree with uncommitted changes (${blocking.slice(0, 8).join(', ')}${blocking.length > 8 ? ', ...' : ''}).`,
      'Commit or stash them so the migration is one reviewable change, or pass --allow-dirty.',
    );
    return result;
  }

  const now = new Date();
  const state: MigrateState = s.state ?? { version: 1, startedAt: now.toISOString(), format: plan.format, archived: [] };
  const stamp = stampOf(now);
  const backupDir = path.join(s.root, MIGRATE_DIR_REL, stamp);
  const manifest: Manifest = { version: 1, startedAt: state.startedAt, format: plan.format, applied: [], backups: [], undo: [] };
  const saved = new Set<string>();
  const ctx: Ctx = {
    root: s.root,
    inGit: s.facts.git !== false,
    survey: s,
    state,
    manifest,
    backup: async (name, text, original) => {
      if (saved.has(name)) return;
      saved.add(name);
      await writeFile(path.join(backupDir, name), text);
      manifest.backups.push(`${MIGRATE_DIR_REL}/${stamp}/${name} (${original})`);
    },
  };

  if (toApply.length > 0 || s.state) await writeState(s.root, state);
  try {
    for (const [id, apply] of toApply) {
      if (await apply(ctx)) manifest.applied.push(id);
    }
  } finally {
    if (manifest.applied.length > 0 || manifest.backups.length > 0) {
      await writeFile(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }

  result.applied = manifest.applied;
  result.updated = manifest.applied.length;
  const handled = new Set<MigrateStepId>(toApply.map(([id]) => id));
  result.steps = plan.steps.map((step) => (handled.has(step.id) ? { ...step, state: 'done' as const } : step));
  // The migration ends when the host agent has nothing left to do; person steps stay listed in this last report.
  const agentPending = result.steps.some((x) => x.state === 'agent');
  if (toApply.length > 0 || s.state) await writeState(s.root, agentPending ? state : { ...state, completedAt: new Date().toISOString() });

  const head = `specguard migrate: applied ${manifest.applied.length} step(s). Detected format: ${plan.format}.`;
  result.messages.push(...renderSteps(head, result.steps), '');
  if (manifest.applied.length > 0) {
    result.messages.push(`Backups and the manifest of this run are in ${MIGRATE_DIR_REL}/${stamp}/. Nothing was committed or pushed; review with \`git status\`.`);
  }
  if (agentPending) {
    result.messages.push('Waiting for the host agent: run the commands under the [agent] steps, then rerun `specguard migrate --yes` (it resumes from .specguard/cache/migrate/state.json).');
  }
  const person = result.steps.filter((x) => x.state === 'person').map((x) => x.id);
  if (person.length > 0) result.messages.push(`Left for you (never run by migrate): ${person.join(', ')}.`);
  if (!agentPending && person.length === 0 && result.steps.every((x) => x.state === 'done' || x.state === 'skip')) {
    result.messages.push('Nothing left to do: the repository is current.');
  }
  result.exitCode = exitFor(result.steps);
  return result;
}
