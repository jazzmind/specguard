/**
 * Where a team server keeps its state, behind interfaces so a single machine can use files and the sandbox can use
 * Postgres. Both pass the same contract tests.
 *
 * Spec: specs/capabilities/team-server.md
 */
import type { ContentCache } from '../../core/state/content-cache.js';
import type { PlanStore } from '../../core/state/plan-store.js';
import type { Snapshot } from '../../core/snapshot.js';
import type { RunManifest, RunRecord, SnapshotDigest } from '../../core/publish-contract.js';

export interface SnapshotRecord {
  id: string;
  project: string;
  branch?: string;
  commit?: string;
  createdAt: string;
  origin: 'local' | 'ci' | 'server';
  bytes: number;
  /** What the content hashes to, computed by the server on put (never taken from a client); computed on demand for older snapshots. */
  digest?: SnapshotDigest;
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
  /** Published test runs and their evidence blobs, per project. */
  evidence(project: string): EvidenceStore;
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

// ---------------------------------------------------------------------------
// Test evidence: published runs and their blobs, per project
// ---------------------------------------------------------------------------

/** A run as listed: the contract's `RunRecord` plus what a list needs without loading the manifest. */
export interface RunListing extends RunRecord {
  /** `digest.total` of the snapshot the run was built against. */
  digest: string;
  tests?: { total: number; pass: number; fail: number; skip: number };
}

export interface StoredRun {
  record: RunListing;
  manifest: RunManifest;
}

export interface BlobState {
  /** The declared total size. */
  size: number;
  /** Bytes held so far (equals `size` once complete). */
  received: number;
  complete: boolean;
}

export class EvidenceError extends Error {
  constructor(
    readonly code: 'offset-mismatch' | 'overflow' | 'not-found',
    message: string,
    readonly expectedOffset?: number,
  ) {
    super(message);
  }
}

/** Evidence of one project: runs and content-addressed blobs. Blobs are never shared between projects. */
export interface EvidenceStore {
  /** Keep a run (replacing one with the same run id). The record's `createdAt` is kept when the digest is unchanged. */
  putRun(manifest: RunManifest, status: 'pending' | 'complete'): Promise<RunListing>;
  /** A run by id, or `latest` for the newest complete one. */
  getRun(id: string): Promise<StoredRun | undefined>;
  /** Newest first. */
  listRuns(): Promise<RunListing[]>;
  deleteRun(id: string): Promise<boolean>;
  blobState(sha256: string): Promise<BlobState | undefined>;
  /** Append bytes at `offset` (it must equal what is held). Throws `EvidenceError` `offset-mismatch` (with `expectedOffset`) or `overflow`. Returns bytes held. */
  appendChunk(sha256: string, offset: number, total: number, data: Buffer): Promise<number>;
  /** Check a fully received blob against its name. On a mismatch the partial is discarded and `ok` is false. */
  finalizeBlob(sha256: string): Promise<{ ok: boolean; size: number }>;
  /** Bytes `start`..`end` inclusive (all when absent) of a complete blob. */
  readBlob(sha256: string, range?: { start: number; end: number }): AsyncIterable<Buffer>;
  /** Keep the newest `keepRuns` complete runs (and pending ones under a day old); delete the rest, blobs no kept run refers to, and partial uploads over a day old. */
  gc(keepRuns: number, now?: number): Promise<{ runs: string[]; blobs: number }>;
  bytesUsed(): Promise<number>;
}

export const PARTIAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The record a manifest makes. */
export function runListingOf(manifest: RunManifest, status: 'pending' | 'complete', createdAt: string): RunListing {
  const unique = new Map<string, number>();
  for (const f of Object.values(manifest.files)) unique.set(f.sha256, f.size);
  const totals = (manifest.report as { totals?: { tests?: { total?: number; pass?: number; fail?: number; skip?: number } } }).totals?.tests;
  return {
    runId: manifest.runId,
    ...(manifest.label ? { label: manifest.label } : {}),
    ingestedAt: manifest.ingestedAt,
    status,
    files: Object.keys(manifest.files).length,
    bytes: [...unique.values()].reduce((a, b) => a + b, 0),
    createdAt,
    digest: manifest.digest.total,
    ...(totals ? { tests: { total: Number(totals.total ?? 0), pass: Number(totals.pass ?? 0), fail: Number(totals.fail ?? 0), skip: Number(totals.skip ?? 0) } } : {}),
  };
}

/** Newest first: by when the run was ingested, then when the server got it. */
export function newestFirst(a: RunListing, b: RunListing): number {
  return b.ingestedAt.localeCompare(a.ingestedAt) || b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId);
}

/** The sha256 of every blob a manifest refers to. */
export function manifestBlobs(manifest: RunManifest): Set<string> {
  return new Set(Object.values(manifest.files).map((f) => f.sha256));
}

/** Which runs `gc` keeps: the newest `keepRuns` complete ones, and pending ones that are not stale. */
export function gcPlan(runs: RunListing[], keepRuns: number, now: number): { keep: RunListing[]; drop: RunListing[] } {
  const complete = runs.filter((r) => r.status === 'complete').sort(newestFirst);
  const keep = complete.slice(0, Math.max(1, keepRuns));
  const drop = complete.slice(keep.length);
  for (const r of runs) {
    if (r.status !== 'pending') continue;
    (now - Date.parse(r.createdAt) > PARTIAL_MAX_AGE_MS ? drop : keep).push(r);
  }
  return { keep, drop };
}

/** Project names are used in paths and URLs. */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
