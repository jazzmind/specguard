---
id: 2026-10-26-change-model-is-four-pure-modules-stage
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Change model is four pure modules; stage derived from facts"
affects:
  - spec-first-changes
---
# Change model is four pure modules; stage derived from facts

## Decision

Decision: the change model is four pure modules with no file, git or clock access. The change record holds only declared intent (kind, capabilities, why, base ref, linked plans), and everything a person might want to call "the stage" is derived from facts the pipeline gathers, so editing a record can never advance a change. The red rules and stage locks are written as predicates over a facts object, not as pipeline code, so the local hooks, the status command and CI judge a change the same way and can be table-tested. Changed claims treat an example row as its own ref but suppress rows whose only change is the claim-hash cascade, to keep a reworded claim from listing every row. Base resolution splits in two: the order and the option-looking-ref refusal are pure, and the git calls arrive as a callback. Plan approvals are derived, taking the newest plan linked to the change, and are never written, so a plan cannot be edited after the fact to approve different wording.
