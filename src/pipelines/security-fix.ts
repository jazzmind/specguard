/**
 * `specguard security fix`: execute plan items with the remediation executor.
 *
 * The executor (`remediate`: temporary git worktree, patch, re-run the tests,
 * compare proof results before and after) is unchanged. This layer selects
 * the plan's dependency and code items, runs it once, and moves each item's
 * status according to what happened to its branch.
 *
 * Spec: specs/capabilities/security-and-remediation.md
 */
import type { Severity } from '../core/advisory.js';
import { ExitCode } from '../core/exit-codes.js';
import { canTransition, type ItemStatus, type PlanItem, type RemediationPlan } from '../core/remediation-schema.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { runRemediate, type RemediateResult } from './remediate/index.js';
import type { ItemReport, RemediateDeps } from './remediate/types.js';
import { planStoreFor, readPlan } from './security-plan.js';

/**
 * Apply status moves to the plan as it is now on disk. `fix` runs for minutes; a tracker may
 * have set an external reference or a status meanwhile, and rewriting the plan it read at the
 * start would undo that. A move is applied only when the item is still in the status `fix` left it in.
 */
async function applyMoves(
  config: SpecGuardConfig,
  planId: string,
  moves: Array<{ id: string; expect: ItemStatus; to: ItemStatus; note: string }>,
  log: (line: string) => void,
): Promise<void> {
  const updated = await planStoreFor(config).update(planId, (current) => {
    for (const m of moves) {
      const item = current.items.find((i) => i.id === m.id);
      if (!item) continue;
      if (item.status !== m.expect) {
        log(`[note] ${item.id} was moved to ${item.status} while the fix ran; left as is (${m.note})`);
        continue;
      }
      move(item, m.to, m.note);
    }
  });
  if (updated === null) throw new Error(`plan ${planId} can no longer be read; its items were not updated`);
}

export interface SecurityFixOpts {
  /** Plan id, or `latest` (default). */
  planId?: string;
  /** Fix one item only. */
  item?: string;
  pr?: boolean;
  dryRun?: boolean;
  noLlm?: boolean;
  allowMajor?: boolean;
  ledger?: string;
  app?: string;
  onLog?: (line: string) => void;
}

export type RemediateFn = (config: SpecGuardConfig, opts: Parameters<typeof runRemediate>[1], deps?: Partial<RemediateDeps>) => Promise<RemediateResult>;

const FIXABLE: ReadonlyArray<PlanItem['type']> = ['dependency', 'code'];

/** The id remediate gives a finding: the advisory id, or `semgrep:<rule>@<path>` for code. */
export function remediationId(item: PlanItem): string | undefined {
  const f = item.findings[0];
  if (!f) return undefined;
  return item.type === 'code' ? `semgrep:${f.ruleId ?? ''}@${f.file ?? ''}` : f.id;
}

const advisorySeverity = (s: PlanItem['severity']): Severity => (s === 'info' ? 'low' : s);

function move(item: PlanItem, to: ItemStatus, note: string): void {
  if (!canTransition(item.status, to)) return;
  // The note matters even when the status does not change: it is how a tracker learns the branch and the verdict.
  item.statusHistory.push({ status: to, at: new Date().toISOString(), by: 'specguard', note });
  item.status = to;
}

