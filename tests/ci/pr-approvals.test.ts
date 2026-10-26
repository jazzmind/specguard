import { describe, expect, it } from 'vitest';

import type { Approval } from '../../src/core/approvals.js';
import type { ChangedClaim } from '../../src/core/change-claims.js';
import type { NoteApproval } from '../../src/core/proof-note.js';
import type { EnforceLevel } from '../../src/core/types.js';
import { qualifyingReviews, reviewCovers, trustApprovals, type QualifyingReview, type ReviewFact, type TrustInput } from '../../src/ci/pr-approvals.js';

const REF = 'capabilities/cart#total';
const H1 = 'a1'.repeat(32);
const H2 = 'b2'.repeat(32);
const short = (h: string): string => h.slice(0, 16);

const fact = (over: Partial<ReviewFact> & { id: number }): ReviewFact => ({
  login: 'rae',
  isBot: false,
  state: 'APPROVED',
  commitId: 'c1',
  submittedAt: `2026-10-25T10:0${over.id}:00Z`,
  association: 'MEMBER',
  ...over,
});
const qr = (over: Partial<QualifyingReview> = {}): QualifyingReview => ({ id: 1, login: 'rae', commitId: 'c1', submittedAt: '2026-10-25T10:00:00Z', ...over });

const changed = (over: Partial<ChangedClaim> = {}): ChangedClaim => ({ ref: REF, capability: 'cart', change: 'modified', hash: H1, baseHash: H2, ...over });
const entry = (over: Partial<Approval & { onBase: boolean }> = {}): Approval & { onBase: boolean } => ({
  claim: REF,
  hash: short(H1),
  method: 'command',
  by: 'Ada',
  date: '2026-10-24',
  entry: '2026-10-24-approve-total',
  onBase: false,
  ...over,
});

/** Every commit sees REF at H1 unless a map says otherwise. */
const hashAtFn =
  (map: Record<string, string | undefined> = {}) =>
  (commit: string, _ref: string): string | undefined =>
    commit in map ? map[commit] : H1;

function input(over: Partial<TrustInput> = {}): TrustInput {
  return {
    changed: [changed()],
    recorded: [],
    reviews: [],
    noteApprovals: [],
    enforce: new Map<string, EnforceLevel>([['cart', 'enforce']]),
    capabilityOf: () => 'cart',
    policy: { requireReview: 'enforce', allowSelf: false },
    hashAt: hashAtFn(),
    pr: { number: 7, author: 'ada' },
    ...over,
  };
}

describe('qualifyingReviews [pr-approvals]', () => {
  // [claims: capabilities/intent-approval#ci-review-qualifies]
  it("ignores the author's own review, whatever its case", () => {
    expect(qualifyingReviews([fact({ id: 1, login: 'Ada' })], 'ada')).toEqual([]);
  });

  // [claims: capabilities/intent-approval#ci-review-qualifies]
  it('ignores bot reviews, by type and by login suffix', () => {
    expect(qualifyingReviews([fact({ id: 1, login: 'helper', isBot: true }), fact({ id: 2, login: 'robo[bot]' })], 'ada')).toEqual([]);
  });

  // [claims: capabilities/intent-approval#ci-review-qualifies]
  it('ignores an association outside owner, member and collaborator', () => {
    const rs = [fact({ id: 1, login: 'a', association: 'NONE' }), fact({ id: 2, login: 'b', association: 'CONTRIBUTOR' }), fact({ id: 3, login: 'c', association: 'FIRST_TIME_CONTRIBUTOR' })];
    expect(qualifyingReviews(rs, 'ada')).toEqual([]);
    const ok = [fact({ id: 1, login: 'a', association: 'OWNER' }), fact({ id: 2, login: 'b', association: 'MEMBER' }), fact({ id: 3, login: 'c', association: 'COLLABORATOR' })];
    expect(qualifyingReviews(ok, 'ada').map((r) => r.login)).toEqual(['a', 'b', 'c']);
  });

  // [claims: capabilities/intent-approval#ci-review-qualifies]
  it('only an approving review counts', () => {
    expect(qualifyingReviews([fact({ id: 1, state: 'COMMENTED' }), fact({ id: 2, login: 'x', state: 'CHANGES_REQUESTED' }), fact({ id: 3, login: 'y', state: 'DISMISSED' })], 'ada')).toEqual([]);
  });

  // [claims: capabilities/intent-approval#ci-review-latest-per-user]
  it('the latest review per user wins: a later change request cancels an approval, a later approval restores it', () => {
    expect(qualifyingReviews([fact({ id: 1 }), fact({ id: 2, state: 'CHANGES_REQUESTED' })], 'ada')).toEqual([]);
    const again = qualifyingReviews([fact({ id: 1, state: 'CHANGES_REQUESTED' }), fact({ id: 2 })], 'ada');
    expect(again.map((r) => r.id)).toEqual([2]);
  });

  // [claims: capabilities/intent-approval#ci-review-latest-per-user]
  it('a later comment does not withdraw an approval, and input order does not matter', () => {
    const rs = [fact({ id: 2, state: 'COMMENTED' }), fact({ id: 1 })];
    expect(qualifyingReviews(rs, 'ada').map((r) => r.id)).toEqual([1]);
    expect(qualifyingReviews([...rs].reverse(), 'ada').map((r) => r.id)).toEqual([1]);
  });

  // [claims: capabilities/intent-approval#ci-review-latest-per-user]
  it('keeps one review per user and returns only the fields the rules read', () => {
    const out = qualifyingReviews([fact({ id: 1, commitId: 'old' }), fact({ id: 2, commitId: 'new' }), fact({ id: 3, login: 'sam' })], 'ada');
    expect(out).toEqual([
      { id: 2, login: 'rae', commitId: 'new', submittedAt: '2026-10-25T10:02:00Z' },
      { id: 3, login: 'sam', commitId: 'c1', submittedAt: '2026-10-25T10:03:00Z' },
    ]);
  });
});

