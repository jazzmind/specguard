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

import { githubApi, type ApiReview } from '../ci/github-api.js';
import { makeHashAt } from '../ci/claim-hash-at.js';
import { qualifyingReviews, REVIEW_STATES, reviewCovers, type QualifyingReview, type ReviewFact } from '../ci/pr-approvals.js';
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
  /**
   * A pull request number: approve the claims a reviewer already approved there, one committed `method: pr` entry per
   * reviewer naming that reviewer. The reviews are read from GitHub (a token in the environment, or `gh auth token`).
   * Without a target it looks at every unapproved claim.
   */
  fromPr?: number;
  /** Injected reader of a pull request's author and reviews (tests); default reads GitHub. */
  loadPr?: (pr: number) => Promise<PullRequestReviews>;
}

/** What `--from-pr` needs of a pull request. */
export interface PullRequestReviews {
  author: string;
  reviews: ApiReview[];
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

/** `owner/name` from `GITHUB_REPOSITORY` or the `origin` remote URL (https or ssh form); undefined for anything else. */
function repoOf(config: SpecGuardConfig): string | undefined {
  const fromEnv = process.env.GITHUB_REPOSITORY?.trim();
  if (fromEnv && /^[\w.-]+\/[\w.-]+$/.test(fromEnv)) return fromEnv;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: config.rootDir ?? process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
    return m ? `${m[1]}/${m[2]}` : undefined;
  } catch {
    return undefined;
  }
}

