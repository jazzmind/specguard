---
id: 2026-10-26-title-scoped-test-selection-and-claim-sc
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Title-scoped test selection and claim-scoped coverage"
affects:
  - conformance-testing
---
# Title-scoped test selection and claim-scoped coverage

## Decision

Phase 3 needs "exactly those tests" for red and green evidence and claim-scoped coverage, but the runner adapters only selected by file. `RunnerAdapter` gains `titleFlags(titles, ctx?)`, which returns shell-quoted flags that select tests by title, or `undefined` when the runner cannot do it safely; callers read `undefined` as unknown and fall back to files or the whole suite, never as a pass. JavaScript runners match the title at the end of the full name (describe blocks plus title joined by spaces) and may select an extra test whose title is a tail of another, so verdicts are always read from the result rows by file and title. `runTests` reports how far a run was narrowed (`tests`, `files` or `suite`). `runTestRun` gains `claims`, `coverage`, `record` and an `ingest` switch (default on, so a red run against older code can skip the proof ledger). A run record stores a hash over the owned source files so a later stage can prove none changed since the run.
