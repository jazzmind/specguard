/**
 * Intent approvals: a person agrees that a requirement, at its exact wording,
 * states what the system should do.
 *
 * An approval is a committed history entry (`kind: approval`), one file per
 * approval event so branches never conflict. It names each approved claim with
 * the claim's hash, so editing a claim's text makes it unapproved again.
 * Pure: reads nothing from disk.
 *
 * Spec: specs/capabilities/intent-approval.md
 */
import { formatClaimRef, parseClaimRef } from './claims.js';
import type { HistoryEntry } from './history.js';

/** How an approval was given: `command` (`spec approve`), `as-built` (accepting what exists), `pr` (a pull request review) or `plan` (an approved plan). */
export type ApprovalMethod = 'command' | 'as-built' | 'pr' | 'plan';

export const APPROVAL_METHODS: readonly ApprovalMethod[] = ['command', 'as-built', 'pr', 'plan'];

/** One claim approved at one wording, by one person, in one history entry. */
export interface Approval {
  /** Local ref, `specKey#claimId` or, for an example row, `specKey#claimId/rowId`. */
  claim: string;
  /** First 16 hex characters of the claim hash (for a row, the row hash) the approver saw. */
  hash: string;
  method: ApprovalMethod;
  by: string;
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  /** Id of the history entry that records the approval. */
  entry: string;
}

const SHORT_HASH = 16;

/** The prefix of a claim hash stored in approvals. */
export function shortHash(full: string): string {
  return full.slice(0, SHORT_HASH);
}

/** `ref@<16 hex>`: the form an approval takes in an entry's `approves` list. `ref` may name an example row (`specKey#claim/row`). */
export function formatApproved(ref: string, claimHash: string): string {
  return `${ref}@${shortHash(claimHash)}`;
}

/** Inverse of {@link formatApproved}; null for a malformed or repo-prefixed ref or a hash that is not 16 hex characters. */
export function parseApproved(s: string): { ref: string; hash: string } | null {
  const at = s.lastIndexOf('@');
  if (at <= 0) return null;
  const ref = s.slice(0, at).trim();
  const hash = s.slice(at + 1).trim().toLowerCase();
  const parsed = parseClaimRef(ref);
  if (!parsed || parsed.repo || !/^[0-9a-f]{16}$/.test(hash)) return null;
  return { ref: formatClaimRef(undefined, parsed.specKey, parsed.claimId, parsed.exampleId), hash };
}

/** Every approval recorded by `kind: approval` entries. Malformed refs and unknown methods are skipped. */
export function approvalsFrom(entries: HistoryEntry[]): Approval[] {
  const out: Approval[] = [];
  for (const e of entries) {
    if (e.kind !== 'approval') continue;
    const method = APPROVAL_METHODS.find((m) => m === e.method);
    if (!method) continue;
    for (const raw of e.approves ?? []) {
      const parsed = parseApproved(raw);
      if (parsed) out.push({ claim: parsed.ref, hash: parsed.hash, method, by: e.author ?? 'unknown', date: e.date, entry: e.id });
    }
  }
  return out;
}

/** Later date wins; on the same day the later entry id (entry ids sort by date, then slug). */
const newer = (a: Approval, b: Approval): boolean => (a.date === b.date ? a.entry > b.entry : a.date > b.date);

export interface ApprovalIndex {
  /** The newest approval of `ref` at the current claim hash; undefined when none matches, which includes any claim edited since it was approved. */
  find(ref: string, claimHash: string): Approval | undefined;
  /** The newest approval of `ref` at any hash; undefined when it was never approved. Tells "edited since approval" from "never approved". */
  latest(ref: string): Approval | undefined;
}

export function indexApprovals(approvals: Approval[]): ApprovalIndex {
  const byRef = new Map<string, Approval[]>();
  for (const a of approvals) byRef.set(a.claim, [...(byRef.get(a.claim) ?? []), a]);
  return {
    find(ref, claimHash) {
      const want = shortHash(claimHash);
      let best: Approval | undefined;
      for (const a of byRef.get(ref) ?? []) {
        if (a.hash === want && (!best || newer(a, best))) best = a;
      }
      return best;
    },
    latest(ref) {
      let best: Approval | undefined;
      for (const a of byRef.get(ref) ?? []) {
        if (!best || newer(a, best)) best = a;
      }
      return best;
    },
  };
}