/** A token for reading reviews: the environment first, then the `gh` login. Never printed. */
function tokenOf(): string | undefined {
  const env = process.env.SG_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function loadPullRequest(config: SpecGuardConfig, pr: number): Promise<PullRequestReviews> {
  const repo = repoOf(config);
  if (!repo) throw new Error('cannot tell which GitHub repository this is: set GITHUB_REPOSITORY or add an origin remote');
  const token = tokenOf();
  if (!token) throw new Error('no GitHub token: set GH_TOKEN or SG_GITHUB_TOKEN, or log in with `gh auth login`');
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const reviews = await githubApi(token, apiUrl).listReviews(repo, pr);
  const res = await fetch(`${apiUrl}/repos/${repo}/pulls/${pr}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'specguard-approve' } });
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for pull request ${pr}`);
  const author = ((await res.json()) as { user?: { login?: unknown } } | null)?.user?.login;
  if (typeof author !== 'string' || author === '') throw new Error(`pull request ${pr} has no author in GitHub's answer`);
  return { author, reviews };
}

const factOf = (r: ApiReview): ReviewFact => {
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
};

/**
 * `spec approve --from-pr <n>`: make a pull request's review approvals permanent. A claim a qualifying reviewer (an
 * approving review by someone other than the author, with write access) covers at its current wording gets a committed
 * `method: pr` entry naming that reviewer. CI re-checks every such entry against the same review, so this is a
 * convenience for people and never a way around the review.
 */
async function approveFromPr(config: SpecGuardConfig, opts: SpecApproveOpts, scope: Array<ClaimState & { approval?: Approval }>, result: PipelineResult): Promise<PipelineResult> {
  const pr = opts.fromPr!;
  if (!Number.isInteger(pr) || pr < 1) return fail(result, ExitCode.ValidationFailed, `--from-pr needs a pull request number, got ${String(opts.fromPr)}`);
  if (opts.asBuilt) return fail(result, ExitCode.ValidationFailed, '--as-built and --from-pr are different methods: use one');
  let loaded: PullRequestReviews;
  try {
    loaded = await (opts.loadPr ?? ((n: number) => loadPullRequest(config, n)))(pr);
  } catch (err) {
    return fail(result, ExitCode.InternalError, `could not read pull request ${pr}: ${err instanceof Error ? err.message.split('\n')[0] : 'unknown error'}. Nothing was written.`);
  }
  const reviews = qualifyingReviews(loaded.reviews.map(factOf), loaded.author);
  if (reviews.length === 0) return fail(result, ExitCode.ValidationFailed, `pull request ${pr} has no qualifying review (an approval by someone other than ${loaded.author}, with write access). Nothing was written.`);
  const hashAt = makeHashAt(config, await buildSpecGraph(config));
  const newestFirst = [...reviews].sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt) || b.id - a.id);

  const byReviewer = new Map<string, { review: QualifyingReview; claims: Array<ClaimState & { approval?: Approval }> }>();
  const pending = scope.filter((c) => !c.approval);
  const uncovered: string[] = [];
  for (const c of pending) {
    const review = newestFirst.find((r) => reviewCovers(r, c.ref, hashAt, c.claimHash));
    if (!review) {
      uncovered.push(c.ref);
      continue;
    }
    const key = review.login.toLowerCase();
    const slot = byReviewer.get(key) ?? { review, claims: [] };
    slot.claims.push(c);
    byReviewer.set(key, slot);
  }
  result.skipped = scope.length - pending.length;
  for (const ref of uncovered) result.messages.push(`  not covered by a review at its current wording: ${ref}`);
  const covered = [...byReviewer.values()].reduce((n, v) => n + v.claims.length, 0);
  if (covered === 0) {
    result.messages.push(pending.length === 0 ? `nothing to approve: ${scope.length} claim(s) in scope, all already approved` : `no unapproved claim is covered by a review of pull request ${pr}`);
    return result;
  }
  if (!opts.yes) {
    for (const { review, claims } of byReviewer.values()) for (const c of claims) result.messages.push(`  ${c.ref}  (${review.login}, review ${review.id})`);
    result.messages.push(`would record ${covered} approval(s) from ${byReviewer.size} reviewer(s) of pull request ${pr}; rerun with --yes`);
    return result;
  }
  for (const { review, claims } of byReviewer.values()) {
    const capabilities = [...new Set(claims.map((c) => c.capabilityId))];
    const approves = claims.map((c) => formatApproved(c.ref, c.claimHash));
    const tag = createHash('sha256').update(`${review.login}\n${pr}\n${approves.join('\n')}`).digest('hex').slice(0, 6);
    const id = await writeHistory(config, {
      kind: 'approval',
      title: `Approval ${tag}: ${capabilities.join(', ')}`,
      decision: `${review.login} approved ${claims.length} requirement(s) in ${capabilities.join(', ')} in review ${review.id} of pull request ${pr}, at the wording they have now. Recorded from GitHub by the person running spec approve --from-pr; CI checks it against the same review.`,
      affects: capabilities,
      approves,
      method: 'pr',
      author: review.login,
      source: 'spec-approve',
    }, (l) => result.messages.push(l));
    result.created += 1;
    result.items.push({ key: id, status: 'created', path: path.join(historyDir(config), `${id}.md`) });
    result.messages.push(`recorded ${claims.length} claim(s) approved by ${review.login} (pr, review ${review.id}); entry ${id}`);
  }
  return result;
}

export async function runSpecApprove(config: SpecGuardConfig, opts: SpecApproveOpts = {}): Promise<PipelineResult> {
  const result = emptyResult('spec-approve');
  const actor = opts.actor ?? { agent: detectHostAgent(), tty: Boolean(process.stdin.isTTY) };
  if (actor.agent && !actor.tty) {
    return fail(result, ExitCode.InternalError, 'approvals must be given by a person in their own terminal: run `specguard spec approve` yourself, not through an agent or script');
  }
  const targets = opts.targets ?? [];
  if (!opts.all && targets.length === 0 && opts.fromPr === undefined) {
    return fail(result, ExitCode.InternalError, 'name what to approve: capability ids or claim refs, or pass --all');
  }

  const status = await approvalStatus(config);
  let scope: typeof status.claims;
  if (opts.all || (targets.length === 0 && opts.fromPr !== undefined)) {
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

  if (opts.fromPr !== undefined) return approveFromPr(config, opts, scope, result);

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