describe('reviewCovers [pr-approvals]', () => {
  // [claims: capabilities/intent-approval#ci-review-covers-by-hash]
  it('a review on an older commit covers a claim whose hash did not change since', () => {
    expect(reviewCovers(qr({ commitId: 'old' }), REF, hashAtFn({ old: H1 }), H1)).toBe(true);
  });

  // [claims: capabilities/intent-approval#ci-review-covers-by-hash]
  it('a review on an older commit does not cover a claim edited after it', () => {
    expect(reviewCovers(qr({ commitId: 'old' }), REF, hashAtFn({ old: H2 }), H1)).toBe(false);
  });

  // [claims: capabilities/intent-approval#ci-review-covers-by-hash]
  it('a claim absent at the reviewed commit is not covered, and a 16-hex hash matches the full one', () => {
    expect(reviewCovers(qr(), REF, hashAtFn({ c1: undefined }), H1)).toBe(false);
    expect(reviewCovers(qr(), REF, () => short(H1), H1)).toBe(true);
  });
});

describe('trustApprovals [pr-approvals]', () => {
  // [claims: capabilities/intent-approval#ci-inherited-approvals]
  it('a recorded entry on the base branch is inherited and counts', () => {
    const out = trustApprovals(input({ recorded: [entry({ onBase: true })] }));
    expect(out.byRef.get(REF)).toMatchObject({ trust: 'inherited', source: '2026-10-24-approve-total' });
    expect(out.effective).toHaveLength(1);
    expect(out.countersigns).toEqual([{ entry: '2026-10-24-approve-total', method: 'command', status: 'inherited', pr: 7 }]);
  });

  // [claims: capabilities/intent-approval#ci-countersigned-approvals]
  it('a recorded entry in the PR with a covering review is countersigned', () => {
    const out = trustApprovals(input({ recorded: [entry()], reviews: [qr()] }));
    expect(out.byRef.get(REF)).toMatchObject({ trust: 'countersigned', countersignedBy: 'rae', by: 'Ada' });
    expect(out.effective.map((a) => a.entry)).toEqual(['2026-10-24-approve-total']);
    expect(out.countersigns).toEqual([{ entry: '2026-10-24-approve-total', method: 'command', status: 'countersigned', by: 'rae', pr: 7 }]);
    expect(out.newNoteApprovals).toEqual([]);
  });

  // [claims: capabilities/intent-approval#ci-countersigned-approvals]
  it('a review that predates an edit of the claim does not countersign the entry', () => {
    const out = trustApprovals(input({ recorded: [entry()], reviews: [qr({ commitId: 'old' })], hashAt: hashAtFn({ old: H2 }) }));
    expect(out.byRef.get(REF)?.trust).toBe('missing');
    expect(out.effective).toEqual([]);
  });

  // [claims: capabilities/intent-approval#ci-review-required-by-policy]
  it('a recorded entry in the PR without a review at enforce is not counted and shows as missing', () => {
    const out = trustApprovals(input({ recorded: [entry()] }));
    expect(out.byRef.get(REF)).toMatchObject({ trust: 'missing', source: '2026-10-24-approve-total' });
    expect(out.effective).toEqual([]);
    expect(out.countersigns).toEqual([]);
  });

  // [claims: capabilities/intent-approval#ci-review-required-by-policy]
  it('at warn with requireReview enforce the entry is recorded and counted', () => {
    const out = trustApprovals(input({ recorded: [entry({ method: 'as-built' })], enforce: new Map([['cart', 'warn']]) }));
    expect(out.byRef.get(REF)?.trust).toBe('recorded');
    expect(out.effective).toHaveLength(1);
  });

  // [claims: capabilities/intent-approval#ci-review-required-by-policy]
  it('requireReview always needs a review even for a capability below enforce, never needs none at enforce', () => {
    const warn = new Map<string, EnforceLevel>([['cart', 'warn']]);
    expect(trustApprovals(input({ recorded: [entry()], enforce: warn, policy: { requireReview: 'always', allowSelf: false } })).byRef.get(REF)?.trust).toBe('missing');
    expect(trustApprovals(input({ recorded: [entry()], policy: { requireReview: 'never', allowSelf: false } })).byRef.get(REF)?.trust).toBe('recorded');
  });

  // [claims: capabilities/intent-approval#ci-self-approved-opt-in]
  it('allowSelf labels an unreviewed entry self-approved and counts it; a review still wins', () => {
    const solo = trustApprovals(input({ recorded: [entry({ method: 'plan' })], policy: { requireReview: 'enforce', allowSelf: true } }));
    expect(solo.byRef.get(REF)?.trust).toBe('self-approved');
    expect(solo.effective).toHaveLength(1);
    expect(solo.countersigns[0]).toMatchObject({ method: 'plan', status: 'self-approved' });
    const reviewed = trustApprovals(input({ recorded: [entry()], reviews: [qr()], policy: { requireReview: 'enforce', allowSelf: true } }));
    expect(reviewed.byRef.get(REF)?.trust).toBe('countersigned');
  });

  // [claims: capabilities/intent-approval#ci-self-approved-opt-in]
  it('self-approval is off by default: the default policy shape never yields self-approved', () => {
    const out = trustApprovals(input({ recorded: [entry()] }));
    expect(out.byRef.get(REF)?.trust).not.toBe('self-approved');
  });

  // [claims: capabilities/intent-approval#ci-review-is-approval]
  it('a covering review with no entry is a verified pr approval written to the note', () => {
    const out = trustApprovals(input({ reviews: [qr({ id: 9, login: 'rae', commitId: 'c1' })] }));
    expect(out.byRef.get(REF)).toMatchObject({ method: 'pr', by: 'rae', trust: 'verified', source: 'review 9 by rae', date: '2026-10-25' });
    expect(out.newNoteApprovals).toEqual([{ claim: REF, hash: short(H1), method: 'pr', by: 'rae', pr: 7, reviewId: 9, reviewedAt: 'c1', date: '2026-10-25' }]);
    expect(out.effective).toEqual([{ claim: REF, hash: short(H1), method: 'pr', by: 'rae', date: '2026-10-25', entry: 'pr-7-review-9' }]);
  });

  // [claims: capabilities/intent-approval#ci-review-is-approval]
  it('without a covering review or entry nothing is approved; an approval carried in the note is verified without being written again', () => {
    const none = trustApprovals(input({ reviews: [qr({ commitId: 'old' })], hashAt: hashAtFn({ old: H2 }) }));
    expect(none.byRef.size).toBe(0);
    const carried: NoteApproval = { claim: REF, hash: short(H1), method: 'pr', by: 'rae', pr: 7, reviewId: 4, reviewedAt: 'c0', date: '2026-10-24' };
    const out = trustApprovals(input({ noteApprovals: [carried] }));
    expect(out.byRef.get(REF)).toMatchObject({ trust: 'verified', by: 'rae', source: 'review 4 by rae' });
    expect(out.newNoteApprovals).toEqual([]);
    expect(out.effective).toHaveLength(1);
  });

  // [claims: capabilities/intent-approval#ci-review-is-approval]
  it('a carried approval for an earlier wording of the claim does not count', () => {
    const stale: NoteApproval = { claim: REF, hash: short(H2), method: 'pr', by: 'rae', pr: 7, reviewId: 4, reviewedAt: 'c0', date: '2026-10-24' };
    expect(trustApprovals(input({ noteApprovals: [stale] })).byRef.size).toBe(0);
  });

  // [claims: capabilities/intent-approval#ci-pr-entry-needs-same-reviewer]
  it('a committed pr entry is verified only when a review by the same login covers the claim', () => {
    const pr = entry({ method: 'pr', by: 'Rae', entry: '2026-10-25-from-pr' });
    expect(trustApprovals(input({ recorded: [pr], reviews: [qr({ login: 'rae' })] })).byRef.get(REF)?.trust).toBe('verified');
    const other = trustApprovals(input({ recorded: [pr], reviews: [qr({ login: 'sam' })] }));
    expect(other.byRef.get(REF)).toMatchObject({ trust: 'countersigned', countersignedBy: 'sam' });
    expect(trustApprovals(input({ recorded: [pr] })).byRef.get(REF)?.trust).toBe('missing');
    expect(trustApprovals(input({ recorded: [pr], enforce: new Map([['cart', 'warn']]) })).byRef.get(REF)?.trust).toBe('recorded');
  });

  // [claims: capabilities/intent-approval#ci-removal-needs-review]
  it('a removed claim at enforce needs a covering review: none is listed, a review that saw it gone approves it', () => {
    const removed = changed({ change: 'removed', hash: undefined });
    const lone = trustApprovals(input({ changed: [removed], hashAt: hashAtFn({ c1: undefined }) , reviews: [] }));
    expect(lone.removalsNeedingReview).toEqual([REF]);
    expect(lone.byRef.has(REF)).toBe(false);
    const early = trustApprovals(input({ changed: [removed], reviews: [qr()] }));
    expect(early.removalsNeedingReview).toEqual([REF]);
    const ok = trustApprovals(input({ changed: [removed], reviews: [qr()], hashAt: hashAtFn({ c1: undefined }) }));
    expect(ok.removalsNeedingReview).toEqual([]);
    expect(ok.byRef.get(REF)).toMatchObject({ trust: 'verified', by: 'rae' });
    expect(ok.newNoteApprovals).toEqual([]);
  });

  // [claims: capabilities/intent-approval#ci-removal-needs-review]
  it('a removal below enforce, or on a solo repo with allowSelf, is not listed', () => {
    const removed = changed({ change: 'removed', hash: undefined });
    expect(trustApprovals(input({ changed: [removed], enforce: new Map([['cart', 'warn']]) })).removalsNeedingReview).toEqual([]);
    expect(trustApprovals(input({ changed: [removed], policy: { requireReview: 'enforce', allowSelf: true } })).removalsNeedingReview).toEqual([]);
  });

  // [claims: capabilities/intent-approval#ci-effective-approvals]
  it('an entry for an earlier wording of a changed claim is dropped, while entries of unchanged claims are still judged', () => {
    const other = 'capabilities/cart#fee';
    const out = trustApprovals(
      input({
        recorded: [entry({ hash: short(H2) }), entry({ claim: other, hash: short(H2), entry: 'e-other', onBase: true }), entry({ claim: other, hash: short(H2), entry: 'e-new' })],
        capabilityOf: () => 'cart',
      }),
    );
    expect(out.effective.map((a) => a.entry)).toEqual(['e-other']);
    expect(out.byRef.has(REF)).toBe(false);
    expect(out.byRef.has(other)).toBe(false);
  });

  // [claims: capabilities/intent-approval#ci-effective-approvals]
  it('an unchanged claim approved in the PR needs the same countersignature as a changed one', () => {
    const other = 'capabilities/cart#fee';
    const rec = entry({ claim: other, hash: short(H2), entry: 'e-new' });
    const none = trustApprovals(input({ changed: [], recorded: [rec] }));
    expect(none.effective).toEqual([]);
    const signed = trustApprovals(input({ changed: [], recorded: [rec], reviews: [qr()], hashAt: hashAtFn({ c1: H2 }) }));
    expect(signed.effective.map((a) => a.entry)).toEqual(['e-new']);
    expect(signed.byRef.size).toBe(0);
  });

  // [claims: capabilities/intent-approval#ci-effective-approvals]
  it('the strongest label wins when several entries approve the same wording', () => {
    const out = trustApprovals(input({ recorded: [entry({ entry: 'e1', onBase: false }), entry({ entry: 'e2', onBase: true })] }));
    expect(out.byRef.get(REF)?.trust).toBe('inherited');
    expect(out.effective.map((a) => a.entry)).toEqual(['e2']);
  });
});
