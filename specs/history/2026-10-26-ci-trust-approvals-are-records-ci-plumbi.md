---
id: 2026-10-26-ci-trust-approvals-are-records-ci-plumbi
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "CI trust: approvals are records, CI plumbing, opt-in note authenticity"
affects:
  - intent-approval
  - integration-surfaces
  - proof-store
---
# CI trust: approvals are records, CI plumbing, opt-in note authenticity

## Decision

CI now treats a recorded approval as a record, not as evidence. An approval entry only counts in a pull request when it was already on the base branch, or when a review by a human other than the author backs it, or when the capability does not require a review, or when the repository has opted into self-approval. A review that covers a changed claim and has no entry is itself an approval, written to the proof note, and a removed claim needs a review that saw it gone. A review covers a claim by hash equality at the reviewed commit and at head, which keeps an early review valid until the wording is edited. Decision: comment and pending reviews do not replace an earlier approval or change request, because on GitHub they do not withdraw one. Decision: every recorded entry is judged, not only entries of changed claims, so an as-built approval added in a pull request for an untouched claim cannot slip in unreviewed. Decision: with `allowSelf` a removal needs no review, because a solo maintainer has no second reviewer and no entry to label.

Wave 1 slice D adds the CI plumbing the gate builds on without its orchestrator. The context reader is pure over environment and payload so fork handling is unit-tested: a fork reads as unable to write anything, and the generated workflow's checkout of the PR head means the head sha, not GitHub's merge commit, is the commit under test. The GitHub client is deliberately small and fetch-based, with typed errors that cannot carry the token and a refusal to follow cross-host pagination links. Pipeline-change detection works on names and statuses only, so it cannot be fooled by file content and costs no extra API call beyond the file list the gate already reads.

Note authenticity is opt-in, not on by default: anyone with push access can write the notes ref, and the check run bound to the note's digest is the only defence against a hand-pushed note, but it costs the `checks: write` permission, so repositories choose it with `proofStore.verify: check-run`. Verification is a pure verdict over the check runs found plus a small lookup, so the policy is tested without a network. Decision: a failed lookup is `not-checked` and a missing token is `unverified`, so neither can read as verified. It does not defeat a workflow change merged with review, which then writes notes.
