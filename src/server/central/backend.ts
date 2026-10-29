/**
 * Where a team server keeps its state, behind interfaces so a single machine can use files and the sandbox can use
 * Postgres. Both pass the same contract tests.
 *
 * Spec: specs/capabilities/team-server.md
 */
import type { ContentCache } from '../../core/state/content-cache.js';
import type { PlanStore } from '../../core/state/plan-store.js';
import type { Snapshot } from '../../core/snapshot.js';

export interface SnapshotRecord {
  id: string;
  project: string;
  branch?: string;
  commit?: string;
  createdAt: string;
  origin: 'local' | 'ci' | 'server';
  bytes: number;
}

export interface SnapshotStore {
  /** Keep a snapshot. Returns its record. */
  put(snapshot: Snapshot): Promise<SnapshotRecord>;
  /**
   * The snapshot a project is shown from: the newest one on the default branch (`main`, else `master`), else the
   * newest of any branch. Undefined for an unknown project.
   */
  latest(project: string): Promise<{ record: SnapshotRecord; snapshot: Snapshot } | undefined>;
  /** Every project with its newest snapshot's record. */
  projects(): Promise<SnapshotRecord[]>;
  /** Whether a snapshot for this exact commit and branch is already stored (the artifact puller skips what it has). */
  has(project: string, commit: string, branch?: string): Promise<boolean>;
  /** Keep the newest `keep` snapshots of a project; returns how many were removed. */
  prune(project: string, keep: number): Promise<number>;
}

/** A named set of projects the server shows together: the combined view of a system that spans repositories. */
export interface WorkspaceDef {
  name: string;
  description?: string;
  projects: Array<{ project: string; /** The repo's key in the workspace manifest. */ key?: string; role?: string; /** Listed, but left out of the totals. */ ignore?: boolean }>;
  updatedAt: string;
  updatedBy: string;
}

export interface WorkspaceStore {
  list(): Promise<WorkspaceDef[]>;
  get(name: string): Promise<WorkspaceDef | undefined>;
  /** Create or replace a workspace. */
  put(def: WorkspaceDef): Promise<void>;
}

/** Workspace names are used in paths and URLs. */
export const WORKSPACE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export type TokenRole = 'viewer' | 'maintainer' | 'admin';

export interface TokenRecord {
  id: string;
  /** Who it belongs to (an email), or `ci:<project>` for a project's CI token. */
  owner: string;
  name: string;
  role: TokenRole;
  /** A token limited to one project; absent means every project. */
  project?: string;
  /** SHA-256 of the token. The token itself is shown once and never stored. */
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

export interface TokenStore {
  create(record: TokenRecord): Promise<void>;
  findByHash(hash: string): Promise<TokenRecord | undefined>;
  list(owner: string): Promise<TokenRecord[]>;
  /** Revoke a token the owner holds (an admin may pass `owner: undefined`). Returns whether one was revoked. */
  revoke(id: string, owner: string | undefined): Promise<boolean>;
  touch(id: string): Promise<void>;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  project?: string;
  detail?: string;
}

export interface UsageRow {
  at: string;
  user?: string;
  project?: string;
  pipeline: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export interface Backend {
  readonly kind: 'file' | 'postgres';
  projects: { list(): Promise<string[]>; create(name: string): Promise<void> };
  snapshots: SnapshotStore;
  /** Plans are per project. */
  plans(project: string): PlanStore;
  /** Cache for generated documents, per project. */
  cache(project: string): ContentCache;
  tokens: TokenStore;
  workspaces: WorkspaceStore;
  audit(entry: AuditEntry): Promise<void>;
  usage(row: UsageRow): Promise<void>;
  /** Everything recorded so far, newest last. For admin reports and tests. */
  readAudit(limit?: number): Promise<AuditEntry[]>;
  readUsage(limit?: number): Promise<UsageRow[]>;
  close(): Promise<void>;
}

/** Project names are used in paths and URLs. */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
