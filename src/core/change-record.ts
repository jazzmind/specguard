/**
 * The change record: intent metadata for one spec-first change (`.specguard/changes/<id>.json`). It holds only what
 * a person or agent declares (kind, capabilities, why, base ref, linked plans). Every stage of the change is detected
 * from git, specs, test tags and run records, so editing the record cannot advance a stage. One file per change, so
 * two branches never touch the same file. Pure: no file is read here.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */
import { z } from 'zod/v4';

import type { Approval } from './approvals.js';
import type { ChangedClaim } from './change-claims.js';
import type { HistoryEntry } from './history.js';

export const CHANGE_KINDS = ['feature', 'refactor', 'spike'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const CHANGE_RECORD_VERSION = 1;

/** Repo-relative directory of change records. */
export const CHANGES_DIR = '.specguard/changes';

/** `YYYYMMDD-<slug>-<4 hex>`. The id is a file name, so nothing else is accepted. */
export const CHANGE_ID_PATTERN = /^\d{8}-[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{4}$/;

export interface ChangeRecord {
  version: 1;
  /** `YYYYMMDD-<slug>-<4 hex>`, e.g. 20261025-free-shipping-a1b2. Random suffix: parallel agents never collide. */
  id: string;
  kind: ChangeKind;
  /** Capability ids (not spec keys). At least one. */
  capabilities: string[];
  why?: string;
  /** ISO timestamp. */
  createdAt: string;
  /** git user.name (or SPECGUARD_ACTOR). */
  createdBy: string;
  /** Ref the base is computed from: merge-base(HEAD, baseRef). Stored as a ref, not a sha, so rebases keep it right. */
  baseRef: string;
  /** HEAD when started; informational. */
  startSha?: string;
  branch?: string;
  /** specs/history entry ids of approved plans linked to this change (history capture or --plan). */
  plans: string[];
  /** A spike converted to a feature keeps this trail. */
  convertedFrom?: { kind: 'spike'; at: string; by: string };
  /** After `closed` the record is immutable. */
  closed?: { at: string; by: string; reason: 'done' | 'abandoned'; note?: string; validatedAt?: string };
}

/** zod/v4 looseObject: unknown fields are kept, so a newer SpecGuard's additions survive an older one's read. */
export const ChangeRecordSchema: z.ZodType<ChangeRecord> = z.looseObject({
  version: z.literal(CHANGE_RECORD_VERSION),
  id: z.string().regex(CHANGE_ID_PATTERN, 'a change id is YYYYMMDD-<slug>-<4 hex>'),
  kind: z.enum(CHANGE_KINDS),
  capabilities: z.array(z.string().min(1)).min(1),
  why: z.string().optional(),
  createdAt: z.string(),
  createdBy: z.string(),
  baseRef: z.string().min(1),
  startSha: z.string().optional(),
  branch: z.string().optional(),
  plans: z.array(z.string()),
  convertedFrom: z.looseObject({ kind: z.literal('spike'), at: z.string(), by: z.string() }).optional(),
  closed: z
    .looseObject({
      at: z.string(),
      by: z.string(),
      reason: z.enum(['done', 'abandoned']),
      note: z.string().optional(),
      validatedAt: z.string().optional(),
    })
    .optional(),
});

/** `YYYYMMDD-<slug>-<4 hex>` from a date, the text the slug is made from, and a source of 4 hex characters. */
export function newChangeId(_date: Date, _slugSource: string, _random: () => string): string {
  throw new Error('not implemented: newChangeId');
}

export function parseChangeRecord(_text: string, _file: string): { ok: true; record: ChangeRecord } | { ok: false; error: string } {
  throw new Error('not implemented: parseChangeRecord');
}

/** Stable key order, 2-space JSON, trailing newline. Same input, same bytes. */
export function serializeChangeRecord(_r: ChangeRecord): string {
  throw new Error('not implemented: serializeChangeRecord');
}

/**
 * Plan-derived approvals (computed, never written): for a change whose `plans` are non-empty, every changed
 * non-removed ref of its capabilities gets `{ method: 'plan', by: plan.author, entry: plan.id }`. `plans` are the linked
 * history entries, already limited by the caller to those dated on or after the base commit.
 */
export function derivePlanApprovals(_record: ChangeRecord, _plans: HistoryEntry[], _changed: ChangedClaim[]): Approval[] {
  throw new Error('not implemented: derivePlanApprovals');
}
