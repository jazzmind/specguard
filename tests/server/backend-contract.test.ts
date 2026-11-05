import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newDb } from 'pg-mem';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/core/config.js';
import type { RunManifest } from '../../src/core/publish-contract.js';
import { snapshotDigest, type Snapshot } from '../../src/core/snapshot.js';
import { itemVersion, setItemStatus } from '../../src/pipelines/security-plan.js';
import { buildSnapshot } from '../../src/pipelines/publish.js';
import { EvidenceError, type Backend } from '../../src/server/central/backend.js';
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
  // Opt-in: a real Postgres (SPECGUARD_TEST_PG_URL), one fresh schema per backend. pg-mem differs from it in places (bytea, ordering).
  ...(process.env.SPECGUARD_TEST_PG_URL
    ? [[
        'postgres (real)',
        async () => {
          const { default: pg } = await import('pg');
          const schema = `t_${Math.random().toString(36).slice(2, 10)}`;
          const admin = new pg.Pool({ connectionString: process.env.SPECGUARD_TEST_PG_URL, max: 1 });
          await admin.query(`CREATE SCHEMA ${schema}`);
          await admin.end();
          const pool = new pg.Pool({ connectionString: process.env.SPECGUARD_TEST_PG_URL, options: `-c search_path=${schema}`, max: 4 });
          return pgBackend(pool as unknown as Db);
        },
      ] as [string, () => Promise<Backend>]]
    : []),
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

  // [claims: capabilities/team-server#project-onboarding]
  it('keeps a project directory independent of snapshots, idempotently and with safe identifiers', async () => {
    const b = await backend();
    expect(await b.projects.list()).toEqual([]);
    await b.projects.create('new-app');
    await b.projects.create('new-app');
    expect(await b.projects.list()).toEqual(['new-app']);
    expect(await b.snapshots.latest('new-app')).toBeUndefined();
    await expect(b.projects.create('../escape')).rejects.toThrow();
  });

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

  // [claims: capabilities/workspaces#server-workspace]
  it('stores workspaces: create, replace, read back, list in name order, and refuse a bad name [workspaces]', async () => {
    const b = await backend();
    expect(await b.workspaces.list()).toEqual([]);
    expect(await b.workspaces.get('sandbox')).toBeUndefined();
    const def = (name: string, projects: string[], at = '2026-10-22T10:00:00.000Z') => ({ name, projects: projects.map((project) => ({ project })), updatedAt: at, updatedBy: 'ada@acme.test' });
    await b.workspaces.put(def('zeta', ['web']));
    await b.workspaces.put(def('sandbox', ['web', 'api']));
    await b.workspaces.put({ ...def('sandbox', ['web', 'api', 'docs'], '2026-10-22T11:00:00.000Z'), description: 'replaced' });
    expect((await b.workspaces.list()).map((w) => w.name)).toEqual(['sandbox', 'zeta']);
    expect(await b.workspaces.get('sandbox')).toMatchObject({ description: 'replaced', updatedAt: '2026-10-22T11:00:00.000Z' });
    expect((await b.workspaces.get('sandbox'))!.projects).toHaveLength(3);
    expect(await b.workspaces.get('../etc')).toBeUndefined();
    await expect(b.workspaces.put(def('bad name', []))).rejects.toThrow(/invalid workspace name/);
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

  // [claims: capabilities/team-server#publish-digest-check]
  it('stores the digest the server computed with each snapshot [snapshot-digest]', async () => {
    const b = await backend();
    const snap = await snapshot({ branch: 'main', commit: 'c1' });
    const record = await b.snapshots.put(snap);
    expect(record.digest).toEqual(snapshotDigest(snap));
    expect((await b.snapshots.latest('demo'))!.record.digest).toEqual(snapshotDigest(snap));
    expect((await b.snapshots.projects())[0].digest ?? snapshotDigest(snap)).toEqual(snapshotDigest(snap));
  });

  // [claims: capabilities/team-server#evidence-backend-storage]
  it('keeps runs per project: replace by id, newest first, latest means newest complete, delete [evidence-runs]', async () => {
    const e = (await backend()).evidence('demo');
    expect(await e.listRuns()).toEqual([]);
    expect(await e.getRun('latest')).toBeUndefined();
    const first = await e.putRun(manifest('run-1', [], '2026-11-01T10:00:00.000Z'), 'complete');
    await e.putRun(manifest('run/2 odd:id', [Buffer.from('x')], '2026-11-02T10:00:00.000Z'), 'pending');
    expect((await e.listRuns()).map((r) => [r.runId, r.status])).toEqual([['run/2 odd:id', 'pending'], ['run-1', 'complete']]);
    expect((await e.getRun('latest'))!.record.runId).toBe('run-1');
    expect((await e.getRun('run/2 odd:id'))!.manifest.files['f0.png'].size).toBe(1);
    expect(first).toMatchObject({ files: 0, bytes: 0, digest: 'd', tests: { total: 2, pass: 1, fail: 1, skip: 0 } });
    // Completing a run keeps when it was created; a changed digest starts it over.
    const done = await e.putRun(manifest('run/2 odd:id', [Buffer.from('x')], '2026-11-02T10:00:00.000Z'), 'complete');
    expect(done.createdAt).toBe((await e.listRuns())[0].createdAt);
    expect((await e.getRun('latest'))!.record.runId).toBe('run/2 odd:id');
    expect(await e.deleteRun('run-1')).toBe(true);
    expect(await e.deleteRun('run-1')).toBe(false);
    // Another project has its own runs.
    expect(await (await backend()).evidence('other').listRuns()).toEqual([]);
  });

  // [claims: capabilities/team-server#evidence-backend-storage]
  it('appends chunks at the offset it holds, verifies the hash on finalize, reads ranges and counts bytes [evidence-blobs]', async () => {
    const b = await backend();
    const e = b.evidence('demo');
    // pg-mem corrupts bytea values above 0x7f (it round-trips them through UTF-8; real Postgres does not), so the in-memory
    // database is given 7-bit bytes. The file backend gets every byte value.
    const data = Buffer.from(Array.from({ length: 2600 }, (_, i) => (i * 7) % (b.kind === 'file' ? 256 : 128)));
    const name = createHash('sha256').update(data).digest('hex');
    expect(await e.blobState(name)).toBeUndefined();
    expect(await e.appendChunk(name, 0, 2600, data.subarray(0, 1000))).toBe(1000);
    expect(await e.blobState(name)).toEqual({ size: 2600, received: 1000, complete: false });
    await expect(e.appendChunk(name, 0, 2600, data.subarray(0, 1000))).rejects.toMatchObject({ code: 'offset-mismatch', expectedOffset: 1000 });
    await expect(e.appendChunk(name, 5000, 2600, data.subarray(0, 10))).rejects.toBeInstanceOf(EvidenceError);
    await expect(e.appendChunk(name, 1000, 2600, Buffer.alloc(2000))).rejects.toMatchObject({ code: 'overflow' });
    expect(await e.appendChunk(name, 1000, 2600, data.subarray(1000, 1700))).toBe(1700);
    expect(await e.appendChunk(name, 1700, 2600, data.subarray(1700))).toBe(2600);
    expect(await e.bytesUsed()).toBe(2600);
    expect(await e.finalizeBlob(name)).toEqual({ ok: true, size: 2600 });
    expect(await e.blobState(name)).toEqual({ size: 2600, received: 2600, complete: true });
    const read = async (range?: { start: number; end: number }) => {
      const parts: Buffer[] = [];
      for await (const c of e.readBlob(name, range)) parts.push(c);
      return Buffer.concat(parts);
    };
    expect((await read()).equals(data)).toBe(true);
    expect((await read({ start: 5, end: 9 })).equals(data.subarray(5, 10))).toBe(true);
    // Ranges that cross and start inside stored chunks.
    expect((await read({ start: 900, end: 1750 })).equals(data.subarray(900, 1751))).toBe(true);
    expect((await read({ start: 2590, end: 2599 })).equals(data.subarray(2590))).toBe(true);
    // Appending to a finished blob changes nothing.
    expect(await e.appendChunk(name, 0, 2600, data.subarray(0, 10))).toBe(2600);

    // Bytes that do not hash to the name are thrown away.
    const bad = createHash('sha256').update('other').digest('hex');
    await e.appendChunk(bad, 0, 5, Buffer.from('12345'));
    expect(await e.finalizeBlob(bad)).toEqual({ ok: false, size: 5 });
    expect(await e.blobState(bad)).toBeUndefined();
    await expect(e.finalizeBlob(bad)).rejects.toMatchObject({ code: 'not-found' });
    await expect(e.appendChunk('nothex', 0, 1, Buffer.alloc(1))).rejects.toThrow();
    // Blobs belong to one project.
    expect(await b.evidence('other').blobState(name)).toBeUndefined();
    // An empty file is a blob too.
    const empty = createHash('sha256').update('').digest('hex');
    expect(await e.appendChunk(empty, 0, 0, Buffer.alloc(0))).toBe(0);
    expect(await e.finalizeBlob(empty)).toEqual({ ok: true, size: 0 });
  });

  // [claims: capabilities/team-server#evidence-backend-storage]
  it('keeps the newest complete runs on gc, deletes blobs no kept run refers to and stale partials [evidence-gc]', async () => {
    const e = (await backend()).evidence('demo');
    const shared = Buffer.from('shared');
    const mine = (n: number) => Buffer.from(`mine-${n}`);
    const upload = async (buf: Buffer) => {
      const h = createHash('sha256').update(buf).digest('hex');
      await e.appendChunk(h, 0, buf.length, buf);
      expect((await e.finalizeBlob(h)).ok).toBe(true);
      return h;
    };
    const hashes: string[] = [];
    for (const n of [1, 2, 3]) {
      hashes.push(await upload(mine(n)));
      await upload(shared);
      await e.putRun(manifest(`run-${n}`, [shared, mine(n)], `2026-11-0${n}T10:00:00.000Z`), 'complete');
    }
    // A pending run keeps its blobs; a partial upload is young.
    const pendingBuf = Buffer.from('pending-blob');
    await e.putRun(manifest('run-p', [pendingBuf], '2026-11-09T10:00:00.000Z'), 'pending');
    const partial = createHash('sha256').update('partial').digest('hex');
    await e.appendChunk(partial, 0, 7, Buffer.from('par'));
    const out = await e.gc(2);
    expect(out.runs).toEqual(['run-1']);
    expect(out.blobs).toBe(1);
    expect(await e.blobState(hashes[0])).toBeUndefined();
    expect((await e.blobState(hashes[1]))!.complete).toBe(true);
    expect((await e.listRuns()).map((r) => r.runId).sort()).toEqual(['run-2', 'run-3', 'run-p']);
    expect(await e.blobState(partial)).toMatchObject({ complete: false, received: 3 });
    // A day later the partial and the unfinished run are gone.
    const later = await e.gc(2, Date.now() + 25 * 60 * 60 * 1000);
    expect(later.runs).toEqual(['run-p']);
    expect(await e.blobState(partial)).toBeUndefined();
    expect(later.blobs).toBeGreaterThanOrEqual(1);
    expect((await e.blobState(hashes[2]))!.complete).toBe(true);
  });
});

