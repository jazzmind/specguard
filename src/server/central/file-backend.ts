/**
 * A team server's state in a directory. One machine, no database: the simplest deployment, and what the tests use.
 *
 * Layout: `projects/<name>/snapshots/<id>.json`, `projects/<name>/plans/`, `projects/<name>/cache/`, plus
 * `tokens.json`, `audit.jsonl` and `usage.jsonl` at the top.
 *
 * Spec: specs/capabilities/team-server.md
 */
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { fileContentCache } from '../../core/state/content-cache.js';
import { serially } from '../../core/state/lock.js';
import { filePlanStore } from '../../core/state/plan-store.js';
import { snapshotDigest, type Snapshot } from '../../core/snapshot.js';
import type { RunManifest } from '../../core/publish-contract.js';
import { writeFile } from '../../core/writer.js';
import { PROJECT_NAME, WORKSPACE_NAME, EvidenceError, gcPlan, manifestBlobs, newestFirst, runListingOf, type AuditEntry, type Backend, type BlobState, type EvidenceStore, type StoredRun, type WorkspaceDef, type WorkspaceStore, type SnapshotRecord, type SnapshotStore, type TokenRecord, type TokenStore, type UsageRow } from './backend.js';

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

const SHA256 = /^[0-9a-f]{64}$/;

