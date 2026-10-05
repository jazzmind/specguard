# Proof ledger

<!--
  module: src/pipelines/proof.ts
  type: pipeline
  status: draft
-->

## Overview

Stores the result of a proof run against claim ids. `specguard proof ingest` merges a verdicts file into `.specguard/proofs.json` on the workspace root when `.specguard/workspace.json` is found, and on the repo root otherwise. Each row records the verdict, the run id, the spec hash, the owning repo's git HEAD, and the drift-registry file hashes at ingest time.

`proven`, `failed`, `unexercised`, and `error` are stored. `error` means a probe threw, so the claim was not exercised. `stale` is computed when the spec hash or a recorded source-file hash no longer matches. `unproven` means the ledger has no row. A non-stale `proven` claim counts as Proven for that spec's channel when `specguard features --state` runs. `specguard status` prints the counts and does not change its exit code. `specguard drift` counts a stale proof as drift.

## Acceptance Criteria

- [ ] Ingest rejects a verdicts file that is missing `runId` or `verdicts` <!-- claim: ingest-schema -->
- [ ] A verdict whose claim ref does not parse, whose spec file cannot be found, or whose claim id has no `<!-- claim: id -->` anchor in that spec, is failed and not stored <!-- claim: ingest-unknown-claim -->
- [ ] A later ingest for the same claim ref replaces the stored row <!-- claim: ingest-replaces -->
- [ ] `effectiveVerdict` returns `stale` when the spec hash differs or a recorded file hash differs, and `unproven` when there is no row <!-- claim: stale-rule -->
- [ ] A file hash that is no longer in the drift registry does not by itself make the proof stale <!-- claim: missing-file-not-stale -->
- [ ] `specguard proof status` lists failed and stale claims and exits 2 when either is present <!-- claim: proof-status-exit -->
- [ ] `specguard status` appends a PROOFS line and does not change its exit code because of it <!-- claim: status-informational -->
- [ ] `specguard drift` adds a failed item for each stale proof <!-- claim: drift-stale-fails -->
- [ ] Proof `fileHashes` keys are repo-relative POSIX paths, and a ledger written with absolute keys is migrated when it is read <!-- claim: portable-hashes -->
- [ ] The current hash of a recorded file is read from disk, so editing a source file marks the proof stale even before `drift` runs <!-- claim: live-file-hashes -->
- [ ] A claim's file hashes come from the registry entry for exactly that app and spec key; two apps with the same spec key do not share hashes <!-- claim: file-hash-key -->
- [ ] Each stored row records a `dependencyFingerprint` (hash of the repo's lockfiles, or its dependency manifests when no lockfile exists) and `effectiveVerdict` returns `stale` when the fingerprint no longer matches; a row with no fingerprint is never stale for that reason <!-- claim: dependency-stale -->
- [ ] The ledger path comes from `--ledger`, then `paths.proofLedger`, then `.specguard/proofs.json`, so two ledgers can sit side by side <!-- claim: ledger-path -->
- [ ] `proof ingest` and `results ingest` share one `ingestVerdicts` function and write identical rows for the same verdicts <!-- claim: shared-ingest -->

## Scenarios

### Scenario 1: Ingest then a spec edit marks the proof stale

**Steps:**
1. Ingest a `proven` verdict for a claim whose spec exists
2. Change the spec bytes
3. Ask for the effective verdict with the new spec hash

**Expected Results:**
- The stored verdict is still `proven`
- The effective verdict is `stale`

### Scenario 2: Unexercised is not a pass

**Steps:**
1. Ingest a verdict of `unexercised` with `exercised: 0`
2. Read the ledger row

**Expected Results:**
- The stored verdict is `unexercised`
- The effective verdict stays `unexercised` while the spec hash matches

## Dependencies

- specs/core/claims.md
- specs/pipelines/drift.md
- specs/pipelines/status.md
