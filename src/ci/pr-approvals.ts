/**
 * Approval trust in CI. A recorded approval (a committed history entry) is only a record: its author is free text and
 * anyone with write access can commit one. CI turns a record into evidence only when a GitHub review by another human
 * backs it, and writes approvals given by a review to the proof note. Pure: the caller fetches reviews and hashes.
 *
 * Spec: specs/capabilities/intent-approval.md
 * Contract: signatures are frozen; the implementing slice fills in the bodies.
 */
import { shortHash, type Approval } from '../core/approvals.js';
import type { ChangedClaim } from '../core/change-claims.js';
import type { NoteApproval, NoteCountersign } from '../core/proof-note.js';
import type { ApprovalTrust, PacketApproval } from '../core/proof-packet.js';
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

/** Reviews that change nobody's approval state: they neither give nor take one. */
const NEUTRAL_STATES: ReadonlyArray<ReviewFact['state']> = ['COMMENTED', 'PENDING'];

const time = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
};

/** Compare hashes at the width approvals store, so a full claim hash and a 16-hex approval hash agree. */
const sameHash = (a: string, b: string): boolean => shortHash(a.toLowerCase()) === shortHash(b.toLowerCase());

/**
 * Latest review per user; it counts when: state APPROVED, not a bot (`[bot]` suffix or type Bot), login != PR author,
 * association in OWNER|MEMBER|COLLABORATOR, and no later CHANGES_REQUESTED from the same user. A COMMENTED or PENDING
 * review never replaces an earlier verdict, because on GitHub it does not withdraw an approval. Logins compare
 * case-insensitively. Oldest first.
 */
export function qualifyingReviews(reviews: ReviewFact[], prAuthor: string): QualifyingReview[] {
  const author = prAuthor.toLowerCase();
  const ordered = [...reviews].sort((a, b) => time(a.submittedAt) - time(b.submittedAt) || a.id - b.id);
  const latest = new Map<string, ReviewFact>();
  for (const r of ordered) {
    if (NEUTRAL_STATES.includes(r.state)) continue;
    latest.delete(r.login.toLowerCase());
    latest.set(r.login.toLowerCase(), r);
  }
  const out: QualifyingReview[] = [];
  for (const r of latest.values()) {
    if (r.state !== 'APPROVED' || r.isBot || r.login.toLowerCase().endsWith('[bot]')) continue;
    if (r.login.toLowerCase() === author) continue;
    if (!(QUALIFYING_ASSOCIATIONS as readonly string[]).includes(r.association.toUpperCase())) continue;
    out.push({ id: r.id, login: r.login, commitId: r.commitId, submittedAt: r.submittedAt });
  }
  return out;
}

/**
 * A review covers a claim when the claim (or row) hash at review.commitId equals the hash at head. This is also what
 * makes a review "on or after the last commit that touched the claim": a later edit changes the hash and the review lapses.
 */
export function reviewCovers(
  review: QualifyingReview,
  ref: string,
  hashAt: (commit: string, ref: string) => string | undefined,
  headHash: string,
): boolean {
  const at = hashAt(review.commitId, ref);
  return at !== undefined && sameHash(at, headHash);
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
  /** Approval per changed ref after the rules, with its trust label. A removed claim appears only when a review covers its removal. */
  byRef: Map<string, PacketApproval>;
  /** New `pr` approvals to write to the note. */
  newNoteApprovals: NoteApproval[];
  countersigns: NoteCountersign[];
  /** Approvals the statement may count (Approved pillar) in CI. */
  effective: Approval[];
  /** Removed claims whose removal needs a covering review and has none (empty when nothing is outstanding). */
  removalsNeedingReview?: string[];
}

/** Strongest first: what a ref shows when several approvals of it exist. */
const TRUST_ORDER: ApprovalTrust[] = ['verified', 'countersigned', 'inherited', 'recorded', 'self-approved', 'missing'];

const reviewSource = (r: QualifyingReview): string => `review ${r.id} by ${r.login}`;
const reviewDate = (r: QualifyingReview): string => r.submittedAt.slice(0, 10);

/**
 * Rules: entries already on the base branch are `inherited` and count; entries added in the PR are `countersigned`
 * (a qualifying review covers the ref), `recorded` (review not required for the capability), `self-approved`
 * (`allowSelf`) or do not count; a covering review with no entry is a new `pr` approval (`verified`); removed claims
 * need a covering review at `enforce`; committed `pr` entries count as verified only when a review by the same login covers the ref.
 *
 * Every recorded entry is judged, not only those of changed claims: an entry added in the PR for a claim that did not
 * change is still an approval nobody else has seen. `effective` is the full list the statement may count.
 */
