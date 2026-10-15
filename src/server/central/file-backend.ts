/**
 * A team server's state in a directory. One machine, no database: the simplest deployment, and what the tests use.
 *
 * Layout: `projects/<name>/snapshots/<id>.json`, `projects/<name>/plans/`, `projects/<name>/cache/`, plus
 * `tokens.json`, `audit.jsonl` and `usage.jsonl` at the top.
 *
 * Spec: specs/capabilities/team-server.md
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { fileContentCache } from '../../core/state/content-cache.js';
import { serially } from '../../core/state/lock.js';
import { filePlanStore } from '../../core/state/plan-store.js';
import type { Snapshot } from '../../core/snapshot.js';
import { writeFile } from '../../core/writer.js';
import { PROJECT_NAME, type AuditEntry, type Backend, type SnapshotRecord, type SnapshotStore, type TokenRecord, type TokenStore, type UsageRow } from './backend.js';

const DEFAULT_BRANCHES = ['main', 'master'];

function safeProject(name: string): string {
  if (!PROJECT_NAME.test(name)) throw new Error(`invalid project name "${name}"`);
  return name;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function readLines<T>(file: string, limit: number): T[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

export function fileBackend(dir: string): Backend {
  const projectDir = (project: string): string => path.join(dir, 'projects', safeProject(project));
  const snapshotDir = (project: string): string => path.join(projectDir(project), 'snapshots');

  const records = (project: string): SnapshotRecord[] => {
    const d = snapshotDir(project);
    if (!fs.existsSync(d)) return [];
    return fs
      .readdirSync(d)
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => readJson<SnapshotRecord | null>(path.join(d, f), null))
      .filter((r): r is SnapshotRecord => Boolean(r))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  };

  const snapshots: SnapshotStore = {
    async put(snapshot: Snapshot) {
      const text = JSON.stringify(snapshot);
      const id = `${snapshot.createdAt.replace(/[^0-9]/g, '').slice(0, 17)}-${randomBytes(3).toString('hex')}`;
      const record: SnapshotRecord = {
        id,
        project: snapshot.project,
        ...(snapshot.branch ? { branch: snapshot.branch } : {}),
        ...(snapshot.commit ? { commit: snapshot.commit } : {}),
        createdAt: snapshot.createdAt,
        origin: snapshot.origin,
        bytes: Buffer.byteLength(text),
      };
      const d = snapshotDir(snapshot.project);
      await writeFile(path.join(d, `${id}.json`), text);
      await writeFile(path.join(d, `${id}.meta.json`), JSON.stringify(record));
      return record;
    },
    async latest(project) {
      const all = records(project);
      if (all.length === 0) return undefined;
      const onDefault = all.filter((r) => r.branch && DEFAULT_BRANCHES.includes(r.branch));
      const record = (onDefault.length > 0 ? onDefault : all).at(-1)!;
      const snapshot = readJson<Snapshot | null>(path.join(snapshotDir(project), `${record.id}.json`), null);
      return snapshot ? { record, snapshot } : undefined;
    },
    async projects() {
      const root = path.join(dir, 'projects');
      if (!fs.existsSync(root)) return [];
      const out: SnapshotRecord[] = [];
      for (const name of fs.readdirSync(root).sort()) {
        if (!PROJECT_NAME.test(name)) continue;
        const latest = await snapshots.latest(name);
        if (latest) out.push(latest.record);
      }
      return out;
    },
    async has(project, commit, branch) {
      return records(project).some((r) => r.commit === commit && (branch === undefined || r.branch === branch));
    },
    async prune(project, keep) {
      const all = records(project);
      const drop = all.slice(0, Math.max(0, all.length - keep));
      for (const r of drop) {
        fs.rmSync(path.join(snapshotDir(project), `${r.id}.json`), { force: true });
        fs.rmSync(path.join(snapshotDir(project), `${r.id}.meta.json`), { force: true });
      }
      return drop.length;
    },
  };

  const tokenFile = path.join(dir, 'tokens.json');
  const loadTokens = (): TokenRecord[] => readJson<TokenRecord[]>(tokenFile, []);
  const saveTokens = (all: TokenRecord[]): Promise<void> => writeFile(tokenFile, JSON.stringify(all, null, 2));
  const tokens: TokenStore = {
    create: (record) => serially(tokenFile, async () => saveTokens([...loadTokens(), record])),
    findByHash: async (hash) => loadTokens().find((t) => t.hash === hash),
    list: async (owner) => loadTokens().filter((t) => t.owner === owner),
    revoke: (id, owner) =>
      serially(tokenFile, async () => {
        const all = loadTokens();
        const hit = all.find((t) => t.id === id && !t.revokedAt && (owner === undefined || t.owner === owner));
        if (!hit) return false;
        hit.revokedAt = new Date().toISOString();
        await saveTokens(all);
        return true;
      }),
    touch: (id) =>
      serially(tokenFile, async () => {
        const all = loadTokens();
        const hit = all.find((t) => t.id === id);
        if (hit) {
          hit.lastUsedAt = new Date().toISOString();
          await saveTokens(all);
        }
      }),
  };

  const append = (file: string, value: unknown): Promise<void> =>
    serially(file, async () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
    });

  return {
    kind: 'file',
    snapshots,
    plans: (project) => filePlanStore(path.join(projectDir(project), 'plans')),
    cache: (project) => fileContentCache(projectDir(project)),
    tokens,
    audit: (entry: AuditEntry) => append(path.join(dir, 'audit.jsonl'), entry),
    usage: (row: UsageRow) => append(path.join(dir, 'usage.jsonl'), row),
    readAudit: async (limit = 200) => readLines<AuditEntry>(path.join(dir, 'audit.jsonl'), limit),
    readUsage: async (limit = 200) => readLines<UsageRow>(path.join(dir, 'usage.jsonl'), limit),
    close: async () => undefined,
  };
}
