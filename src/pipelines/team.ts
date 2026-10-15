/**
 * The commands that can use a team server, each with its fallback.
 *
 * The rule: reads use the server when it answers and local files when it does not, and say which they used.
 * A shared write goes to the server; with none, it is written locally and said to be local-only. A server that
 * answers but refuses (bad token, no permission) is an error, never a quiet switch to local, because that would hide
 * a misconfiguration. `server.mode: required` makes an unreachable server an error too.
 *
 * Spec: specs/capabilities/team-server.md
 */
import { connect, ServerRequestError, type Connection } from '../client/index.js';
import { ExitCode } from '../core/exit-codes.js';
import { RemediationPlanSchema, type RemediationPlan } from '../core/remediation-schema.js';
import type { TraceModel } from '../core/trace.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { loadTrace } from './check.js';
import { describePlan, describePlans, runPlanList, runPlanSetStatus, runPlanShow, type SetStatusOpts } from './security-plan.js';

function tag(result: PipelineResult, source: 'server' | 'local', why?: string): PipelineResult {
  result.messages.push(source === 'server' ? '[source: server]' : `[source: local${why ? `; ${why}` : ''}]`);
  return result;
}

/** A server that answered but refused: say so, and how to fix it. */
function refused(err: ServerRequestError, action: string): PipelineResult {
  const result = emptyResult('team');
  result.failed = 1;
  result.exitCode = ExitCode.InternalError;
  result.messages.push(
    err.status === 401
      ? `the team server did not accept your credentials for ${action}. Run \`specguard login --server <url>\`, or set SPECGUARD_TOKEN.`
      : err.status === 403
        ? `the team server says you may not ${action}: ${err.message}`
        : `the team server could not ${action}: ${err.message}`,
  );
  return result;
}

async function open(config: SpecGuardConfig, notes: string[]): Promise<Connection | null> {
  return connect(config, { onFallback: (reason) => notes.push(reason) });
}

export async function planList(config: SpecGuardConfig): Promise<PipelineResult> {
  const notes: string[] = [];
  const conn = await open(config, notes);
  if (conn) {
    try {
      const listed = await conn.client.get<{ plans: Array<{ id: string }> }>('/security/plans');
      const plans: RemediationPlan[] = [];
      for (const { id } of listed.plans) {
        const plan = RemediationPlanSchema.safeParse(await conn.client.get<unknown>(`/security/plans/${encodeURIComponent(id)}`));
        if (plan.success) plans.push(plan.data);
      }
      return tag(describePlans(plans), 'server');
    } catch (err) {
      if (err instanceof ServerRequestError && err.status !== 404) return refused(err, 'list plans');
      notes.push(err instanceof ServerRequestError ? 'the project is not on the server' : (err as Error).message);
    }
  }
  return tag(runPlanList(config), 'local', notes[0]);
}

export async function planShow(config: SpecGuardConfig, planId: string): Promise<PipelineResult> {
  const notes: string[] = [];
  const conn = await open(config, notes);
  if (conn) {
    try {
      const plan = RemediationPlanSchema.safeParse(await conn.client.get<unknown>(`/security/plans/${encodeURIComponent(planId)}`));
      if (plan.success) return tag(describePlan(plan.data), 'server');
      notes.push('the server returned a plan that does not match the schema');
    } catch (err) {
      if (err instanceof ServerRequestError && err.status !== 404) return refused(err, 'read the plan');
      notes.push('the plan is not on the server');
    }
  }
  return tag(runPlanShow(config, planId), 'local', notes[0]);
}

