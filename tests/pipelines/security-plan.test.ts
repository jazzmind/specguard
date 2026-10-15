import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import { listHistory } from '../../src/core/history.js';
import {
  canTransition,
  ITEM_STATUSES,
  PLAN_SCHEMA_FILE,
  RemediationPlanSchema,
  remediationPlanJsonSchema,
  type PlanItem,
  type RemediationPlan,
} from '../../src/core/remediation-schema.js';
import { filePlanStore } from '../../src/core/state/plan-store.js';
import { PlanStatusError, carryOver, itemVersion, planStoreFor, readPlan, runPlanList, runPlanSetStatus, runPlanShow, setItemStatus, writePlan } from '../../src/pipelines/security-plan.js';
import { makeV2Repo } from '../helpers/v2-repo.js';

const item = (over: Partial<PlanItem> = {}): PlanItem => ({
  id: 'sec-aaa',
  title: 'lodash@4.17.0: Prototype pollution',
  severity: 'high',
  type: 'dependency',
  change: 'dependency',
  summary: 'Upgrade lodash',
  findings: [{ id: 'GHSA-1', detector: 'advisory', message: 'pp' }],
  claims: [],
  files: ['package.json'],
  verify: { scope: 'all-proven', claims: [] },
  status: 'open',
  statusHistory: [],
  fingerprint: 'aaa',
  ...over,
});

const plan = (items: PlanItem[], id = 'scan-1'): RemediationPlan => ({ version: 1, id, createdAt: '2026-10-15T00:00:00Z', tool: { name: 'specguard' }, items });

describe('lifecycle [plan-lifecycle]', () => {
  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('allows the documented transitions and nothing else [transitions]', () => {
    expect(canTransition('open', 'in-progress')).toBe(true);
    expect(canTransition('fixed', 'verified')).toBe(true);
    expect(canTransition('open', 'verified')).toBe(false);
    expect(canTransition('verified', 'fixed')).toBe(false);
    for (const s of ITEM_STATUSES) expect(canTransition(s, 'open')).toBe(true);
    expect(canTransition('wont-fix', 'fixed')).toBe(false);
  });
});

describe('carry-over across scans [plan-carry-over]', () => {
  const NOW = '2026-10-16T00:00:00Z';

  // [claims: capabilities/security-and-remediation#plan-carry-over]
  it('keeps status, history and external reference for an item seen before [kept]', () => {
    const old = item({ status: 'in-progress', externalRef: 'JIRA-9', statusHistory: [{ status: 'in-progress', at: 'x', by: 'bot' }] });
    const out = carryOver(plan([old]), [item({ title: 'reworded title' })], NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'in-progress', externalRef: 'JIRA-9', title: 'reworded title' });
    expect(out[0].statusHistory).toHaveLength(1);
  });

  // [claims: capabilities/security-and-remediation#plan-carry-over]
  it('closes an unresolved item that is no longer detected, with a note [closed]', () => {
    const out = carryOver(plan([item({ status: 'planned' })]), [], NOW);
    expect(out[0].status).toBe('fixed');
    expect(out[0].statusHistory.at(-1)).toMatchObject({ status: 'fixed', by: 'specguard', note: 'no longer detected', at: NOW });
  });

  // [claims: capabilities/security-and-remediation#plan-carry-over]
  it('drops items that were already closed and are gone [dropped]', () => {
    expect(carryOver(plan([item({ status: 'verified' }), item({ fingerprint: 'b', id: 'sec-b', status: 'wont-fix' })]), [], NOW)).toEqual([]);
  });

  it('starts a new item open and with no previous plan returns the fresh items unchanged [new]', () => {
    const fresh = [item({ fingerprint: 'zzz', id: 'sec-zzz' })];
    expect(carryOver(null, fresh, NOW)).toBe(fresh);
    expect(carryOver(plan([item()]), fresh, NOW).map((i) => i.status)).toEqual(['open', 'fixed']);
  });
});

