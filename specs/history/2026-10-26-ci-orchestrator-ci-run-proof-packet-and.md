---
id: 2026-10-26-ci-orchestrator-ci-run-proof-packet-and
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "CI orchestrator: ci run, proof packet and spec approve --from-pr"
affects:
  - integration-surfaces
  - intent-approval
---
# CI orchestrator: ci run, proof packet and spec approve --from-pr

## Decision

Slice M, the CI orchestrator, turns the pieces built before it into one command. `specguard ci run` reads the CI context and the nearest proof note, re-runs only what is stale, and shows by construction that each changed requirement's tests detect the change by running them against the base version of the owned code in a temporary worktree, so the evidence cannot be faked by commit order or a local run record. Approvals are trusted through the review rules: a recorded approval added in a pull request counts at an `enforce` capability only when a review by someone other than the author backs it. The result is one packet comment, a proof note on the pull request head that a squash merge can import by tree equality, and an exit code that only `enforce` capabilities can make non-zero. Writing to GitHub never fails the job; a fork or a missing token degrades to the job summary and the artifacts. The generated workflow checks out the pull request head, holds no model key in the gating job and pins the installed version by minor, and the Action gains a `prove` gate that replaces the ledger thresholds a gitignored ledger cannot serve. `spec approve --from-pr` lets a person turn a review's approvals into committed entries; CI re-checks them. Decisions: attestation stays opt-in, so no check run (and no `checks: write`) is needed by default; a merge-queue run records proofs but does not judge intent, since the pull request's own run did.
