/**
 * What the API serves, one project at a time. A project is the specs, the trace over them, the history, the
 * remediation plans and a place to cache generated documents. The local `serve` has one project, read live
 * from the working tree; a team server has many, read from the snapshots CI published.
 *
 * Spec: specs/capabilities/documentation-api.md
 */
import path from 'node:path';

import type { LedgerStore } from '../core/state/ledger-store.js';
import { fileContentCache, type ContentCache } from '../core/state/content-cache.js';
import type { Snapshot } from '../core/snapshot.js';
import type { PlanStore } from '../core/state/plan-store.js';
import type { TraceModel } from '../core/trace.js';
import type { SpecGuardConfig } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import type { WorkspaceManifest } from '../core/workspace.js';
import { loadTrace } from '../pipelines/check.js';
import { planStoreFor } from '../pipelines/security-plan.js';

export interface ProjectSource {
  name: string;
  /**
   * The project's config. Its `rootDir` holds the spec files (and history) that documents are written from, and
   * `llm` says which model writes them.
   */
  config: SpecGuardConfig;
  /** The trace model: system, capabilities, claims, tests, proofs. */
  trace(): Promise<TraceModel>;
  plans: PlanStore;
  cache: ContentCache;
  /** Where the project's proofs live, when this source can accept new ones. */
  ledger?: LedgerStore;
}

export interface ProjectInfo {
  name: string;
  /** Where the data came from: `working-tree` (local serve) or `snapshot` (team server). */
  kind: 'working-tree' | 'snapshot';
  /** Commit and branch of the data, for snapshot projects. */
  commit?: string;
  branch?: string;
  updatedAt?: string;
}

export interface PublishResult {
  project: string;
  snapshotId: string;
  commit?: string;
  branch?: string;
}

export interface ProjectRegistry {
  /** The project that unprefixed `/api/v1/...` routes mean. Absent on a server with many projects. */
  defaultProject?: string;
  /** Whether this registry accepts writes (snapshots, proofs, plan status). A local serve does not. */
  writable: boolean;
  list(): Promise<ProjectInfo[]>;
  get(name: string): Promise<ProjectSource | undefined>;
  /** Accept a snapshot for a project, creating the project on first publish. Only a writable registry has it. */
  publish?(snapshot: Snapshot): Promise<PublishResult>;
  /** Named sets of projects shown together. Only a server that keeps them has it. */
  workspaces?: import('./central/backend.js').WorkspaceStore;
}

/** A trace is cheap but not free; repeated requests within this window share one. */
const TRACE_TTL_MS = 3000;

/** The working tree of one repo, read live. */
export function localProject(config: SpecGuardConfig): ProjectSource {
  const root = config.rootDir ?? process.cwd();
  let cached: { at: number; model: TraceModel } | undefined;
  return {
    name: config.server?.project ?? path.basename(root),
    config,
    async trace() {
      const now = Date.now();
      if (cached && now - cached.at < TRACE_TTL_MS) return cached.model;
      const { model } = await loadTrace(config);
      cached = { at: now, model };
      return model;
    },
    plans: planStoreFor(config),
    cache: fileContentCache(root),
  };
}

/** A registry holding just the local project. */
export function localRegistry(config: SpecGuardConfig): ProjectRegistry {
  const project = localProject(config);
  return {
    defaultProject: project.name,
    writable: false,
    list: async () => [{ name: project.name, kind: 'working-tree' }],
    get: async (name) => (name === project.name ? project : undefined),
  };
}

/**
 * A registry holding every active repo of a workspace as its own project, read live. Ignored repos,
 * and repos with no SpecGuard config, are not projects. There is no default project: routes name one.
 */
export async function workspaceRegistry(manifest: WorkspaceManifest): Promise<ProjectRegistry> {
  const projects = new Map<string, ProjectSource>();
  for (const [key, repo] of Object.entries(manifest.repos)) {
    try {
      const config = await loadConfig(path.resolve(manifest.rootDir, repo.path));
      projects.set(key, { ...localProject(config), name: key });
    } catch {
      /* not a SpecGuard repo: it is in the rollup as `no-config` and has no project of its own */
    }
  }
  return {
    writable: false,
    list: async () => [...projects.keys()].map((name) => ({ name, kind: 'working-tree' as const })),
    get: async (name) => projects.get(name),
  };
}