/** A run id made safe for a file name; the hash keeps two ids that sanitize alike apart. */
export function runFileId(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '_').slice(0, 80)}-${createHash('sha1').update(runId).digest('hex').slice(0, 8)}`;
}

/** Evidence of one project as files: runs as JSON, blobs by hash, partial uploads aside. */
function fileEvidence(root: string): EvidenceStore {
  const runDir = path.join(root, 'runs');
  const blobDir = path.join(root, 'blobs');
  const partialDir = path.join(blobDir, '.partial');
  const runFile = (runId: string): string => path.join(runDir, `${runFileId(runId)}.json`);
  const blobFile = (sha: string): string => path.join(blobDir, sha.slice(0, 2), sha);
  const partialFile = (sha: string): string => path.join(partialDir, sha);
  const metaFile = (sha: string): string => path.join(partialDir, `${sha}.meta`);
  const checked = (sha: string): string => {
    if (!SHA256.test(sha)) throw new Error('invalid blob hash');
    return sha;
  };
  const stored = (file: string): StoredRun | undefined => {
    const run = readJson<StoredRun | null>(file, null);
    return run?.record && run.manifest ? run : undefined;
  };
  const allRuns = (): StoredRun[] => (fs.existsSync(runDir) ? fs.readdirSync(runDir).filter((f) => f.endsWith('.json')).map((f) => stored(path.join(runDir, f))).filter((r): r is StoredRun => Boolean(r)) : []);

  const store: EvidenceStore = {
    async putRun(manifest: RunManifest, status) {
      return serially(runDir, async () => {
        const before = stored(runFile(manifest.runId));
        const createdAt = before && before.record.digest === manifest.digest.total ? before.record.createdAt : new Date().toISOString();
        const record = runListingOf(manifest, status, createdAt);
        await writeFile(runFile(manifest.runId), JSON.stringify({ record, manifest } satisfies StoredRun));
        return record;
      });
    },
    async getRun(id) {
      if (id === 'latest') return allRuns().filter((r) => r.record.status === 'complete').sort((a, b) => newestFirst(a.record, b.record))[0];
      return stored(runFile(id));
    },
    async listRuns() {
      return allRuns().map((r) => r.record).sort(newestFirst);
    },
    async deleteRun(id) {
      return serially(runDir, async () => {
        const file = runFile(id);
        if (!fs.existsSync(file)) return false;
        fs.rmSync(file, { force: true });
        return true;
      });
    },
    async blobState(sha) {
      checked(sha);
      const done = blobFile(sha);
      if (fs.existsSync(done)) {
        const size = fs.statSync(done).size;
        return { size, received: size, complete: true } satisfies BlobState;
      }
      const part = partialFile(sha);
      if (!fs.existsSync(part)) return undefined;
      const meta = readJson<{ total?: number }>(metaFile(sha), {});
      return { size: meta.total ?? 0, received: fs.statSync(part).size, complete: false } satisfies BlobState;
    },
    async appendChunk(sha, offset, total, data) {
      checked(sha);
      return serially(`blob:${root}:${sha}`, async () => {
        if (fs.existsSync(blobFile(sha))) return fs.statSync(blobFile(sha)).size;
        const part = partialFile(sha);
        const held = fs.existsSync(part) ? fs.statSync(part).size : 0;
        if (offset !== held) throw new EvidenceError('offset-mismatch', `the server holds ${held} bytes, not ${offset}`, held);
        if (held + data.length > total) throw new EvidenceError('overflow', 'the upload is longer than its declared length');
        fs.mkdirSync(partialDir, { recursive: true });
        if (held === 0) fs.writeFileSync(metaFile(sha), JSON.stringify({ total }));
        fs.appendFileSync(part, data);
        return held + data.length;
      });
    },
    async finalizeBlob(sha) {
      checked(sha);
      return serially(`blob:${root}:${sha}`, async () => {
        if (fs.existsSync(blobFile(sha))) return { ok: true, size: fs.statSync(blobFile(sha)).size };
        const part = partialFile(sha);
        if (!fs.existsSync(part)) throw new EvidenceError('not-found', 'no upload in progress');
        const hash = createHash('sha256');
        let size = 0;
        for await (const chunk of fs.createReadStream(part)) {
          hash.update(chunk as Buffer);
          size += (chunk as Buffer).length;
        }
        const meta = readJson<{ total?: number }>(metaFile(sha), {});
        const ok = hash.digest('hex') === sha && (meta.total === undefined || meta.total === size);
        if (!ok) {
          fs.rmSync(part, { force: true });
          fs.rmSync(metaFile(sha), { force: true });
          return { ok: false, size };
        }
        fs.mkdirSync(path.dirname(blobFile(sha)), { recursive: true });
        fs.renameSync(part, blobFile(sha));
        fs.rmSync(metaFile(sha), { force: true });
        return { ok: true, size };
      });
    },
    async *readBlob(sha, range) {
      checked(sha);
      const file = blobFile(sha);
      if (!fs.existsSync(file)) throw new EvidenceError('not-found', 'no such blob');
      if (range && range.end < range.start) return;
      for await (const chunk of fs.createReadStream(file, range ? { start: range.start, end: range.end } : {})) yield chunk as Buffer;
    },
    async gc(keepRuns, now = Date.now()) {
      return serially(runDir, async () => {
        const runs = allRuns().map((r) => r.record);
        const { keep, drop } = gcPlan(runs, keepRuns, now);
        for (const r of drop) fs.rmSync(runFile(r.runId), { force: true });
        const referenced = new Set<string>();
        for (const r of keep) {
          const run = stored(runFile(r.runId));
          if (run) for (const sha of manifestBlobs(run.manifest)) referenced.add(sha);
        }
        let blobs = 0;
        if (fs.existsSync(blobDir)) {
          for (const dir of fs.readdirSync(blobDir)) {
            if (!/^[0-9a-f]{2}$/.test(dir)) continue;
            for (const name of fs.readdirSync(path.join(blobDir, dir))) {
              if (SHA256.test(name) && !referenced.has(name)) {
                fs.rmSync(path.join(blobDir, dir, name), { force: true });
                blobs += 1;
              }
            }
          }
        }
        if (fs.existsSync(partialDir)) {
          for (const name of fs.readdirSync(partialDir)) {
            const file = path.join(partialDir, name);
            if (now - fs.statSync(file).mtimeMs > 24 * 60 * 60 * 1000) {
              fs.rmSync(file, { force: true });
              if (SHA256.test(name)) blobs += 1;
            }
          }
        }
        return { runs: drop.map((r) => r.runId), blobs };
      });
    },
    async bytesUsed() {
      let total = 0;
      if (!fs.existsSync(blobDir)) return 0;
      for (const dir of fs.readdirSync(blobDir)) {
        if (!/^[0-9a-f]{2}$/.test(dir)) continue;
        const d = path.join(blobDir, dir);
        for (const name of fs.readdirSync(d)) total += fs.statSync(path.join(d, name)).size;
      }
      if (fs.existsSync(partialDir)) for (const name of fs.readdirSync(partialDir)) if (SHA256.test(name)) total += fs.statSync(path.join(partialDir, name)).size;
      return total;
    },
  };
  return store;
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
        digest: snapshotDigest(snapshot),
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
      if (!snapshot) return undefined;
      // Snapshots stored before digests existed get theirs on demand.
      return { record: record.digest ? record : { ...record, digest: snapshotDigest(snapshot) }, snapshot };
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

  const workspaceDir = path.join(dir, 'workspaces');
  const safeWorkspace = (name: string): string => {
    if (!WORKSPACE_NAME.test(name)) throw new Error(`invalid workspace name "${name}"`);
    return name;
  };
  const workspaces: WorkspaceStore = {
    async list() {
      if (!fs.existsSync(workspaceDir)) return [];
      return fs
        .readdirSync(workspaceDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson<WorkspaceDef | null>(path.join(workspaceDir, f), null))
        .filter((w): w is WorkspaceDef => Boolean(w))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    get: async (name) => (WORKSPACE_NAME.test(name) ? readJson<WorkspaceDef | undefined>(path.join(workspaceDir, `${safeWorkspace(name)}.json`), undefined) : undefined),
    put: (def) => serially(workspaceDir, () => writeFile(path.join(workspaceDir, `${safeWorkspace(def.name)}.json`), JSON.stringify(def, null, 2))),
  };

  const append = (file: string, value: unknown): Promise<void> =>
    serially(file, async () => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
    });

  return {
    kind: 'file',
    projects: {
      async list() {
        const d = path.join(dir, 'project-directory');
        return fs.existsSync(d) ? fs.readdirSync(d).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5)).filter(n => PROJECT_NAME.test(n)).sort() : [];
      },
      async create(name) { await writeFile(path.join(dir, 'project-directory', safeProject(name) + '.json'), JSON.stringify({ name })); },
    },
    snapshots,
    evidence: (project) => fileEvidence(projectDir(project)),
    plans: (project) => filePlanStore(path.join(projectDir(project), 'plans')),
    cache: (project) => fileContentCache(projectDir(project)),
    tokens,
    workspaces,
    audit: (entry: AuditEntry) => append(path.join(dir, 'audit.jsonl'), entry),
    usage: (row: UsageRow) => append(path.join(dir, 'usage.jsonl'), row),
    readAudit: async (limit = 200) => readLines<AuditEntry>(path.join(dir, 'audit.jsonl'), limit),
    readUsage: async (limit = 200) => readLines<UsageRow>(path.join(dir, 'usage.jsonl'), limit),
    close: async () => undefined,
  };
}
