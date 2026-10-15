# Behavior-preservation verdict

<!--
  module: src/core/behavior-verdict.ts
  type: core
  status: draft
-->

## Overview

A pure function that compares a baseline run with a patched run and returns PRESERVED, CHANGED or INCONCLUSIVE, with the exact differing tests and claims. It does no I/O. The patched run is only PRESERVED when nothing that passed before has been lost and the vulnerability is really gone.

## Acceptance Criteria

- [ ] PRESERVED requires every condition: no baseline-passing test fails or disappears, no claim drops from proven, claim count unchanged, test count not lower, the advisory resolved, no new advisory at or above the threshold, build and typecheck green, and for dependency bumps the proofs went stale and were re-proven with a new dependency fingerprint <!-- claim: preserved-all -->
- [ ] A baseline-passing test that fails in the patched run makes the verdict CHANGED and is listed by id <!-- claim: test-regressed -->
- [ ] A baseline-passing test missing from the patched run makes the verdict CHANGED <!-- claim: test-vanished -->
- [ ] A claim that was proven and is now failed, error or unexercised makes the verdict CHANGED <!-- claim: claim-dropped -->
- [ ] Fewer claims or fewer tests than the baseline makes the verdict CHANGED <!-- claim: count-drop -->
- [ ] An unresolved advisory, or a new advisory at or above the threshold, makes the verdict CHANGED <!-- claim: advisory-state -->
- [ ] A red build or typecheck makes the verdict CHANGED <!-- claim: build-red -->
- [ ] Flaky tests (their ids differed between two baseline runs) are excluded from every comparison and reported <!-- claim: flaky-excluded -->
- [ ] Unparseable test output in either run, zero tests selected for the package, a baseline that had unexercised claims, or a dependency bump whose proofs were not re-proven with a new fingerprint makes the verdict INCONCLUSIVE unless something already made it CHANGED <!-- claim: inconclusive -->
- [ ] CHANGED wins over INCONCLUSIVE, and INCONCLUSIVE wins over PRESERVED <!-- claim: precedence -->
- [ ] Test identity is the stable id `file::fullTitle`, independent of duration and message <!-- claim: stable-id -->

## Dependencies

- specs/core/test-results.md
- specs/core/advisory.md
