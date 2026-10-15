/**
 * The remediation plan store and its status updates.
 *
 * Plans live in `.specguard/security/plans/<id>.json`. A scan writes a new plan
 * and carries item statuses over from the previous one by fingerprint, so a
 * tracker sees the same item across scans. Other systems report progress with
 * `security plan set-status`, which enforces the lifecycle.
 *
 * Spec: specs/capabilities/security-and-remediation.md
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { ExitCode } from '../core/exit-codes.js';
import {
  canTransition,
  ITEM_STATUSES,
  UNRESOLVED,
  type ItemStatus,
  type PlanItem,
  type RemediationPlan,
} from '../core/remediation-schema.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { filePlanStore, listPlanFiles, readPlanFile, type PlanStore } from '../core/state/plan-store.js';
import { writeHistory } from './history.js';

export const PLAN_DIR = '.specguard/security/plans';

const rootOf = (config: SpecGuardConfig): string => config.rootDir ?? process.cwd();
const dirOf = (config: SpecGuardConfig): string => path.join(rootOf(config), PLAN_DIR);

/** The plans of this project as files under `.specguard/security/plans/`. */
export function planStoreFor(config: SpecGuardConfig): PlanStore {
  return filePlanStore(dirOf(config));
}

export function fingerprintOf(...parts: Array<string | number | undefined>): string {
  return createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\u0000')).digest('hex').slice(0, 12);
}

export function listPlanIds(config: SpecGuardConfig): string[] {
  return listPlanFiles(dirOf(config));
}

/** `latest` resolves to the newest plan. Returns null when the plan does not exist or does not validate. */
export function readPlan(config: SpecGuardConfig, id: string): RemediationPlan | null {
  return readPlanFile(dirOf(config), id);
}

export async function writePlan(config: SpecGuardConfig, plan: RemediationPlan): Promise<string> {
  return planStoreFor(config).write(plan);
}

/**
 * Carry statuses from the previous plan onto freshly detected items.
 *
 * - A new item starts `open`.
 * - An item seen before keeps its status, history and external reference.
 * - An item marked `fixed` or `verified` that the scan detects again is reopened,
 *   with a note: a status someone typed in does not outrank the scanner.
 * - An unresolved item no longer detected is closed as `fixed` with a note, so
 *   a tracker sees the closure, but only when `canClose` says the scan could have
 *   seen it. A detector that did not run, a raised severity floor or a narrowed
 *   scope say nothing about an item, so it is carried over unchanged. Items
 *   already closed are dropped.
 */
export function carryOver(previous: RemediationPlan | null, fresh: PlanItem[], now: string, canClose: (item: PlanItem) => boolean = () => true): PlanItem[] {
  if (!previous) return fresh;
  const before = new Map(previous.items.map((i) => [i.fingerprint, i]));
  const out: PlanItem[] = [];
  const seen = new Set<string>();
  for (const item of fresh) {
    if (seen.has(item.fingerprint)) continue;
    seen.add(item.fingerprint);
    const old = before.get(item.fingerprint);
    if (!old) {
      out.push(item);
      continue;
    }
    const reopen = old.status === 'fixed' || old.status === 'verified';
    out.push({
      ...item,
      id: old.id,
      status: reopen ? 'open' : old.status,
      statusHistory: reopen ? [...old.statusHistory, { status: 'open', at: now, by: 'specguard', note: `detected again after it was marked ${old.status}` }] : old.statusHistory,
      externalRef: old.externalRef ?? item.externalRef,
    });
  }
  for (const old of previous.items) {
    if (seen.has(old.fingerprint) || !UNRESOLVED.includes(old.status)) continue;
    if (!canClose(old)) {
      out.push(old);
      continue;
    }
    out.push({ ...old, status: 'fixed', statusHistory: [...old.statusHistory, { status: 'fixed', at: now, by: 'specguard', note: 'no longer detected' }] });
  }
  return out;
}

export interface SetStatusOpts {
  note?: string;
  by?: string;
  externalRef?: string;
  /**
   * The item's version as the caller last saw it (`itemVersion`). When it no longer matches, nothing is
   * written: someone else changed the item first.
   */
  expectedVersion?: number;
  store?: PlanStore;
}

export type PlanStatusErrorCode = 'no-plan' | 'no-item' | 'bad-status' | 'bad-transition' | 'conflict';

export class PlanStatusError extends Error {
  constructor(
    readonly code: PlanStatusErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PlanStatusError';
  }
}

/** An item's version: it changes with every recorded status change or note, so it detects a lost update. */
export const itemVersion = (item: PlanItem): number => item.statusHistory.length;

export interface StatusChange {
  plan: RemediationPlan;
  item: PlanItem;
  was: ItemStatus;
}

/**
 * Move one item to `status`, enforcing the lifecycle, under the store's read-modify-write. Throws
 * `PlanStatusError`; nothing is written then. Shared by the CLI and the team server's PATCH route.
 */
