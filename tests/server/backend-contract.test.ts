import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newDb } from 'pg-mem';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import type { Snapshot } from '../../src/core/snapshot.js';
import { itemVersion, setItemStatus } from '../../src/pipelines/security-plan.js';
import { buildSnapshot } from '../../src/pipelines/publish.js';
import type { Backend } from '../../src/server/central/backend.js';
import { fileBackend } from '../../src/server/central/file-backend.js';
import { pgBackend, type Db } from '../../src/server/central/pg-backend.js';
import { makeV2Repo } from '../helpers/v2-repo.js';

const open: Backend[] = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

const makers: Array<[string, () => Promise<Backend>]> = [
  ['file', async () => fileBackend(mkdtempSync(path.join(os.tmpdir(), 'sg-backend-')))],
  [
    'postgres (pg-mem)',
    async () => {
      const { Pool } = newDb().adapters.createPg();
      return pgBackend(new Pool() as unknown as Db);
    },
  ],
];

let template: Snapshot | undefined;
async function snapshot(over: Partial<Snapshot> = {}): Promise<Snapshot> {
  template ??= await buildSnapshot(await loadConfig(makeV2Repo().dir), { project: 'demo' });
  return { ...JSON.parse(JSON.stringify(template)), ...over } as Snapshot;
}

const plan = (id: string, n = 3) => ({
  version: 1 as const,
  id,
  createdAt: '2026-10-15T00:00:00Z',
  tool: { name: 'specguard' as const },
  items: Array.from({ length: n }, (_, i) => ({
    id: `sec-${i}`, title: `t${i}`, severity: 'high' as const, type: 'code' as const, change: 'code' as const, summary: 's',
    findings: [{ id: `f${i}`, detector: 'semgrep' as const, message: 'm' }], claims: [], files: ['a.ts'], verify: { scope: 'listed' as const, claims: [] },
    status: 'open' as const, statusHistory: [], fingerprint: `fp${i}`,
  })),
});

