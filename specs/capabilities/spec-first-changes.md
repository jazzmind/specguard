---
id: spec-first-changes
kind: capability
title: Spec-First Changes
parent: system
value: A change starts as a requirement a person approved, is proven by a test that failed before the code existed and passed after, and reaches review with a packet that shows what changed and what was proven, so an agent cannot ship code nobody asked for.
status: active
sources:
  - "src/core/change-record.ts"
  - "src/core/change-claims.ts"
  - "src/core/unrequested.ts"
  - "src/core/proof-packet.ts"
  - "src/hooks/**"
  - "src/cli/commands/change.ts"
  - "src/cli/commands/enforce.ts"
  - "src/cli/commands/hook.ts"
docs: []
history:
  - 2026-10-26-phase-3-contracts-and-seams
tests:
  - "tests/core/contracts-phase3.test.ts"
  - "tests/core/config-phase3.test.ts"
---

# Spec-First Changes

## Problem & Value
A coding agent can write the code, then the requirement that describes it, then a test that passes, and every check is green while nobody decided the requirement was right and no test ever failed. Checking proof after the fact cannot tell a test that detects a change from one written to agree with the code.

A spec-first change reverses the order and enforces it. The requirement is written and approved first, the tests that cite it must fail against the old code, and only then is code written. Each capability sets how strictly this binds it, from observing to enforcing, so a repository can tighten one capability at a time. The pull request carries a packet that lists the requirements that changed, the evidence for each, any test that was weakened and any code no requirement asked for.

## Requirements
- [ ] A change record is one JSON file named by an id of date, slug and four hex characters, lists at least one capability and has the kind feature, refactor or spike, so the record contract rejects an id that could leave the changes directory, a record without a capability and an unknown kind <!-- claim: change-record-contract -->
- [ ] A capability's enforcement level is observe, warn or enforce, weakest first, and a repository whose config sets none treats every capability as observe <!-- claim: enforce-levels -->
