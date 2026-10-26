/**
 * A snapshot is everything a team server needs to show one commit of a project: the spec and history files, the
 * trace model computed where the code was, the proof rows, and the newest remediation plan. CI builds it with
 * `specguard publish`; the server reads only snapshots, never anyone's working tree.
 *
 * Spec: specs/capabilities/team-server.md
 */
import { z } from 'zod/v4';

import { RemediationPlanSchema } from './remediation-schema.js';

export const SNAPSHOT_VERSION = 1;

/** Largest snapshot the server accepts, in bytes. */
export const MAX_SNAPSHOT_BYTES = 25 * 1024 * 1024;

const ProofRowSchema = z.looseObject({
  claim: z.string(),
  verdict: z.enum(['proven', 'failed', 'unexercised', 'error']),
  runId: z.string(),
  specHash: z.string(),
  ingestedAt: z.string(),
});

const TraceClaimSchema = z.looseObject({ id: z.string(), ref: z.string(), text: z.string(), proof: z.string() });

const TraceNodeSchema = z.looseObject({
  id: z.string(),
  specKey: z.string(),
  kind: z.string(),
  title: z.string(),
  ownedFiles: z.array(z.string()),
  tests: z.array(z.string()),
  claims: z.array(TraceClaimSchema),
});

const TraceSchema = z.looseObject({
  version: z.literal(1),
  generated: z.string(),
  nodes: z.array(TraceNodeSchema),
  unowned: z.array(z.string()),
  issues: z.array(z.looseObject({})),
  totals: z.looseObject({ claims: z.number(), sourceFiles: z.number() }),
});

/** A repo-relative POSIX path to a markdown file: no `..`, no absolute paths, no backslashes. */
function isSafeMarkdownPath(file: string): boolean {
  return file.endsWith('.md') && !file.startsWith('/') && !file.includes('\\') && !file.split('/').some((part) => part === '..' || part === '' || part === '.');
}

export const SnapshotSchema = z
  .looseObject({
    version: z.literal(SNAPSHOT_VERSION),
    /** Name of the project on the server. */
    project: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i, 'a project name is letters, digits, dots, dashes and underscores'),
    repo: z.string().optional(),
    branch: z.string().optional(),
    commit: z.string().optional(),
    createdAt: z.string(),
    engineVersion: z.string(),
    hashVersion: z.number().int(),
    origin: z.enum(['local', 'ci', 'server']),
    /** Directory of the spec tree, relative to the repo root (for example `specs`). */
    specsRoot: z.string().regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/),
    /** Spec and history markdown, by repo-relative path. */
    files: z.record(z.string(), z.string()),
    trace: TraceSchema,
    /** Proof rows by claim ref. */
    ledger: z.record(z.string(), ProofRowSchema),
    /** Where the proof rows came from: the local cache, a CI proof note, or both. Absent on older snapshots. */
    proofSource: z.looseObject({ kind: z.enum(['note', 'local', 'mixed']), noteCommit: z.string().optional(), verified: z.string().optional() }).optional(),
    /** Newest remediation plan, when there is one. */
    plans: z.array(RemediationPlanSchema),
    contracts: z.looseObject({ nodes: z.array(z.looseObject({})), edges: z.array(z.looseObject({})) }).optional(),
  })
  .superRefine((snap, ctx) => {
    for (const file of Object.keys(snap.files)) {
      if (!isSafeMarkdownPath(file) || !(file === `${snap.specsRoot}/` || file.startsWith(`${snap.specsRoot}/`))) {
        ctx.addIssue({ code: 'custom', path: ['files', file], message: `${file}: files must be markdown under ${snap.specsRoot}/, with no .. or absolute paths` });
      }
    }
  });

export type Snapshot = z.infer<typeof SnapshotSchema>;

export type SnapshotParse = { ok: true; snapshot: Snapshot } | { ok: false; error: string };

/** Parse and validate a snapshot from JSON text. Never throws. */
export function parseSnapshot(text: string): SnapshotParse {
  if (Buffer.byteLength(text) > MAX_SNAPSHOT_BYTES) return { ok: false, error: `snapshot is larger than ${MAX_SNAPSHOT_BYTES} bytes` };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'snapshot is not valid JSON' };
  }
  const parsed = SnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `snapshot is invalid at ${issue.path.join('.') || '(root)'}: ${issue.message}` };
  }
  return { ok: true, snapshot: parsed.data };
}