describe('plan store and set-status [plan-store]', () => {
  async function repoWithPlan(items: PlanItem[]) {
    const repo = makeV2Repo();
    const config = await loadConfig(repo.dir);
    await writePlan(config, plan(items));
    return { repo, config };
  }

  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('moves an item, records who and why, and keeps the plan valid [set-status]', async () => {
    const { config } = await repoWithPlan([item()]);
    const r = await runPlanSetStatus(config, 'scan-1', 'sec-aaa', 'in-progress', { by: 'renovate-bot', note: 'PR #12', externalRef: 'SEC-77' });
    expect(r.exitCode).toBe(0);
    const stored = readPlan(config, 'scan-1')!;
    expect(RemediationPlanSchema.safeParse(stored).success).toBe(true);
    expect(stored.items[0]).toMatchObject({ status: 'in-progress', externalRef: 'SEC-77' });
    expect(stored.items[0].statusHistory.at(-1)).toMatchObject({ status: 'in-progress', by: 'renovate-bot', note: 'PR #12' });
  });

  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('refuses a transition the lifecycle forbids and leaves the plan alone [bad-transition]', async () => {
    const { config } = await repoWithPlan([item()]);
    const r = await runPlanSetStatus(config, 'scan-1', 'sec-aaa', 'verified');
    expect(r.exitCode).toBe(2);
    expect(r.messages[0]).toContain('cannot move sec-aaa from open to verified');
    expect(readPlan(config, 'scan-1')!.items[0].status).toBe('open');
  });

  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('rejects an unknown status, plan or item [unknowns]', async () => {
    const { config } = await repoWithPlan([item()]);
    expect((await runPlanSetStatus(config, 'scan-1', 'sec-aaa', 'done')).exitCode).toBe(2);
    expect((await runPlanSetStatus(config, 'nope', 'sec-aaa', 'fixed')).exitCode).toBe(1);
    expect((await runPlanSetStatus(config, 'scan-1', 'sec-zzz', 'fixed')).exitCode).toBe(1);
  });

  // [claims: capabilities/security-and-remediation#plan-lifecycle]
  it('resolves latest and cannot be walked out of the plans folder [latest-and-paths]', async () => {
    const { repo, config } = await repoWithPlan([item()]);
    await writePlan(config, plan([item({ id: 'sec-new' })], 'scan-2'));
    repo.write('secret.json', JSON.stringify(plan([item({ id: 'sec-leak' })])));
    expect(readPlan(config, 'latest')!.id).toBe('scan-2');
    expect(readPlan(config, '../../secret')).toBeNull();
    expect(runPlanList(config).messages[0]).toContain('scan-2');
    expect(runPlanShow(config, 'latest').messages.join('\n')).toContain('sec-new');
  });

  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('rejects a stored plan that does not match the schema instead of trusting it [invalid-plan]', async () => {
    const { repo, config } = await repoWithPlan([item()]);
    repo.write('.specguard/security/plans/broken.json', JSON.stringify({ version: 2, items: 'x' }));
    expect(readPlan(config, 'broken')).toBeNull();
  });

  // [claims: capabilities/security-and-remediation#spec-fix-history]
  it('records requirement history when a spec-level finding is resolved [spec-fix-history]', async () => {
    const specItem = item({ id: 'sec-spec', fingerprint: 'spec', type: 'spec', change: 'spec', capability: 'auth', title: 'No rate limit on code requests', summary: 'Add a rate-limit requirement' });
    const { config } = await repoWithPlan([specItem]);
    const r = await runPlanSetStatus(config, 'scan-1', 'sec-spec', 'fixed', { note: 'added requirement' });
    expect(r.messages.join('\n')).toContain('recorded requirement history');
    const entries = listHistory(await loadConfig(config.rootDir!));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'decision', affects: ['auth'], source: 'security-plan' });
    expect(entries[0].body).toContain('No rate limit on code requests');
    // Resolving again, or fixing a non-spec item, records nothing more.
    await runPlanSetStatus(config, 'scan-1', 'sec-spec', 'fixed');
    expect(listHistory(await loadConfig(config.rootDir!))).toHaveLength(1);
  });
});

