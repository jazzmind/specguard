/**
 * The contract between `specguard publish`, a team server and the VS Code extension for publish status and test evidence.
 * Types and zod schemas only; the behaviour lives in the pipelines, the server and the extension.
 *
 * Spec: specs/capabilities/team-server.md
 */
import { z } from 'zod/v4';

/** Feature names a server lists in `/health` `features`. A client checks for them before relying on a route. */
export const SERVER_FEATURES = { publishState: 'publish-state', evidence: 'evidence' } as const;

export const DEFAULT_LIMITS = {
  /** Largest single evidence file, bytes. */
  maxFileBytes: 100 * 1024 * 1024,
  /** Largest evidence total of one run, bytes. */
  maxRunBytes: 1024 * 1024 * 1024,
  /** Largest body of one blob PUT. The proxy in front of the server rejects bodies near 1 MB. */
  chunkBytes: 768 * 1024,
  /** Runs kept per project; older runs and blobs no kept run refers to are pruned. */
  keepRuns: 5,
} as const;

export const SERVER_LIMITS_SCHEMA = z.object({
  maxFileBytes: z.number().int().positive(),
  maxRunBytes: z.number().int().positive(),
  chunkBytes: z.number().int().positive(),
  keepRuns: z.number().int().positive(),
});
export type ServerLimits = z.infer<typeof SERVER_LIMITS_SCHEMA>;

/** Hex sha256 (64 characters). */
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------
// Snapshot digest: what makes two snapshots "the same" for the needs-publish check
// ---------------------------------------------------------------------------

export const SNAPSHOT_DIGEST_SECTIONS = ['specs', 'trace', 'ledger', 'plans', 'contracts'] as const;
export type SnapshotDigestSection = (typeof SNAPSHOT_DIGEST_SECTIONS)[number];

export const SnapshotDigestSchema = z.object({
  v: z.literal(1),
  /** One hash over every section. Equal totals mean nothing differs. */
  total: z.string(),
  /** A hash per section, so a check can say what changed. */
  sections: z.record(z.enum(SNAPSHOT_DIGEST_SECTIONS), z.string()),
  /** Per spec or history file: the first 12 hex characters of its sha256. */
  files: z.record(z.string(), z.string()),
});
export type SnapshotDigest = z.infer<typeof SnapshotDigestSchema>;

// ---------------------------------------------------------------------------
// Run manifest: one recorded test run, published with the report data and its evidence files
// ---------------------------------------------------------------------------

export const RUN_MANIFEST_SCHEMA = 'specguard-run/1';

export const EvidenceFileSchema = z.object({
  sha256: Sha256,
  size: z.number().int().nonnegative(),
  contentType: z.string(),
  kind: z.enum(['image', 'video', 'trace', 'file']),
});
export type EvidenceFile = z.infer<typeof EvidenceFileSchema>;

export const RunManifestSchema = z.object({
  schema: z.literal(RUN_MANIFEST_SCHEMA),
  project: z.string(),
  runId: z.string().min(1).max(200),
  label: z.string().optional(),
  ingestedAt: z.string(),
  /** Digest of the snapshot the report was built against (specs can change under an old run). */
  digest: SnapshotDigestSchema,
  /** The run index (`.specguard/runs/<id>.json`), paths made repo-relative and secrets redacted. */
  index: z.looseObject({ runId: z.string(), tests: z.array(z.looseObject({})), claims: z.array(z.looseObject({})) }),
  /** The report data (`ReportData` from `src/pipelines/report.ts`); the server renders it, it never rebuilds it. */
  report: z.looseObject({ schema: z.literal('specguard-report/1') }),
  /** Evidence by path relative to the report's `evidence/` folder (the same string the report's hrefs use). */
  files: z.record(z.string(), EvidenceFileSchema),
  /** Evidence that was left out, and why. */
  omitted: z.array(z.object({ path: z.string(), reason: z.enum(['too-large', 'missing']) })),
});
export type RunManifest = z.infer<typeof RunManifestSchema>;

export const RunRecordSchema = z.object({
  runId: z.string(),
  label: z.string().optional(),
  ingestedAt: z.string(),
  status: z.enum(['pending', 'complete']),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

/** `POST /projects/:p/runs` answer. */
export const RunOfferSchema = z.object({
  runId: z.string(),
  status: z.enum(['pending', 'complete']),
  /** sha256 of the evidence blobs the server does not have yet (empty: the run can be committed). */
  missing: z.array(Sha256),
  chunkBytes: z.number().int().positive(),
});
export type RunOffer = z.infer<typeof RunOfferSchema>;

/** `GET /projects/:p/publish-state` answer. */
export const PublishStateSchema = z.object({
  project: z.string(),
  caller: z.object({ user: z.string(), role: z.string(), project: z.string().optional() }),
  snapshot: z.object({ id: z.string(), createdAt: z.string(), commit: z.string().optional(), branch: z.string().optional(), digest: SnapshotDigestSchema.nullable() }).nullable(),
  runs: z.array(RunRecordSchema),
  limits: SERVER_LIMITS_SCHEMA,
  features: z.array(z.string()),
});
export type PublishState = z.infer<typeof PublishStateSchema>;

// ---------------------------------------------------------------------------
// Publish check: what `publish --check --json` and `workspace publish --check --json` print
// ---------------------------------------------------------------------------

export const PUBLISH_CHECK_SCHEMA = 'specguard-publish-check/1';
export const WORKSPACE_PUBLISH_CHECK_SCHEMA = 'specguard-workspace-publish-check/1';

export const PUBLISH_REASONS = ['never-published', 'specs-changed', 'trace-changed', 'proofs-changed', 'plans-changed', 'contracts-changed', 'new-run', 'run-evidence-incomplete', 'server-cannot-compare'] as const;
export type PublishReason = (typeof PUBLISH_REASONS)[number];

export interface PublishCheck {
  schema: typeof PUBLISH_CHECK_SCHEMA;
  project: string;
  /** Repo key when run for a workspace member. */
  key?: string;
  server: { url: string; reachable: boolean; signedIn: boolean; role?: string; features: string[] };
  local: { digest: SnapshotDigest; commit?: string; branch?: string; latestRun?: { runId: string; files: number; bytes: number } };
  remote: { snapshotId: string; createdAt: string; digest: SnapshotDigest | null; commit?: string; latestRun?: RunRecord } | null;
  needsPublish: boolean;
  /** False when the server could not compare digests (an older server), so only commits were compared. */
  exact: boolean;
  reasons: PublishReason[];
  specFiles: { added: string[]; removed: string[]; modified: string[] };
  commitDiffers: boolean;
  /** Set when the check itself failed (no server configured, unreachable, not signed in). */
  error?: string;
}

export interface WorkspacePublishCheck {
  schema: typeof WORKSPACE_PUBLISH_CHECK_SCHEMA;
  workspace: string;
  server: { url: string; reachable: boolean; signedIn: boolean; role?: string; features: string[] };
  definition: { needsPublish: boolean; reasons: Array<'missing' | 'projects-differ'> };
  repos: Array<PublishCheck | { key: string; error: string }>;
}

/** One NDJSON line on stderr while a publish uploads (`--progress-json`). */
export interface PublishProgress {
  sg: 'progress';
  key?: string;
  phase: 'hash' | 'upload' | 'commit';
  done: number;
  total: number;
  bytes: number;
}