export function trustApprovals(input: TrustInput): TrustOutput {
  const changedBy = new Map(input.changed.map((c) => [c.ref, c]));
  const byRef = new Map<string, PacketApproval>();
  const effective: Approval[] = [];
  const countersigns: NoteCountersign[] = [];
  const newNoteApprovals: NoteApproval[] = [];
  const removalsNeedingReview: string[] = [];
  const countersignKeys = new Set<string>();

  // Newest review first, so a ref shows the latest reviewer that covers it.
  const newestFirst = [...input.reviews].sort((a, b) => time(b.submittedAt) - time(a.submittedAt) || b.id - a.id);
  const covering = (ref: string, headHash: string): QualifyingReview | undefined => newestFirst.find((r) => reviewCovers(r, ref, input.hashAt, headHash));

  const reviewRequired = (ref: string): boolean => {
    const mode = input.policy.requireReview;
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    return input.enforce.get(input.capabilityOf(ref)) === 'enforce';
  };

  const show = (ref: string, a: PacketApproval): void => {
    const cur = byRef.get(ref);
    if (!cur || TRUST_ORDER.indexOf(a.trust) < TRUST_ORDER.indexOf(cur.trust)) byRef.set(ref, a);
  };

  const addCountersign = (e: Approval, status: NoteCountersign['status'], by?: string): void => {
    if (e.method === 'pr') return;
    const key = `${e.entry}|${status}|${by ?? ''}`;
    if (countersignKeys.has(key)) return;
    countersignKeys.add(key);
    countersigns.push({ entry: e.entry, method: e.method, status, ...(by ? { by } : {}), ...(input.pr ? { pr: input.pr.number } : {}) });
  };

  for (const e of input.recorded) {
    const c = changedBy.get(e.claim);
    if (c?.change === 'removed') continue;
    // An entry for an earlier wording of a changed claim says nothing about what is there now.
    if (c?.hash !== undefined && !sameHash(c.hash, e.hash)) continue;
    const headHash = c?.hash ?? e.hash;
    const entryApproval = (trust: ApprovalTrust, countersignedBy?: string): PacketApproval => ({
      method: e.method,
      by: e.by,
      trust,
      source: e.entry,
      date: e.date,
      ...(countersignedBy ? { countersignedBy } : {}),
    });
    const count = (trust: ApprovalTrust, countersignedBy?: string): void => {
      effective.push({ claim: e.claim, hash: e.hash, method: e.method, by: e.by, date: e.date, entry: e.entry });
      if (c) show(e.claim, entryApproval(trust, countersignedBy));
    };

    if (e.onBase) {
      count('inherited');
      addCountersign(e, 'inherited');
      continue;
    }
    const samePerson = e.method === 'pr' ? input.reviews.find((r) => r.login.toLowerCase() === e.by.toLowerCase() && reviewCovers(r, e.claim, input.hashAt, headHash)) : undefined;
    if (samePerson) {
      count('verified');
      continue;
    }
    const review = covering(e.claim, headHash);
    if (review) {
      count('countersigned', review.login);
      addCountersign(e, 'countersigned', review.login);
    } else if (!reviewRequired(e.claim)) {
      count('recorded');
    } else if (input.policy.allowSelf) {
      count('self-approved');
      addCountersign(e, 'self-approved');
    } else if (c) {
      show(e.claim, entryApproval('missing'));
    }
  }

  const noteHas = (ref: string, hash: string): NoteApproval | undefined => input.noteApprovals.find((n) => n.claim === ref && sameHash(n.hash, hash));
  for (const c of input.changed) {
    if (c.change === 'removed') {
      const review = newestFirst.find((r) => input.hashAt(r.commitId, c.ref) === undefined);
      if (review) byRef.set(c.ref, { method: 'pr', by: review.login, trust: 'verified', source: reviewSource(review), date: reviewDate(review), countersignedBy: review.login });
      else if (reviewRequired(c.ref) && !input.policy.allowSelf) removalsNeedingReview.push(c.ref);
      continue;
    }
    if (c.hash === undefined) continue;
    const current = byRef.get(c.ref);
    if (current && current.trust !== 'missing') continue;
    const carried = noteHas(c.ref, c.hash);
    if (carried) {
      effective.push({ claim: c.ref, hash: shortHash(c.hash), method: 'pr', by: carried.by, date: carried.date, entry: `pr-${carried.pr}-review-${carried.reviewId}` });
      byRef.set(c.ref, { method: 'pr', by: carried.by, trust: 'verified', source: `review ${carried.reviewId} by ${carried.by}`, date: carried.date });
      continue;
    }
    const review = current ? undefined : covering(c.ref, c.hash);
    if (!review) continue;
    const hash = shortHash(c.hash.toLowerCase());
    const date = reviewDate(review);
    newNoteApprovals.push({ claim: c.ref, hash, method: 'pr', by: review.login, pr: input.pr?.number ?? 0, reviewId: review.id, reviewedAt: review.commitId, date });
    effective.push({ claim: c.ref, hash, method: 'pr', by: review.login, date, entry: `pr-${input.pr?.number ?? 0}-review-${review.id}` });
    byRef.set(c.ref, { method: 'pr', by: review.login, trust: 'verified', source: reviewSource(review), date });
  }

  return { byRef, newNoteApprovals, countersigns, effective, removalsNeedingReview };
}
