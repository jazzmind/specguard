/**
 * `specguard enforce show|raise|lower`: the per-capability ratchet.
 *
 * `show` prints every capability's level. `raise` moves a capability up the ladder (observe, warn,
 * enforce); moving to `enforce` is allowed only while the capability is certified, and is refused
 * otherwise with the reasons that block it. `lower` moves it down, needs a stated reason, and is
 * recorded as a history entry naming the person, because a lowering is a policy weakening: CI reads
 * `enforce:` between versions (`policy-enforce-lowered`) and wants a review for it. The level is
 * written into the capability's frontmatter with a one-line edit that no claim hash covers.
 *
 * Both moves are a person's decision. Like `spec approve`, they refuse an agent without a terminal; the
 * guard is a speed bump, and CI is the gate.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { detectHostAgent } from '../core/agent-work.js';
import {
  canRaise,
  effectiveEnforce,
  isEnforceLevel,
  isLowering,
  nextLevel,
  policyLine,
  setEnforceLevel,
  unknownEnforce,
} from '../core/enforce.js';
import { ExitCode } from '../core/exit-codes.js';
import { listHistory } from '../core/history.js';
import { intentGaps } from '../core/intent-gap.js';
import { computeStatement, type CapabilityStatement, type CertLevel, type Reason } from '../core/proof-statement.js';
import { readFile } from '../core/reader.js';
import { buildSpecGraph, type SpecNode } from '../core/spec-graph.js';
import { specsRootDir } from '../core/spec-key.js';
import { ENFORCE_LEVELS, emptyResult, type EnforceLevel, type PipelineResult, type SpecGuardConfig } from '../core/types.js';
import { writeFile } from '../core/writer.js';
import { loadTrace } from './check.js';
import { loadEffectiveLedger, noteApprovalsAsApprovals, readOnlyStore, type EffectiveLedger } from './proof-sources.js';
import { writeHistory } from './history.js';
import { buildStatementInput } from './statement-input.js';

export interface EnforceActor {
  agent: boolean;
  tty: boolean;
}

export interface EnforceShowOpts {
  /** Capability ids or spec keys; all of them when empty. */
  targets?: string[];
  /** The statement to read certification from, instead of building it (tests). */
  statement?: ReadonlyMap<string, CapabilityStatement>;
}

export interface EnforceRaiseOpts extends EnforceShowOpts {
  /** The level to reach. Default: the next one up. */
  to?: string;
  by?: string;
  /** Who is running the command. Default: from the environment. */
  actor?: EnforceActor;
}

export interface EnforceLowerOpts extends EnforceRaiseOpts {
  /** Why the level is being lowered. Required, and recorded in history. */
  why?: string;
}

const capabilityNodes = (graph: Awaited<ReturnType<typeof buildSpecGraph>>): SpecNode[] =>
  [...graph.nodes.values()].filter((n) => n.kind === 'capability' || n.kind === 'component').sort((a, b) => a.specKey.localeCompare(b.specKey));

function fail(result: PipelineResult, code: number, message: string): PipelineResult {
  result.failed = Math.max(result.failed, 1);
  result.exitCode = code;
  result.messages.push(message);
  return result;
}