export async function setItemStatus(store: PlanStore, planId: string, itemId: string, status: string, opts: SetStatusOpts = {}): Promise<StatusChange> {
  if (!(ITEM_STATUSES as readonly string[]).includes(status)) throw new PlanStatusError('bad-status', `status must be one of ${ITEM_STATUSES.join(', ')}`);
  const next = status as ItemStatus;
  let change: StatusChange | undefined;
  const found = await store.update(planId, (plan) => {
    const item = plan.items.find((i) => i.id === itemId);
    if (!item) throw new PlanStatusError('no-item', `no item "${itemId}" in plan ${plan.id}`);
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== itemVersion(item)) {
      throw new PlanStatusError('conflict', `${item.id} changed since you read it (version ${itemVersion(item)}, you had ${opts.expectedVersion}); read it again and retry`);
    }
    if (!canTransition(item.status, next)) throw new PlanStatusError('bad-transition', `cannot move ${item.id} from ${item.status} to ${next}`);
    if (opts.externalRef !== undefined) item.externalRef = opts.externalRef;
    if (next !== item.status || opts.note) {
      item.statusHistory.push({ status: next, at: new Date().toISOString(), ...(opts.by ? { by: opts.by } : {}), ...(opts.note ? { note: opts.note } : {}) });
    }
    const was = item.status;
    item.status = next;
    change = { plan, item, was };
    return true;
  });
  if (found === null || !change) throw new PlanStatusError('no-plan', `no plan "${planId}"`);
  return change;
}

export async function runPlanSetStatus(
  config: SpecGuardConfig,
  planId: string,
  itemId: string,
  status: string,
  opts: SetStatusOpts = {},
): Promise<PipelineResult> {
  const result = emptyResult('security-plan');
  const fail = (message: string, code: number = ExitCode.ValidationFailed): PipelineResult => {
    result.failed = 1;
    result.exitCode = code;
    result.messages.push(message);
    return result;
  };
  let change: StatusChange;
  try {
    change = await setItemStatus(opts.store ?? planStoreFor(config), planId, itemId, status, opts);
  } catch (err) {
    if (!(err instanceof PlanStatusError)) throw err;
    return fail(err.message, err.code === 'no-plan' || err.code === 'no-item' ? ExitCode.InternalError : ExitCode.ValidationFailed);
  }
  const { item, was } = change;
  const next = item.status;
  result.updated = 1;
  result.items.push({ key: item.id, status: 'updated', message: `${was} -> ${next}` });
  result.messages.push(`${item.id}: ${was} -> ${next}`);

  // Resolving a spec-level finding changes the requirements, which is exactly what history is for.
  if (item.type === 'spec' && next === 'fixed' && was !== 'fixed' && item.capability) {
    const id = await writeHistory(config, {
      decision: `Resolved spec-level security finding "${item.title}": ${item.summary}${opts.note ? `\n\nNote: ${opts.note}` : ''}`,
      title: `Security: ${item.title}`.slice(0, 80),
      kind: 'decision',
      affects: [item.capability],
      source: 'security-plan',
    });
    result.messages.push(`recorded requirement history ${id}`);
  }
  return result;
}

/** The lines `plan list` prints, for plans from any source. Newest first. */
export function describePlans(plans: RemediationPlan[]): PipelineResult {
  const result = emptyResult('security-plan');
  for (const plan of [...plans].sort((a, b) => b.id.localeCompare(a.id))) {
    const open = plan.items.filter((i) => UNRESOLVED.includes(i.status)).length;
    result.messages.push(`${plan.id}  ${plan.createdAt}  ${plan.items.length} item(s), ${open} unresolved`);
    result.items.push({ key: plan.id, status: 'ok', message: `${plan.items.length} items, ${open} unresolved` });
  }
  if (result.items.length === 0) result.messages.push('no remediation plans yet; run `specguard security scan`');
  return result;
}

/** The lines `plan show` prints, for a plan from any source. */
export function describePlan(plan: RemediationPlan): PipelineResult {
  const result = emptyResult('security-plan');
  result.messages.push(`${plan.id}  ${plan.createdAt}${plan.previous ? `  (carried over from ${plan.previous})` : ''}`);
  for (const i of plan.items) {
    result.messages.push(`  ${i.id}  [${i.severity}] [${i.status}] ${i.type}/${i.change}  ${i.title}${i.capability ? `  (${i.capability})` : ''}${i.unit ? `  [${i.unit}]` : ''}${i.externalRef ? `  ext:${i.externalRef}` : ''}`);
    result.items.push({ key: i.id, status: UNRESOLVED.includes(i.status) ? 'failed' : 'ok', message: i.title });
  }
  return result;
}

export function runPlanList(config: SpecGuardConfig): PipelineResult {
  return describePlans(listPlanIds(config).map((id) => readPlan(config, id)).filter((p): p is RemediationPlan => Boolean(p)));
}

export function runPlanShow(config: SpecGuardConfig, planId: string): PipelineResult {
  const plan = readPlan(config, planId);
  if (!plan) {
    const result = emptyResult('security-plan');
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.messages.push(`no plan "${planId}"`);
    return result;
  }
  return describePlan(plan);
}
