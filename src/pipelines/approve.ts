/**
 * `spec approve` and `spec approvals`: humans approve intent.
 *
 * An approval records that a person agrees a requirement, at its exact wording,
 * states what the system should do. It is written as one committed history
 * entry (`kind: approval`) per event, and holds only while the claim's hash is
 * unchanged.
 *
 * The agent guard below is a speed bump, not security: a person can always run
 * the command from a script. The real enforcement belongs in CI, which checks
 * that approvals added in a pull request are backed by a review from someone
 * other than the author (a later phase).
 *
 * Spec: specs/capabilities/intent-approval.md
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import { approvalsFrom, formatApproved, indexApprovals, type Approval } from '../core/approvals.js';
import { claimHashOf } from '../core/claim-hash.js';
import { formatClaimRef } from '../core/claims.js';
import { detectHostAgent } from '../core/agent-work.js';
import { ExitCode } from '../core/exit-codes.js';
import { historyDir, listHistory } from '../core/history.js';
import { buildSpecGraph } from '../core/spec-graph.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { writeHistory } from './history.js';

/**
 * One claim with an id in a v2 capability or component spec, at its current wording. A claim with an examples table
 * also has one entry per row, with `exampleId` set, the row's ref and the row hash.
 */
export interface ClaimState {
  /** Local ref, `specKey#claimId`, or `specKey#claimId/rowId` for an example row. */
  ref: string;
  specKey: string;
  capabilityId: string;
  claimId: string;
  /** Set for an example row of the claim. */
  exampleId?: string;
  text: string;
  /** Full hash of the claim (for a row, of the row) as it reads now. */
  claimHash: string;
  /** Number of source files the owning spec declares and that exist. */
  ownedSources: number;
}

export interface ApprovalStatus {
  claims: Array<ClaimState & { approval?: Approval }>;
  byCapability: Record<string, { total: number; approved: number; unapproved: string[] }>;
}

export interface SpecApproveOpts {
  /** Capability ids, or claim refs (`cap#claim`, `specKey#claim`) or bare claim ids. */
  targets?: string[];
  /** Every claim of every capability. */
  all?: boolean;
  /** Accept existing behaviour as intent: refused for a capability that owns no source files. */
  asBuilt?: boolean;
  by?: string;
  note?: string;
  /** Write the approval. Without it the command only lists what it would approve. */
  yes?: boolean;
  /** Who is running the command. Default: from the environment. */
  actor?: { agent: boolean; tty: boolean };
}

/**
 * Every claim with an id in every v2 capability and component spec, each followed by its example rows when it has a
 * table. v1 specs have no claim hash and are skipped.
 */
export async function enumerateClaims(config: SpecGuardConfig): Promise<ClaimState[]> {
  const graph = await buildSpecGraph(config);
  const out: ClaimState[] = [];
  for (const node of [...graph.nodes.values()].sort((a, b) => a.specKey.localeCompare(b.specKey))) {
    if (node.kind !== 'capability' && node.kind !== 'component') continue;
    for (const claim of node.spec.claims) {
      if (!claim.id) continue;
      const claimHash = claimHashOf(node.spec, claim.id);
      if (!claimHash) continue;
      out.push({
        ref: formatClaimRef(undefined, node.specKey, claim.id),
        specKey: node.specKey,
        capabilityId: node.id,
        claimId: claim.id,
        text: claim.text,
        claimHash,
        ownedSources: node.ownedFiles.length,
      });
      for (const row of claim.examples?.rows ?? []) {
        out.push({
          ref: formatClaimRef(undefined, node.specKey, claim.id, row.id),
          specKey: node.specKey,
          capabilityId: node.id,
          claimId: claim.id,
          exampleId: row.id,
          text: claim.text,
          claimHash: row.hash,
          ownedSources: node.ownedFiles.length,
        });
      }
    }
  }
  return out;
}

/** Each claim with the newest approval of its current wording, and the per-capability tally. */
export async function approvalStatus(config: SpecGuardConfig): Promise<ApprovalStatus> {
  const index = indexApprovals(approvalsFrom(listHistory(config)));
  const claims = (await enumerateClaims(config)).map((c) => ({ ...c, approval: index.find(c.ref, c.claimHash) }));
  const byCapability: ApprovalStatus['byCapability'] = {};
  for (const c of claims) {
    const row = (byCapability[c.capabilityId] ??= { total: 0, approved: 0, unapproved: [] });
    row.total += 1;
    if (c.approval) row.approved += 1;
    else row.unapproved.push(c.ref);
  }
  return { claims, byCapability };
}