function personName(config: SpecGuardConfig): string {
  const git = (key: string): string => {
    try {
      return execFileSync('git', ['config', key], { cwd: config.rootDir ?? process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  return git('user.name') || git('user.email') || os.userInfo().username;
}

/**
 * The proof statement of every capability, built the way `check` builds it: the CI proof notes in git are part of the
 * evidence, so a person who only has the checkout (no local test run) sees the same certification `check` shows.
 */
export async function certificationOf(config: SpecGuardConfig): Promise<Map<string, CapabilityStatement>> {
  const root = config.rootDir ?? process.cwd();
  let eff: EffectiveLedger | undefined;
  try {
    const loaded = await loadEffectiveLedger(config);
    if (loaded.note) eff = loaded;
  } catch {
    /* unreadable notes: the local ledger alone, as before */
  }
  const store = eff ? readOnlyStore(eff) : undefined;
  const { model } = await loadTrace(config, store ? { store } : {});
  const gaps = intentGaps(root, model.nodes, listHistory(config), path.relative(root, specsRootDir(config)).split(path.sep).join('/'));
  model.gaps = { intent: gaps, docsStale: [] };
  const assembled = await buildStatementInput(config, { model, gaps }, eff && store ? { store, extraApprovals: noteApprovalsAsApprovals(eff) } : {});
  return new Map(computeStatement(assembled.input).capabilities.map((c) => [c.capability, c]));
}

/** The nodes a list of targets names (a capability id or spec key), or the error for the first unknown one. */
function resolve(nodes: SpecNode[], targets: string[]): { picked: SpecNode[]; errors: string[] } {
  if (targets.length === 0) return { picked: nodes, errors: [] };
  const picked: SpecNode[] = [];
  const errors: string[] = [];
  for (const t of targets) {
    const hit = nodes.find((n) => n.id === t || n.specKey === t);
    if (!hit) errors.push(`no capability ${t}; known: ${nodes.map((n) => n.id).join(', ') || 'none'}`);
    else if (!picked.includes(hit)) picked.push(hit);
  }
  return { picked, errors };
}

const reasonLine = (r: Reason): string => `    [${r.code}] ${r.message}${r.fix ? ` (${r.fix})` : ''}`;

/** Why a capability is not certified: its blocking reasons, else every reason that is not a note. */
function whyNotCertified(statement: CapabilityStatement | undefined): string[] {
  if (!statement) return ['    no proof statement was produced for it'];
  const reasons = statement.blocking.length > 0 ? statement.blocking : Object.values(statement.pillars).flatMap((p) => p.reasons).filter((r) => r.outcome !== 'note');
  return reasons.length > 0 ? reasons.slice(0, 6).map(reasonLine) : [`    ${statement.headline}`];
}

function guardActor(result: PipelineResult, verb: string, actor: EnforceActor | undefined): PipelineResult | undefined {
  const who = actor ?? { agent: detectHostAgent(), tty: Boolean(process.stdin.isTTY) };
  if (who.agent && !who.tty) {
    return fail(result, ExitCode.InternalError, `changing an enforce level must be done by a person in their own terminal: run \`specguard enforce ${verb}\` yourself, not through an agent or script`);
  }
  return undefined;
}

/** `enforce show`: every capability's level, where it comes from, and whether it could be raised now. */
export async function runEnforceShow(config: SpecGuardConfig, opts: EnforceShowOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('enforce-show');
  const graph = await buildSpecGraph(config);
  const { picked, errors } = resolve(capabilityNodes(graph), opts.targets ?? []);
  if (errors.length > 0) return fail(result, ExitCode.ValidationFailed, errors.join('; '));
  const statements = opts.statement ?? (picked.length > 0 ? await certificationOf(config) : new Map<string, CapabilityStatement>());
  const fallback = effectiveEnforce({}, config.enforce);
  for (const node of picked) {
    const meta = node.spec.meta;
    const level = effectiveEnforce(meta, config.enforce);
    const cert: CertLevel | undefined = statements.get(node.id)?.level;
    const source = meta.enforce ? 'set' : `default ${fallback}`;
    const next = nextLevel(level);
    const raise = next === undefined ? 'at the top' : canRaise(level, next, cert ?? 'not-certified').ok ? `can raise to ${next}` : `cannot raise to ${next} yet`;
    const bad = unknownEnforce(meta);
    result.messages.push(`${node.id.padEnd(28)} ${level.padEnd(8)} ${cert ?? 'unknown'}, ${raise} (${source})${bad ? ` [ignored enforce: "${bad}"]` : ''}`);
    result.items.push({ key: node.id, status: 'ok', message: level });
  }
  result.created = picked.length;
  if (picked.length === 0) result.messages.push('no capabilities');
  return result;
}

interface Move {
  node: SpecNode;
  from: EnforceLevel;
  to: EnforceLevel;
}

/** Write the new levels into the specs and record one history entry. */
async function applyMoves(config: SpecGuardConfig, result: PipelineResult, kind: 'raised' | 'lowered', moves: Move[], by: string, why: string | undefined): Promise<void> {
  const specsRoot = specsRootDir(config);
  for (const m of moves) {
    const file = path.join(specsRoot, `${m.node.specKey}.md`);
    const before = await readFile(file);
    const after = setEnforceLevel(before, m.to);
    if (after === before) throw new Error(`could not set enforce in ${path.relative(config.rootDir ?? process.cwd(), file)}`);
    await writeFile(file, after);
  }
  const names = moves.map((m) => m.node.id);
  const lines = moves.map((m) => policyLine(kind, m.node.id, m.from, m.to));
  const id = await writeHistory(config, {
    kind: 'decision',
    title: `Enforce ${kind}: ${names.join(', ')}`,
    decision: `${by} ${kind === 'raised' ? 'raised' : 'lowered'} the enforce level: ${moves.map((m) => `${m.node.id} ${m.from} to ${m.to}`).join('; ')}.${why ? `\n\nWhy: ${why}` : ''}`,
    affects: names,
    policy: lines,
    author: by,
    source: 'enforce',
  }, (l) => result.messages.push(l));
  for (const m of moves) {
    result.messages.push(`${m.node.id}: ${m.from} -> ${m.to}`);
    result.items.push({ key: m.node.id, status: 'updated', message: `${m.from}->${m.to}`, path: path.join(specsRoot, `${m.node.specKey}.md`) });
  }
  result.updated = moves.length;
  result.messages.push(`enforce ${kind} for ${moves.length} capability(ies); recorded ${id}`);
}

/**
 * `enforce raise`: up the ladder, to `--to` or the next level. Moving to `enforce` needs the capability to be
 * certified. Nothing is written unless every named capability can move.
 */
export async function runEnforceRaise(config: SpecGuardConfig, opts: EnforceRaiseOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('enforce-raise');
  const refused = guardActor(result, 'raise', opts.actor);
  if (refused) return refused;
  const targets = opts.targets ?? [];
  if (targets.length === 0) return fail(result, ExitCode.InternalError, 'name the capabilities to raise');
  if (opts.to !== undefined && !isEnforceLevel(opts.to)) return fail(result, ExitCode.ValidationFailed, `--to must be one of ${ENFORCE_LEVELS.join(', ')}`);

  const graph = await buildSpecGraph(config);
  const { picked, errors } = resolve(capabilityNodes(graph), targets);
  if (errors.length > 0) return fail(result, ExitCode.ValidationFailed, `${errors.join('; ')}. Nothing was written.`);

  const moves: Move[] = [];
  const refusals: string[] = [];
  let needsCertification = false;
  const plan = picked.map((node) => {
    const from = effectiveEnforce(node.spec.meta, config.enforce);
    const to = (opts.to as EnforceLevel | undefined) ?? nextLevel(from);
    if (to === 'enforce' && to !== from) needsCertification = true;
    return { node, from, to };
  });
  const statements = opts.statement ?? (needsCertification ? await certificationOf(config) : new Map<string, CapabilityStatement>());
  for (const { node, from, to } of plan) {
    if (to === undefined) {
      refusals.push(`${node.id}: already at ${from}, the top`);
      continue;
    }
    const statement = statements.get(node.id);
    const verdict = canRaise(from, to, statement?.level ?? 'not-certified');
    if (!verdict.ok) {
      refusals.push(`${node.id}: ${verdict.reason}`);
      if (to === 'enforce' && !isLowering(from, to) && from !== to) refusals.push(...whyNotCertified(statement));
      continue;
    }
    moves.push({ node, from, to });
  }
  if (refusals.length > 0) {
    result.messages.push(...refusals, 'Nothing was written.');
    const certification = refusals.some((r) => r.includes('only while it is certified'));
    return fail(result, certification ? ExitCode.NotCertified : ExitCode.ValidationFailed, `refused to raise ${plan.length - moves.length} of ${plan.length} capability(ies)`);
  }
  await applyMoves(config, result, 'raised', moves, opts.by?.trim() || personName(config), undefined);
  return result;
}

/** `enforce lower`: down the ladder to `--to`. Needs `--why`; the move is recorded in history under the person's name. */
export async function runEnforceLower(config: SpecGuardConfig, opts: EnforceLowerOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('enforce-lower');
  const refused = guardActor(result, 'lower', opts.actor);
  if (refused) return refused;
  const targets = opts.targets ?? [];
  if (targets.length === 0) return fail(result, ExitCode.InternalError, 'name the capabilities to lower');
  if (!opts.to || !isEnforceLevel(opts.to)) return fail(result, ExitCode.ValidationFailed, `--to is required and must be one of ${ENFORCE_LEVELS.join(', ')}`);
  const why = opts.why?.trim();
  if (!why) return fail(result, ExitCode.ValidationFailed, '--why is required: a lowered level is a policy weakening and is recorded with its reason');

  const graph = await buildSpecGraph(config);
  const { picked, errors } = resolve(capabilityNodes(graph), targets);
  if (errors.length > 0) return fail(result, ExitCode.ValidationFailed, `${errors.join('; ')}. Nothing was written.`);

  const to = opts.to;
  const notLower = picked.map((n) => ({ id: n.id, from: effectiveEnforce(n.spec.meta, config.enforce) })).filter((x) => !isLowering(x.from, to));
  if (notLower.length > 0) {
    result.messages.push(...notLower.map((x) => `${x.id}: ${x.from} to ${to} does not lower the level${x.from === to ? ' (already there)' : '; use `enforce raise`'}`), 'Nothing was written.');
    return fail(result, ExitCode.ValidationFailed, `refused to lower ${notLower.length} of ${picked.length} capability(ies)`);
  }
  const moves = picked.map((node) => ({ node, from: effectiveEnforce(node.spec.meta, config.enforce), to }));
  await applyMoves(config, result, 'lowered', moves, opts.by?.trim() || personName(config), why);
  return result;
}