function manifest(runId: string, files: Buffer[], ingestedAt = '2026-11-01T10:00:00.000Z'): RunManifest {
  return {
    schema: 'specguard-run/1',
    project: 'demo',
    runId,
    ingestedAt,
    digest: { v: 1, total: 'd', sections: { specs: 's', trace: 't', ledger: 'l', plans: 'p', contracts: 'c' }, files: {} },
    index: { runId, tests: [], claims: [] },
    report: { schema: 'specguard-report/1', totals: { tests: { total: 2, pass: 1, fail: 1, skip: 0 } } },
    files: Object.fromEntries(files.map((f, i) => [`f${i}.png`, { sha256: createHash('sha256').update(f).digest('hex'), size: f.length, contentType: 'image/png', kind: 'image' as const }])),
    omitted: [],
  };
}

describe('snapshots stored before digests existed [backend-contract]', () => {
  // [claims: capabilities/team-server#publish-digest-check]
  it('get their digest on demand: file backend', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-backend-'));
    const b = fileBackend(dir);
    const snap = await snapshot({ branch: 'main', commit: 'c1' });
    await b.snapshots.put(snap);
    const meta = path.join(dir, 'projects', 'demo', 'snapshots', readdirSync(path.join(dir, 'projects', 'demo', 'snapshots')).find((f) => f.endsWith('.meta.json'))!);
    const record = JSON.parse(readFileSync(meta, 'utf8'));
    delete record.digest;
    writeFileSync(meta, JSON.stringify(record));
    expect((await b.snapshots.latest('demo'))!.record.digest).toEqual(snapshotDigest(snap));
  });

  // [claims: capabilities/team-server#publish-digest-check]
  it('get their digest on demand, and adding the column twice is harmless: postgres (pg-mem)', async () => {
    const { Pool } = newDb().adapters.createPg();
    const db = new Pool() as unknown as Db;
    const b = await pgBackend(db);
    open.push(b);
    const snap = await snapshot({ branch: 'main', commit: 'c1' });
    await b.snapshots.put(snap);
    await db.query('UPDATE sg_snapshots SET digest = NULL');
    expect((await b.snapshots.latest('demo'))!.record.digest).toEqual(snapshotDigest(snap));
    await db.query('ALTER TABLE sg_snapshots ADD COLUMN IF NOT EXISTS digest text');
  });
});