function approverName(config: SpecGuardConfig): string {
  const git = (key: string): string => {
    try {
      return execFileSync('git', ['config', key], { cwd: config.rootDir ?? process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return '';
    }
  };
  return git('user.name') || git('user.email') || os.userInfo().username;
}

function fail(result: PipelineResult, code: number, message: string): PipelineResult {
  result.failed = 1;
  result.exitCode = code;
  result.messages.push(message);
  return result;
}

/**
 * Claims a target names: a capability id, a claim ref (`cap#claim` or `specKey#claim`) or a bare claim id. Naming a
 * claim also names its example rows; `cap#claim/row` names just that row. Empty hits with an error when none match or a bare id is ambiguous.
 */
function resolveTarget(claims: ClaimState[], target: string): { hits: ClaimState[]; error?: string } {
  const at = target.lastIndexOf('#');
  if (at > 0) {
    const left = target.slice(0, at);
    const [id, rowId] = target.slice(at + 1).split('/');
    const hits = claims.filter(
      (c) => c.claimId === id && (rowId === undefined || c.exampleId === rowId) && (c.specKey === left || c.capabilityId === left),
    );
    return hits.length > 0 ? { hits } : { hits, error: `no claim ${target}` };
  }
  const caps = claims.filter((c) => c.capabilityId === target || c.specKey === target);
  if (caps.length > 0) return { hits: caps };
  const byId = claims.filter((c) => c.claimId === target);
  const owners = [...new Set(byId.map((c) => c.specKey))];
  if (owners.length === 1) return { hits: byId };
  if (owners.length > 1) return { hits: [], error: `claim id ${target} is in several capabilities (${[...new Set(byId.map((c) => c.capabilityId))].join(', ')}); use capability#claim` };
  return { hits: [], error: `no capability or claim ${target}` };
}

export async function runSpecApprove(config: SpecGuardConfig, opts: SpecApproveOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('spec-approve');
  const actor = opts.actor ?? { agent: detectHostAgent(), tty: Boolean(process.stdin.isTTY) };
  if (actor.agent && !actor.tty) {
    return fail(result, ExitCode.InternalError, 'approvals must be given by a person in their own terminal: run `specguard spec approve` yourself, not through an agent or script');
  }
  const targets = opts.targets ?? [];
  if (!opts.all && targets.length === 0) {
    return fail(result, ExitCode.InternalError, 'name what to approve: capability ids or claim refs, or pass --all');
  }

  const status = await approvalStatus(config);
  let scope: typeof status.claims;
  if (opts.all) {
    scope = status.claims;
  } else {
    const picked = new Set<string>();
    const errors: string[] = [];
    for (const t of targets) {
      const { hits, error } = resolveTarget(status.claims, t);
      if (error) errors.push(error);
      for (const h of hits) picked.add(h.ref);
    }
    if (errors.length > 0) return fail(result, ExitCode.ValidationFailed, `${errors.join('; ')}. Nothing was written.`);
    scope = status.claims.filter((c) => picked.has(c.ref));
  }

  const pending = scope.filter((c) => !c.approval);
  result.skipped = scope.length - pending.length;
  const capabilities = [...new Set(pending.map((c) => c.capabilityId))];

  if (opts.asBuilt) {
    const empty = capabilities.filter((id) => pending.find((c) => c.capabilityId === id)!.ownedSources === 0);
    if (empty.length > 0) {
      return fail(
        result,
        ExitCode.ValidationFailed,
        `--as-built accepts what already exists, and ${empty.join(', ')} ${empty.length === 1 ? 'owns' : 'own'} no source files. Review ${empty.length === 1 ? 'its' : 'their'} requirements and approve without --as-built. Nothing was written.`,
      );
    }
  }

  if (pending.length === 0) {
    result.messages.push(`nothing to approve: ${scope.length} claim(s) in scope, all already approved`);
    return result;
  }

  if (!opts.yes) {
    for (const c of pending) result.messages.push(`  ${c.ref}`);
    result.messages.push(`would approve ${pending.length} claim(s) in ${capabilities.length} capabilities; rerun with --yes`);
    return result;
  }

  const by = opts.by?.trim() || approverName(config);
  const approves = pending.map((c) => formatApproved(c.ref, c.claimHash));
  // The id suffix keeps two people's approvals of different claims on the same day in different files.
  const tag = createHash('sha256').update(`${by}\n${approves.join('\n')}`).digest('hex').slice(0, 6);
  const note = opts.note?.trim();
  const id = await writeHistory(config, {
    kind: 'approval',
    title: `Approval ${tag}: ${capabilities.join(', ')}`,
    decision: `${by} approved ${pending.length} requirement(s) in ${capabilities.join(', ')} as stating what the system should do, at the wording they have now.${note ? `\n\n${note}` : ''}`,
    affects: capabilities,
    approves,
    method: opts.asBuilt ? 'as-built' : 'command',
    author: by,
    source: 'spec-approve',
  }, (l) => result.messages.push(l));
  result.created = 1;
  result.items.push({ key: id, status: 'created', path: path.join(historyDir(config), `${id}.md`) });
  result.messages.push(`approved ${pending.length} claim(s) in ${capabilities.length} capabilities (${opts.asBuilt ? 'as-built' : 'command'}); recorded ${id}`);
  return result;
}

/** `spec approvals`: approved/total per capability and the claims still unapproved. */
export async function runSpecApprovals(config: SpecGuardConfig): Promise<PipelineResult> {
  const result = emptyResult('spec-approvals');
  const { byCapability } = await approvalStatus(config);
  let approved = 0;
  let total = 0;
  for (const [id, row] of Object.entries(byCapability).sort(([a], [b]) => a.localeCompare(b))) {
    approved += row.approved;
    total += row.total;
    result.messages.push(`${id.padEnd(28)} ${row.approved}/${row.total} approved`);
    for (const ref of row.unapproved) result.messages.push(`  unapproved: ${ref}`);
    result.items.push({ key: id, status: row.approved === row.total ? 'ok' : 'skipped', message: `${row.approved}/${row.total}` });
  }
  result.created = approved;
  result.skipped = total - approved;
  result.messages.push(total === 0 ? 'no claims to approve' : `${approved}/${total} claim(s) approved`);
  return result;
}
