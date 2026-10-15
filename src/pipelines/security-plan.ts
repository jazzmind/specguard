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
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode } from '../core/exit-codes.js';
import {
  canTransition,
  ITEM_STATUSES,
  RemediationPlanSchema,
  UNRESOLVED,
  type ItemStatus,
  type PlanItem,
  type RemediationPlan,
} from '../core/remediation-schema.js';
import type { PipelineResult, SpecGuardConfig } from '../core/types.js';
import { emptyResult } from '../core/types.js';
import { writeFile } from '../core/writer.js';
import { writeHistory } from './history.js';

export const PLAN_DIR = '.specguard/security/plans';

const rootOf = (config: SpecGuardConfig): string => config.rootDir ?? process.cwd();
const dirOf = (config: SpecGuardConfig): string => path.join(rootOf(config), PLAN_DIR);

/** Safe file stem for a plan id: no path separators or dots that could leave the plans folder. */
const stem = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '');

export function fingerprintOf(...parts: Array<string | number | undefined>): string {
  return createHash('sha256').update(parts.map((p) => String(p ?? '')).join('\u0000')).digest('hex').slice(0, 12);
}

export function listPlanIds(config: SpecGuardConfig): string[] {
  const dir = dirOf(config);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

/** `latest` resolves to the newest plan. Returns null when the plan does not exist or does not validate. */
export function readPlan(config: SpecGuardConfig, id: string): RemediationPlan | null {
  const resolved = id === 'latest' ? listPlanIds(config).pop() : stem(id);
  if (!resolved) return null;
  const file = path.join(dirOf(config), `${resolved}.json`);
  try {
    const parsed = RemediationPlanSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function writePlan(config: SpecGuardConfig, plan: RemediationPlan): Promise<string> {
  const file = path.join(dirOf(config), `${stem(plan.id)}.json`);
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`);
  return file;
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
  if (!(ITEM_STATUSES as readonly string[]).includes(status)) return fail(`status must be one of ${ITEM_STATUSES.join(', ')}`);
  const plan = readPlan(config, planId);
  if (!plan) return fail(`no plan "${planId}"`, ExitCode.InternalError);
  const item = plan.items.find((i) => i.id === itemId);
  if (!item) return fail(`no item "${itemId}" in plan ${plan.id}`, ExitCode.InternalError);
  const next = status as ItemStatus;
  if (!canTransition(item.status, next)) return fail(`cannot move ${item.id} from ${item.status} to ${next}`);

  if (opts.externalRef !== undefined) item.externalRef = opts.externalRef;
  if (next !== item.status || opts.note) {
    item.statusHistory.push({ status: next, at: new Date().toISOString(), ...(opts.by ? { by: opts.by } : {}), ...(opts.note ? { note: opts.note } : {}) });
  }
  const was = item.status;
  item.status = next;
  await writePlan(config, plan);
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

export function runPlanList(config: SpecGuardConfig): PipelineResult {
  const result = emptyResult('security-plan');
  for (const id of listPlanIds(config).reverse()) {
    const plan = readPlan(config, id);
    if (!plan) continue;
    const open = plan.items.filter((i) => UNRESOLVED.includes(i.status)).length;
    result.messages.push(`${plan.id}  ${plan.createdAt}  ${plan.items.length} item(s), ${open} unresolved`);
    result.items.push({ key: plan.id, status: 'ok', message: `${plan.items.length} items, ${open} unresolved` });
  }
  if (result.items.length === 0) result.messages.push('no remediation plans yet; run `specguard security scan`');
  return result;
}

export function runPlanShow(config: SpecGuardConfig, planId: string): PipelineResult {
  const result = emptyResult('security-plan');
  const plan = readPlan(config, planId);
  if (!plan) {
    result.failed = 1;
    result.exitCode = ExitCode.InternalError;
    result.messages.push(`no plan "${planId}"`);
    return result;
  }
  result.messages.push(`${plan.id}  ${plan.createdAt}${plan.previous ? `  (carried over from ${plan.previous})` : ''}`);
  for (const i of plan.items) {
    result.messages.push(`  ${i.id}  [${i.severity}] [${i.status}] ${i.type}/${i.change}  ${i.title}${i.capability ? `  (${i.capability})` : ''}${i.externalRef ? `  ext:${i.externalRef}` : ''}`);
    result.items.push({ key: i.id, status: UNRESOLVED.includes(i.status) ? 'failed' : 'ok', message: i.title });
  }
  return result;
}