export async function planSetStatus(config: SpecGuardConfig, planId: string, itemId: string, status: string, opts: SetStatusOpts = {}): Promise<PipelineResult> {
  const notes: string[] = [];
  const conn = await open(config, notes);
  if (conn) {
    try {
      const done = await conn.client.setItemStatus(planId, itemId, { status, ...(opts.note ? { note: opts.note } : {}), ...(opts.externalRef !== undefined ? { externalRef: opts.externalRef } : {}) });
      const result = emptyResult('security-plan');
      result.updated = 1;
      result.items.push({ key: done.item.id, status: 'updated', message: `${done.was} -> ${done.item.status}` });
      result.messages.push(`${done.item.id}: ${done.was} -> ${done.item.status}`, '[written to the team server]');
      return result;
    } catch (err) {
      if (!(err instanceof ServerRequestError)) throw err;
      // The plan or item is not on the server (not published yet): the change can still be made locally.
      if (err.status === 404) notes.push(`${err.message}`);
      else if (err.status === 400 || err.status === 409 || err.status === 422) {
        const result = emptyResult('security-plan');
        result.failed = 1;
        result.exitCode = ExitCode.ValidationFailed;
        result.messages.push(err.message);
        return result;
      } else return refused(err, 'change this item');
    }
  }
  const result = await runPlanSetStatus(config, planId, itemId, status, opts);
  result.messages.push(`[local-only: this change is in your .specguard folder, not on the team server${notes[0] ? ` (${notes[0]})` : ''}]`);
  return result;
}

const PROOF = ['proven', 'stale', 'failed', 'unproven', 'unexercised', 'error'] as const;

/**
 * What the team's CI proved, set against what this working tree has proven. Advisory: it never changes `check`'s exit code.
 */
export async function teamLines(config: SpecGuardConfig): Promise<string[]> {
  const notes: string[] = [];
  const conn = await open(config, notes);
  if (!conn) return [`TEAM: no server answered${notes[0] ? ` (${notes[0]})` : ''}; showing local proofs only`];
  try {
    const info = await conn.client.request<{ name: string; commit?: string; branch?: string; updatedAt?: string }>('GET', conn.client.projectPath());
    const team = await conn.client.get<TraceModel>('/trace');
    const { model: local } = await loadTrace(config);
    const lines: string[] = [];
    const counts = PROOF.map((p) => `${team.totals[p as keyof typeof team.totals] ?? 0} ${p}`);
    lines.push(`TEAM: ${info.name}${info.commit ? ` @ ${info.commit.slice(0, 8)}` : ''}${info.branch ? ` (${info.branch})` : ''}${info.updatedAt ? `, published ${info.updatedAt}` : ''}: ${counts.join(', ')}`);
    if (conn.hashMismatch) {
      lines.push(`TEAM: the server's claim hashes (version ${conn.health.hashVersion}) follow other rules than this SpecGuard's, so its proofs are not compared with yours`);
      return lines;
    }
    const proofOf = (m: TraceModel): Map<string, string> => new Map(m.nodes.flatMap((n) => n.claims.map((c) => [`${n.specKey}#${c.id}`, c.proof] as const)));
    const mine = proofOf(local);
    const theirs = proofOf(team);
    const ciOnly = [...theirs].filter(([ref, p]) => p === 'proven' && mine.get(ref) !== undefined && mine.get(ref) !== 'proven').map(([ref]) => ref);
    const localOnly = [...mine].filter(([ref, p]) => p === 'proven' && theirs.has(ref) && theirs.get(ref) !== 'proven').map(([ref]) => ref);
    lines.push(`TEAM: proven in CI but not here: ${ciOnly.length}${ciOnly.length ? ` (${ciOnly.slice(0, 3).join(', ')}${ciOnly.length > 3 ? ', ...' : ''})` : ''}`);
    lines.push(`TEAM: proven here but not in CI: ${localOnly.length}${localOnly.length ? ` (${localOnly.slice(0, 3).join(', ')}${localOnly.length > 3 ? ', ...' : ''})` : ''}`);
    return lines;
  } catch (err) {
    if (err instanceof ServerRequestError) return [`TEAM: ${refused(err, 'read the team state').messages[0]}`];
    return [`TEAM: could not read the team state (${(err as Error).message})`];
  }
}
