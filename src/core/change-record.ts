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

import { shortHash, type Approval } from './approvals.js';
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

const SLUG_MAX = 40;

/** Lower-case words joined by hyphens, at most {@link SLUG_MAX} characters, never empty. */
function slugOf(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return slug || 'change';
}

/**
 * `YYYYMMDD-<slug>-<4 hex>` from a date (UTC), the text the slug is made from, and a source of 4 hex characters.
 * Throws when the date is invalid or `random()` does not give 4 hex characters: an id is a file name, so it is never
 * repaired silently.
 */
export function newChangeId(date: Date, slugSource: string, random: () => string): string {
  if (Number.isNaN(date.getTime())) throw new Error('newChangeId: invalid date');
  const suffix = random().toLowerCase();
  if (!/^[0-9a-f]{4}$/.test(suffix)) throw new Error(`newChangeId: random() must give 4 hex characters, got "${suffix}"`);
  const day = date.toISOString().slice(0, 10).replace(/-/g, '');
  return `${day}-${slugOf(slugSource)}-${suffix}`;
}

export function parseChangeRecord(text: string, file: string): { ok: true; record: ChangeRecord } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `${file}: not valid JSON (${(err as Error).message})` };
  }
  const parsed = ChangeRecordSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(record)'}: ${i.message}`).join('; ');
    return { ok: false, error: `${file}: not a change record (${detail})` };
  }
  return { ok: true, record: parsed.data };
}

/** Known keys, in the order a person reads them. Anything else a newer SpecGuard added follows, sorted. */
const RECORD_KEYS = ['version', 'id', 'kind', 'capabilities', 'why', 'createdAt', 'createdBy', 'baseRef', 'startSha', 'branch', 'plans', 'convertedFrom', 'closed'];
const CONVERTED_KEYS = ['kind', 'at', 'by'];
const CLOSED_KEYS = ['at', 'by', 'reason', 'note', 'validatedAt'];

/** Plain-data copy with every object's keys sorted, `undefined` dropped. */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') return ordered(value as Record<string, unknown>, []);
  return value;
}

function ordered(obj: Record<string, unknown>, first: string[], nested: Record<string, string[]> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const put = (key: string): void => {
    const v = obj[key];
    if (v === undefined) return;
    out[key] = nested[key] && v && typeof v === 'object' && !Array.isArray(v) ? ordered(v as Record<string, unknown>, nested[key]) : sortDeep(v);
  };
  for (const key of first) put(key);
  for (const key of Object.keys(obj).filter((k) => !first.includes(k)).sort()) put(key);
  return out;
}

/** Stable key order, 2-space JSON, trailing newline. Same input, same bytes. */
export function serializeChangeRecord(r: ChangeRecord): string {
  const body = ordered(r as unknown as Record<string, unknown>, RECORD_KEYS, { convertedFrom: CONVERTED_KEYS, closed: CLOSED_KEYS });
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Plan-derived approvals (computed, never written): for a change whose `plans` are non-empty, every changed
 * non-removed ref of its capabilities gets `{ method: 'plan', by: plan.author, entry: plan.id }`. `plans` are the linked
 * history entries, already limited by the caller to those dated on or after the base commit.
 *
 * With several plans the newest speaks for every ref (later date, then later id), so each ref gets one approval. A
 * ref with no current hash cannot be approved at a hash and is skipped.
 */
export function derivePlanApprovals(record: ChangeRecord, plans: HistoryEntry[], changed: ChangedClaim[]): Approval[] {
  if (record.plans.length === 0 || plans.length === 0) return [];
  const plan = [...plans].sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.date < b.date ? -1 : 1)).at(-1)!;
  const caps = new Set(record.capabilities);
  const out: Approval[] = [];
  for (const c of changed) {
    if (c.change === 'removed' || !c.hash || !caps.has(c.capability)) continue;
    out.push({ claim: c.ref, hash: shortHash(c.hash), method: 'plan', by: plan.author ?? 'unknown', date: plan.date, entry: plan.id });
  }
  return out;
}
