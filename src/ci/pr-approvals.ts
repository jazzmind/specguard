/**
 * Approval trust in CI. A recorded approval (a committed history entry) is only a record: its author is free text and
 * anyone with write access can commit one. CI turns a record into evidence only when a GitHub review by another human
 * backs it, and writes approvals given by a review to the proof note. Pure: the caller fetches reviews and hashes.
 *
 * Spec: specs/capabilities/intent-approval.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */
import type { Approval } from '../core/approvals.js';
import type { ChangedClaim } from '../core/change-claims.js';
import type { NoteApproval, NoteCountersign } from '../core/proof-note.js';
import type { PacketApproval } from '../core/proof-packet.js';
import type { EnforceLevel } from '../core/types.js';

export const REVIEW_STATES = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING'] as const;

/** `author_association` values whose approval counts. */
export const QUALIFYING_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'] as const;

export interface ReviewFact {
  id: number;
  login: string;
  isBot: boolean;
  state: (typeof REVIEW_STATES)[number];
  commitId: string;
  submittedAt: string;
  association: string;
}

export interface QualifyingReview {
  id: number;
  login: string;
  commitId: string;
  submittedAt: string;
}

/**
 * Latest review per user; it counts when: state APPROVED, not a bot (`[bot]` suffix or type Bot), login != PR author,
 * association in OWNER|MEMBER|COLLABORATOR, and no later CHANGES_REQUESTED from the same user.
 */
export function qualifyingReviews(_reviews: ReviewFact[], _prAuthor: string): QualifyingReview[] {
  throw new Error('not implemented: qualifyingReviews');
}

/** A review covers a claim when the claim (or row) hash at review.commitId equals the hash at head. */
export function reviewCovers(
  _review: QualifyingReview,
  _ref: string,
  _hashAt: (commit: string, ref: string) => string | undefined,
  _headHash: string,
): boolean {
  throw new Error('not implemented: reviewCovers');
}

export interface TrustInput {
  changed: ChangedClaim[];
  /** Approval entries in history at head, split by whether the entry file exists on the base. */
  recorded: Array<Approval & { onBase: boolean }>;
  reviews: QualifyingReview[];
  /** Carried forward from the nearest noted ancestor. */
  noteApprovals: NoteApproval[];
  /** By capability id. */
  enforce: Map<string, EnforceLevel>;
  capabilityOf: (ref: string) => string;
  policy: { requireReview: 'enforce' | 'always' | 'never'; allowSelf: boolean };
  hashAt: (commit: string, ref: string) => string | undefined;
  pr?: { number: number; author: string };
}

export interface TrustOutput {
  /** Approval per changed (non-removed) ref after the rules, with its trust label. */
  byRef: Map<string, PacketApproval>;
  /** New `pr` approvals to write to the note. */
  newNoteApprovals: NoteApproval[];
  countersigns: NoteCountersign[];
  /** Approvals the statement may count (Approved pillar) in CI. */
  effective: Approval[];
}

/**
 * Rules: entries already on the base branch are `inherited` and count; entries added in the PR are `countersigned`
 * (a qualifying review covers the ref), `recorded` (review not required for the capability), `self-approved`
 * (`allowSelf`) or do not count; a covering review with no entry is a new `pr` approval (`verified`); removed claims
 * need a covering review at `enforce`; committed `pr` entries count as verified only when a review by the same login covers the ref.
 */
export function trustApprovals(_input: TrustInput): TrustOutput {
  throw new Error('not implemented: trustApprovals');
}
