# Results ingest

<!--
  module: src/pipelines/results.ts
  type: pipeline
  status: draft
-->

## Overview

`specguard results ingest <file...>` parses reporter output files, maps tests to claims through claim tags, aggregates one verdict per claim, and writes the verdicts through the proof ledger (`runProofIngest`) with `evidencePath` pointing at the results file. It makes proof verdicts producible by a plain test run, with no LLM.

## Acceptance Criteria

- [ ] Results from several files are merged before aggregation so one claim can be exercised from two suites <!-- claim: merge-files -->
- [ ] `--format auto` detects each file's format and an explicit `--format` overrides detection <!-- claim: format-flag -->
- [ ] The ingest writes `evidencePath` as a repo-relative POSIX path to the results file that exercised the claim <!-- claim: evidence-path -->
- [ ] `--run-id` sets the ledger `runId` and defaults to a timestamped id <!-- claim: run-id -->
- [ ] A tag that points at a claim whose spec cannot be found is reported failed and not stored <!-- claim: unknown-claim -->
- [ ] By default a partial ingest only writes verdicts for the claims present in the results; claims absent from the files keep their stored rows <!-- claim: partial-ingest -->
- [ ] `--unexercised` (alias `--sweep`) stores `unexercised` for claims absent from every ingested file only when `--full-run` is also given or when the ingested files cover all configured apps; otherwise it is ignored with a warning and nothing is overwritten <!-- claim: unexercised-flag -->
- [ ] A sweep never downgrades a `proven` claim whose spec and source hashes still match; only a claim explicitly present in the results can change a `proven` row <!-- claim: sweep-keeps-proven -->
- [ ] The command exits 2 when any claim verdict is failed or a results file cannot be parsed <!-- claim: exit-code -->
- [ ] After ingest each row's `fileHashes` are populated from the spec's declared `sources:` (see `proof.md`), so a source edit makes the claim stale <!-- claim: records-source-hashes -->
- [ ] The ledger path honours `--ledger` and `paths.proofLedger` <!-- claim: ledger-path -->

## Scenarios

### Scenario 1: Vitest report with a tagged test

**Steps:**
1. Write a Vitest JSON report with a passing test titled `awards once @claim:core/awards#award-once`
2. Run `specguard results ingest report.json`

**Expected Results:**
- The ledger has a `proven` row for `core/awards#award-once` with `exercised: 1`
