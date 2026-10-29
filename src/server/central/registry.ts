/**
 * The team server's project registry: every project is the newest snapshot CI published for it, with plans and
 * generated documents kept in the backend.
 *
 * A snapshot is written out to a temporary directory so the same document and history code that serves a working
 * tree serves it. The trace model comes from the snapshot, because the server has no source files to compute one.
 *
 * Spec: specs/capabilities/team-server.md
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Snapshot } from '../../core/snapshot.js';
import type { PlanStore } from '../../core/state/plan-store.js';
import type { TraceModel } from '../../core/trace.js';
import type { LlmConfig, SpecGuardConfig } from '../../core/types.js';
import { UNRESOLVED, type RemediationPlan } from '../../core/remediation-schema.js';
import { PROJECT_NAME, type Backend, type SnapshotRecord } from './backend.js';
import { localProject } from '../project.js';
import type { ProjectInfo, ProjectRegistry, ProjectSource, PublishResult } from '../project.js';

export interface CentralRegistryOptions {
  backend: Backend;
  /** The model that writes documents, usually a gateway alias. */
  llm: LlmConfig;
  /** Where snapshots are written out to be read. Default: a temp directory. */
  workDir?: string;
  /** Snapshots kept per project. Default 20. */
  keep?: number;
}

export interface CentralRegistry extends ProjectRegistry {
  /** Accept a snapshot: store it, merge its plan into the project's plans, and make it the one shown. */
  publish(snapshot: Snapshot): Promise<PublishResult>;
}

/** Write the snapshot's files out and describe them as a config the document code can read. */
export function materialize(snapshot: Snapshot, rootDir: string, llm: LlmConfig): SpecGuardConfig {
  fs.rmSync(rootDir, { recursive: true, force: true });
  for (const [file, text] of Object.entries(snapshot.files)) {
    const target = path.join(rootDir, file);
    // The snapshot was validated, but a path must never leave the directory it is written to.
    if (!path.resolve(target).startsWith(path.resolve(rootDir) + path.sep)) throw new Error(`refusing to write ${file} outside the project directory`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  if (snapshot.contracts) {
    fs.mkdirSync(path.join(rootDir, '.specguard'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, '.specguard', 'contracts.json'), JSON.stringify(snapshot.contracts));
  }
  return {
    rootDir,
    apps: [{ name: 'app', repo: '.', specDir: snapshot.specsRoot, sources: {}, framework: 'vitest', testOutput: 'tests/' }],
    paths: { specsRoot: snapshot.specsRoot },
    llm,
    server: { project: snapshot.project },
  } as SpecGuardConfig;
}

/**
 * The plan to store when a snapshot brings one. The server is where trackers change statuses, so for an item both
 * sides know, whichever has recorded more status changes wins. An item someone marked fixed that the new scan reports
 * again is open again. Unresolved items the server holds that the new plan lacks are kept as they are, because a scan
 * that never saw the old plan cannot say they were fixed; when the new plan was made from the stored one, its
 * omissions are real closures and are not carried.
 */
export function mergePublishedPlan(stored: RemediationPlan | null, published: RemediationPlan, now: string): RemediationPlan {
  if (!stored) return published;
  const mineByFingerprint = new Map(stored.items.map((i) => [i.fingerprint, i]));
  const seen = new Set<string>();
  const items = published.items.map((item) => {
    seen.add(item.fingerprint);
    const mine = mineByFingerprint.get(item.fingerprint);
    if (!mine || mine.statusHistory.length <= item.statusHistory.length) return item;
    const reopen = mine.status === 'fixed' || mine.status === 'verified';
    return {
      ...item,
      id: mine.id,
      status: reopen ? ('open' as const) : mine.status,
      statusHistory: reopen ? [...mine.statusHistory, { status: 'open' as const, at: now, by: 'specguard', note: `detected again after it was marked ${mine.status}` }] : mine.statusHistory,
      externalRef: mine.externalRef ?? item.externalRef,
    };
  });
  const carried = published.previous === stored.id ? [] : stored.items.filter((i) => !seen.has(i.fingerprint) && UNRESOLVED.includes(i.status));
  return { ...published, previous: stored.id, items: [...items, ...carried] };
}

export function centralRegistry(opts: CentralRegistryOptions): CentralRegistry {
  const { backend, llm } = opts;
  const workDir = opts.workDir ?? path.join(os.tmpdir(), 'specguard-server');
  const keep = opts.keep ?? 20;
  const loaded = new Map<string, { id: string; source: ProjectSource }>();

  const sourceFor = (record: SnapshotRecord, snapshot: Snapshot): ProjectSource => {
    const config = materialize(snapshot, path.join(workDir, record.project, record.id), llm);
    const plans: PlanStore = backend.plans(record.project);
    return {
      name: record.project,
      config,
      trace: async () => snapshot.trace as unknown as TraceModel,
      plans,
      cache: backend.cache(record.project),
    };
  };

  const infoOf = (r: SnapshotRecord): ProjectInfo => ({ name: r.project, kind: 'snapshot', ...(r.commit ? { commit: r.commit } : {}), ...(r.branch ? { branch: r.branch } : {}), updatedAt: r.createdAt });

  return {
    writable: true,
    workspaces: backend.workspaces,
    create: (name) => backend.projects.create(name),
    list: async () => {
      const published = (await backend.snapshots.projects()).map(infoOf);
      const names = new Set(published.map(p => p.name));
      return [...published, ...(await backend.projects.list()).filter(n => !names.has(n)).map(name => ({ name, kind: 'pending' as const }))].sort((a,b) => a.name.localeCompare(b.name));
    },
    async get(name) {
      if (!PROJECT_NAME.test(name)) return undefined;
      const latest = await backend.snapshots.latest(name);
      if (!latest) {
        if (!(await backend.projects.list()).includes(name)) return undefined;
        const rootDir = path.join(workDir, name, 'pending');
        fs.mkdirSync(rootDir, { recursive: true });
        return localProject({ rootDir, apps: [], paths: { specsRoot: 'specs' }, llm, server: { project: name } } as unknown as SpecGuardConfig);
      }
      const hit = loaded.get(name);
      if (hit?.id === latest.record.id) return hit.source;
      const source = sourceFor(latest.record, latest.snapshot);
      loaded.set(name, { id: latest.record.id, source });
      if (hit) fs.rmSync(path.join(workDir, name, hit.id), { recursive: true, force: true });
      return source;
    },
    async publish(snapshot) {
      const record = await backend.snapshots.put(snapshot);
      if (snapshot.plans[0]) {
        const plans = backend.plans(snapshot.project);
        const incoming = snapshot.plans[0];
        const stored = await plans.read(incoming.id);
        const latestStored = stored ?? (await plans.read('latest'));
        const merged = mergePublishedPlan(latestStored, incoming, new Date().toISOString());
        await plans.write(merged);
      }
      await backend.snapshots.prune(snapshot.project, keep);
      return { project: record.project, snapshotId: record.id, ...(record.commit ? { commit: record.commit } : {}), ...(record.branch ? { branch: record.branch } : {}) };
    },
  };
}