export async function runSecurityFix(
  config: SpecGuardConfig,
  opts: SecurityFixOpts = {},
  deps: Partial<RemediateDeps> = {},
  remediate: RemediateFn = runRemediate,
): Promise<PipelineResult> {
  const result = emptyResult('security-fix');
  const log = (line: string): void => {
    result.messages.push(line);
    opts.onLog?.(line);
  };
  const plan: RemediationPlan | null = readPlan(config, opts.planId ?? 'latest');
  if (!plan) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    log(`no plan "${opts.planId ?? 'latest'}"; run \`specguard security scan\` first`);
    return result;
  }

  const chosen = opts.item ? plan.items.filter((i) => i.id === opts.item) : plan.items;
  if (opts.item && chosen.length === 0) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    log(`no item "${opts.item}" in plan ${plan.id}`);
    return result;
  }
  const fromPlugin = (i: PlanItem): boolean => (i.findings[0] as { detector?: string } | undefined)?.detector === 'plugin';
  const fixable = (i: PlanItem): boolean => FIXABLE.includes(i.type) && !fromPlugin(i);
  const selected = chosen.filter((i) => fixable(i) && (i.status === 'open' || i.status === 'planned'));
  for (const i of chosen) {
    if (fixable(i)) continue;
    log(`[skip] ${i.id}: ${i.type === 'spec' ? 'a spec-level finding is fixed by changing the spec; then `security plan set-status`' : fromPlugin(i) ? 'found by a plugin detector, which reports but does not patch; fix it by hand, then `security plan set-status`' : 'a secret needs rotation by a person; it is reported, never patched'}`);
    result.skipped += 1;
  }
  if (selected.length === 0) {
    log('nothing to fix automatically');
    return result;
  }

  // One run covers every selected item; a single dependency item narrows it to its advisory.
  const only = selected.length === 1 && selected[0].type === 'dependency' ? remediationId(selected[0]) : undefined;
  const lowest = selected.map((i) => advisorySeverity(i.severity)).sort((a, b) => (['critical', 'high', 'moderate', 'low', 'unknown'].indexOf(b) - ['critical', 'high', 'moderate', 'low', 'unknown'].indexOf(a)))[0];

  const before = new Map(selected.map((i) => [i.id, i.status]));
  if (!opts.dryRun) {
    await applyMoves(config, plan.id, selected.map((i) => ({ id: i.id, expect: i.status, to: 'in-progress' as const, note: 'remediation started' })), log);
  }
  let run: RemediateResult;
  try {
    run = await remediate(
      config,
      { advisory: only, minSeverity: lowest, allowMajor: opts.allowMajor, ledger: opts.ledger, pr: opts.pr, dryRun: opts.dryRun, noLlm: opts.noLlm, app: opts.app, onLog: opts.onLog },
      deps,
    );
  } catch (err) {
    // A crash must not strand the items in `in-progress`, where nothing would pick them up again.
    if (!opts.dryRun) {
      const why = `remediation did not finish: ${err instanceof Error ? err.message : String(err)}`;
      await applyMoves(config, plan.id, selected.map((i) => ({ id: i.id, expect: 'in-progress' as const, to: before.get(i.id) ?? 'open', note: why })), log).catch(() => undefined);
    }
    throw err;
  }
  for (const m of run.messages) if (!opts.onLog) result.messages.push(m);

  const reports: ItemReport[] = run.report?.results ?? [];
  const moves: Array<{ id: string; expect: ItemStatus; to: ItemStatus; note: string }> = [];
  for (const item of selected) {
    const id = remediationId(item);
    const hit = reports.find((r) => id !== undefined && r.advisoryIds.includes(id));
    let note: string;
    let to: ItemStatus;
    if (!hit) {
      to = 'open';
      note = 'not attempted in this run (outside the advisory limit, below the threshold, or not detected)';
    } else if (hit.error) {
      to = 'open';
      note = `remediation failed: ${hit.error}`;
    } else if (hit.skipped) {
      to = 'planned';
      note = `skipped: ${hit.skipped}`;
    } else if (hit.verdict === 'PRESERVED') {
      to = 'fixed';
      note = `branch ${hit.branch}${hit.pr?.url ? ` (${hit.pr.url})` : ''}; behaviour preserved`;
    } else {
      to = 'in-progress';
      note = `branch ${hit.branch}; verdict ${hit.verdict ?? 'unknown'}: review before merging`;
    }
    if (!opts.dryRun) moves.push({ id: item.id, expect: 'in-progress', to, note });
    result.items.push({ key: item.id, status: to === 'fixed' ? 'updated' : to === 'open' ? 'failed' : 'skipped', message: note });
    if (to === 'fixed') result.updated += 1;
    else if (to === 'open') result.failed += 1;
    else result.skipped += 1;
    log(`${item.id}: ${to} (${note})`);
  }
  if (!opts.dryRun) await applyMoves(config, plan.id, moves, log);
  result.exitCode = run.exitCode;
  return result;
}
