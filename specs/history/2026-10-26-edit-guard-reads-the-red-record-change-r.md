---
id: 2026-10-26-edit-guard-reads-the-red-record-change-r
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Edit guard reads the red record change red writes; end-to-end protocol tests"
affects:
  - spec-first-changes
---
# Edit guard reads the red record change red writes; end-to-end protocol tests

## Decision

Reconciled the edit guard with the change pipeline. The pipeline's red pointer (`.specguard/cache/changes/<id>/red.json`) named a run record and carried hashes but no test verdicts, while the guard's index builder read `tests[]` from that same path to find the files to lock and to judge whether any test failed, so after a real `change red` the guard saw a red record with no failing test and kept denying code. The decision was to keep one writer and one shape: `change red` and `change green` now copy the run's verdicts (through one shared mapping, `pointerTests`, also used by the stage detection), the run id and the locked test files (the exact set the tests hash covers) into the pointer in the shape of a red record, so the guard needs neither the run record nor the pipeline modules and its bundle does not grow. The stage detection still reads verdicts from the run record, and the copy is only what the guard reads. The guard prefers the pointer's `lockedTests` and falls back to the files of its tests. The end-to-end tests also found that `change done` treated a green change waiting for CI as validated (the stage name is `validated` while the last stage is still blocked), so it closed without CI; it now requires the validated stage to be satisfied. They found that `enforce raise --to enforce` judged certification from the local ledger alone, so a person with only the CI note could never raise a capability; it now reads the proof notes as `check` does.