describe('published schema [plan-schema]', () => {
  // [claims: capabilities/security-and-remediation#remediation-plan]
  it('is generated from the zod definition and the committed file is current [schema-current]', () => {
    const committed = JSON.parse(readFileSync(path.join(__dirname, '..', '..', PLAN_SCHEMA_FILE), 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(remediationPlanJsonSchema())));
  });

  // [claims: capabilities/security-and-remediation#remediation-plan]
  it('describes the lifecycle and allows extra fields for consumers [schema-shape]', () => {
    const schema = remediationPlanJsonSchema() as { properties: { items: { items: { properties: { status: { enum: string[] } }; additionalProperties: unknown } } } };
    expect(schema.properties.items.items.properties.status.enum).toEqual([...ITEM_STATUSES]);
    expect(schema.properties.items.items.additionalProperties).not.toBe(false);
    expect(RemediationPlanSchema.safeParse({ ...plan([item()]), annotatedBy: 'tracker' }).success).toBe(true);
  });
});

describe('plan store and versioned status updates [plan-store]', () => {
  const stored = async (items: PlanItem[]) => {
    const config = await loadConfig(makeV2Repo().dir);
    await writePlan(config, plan(items));
    return { config, store: planStoreFor(config) };
  };

  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('rejects an update made against a stale item version and writes nothing [conflict]', async () => {
    const { store } = await stored([item()]);
    const first = await setItemStatus(store, 'scan-1', 'sec-aaa', 'in-progress', { note: 'taking it' });
    expect(itemVersion(first.item)).toBe(1);
    // A second caller still holds version 0.
    await expect(setItemStatus(store, 'scan-1', 'sec-aaa', 'wont-fix', { expectedVersion: 0 })).rejects.toMatchObject({ code: 'conflict' });
    expect((await store.read('scan-1'))!.items[0].status).toBe('in-progress');
    // With the current version it goes through.
    const ok = await setItemStatus(store, 'scan-1', 'sec-aaa', 'fixed', { expectedVersion: 1, by: 'tracker' });
    expect(ok.was).toBe('in-progress');
    expect(itemVersion(ok.item)).toBe(2);
  });

  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('names why an update was refused: no plan, no item, bad status, bad transition [error-codes]', async () => {
    const { store } = await stored([item()]);
    const code = async (fn: () => Promise<unknown>) => (await fn().catch((e: PlanStatusError) => e)) as PlanStatusError;
    expect((await code(() => setItemStatus(store, 'nope', 'sec-aaa', 'fixed'))).code).toBe('no-plan');
    expect((await code(() => setItemStatus(store, 'scan-1', 'missing', 'fixed'))).code).toBe('no-item');
    expect((await code(() => setItemStatus(store, 'scan-1', 'sec-aaa', 'done'))).code).toBe('bad-status');
    expect((await code(() => setItemStatus(store, 'scan-1', 'sec-aaa', 'verified'))).code).toBe('bad-transition');
    expect((await store.read('scan-1'))!.items[0].statusHistory).toEqual([]);
  });

  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('serialises concurrent updates to different items of one plan, losing none [concurrent-items]', async () => {
    const items = Array.from({ length: 12 }, (_, i) => item({ id: `sec-${i}`, fingerprint: `f${i}` }));
    const { store } = await stored(items);
    await Promise.all(items.map((it, i) => setItemStatus(store, 'scan-1', it.id, 'in-progress', { note: `n${i}`, externalRef: `EXT-${i}` })));
    const after = (await store.read('latest'))!.items;
    expect(after.every((it, i) => it.status === 'in-progress' && it.externalRef === `EXT-${i}`)).toBe(true);
  });

  // [claims: capabilities/security-and-remediation#plan-transitions]
  it('lists plans oldest first and resolves latest, and skips temp files and invalid plans [list-latest]', async () => {
    const { config } = await stored([item()]);
    await writePlan(config, plan([item()], 'scan-2'));
    const store = filePlanStore(path.join(config.rootDir!, '.specguard/security/plans'));
    expect(await store.list()).toEqual(['scan-1', 'scan-2']);
    expect((await store.read('latest'))!.id).toBe('scan-2');
    expect(await store.read('../scan-1')).not.toBeNull();
    expect(await store.read('ghost')).toBeNull();
  });
});