describe.each(makers)('backend contract: %s [backend-contract]', (_name, make) => {
  const backend = async (): Promise<Backend> => {
    const b = await make();
    open.push(b);
    return b;
  };

  // [claims: capabilities/team-server#team-server-storage]
  it('shows a project from its newest snapshot on the default branch, else its newest overall [snapshots-latest]', async () => {
    const b = await backend();
    expect(await b.snapshots.latest('demo')).toBeUndefined();
    await b.snapshots.put(await snapshot({ branch: 'main', commit: 'c1', createdAt: '2026-10-15T10:00:00.000Z' }));
    await b.snapshots.put(await snapshot({ branch: 'feature/x', commit: 'c2', createdAt: '2026-10-15T11:00:00.000Z' }));
    expect((await b.snapshots.latest('demo'))!.record).toMatchObject({ branch: 'main', commit: 'c1' });
    await b.snapshots.put(await snapshot({ branch: 'main', commit: 'c3', createdAt: '2026-10-15T12:00:00.000Z' }));
    expect((await b.snapshots.latest('demo'))!.record.commit).toBe('c3');
    const only = await b.snapshots.put(await snapshot({ project: 'branch-only', branch: 'dev', commit: 'd1', createdAt: '2026-10-15T09:00:00.000Z' }));
    expect((await b.snapshots.latest('branch-only'))!.record.id).toBe(only.id);
    expect((await b.snapshots.latest('demo'))!.snapshot.project).toBe('demo');
  });

  // [claims: capabilities/team-server#team-server-storage]
  it('lists projects, knows which commits it has, and prunes the oldest [snapshots-housekeeping]', async () => {
    const b = await backend();
    for (let i = 1; i <= 5; i += 1) await b.snapshots.put(await snapshot({ branch: 'main', commit: `c${i}`, createdAt: `2026-10-15T0${i}:00:00.000Z` }));
    await b.snapshots.put(await snapshot({ project: 'other', branch: 'main', commit: 'o1', createdAt: '2026-10-15T01:00:00.000Z' }));
    expect((await b.snapshots.projects()).map((r) => [r.project, r.commit])).toEqual([['demo', 'c5'], ['other', 'o1']]);
    expect(await b.snapshots.has('demo', 'c3')).toBe(true);
    expect(await b.snapshots.has('demo', 'c3', 'dev')).toBe(false);
    expect(await b.snapshots.has('demo', 'nope')).toBe(false);
    expect(await b.snapshots.prune('demo', 2)).toBe(3);
    expect(await b.snapshots.has('demo', 'c1')).toBe(false);
    expect(await b.snapshots.has('demo', 'c5')).toBe(true);
    expect(await b.snapshots.has('other', 'o1')).toBe(true);
  });

  // [claims: capabilities/team-server#team-server-storage]
  it('stores plans per project, lists them in order, resolves latest, and ignores a plan that does not validate [plans]', async () => {
    const b = await backend();
    await b.plans('demo').write(plan('scan-1') as never);
    await b.plans('demo').write(plan('scan-2') as never);
    await b.plans('other').write(plan('scan-9') as never);
    expect(await b.plans('demo').list()).toEqual(['scan-1', 'scan-2']);
    expect((await b.plans('demo').read('latest'))!.id).toBe('scan-2');
    expect(await b.plans('demo').read('scan-9')).toBeNull();
    expect(await b.plans('demo').read('ghost')).toBeNull();
    expect(await b.plans('empty').read('latest')).toBeNull();
    await b.plans('demo').write({ ...plan('scan-2'), previous: 'scan-1' } as never);
    expect((await b.plans('demo').read('scan-2'))!.previous).toBe('scan-1');
  });

  // [claims: capabilities/team-server#team-server-storage]
  it('loses no update when many items of one plan change at once, and none when the update throws [plan-updates]', async () => {
    const b = await backend();
    const store = b.plans('demo');
    await store.write(plan('scan-1', 10) as never);
    await Promise.all(Array.from({ length: 10 }, (_, i) => setItemStatus(store, 'scan-1', `sec-${i}`, 'in-progress', { note: `n${i}`, externalRef: `EXT-${i}` })));
    const after = (await store.read('scan-1'))!.items;
    expect(after.every((it, i) => it.status === 'in-progress' && it.externalRef === `EXT-${i}` && itemVersion(it) === 1)).toBe(true);
    await expect(store.update('scan-1', (p) => { p.items[0].status = 'wont-fix'; throw new Error('abort'); })).rejects.toThrow('abort');
    expect((await store.read('scan-1'))!.items[0].status).toBe('in-progress');
    expect(await store.update('ghost', () => 1)).toBeNull();
  });

  // [claims: capabilities/team-server#team-server-storage]
  it('caches by namespace and slot per project, replacing an entry in place [cache]', async () => {
    const b = await backend();
    expect(await b.cache('demo').get('docs/user', 'auth')).toBeUndefined();
    await b.cache('demo').put('docs/user', 'auth', { hash: 'h1', value: 'one' });
    await b.cache('demo').put('docs/user', 'auth', { hash: 'h2', value: 'two' });
    await b.cache('other').put('docs/user', 'auth', { hash: 'x', value: 'theirs' });
    expect(await b.cache('demo').get('docs/user', 'auth')).toEqual({ hash: 'h2', value: 'two' });
    expect(await b.cache('other').get('docs/user', 'auth')).toEqual({ hash: 'x', value: 'theirs' });
    expect(await b.cache('demo').get('docs/dev', 'auth')).toBeUndefined();
  });

  // [claims: capabilities/team-server#team-server-storage]
  it('finds tokens by hash, lets only the owner revoke, and tracks use [tokens]', async () => {
    const b = await backend();
    const base = { name: 'laptop', role: 'maintainer' as const, createdAt: '2026-10-15T00:00:00Z' };
    await b.tokens.create({ id: 't1', owner: 'ada@x', hash: 'h1', ...base });
    await b.tokens.create({ id: 't2', owner: 'bob@x', hash: 'h2', project: 'demo', ...base });
    expect(await b.tokens.findByHash('h1')).toMatchObject({ id: 't1', owner: 'ada@x' });
    expect((await b.tokens.findByHash('h2'))!.project).toBe('demo');
    expect(await b.tokens.findByHash('nope')).toBeUndefined();
    expect((await b.tokens.list('ada@x')).map((t) => t.id)).toEqual(['t1']);
    expect(await b.tokens.revoke('t1', 'bob@x')).toBe(false);
    expect(await b.tokens.revoke('t1', 'ada@x')).toBe(true);
    expect(await b.tokens.revoke('t1', 'ada@x')).toBe(false);
    expect((await b.tokens.findByHash('h1'))!.revokedAt).toBeTruthy();
    expect(await b.tokens.revoke('t2', undefined)).toBe(true);
    await b.tokens.touch('t2');
    expect((await b.tokens.findByHash('h2'))!.lastUsedAt).toBeTruthy();
  });

  // [claims: capabilities/team-server#team-server-storage]
  it('keeps the audit trail and the model usage in order [audit-usage]', async () => {
    const b = await backend();
    await b.audit({ at: '2026-10-15T00:00:01Z', actor: 'ada@x', action: 'token.create', detail: 'one' });
    await b.audit({ at: '2026-10-15T00:00:02Z', actor: 'bob@x', action: 'token.revoke', project: 'demo' });
    expect((await b.readAudit()).map((a) => [a.actor, a.action, a.project ?? null])).toEqual([['ada@x', 'token.create', null], ['bob@x', 'token.revoke', 'demo']]);
    expect((await b.readAudit(1)).map((a) => a.actor)).toEqual(['bob@x']);
    await b.usage({ at: '2026-10-15T00:00:01Z', user: 'ada@x', project: 'demo', pipeline: 'docs', model: 'fast', inputTokens: 10, outputTokens: 5, estimatedUsd: 0.01 });
    await b.usage({ at: '2026-10-15T00:00:02Z', pipeline: 'docs', model: 'fast', inputTokens: 1, outputTokens: 1, estimatedUsd: 0 });
    const usage = await b.readUsage();
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ user: 'ada@x', project: 'demo', inputTokens: 10, estimatedUsd: 0.01 });
    expect(usage[1].user).toBeUndefined();
  });

  // [claims: capabilities/team-server#team-server-storage]
  it('refuses a project name that could leave its directory or break a path [project-names]', async () => {
    const b = await backend();
    if (b.kind === 'file') {
      await expect(b.snapshots.put(await snapshot({ project: '../escape' }))).rejects.toThrow(/invalid project name/);
      expect(() => b.plans('../escape')).toThrow(/invalid project name/);
    }
  });
});
