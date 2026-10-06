# Align pipeline

<!--
  module: src/pipelines/align.ts
  type: pipeline
  status: draft
-->

## Overview

Compares each spec's scenarios and claims with the tests that exist. A deterministic prepass (`src/core/claim-prepass.ts`) settles what claim tags and scenario-name titles already show. Only the claims and scenarios still uncovered go to the LLM, along with the test files that plausibly relate to the spec. Output is `.specguard/alignment.json`, checkpointed after every spec.

## Acceptance Criteria

- [ ] A claim whose tag appears in a test is reported covered without an LLM call <!-- claim: tag-covers-claim -->
- [ ] A scenario whose name appears in a test title is reported covered without an LLM call <!-- claim: title-covers-scenario -->
- [ ] A spec with nothing left uncovered makes no LLM call <!-- claim: no-call-when-covered -->
- [ ] The LLM prompt lists only uncovered scenarios and uncovered claims <!-- claim: prompt-only-uncovered -->
- [ ] The LLM receives the spec's name-matched test files and the files that carry its claim tags, and no unrelated files used as padding <!-- claim: no-padding -->
- [ ] Entries and claim matching use the canonical spec key (`specs/core/spec-key.md`), so tags written with the specs-root-relative key cover claims under per-app spec dirs <!-- claim: canonical-keys -->
- [ ] Each entry records `coveredClaims` and `uncoveredClaims` <!-- claim: entry-claims -->
- [ ] The alignment score counts deterministically covered and LLM-covered scenarios together <!-- claim: score-combines -->

## Scenarios

### Scenario 1: All scenarios named in tests

**Steps:**
1. Tests whose titles contain every scenario name exist
2. Run `specguard align`

**Expected Results:**
- Score is 100 and the LLM is never called
