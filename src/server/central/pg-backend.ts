/**
 * A team server's state in Postgres, for deployments with a database (the sandbox gives each app one). Same
 * interfaces as the file backend, same contract tests.
 *
 * Concurrent edits to one plan never take a row lock: each plan row carries a revision, an update writes only if the
 * revision is still the one it read, and otherwise reads again and retries. That works on any SQL database.
 *
 * Spec: specs/capabilities/team-server.md
 */
import { randomBytes } from 'node:crypto';

import type { CacheEntry, ContentCache } from '../../core/state/content-cache.js';
import type { PlanStore } from '../../core/state/plan-store.js';
import { planStem } from '../../core/state/plan-store.js';
import { RemediationPlanSchema, type RemediationPlan } from '../../core/remediation-schema.js';
import type { Snapshot } from '../../core/snapshot.js';
import { PROJECT_NAME, WORKSPACE_NAME, type AuditEntry, type Backend, type SnapshotRecord, type SnapshotStore, type TokenRecord, type TokenStore, type UsageRow, type WorkspaceDef, type WorkspaceStore } from './backend.js';

/** The part of a Postgres pool this backend uses. `pg.Pool` satisfies it; so does a pg-mem adapter. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
}

const DEFAULT_BRANCHES = ['main', 'master'];
const MAX_RETRIES = 12;

/** Run once, in order; each statement is idempotent. */
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS sg_projects (name TEXT PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS sg_snapshots (
     id text PRIMARY KEY, project text NOT NULL, branch text, commit_sha text, created_at text NOT NULL,
     origin text NOT NULL, bytes integer NOT NULL, body text NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sg_snapshots_project ON sg_snapshots (project, created_at)`,
  `CREATE TABLE IF NOT EXISTS sg_plans (
     project text NOT NULL, id text NOT NULL, rev integer NOT NULL, body text NOT NULL, updated_at text NOT NULL,
     PRIMARY KEY (project, id))`,
  `CREATE TABLE IF NOT EXISTS sg_cache (
     namespace text NOT NULL, slot text NOT NULL, hash text NOT NULL, value text NOT NULL,
     PRIMARY KEY (namespace, slot))`,
  `CREATE TABLE IF NOT EXISTS sg_tokens (
     id text PRIMARY KEY, owner text NOT NULL, name text NOT NULL, role text NOT NULL, project text,
     hash text NOT NULL, created_at text NOT NULL, last_used_at text, revoked_at text)`,
  `CREATE INDEX IF NOT EXISTS sg_tokens_hash ON sg_tokens (hash)`,
  `CREATE TABLE IF NOT EXISTS sg_workspaces (
     name text PRIMARY KEY, body text NOT NULL, updated_at text NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sg_audit (
     seq SERIAL PRIMARY KEY, at text NOT NULL, actor text NOT NULL, action text NOT NULL, project text, detail text)`,
  `CREATE TABLE IF NOT EXISTS sg_usage (
     seq SERIAL PRIMARY KEY, at text NOT NULL, usr text, project text, pipeline text NOT NULL, model text NOT NULL,
     input_tokens integer NOT NULL, output_tokens integer NOT NULL, estimated_usd double precision NOT NULL)`,
];

export async function migrate(db: Db): Promise<void> {
  for (const statement of MIGRATIONS) await db.query(statement);
}

interface SnapshotRow {
  id: string;
  project: string;
  branch: string | null;
  commit_sha: string | null;
  created_at: string;
  origin: SnapshotRecord['origin'];
  bytes: number;
}

const recordOf = (r: SnapshotRow): SnapshotRecord => ({
  id: r.id,
  project: r.project,
  ...(r.branch ? { branch: r.branch } : {}),
  ...(r.commit_sha ? { commit: r.commit_sha } : {}),
  createdAt: r.created_at,
  origin: r.origin,
  bytes: Number(r.bytes),
});

const RECORD_COLUMNS = 'id, project, branch, commit_sha, created_at, origin, bytes';

function snapshotStore(db: Db): SnapshotStore {
  const records = async (project: string): Promise<SnapshotRecord[]> =>
    (await db.query<SnapshotRow>(`SELECT ${RECORD_COLUMNS} FROM sg_snapshots WHERE project = $1 ORDER BY created_at ASC, id ASC`, [project])).rows.map(recordOf);
  const store: SnapshotStore = {
    async put(snapshot: Snapshot) {
      const body = JSON.stringify(snapshot);
      const id = `${snapshot.createdAt.replace(/[^0-9]/g, '').slice(0, 17)}-${randomBytes(3).toString('hex')}`;
      await db.query(
        'INSERT INTO sg_snapshots (id, project, branch, commit_sha, created_at, origin, bytes, body) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, snapshot.project, snapshot.branch ?? null, snapshot.commit ?? null, snapshot.createdAt, snapshot.origin, Buffer.byteLength(body), body],
      );
      return { id, project: snapshot.project, ...(snapshot.branch ? { branch: snapshot.branch } : {}), ...(snapshot.commit ? { commit: snapshot.commit } : {}), createdAt: snapshot.createdAt, origin: snapshot.origin, bytes: Buffer.byteLength(body) };
    },
    async latest(project) {
      const all = await records(project);
      if (all.length === 0) return undefined;
      const onDefault = all.filter((r) => r.branch && DEFAULT_BRANCHES.includes(r.branch));
      const record = (onDefault.length > 0 ? onDefault : all).at(-1)!;
      const row = (await db.query<{ body: string }>('SELECT body FROM sg_snapshots WHERE id = $1', [record.id])).rows[0];
      if (!row) return undefined;
      try {
        return { record, snapshot: JSON.parse(row.body) as Snapshot };
      } catch {
        return undefined;
      }
    },
    async projects() {
      const names = (await db.query<{ project: string }>('SELECT DISTINCT project FROM sg_snapshots ORDER BY project')).rows.map((r) => r.project);
      const out: SnapshotRecord[] = [];
      for (const name of names) {
        if (!PROJECT_NAME.test(name)) continue;
        const latest = await store.latest(name);
        if (latest) out.push(latest.record);
      }
      return out;
    },
    async has(project, commit, branch) {
      const rows = branch === undefined
        ? (await db.query('SELECT id FROM sg_snapshots WHERE project = $1 AND commit_sha = $2', [project, commit])).rows
        : (await db.query('SELECT id FROM sg_snapshots WHERE project = $1 AND commit_sha = $2 AND branch = $3', [project, commit, branch])).rows;
      return rows.length > 0;
    },
    async prune(project, keep) {
      const all = await records(project);
      const drop = all.slice(0, Math.max(0, all.length - keep));
      for (const r of drop) await db.query('DELETE FROM sg_snapshots WHERE id = $1', [r.id]);
      return drop.length;
    },
  };
  return store;
}

function workspaceStore(db: Db): WorkspaceStore {
  const parse = (body: string): WorkspaceDef | undefined => {
    try {
      return JSON.parse(body) as WorkspaceDef;
    } catch {
      return undefined;
    }
  };
  return {
    async list() {
      const rows = (await db.query<{ body: string }>('SELECT body FROM sg_workspaces ORDER BY name ASC')).rows;
      return rows.map((r) => parse(r.body)).filter((w): w is WorkspaceDef => Boolean(w));
    },
    async get(name) {
      if (!WORKSPACE_NAME.test(name)) return undefined;
      const row = (await db.query<{ body: string }>('SELECT body FROM sg_workspaces WHERE name = $1', [name])).rows[0];
      return row ? parse(row.body) : undefined;
    },
    async put(def) {
      if (!WORKSPACE_NAME.test(def.name)) throw new Error(`invalid workspace name "${def.name}"`);
      await db.query(
        `INSERT INTO sg_workspaces (name, body, updated_at) VALUES ($1,$2,$3)
         ON CONFLICT (name) DO UPDATE SET body = EXCLUDED.body, updated_at = EXCLUDED.updated_at`,
        [def.name, JSON.stringify(def), def.updatedAt],
      );
    },
  };
}

function planStore(db: Db, project: string): PlanStore {
  const parse = (body: string): RemediationPlan | null => {
    try {
      const parsed = RemediationPlanSchema.safeParse(JSON.parse(body));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  const resolve = async (id: string): Promise<string | undefined> => {
    if (id !== 'latest') return planStem(id);
    const rows = (await db.query<{ id: string }>('SELECT id FROM sg_plans WHERE project = $1 ORDER BY id DESC', [project])).rows;
    return rows[0]?.id;
  };
  return {
    location: `postgres:${project}`,
    list: async () => (await db.query<{ id: string }>('SELECT id FROM sg_plans WHERE project = $1 ORDER BY id ASC', [project])).rows.map((r) => r.id),
    async read(id) {
      const resolved = await resolve(id);
      if (!resolved) return null;
      const row = (await db.query<{ body: string }>('SELECT body FROM sg_plans WHERE project = $1 AND id = $2', [project, resolved])).rows[0];
      return row ? parse(row.body) : null;
    },
    async write(plan) {
      await db.query(
        `INSERT INTO sg_plans (project, id, rev, body, updated_at) VALUES ($1,$2,1,$3,$4)
         ON CONFLICT (project, id) DO UPDATE SET body = EXCLUDED.body, rev = sg_plans.rev + 1, updated_at = EXCLUDED.updated_at`,
        [project, planStem(plan.id), JSON.stringify(plan), new Date().toISOString()],
      );
      return `postgres:${project}/${planStem(plan.id)}`;
    },
    async update(id, fn) {
      const resolved = await resolve(id);
      if (!resolved) return null;
      for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
        const row = (await db.query<{ body: string; rev: number }>('SELECT body, rev FROM sg_plans WHERE project = $1 AND id = $2', [project, resolved])).rows[0];
        const plan = row ? parse(row.body) : null;
        if (!row || !plan) return null;
        const out = await fn(plan);
        const written = await db.query('UPDATE sg_plans SET body = $1, rev = rev + 1, updated_at = $2 WHERE project = $3 AND id = $4 AND rev = $5', [JSON.stringify(plan), new Date().toISOString(), project, resolved, Number(row.rev)]);
        if ((written.rowCount ?? 0) === 1) return out;
      }
      throw new Error(`plan ${resolved} is being changed too often to update; try again`);
    },
  };
}

function contentCache(db: Db, project: string): ContentCache {
  const ns = (namespace: string): string => `${project}/${namespace}`;
  return {
    async get(namespace, slot) {
      const row = (await db.query<CacheEntry>('SELECT hash, value FROM sg_cache WHERE namespace = $1 AND slot = $2', [ns(namespace), slot])).rows[0];
      return row ? { hash: row.hash, value: row.value } : undefined;
    },
    async put(namespace, slot, entry) {
      await db.query(
        `INSERT INTO sg_cache (namespace, slot, hash, value) VALUES ($1,$2,$3,$4)
         ON CONFLICT (namespace, slot) DO UPDATE SET hash = EXCLUDED.hash, value = EXCLUDED.value`,
        [ns(namespace), slot, entry.hash, entry.value],
      );
    },
  };
}

interface TokenRow {
  id: string;
  owner: string;
  name: string;
  role: TokenRecord['role'];
  project: string | null;
  hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const tokenOf = (r: TokenRow): TokenRecord => ({
  id: r.id,
  owner: r.owner,
  name: r.name,
  role: r.role,
  ...(r.project ? { project: r.project } : {}),
  hash: r.hash,
  createdAt: r.created_at,
  ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
  ...(r.revoked_at ? { revokedAt: r.revoked_at } : {}),
});

function tokenStore(db: Db): TokenStore {
  return {
    async create(t) {
      await db.query('INSERT INTO sg_tokens (id, owner, name, role, project, hash, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [t.id, t.owner, t.name, t.role, t.project ?? null, t.hash, t.createdAt]);
    },
    async findByHash(hash) {
      const row = (await db.query<TokenRow>('SELECT * FROM sg_tokens WHERE hash = $1', [hash])).rows[0];
      return row ? tokenOf(row) : undefined;
    },
    async list(owner) {
      return (await db.query<TokenRow>('SELECT * FROM sg_tokens WHERE owner = $1 ORDER BY created_at ASC', [owner])).rows.map(tokenOf);
    },
    async revoke(id, owner) {
      const now = new Date().toISOString();
      const res = owner === undefined
        ? await db.query('UPDATE sg_tokens SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL', [now, id])
        : await db.query('UPDATE sg_tokens SET revoked_at = $1 WHERE id = $2 AND owner = $3 AND revoked_at IS NULL', [now, id, owner]);
      return (res.rowCount ?? 0) > 0;
    },
    async touch(id) {
      await db.query('UPDATE sg_tokens SET last_used_at = $1 WHERE id = $2', [new Date().toISOString(), id]);
    },
  };
}

/** A backend over an open connection pool. Creates its tables on first use. */
export async function pgBackend(db: Db): Promise<Backend> {
  await migrate(db);
  return {
    kind: 'postgres',
    projects: {
      async list() { return (await db.query<{ name: string }>('SELECT name FROM sg_projects ORDER BY name')).rows.map(r => r.name); },
      async create(name) {
        if (!PROJECT_NAME.test(name)) throw new Error('invalid project name');
        await db.query('INSERT INTO sg_projects (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
      },
    },
    snapshots: snapshotStore(db),
    plans: (project) => planStore(db, project),
    cache: (project) => contentCache(db, project),
    tokens: tokenStore(db),
    workspaces: workspaceStore(db),
    audit: async (e: AuditEntry) => {
      await db.query('INSERT INTO sg_audit (at, actor, action, project, detail) VALUES ($1,$2,$3,$4,$5)', [e.at, e.actor, e.action, e.project ?? null, e.detail ?? null]);
    },
    usage: async (u: UsageRow) => {
      await db.query('INSERT INTO sg_usage (at, usr, project, pipeline, model, input_tokens, output_tokens, estimated_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [u.at, u.user ?? null, u.project ?? null, u.pipeline, u.model, u.inputTokens, u.outputTokens, u.estimatedUsd]);
    },
    readAudit: async (limit = 200) =>
      (await db.query<{ at: string; actor: string; action: string; project: string | null; detail: string | null }>('SELECT at, actor, action, project, detail FROM sg_audit ORDER BY seq DESC LIMIT $1', [limit])).rows
        .reverse()
        .map((r) => ({ at: r.at, actor: r.actor, action: r.action, ...(r.project ? { project: r.project } : {}), ...(r.detail ? { detail: r.detail } : {}) })),
    readUsage: async (limit = 200) =>
      (await db.query<{ at: string; usr: string | null; project: string | null; pipeline: string; model: string; input_tokens: number; output_tokens: number; estimated_usd: number }>('SELECT at, usr, project, pipeline, model, input_tokens, output_tokens, estimated_usd FROM sg_usage ORDER BY seq DESC LIMIT $1', [limit])).rows
        .reverse()
        .map((r) => ({ at: r.at, ...(r.usr ? { user: r.usr } : {}), ...(r.project ? { project: r.project } : {}), pipeline: r.pipeline, model: r.model, inputTokens: Number(r.input_tokens), outputTokens: Number(r.output_tokens), estimatedUsd: Number(r.estimated_usd) })),
    close: () => db.end(),
  };
}

/** Connect to Postgres by URL. `pg` is loaded only when a database is used. */
export async function connectPostgres(url: string): Promise<Backend> {
  const { default: pg } = (await import('pg')) as unknown as { default: { Pool: new (config: { connectionString: string; max?: number }) => Db } };
  return pgBackend(new pg.Pool({ connectionString: url, max: 8 }));
}
