# GitHub Action and release workflow

<!--
  module: action/run-gates.mjs
  type: cli
  status: draft
-->

## Overview

`action.yml` is a composite GitHub Action. It installs `specguard-ai`, runs the requested gates through `action/run-gates.mjs`, writes a job summary and per-gate JSON under `.specguard/ci/`, uploads `.specguard/` as an artifact without secrets, and fails the job on the `fail-on` thresholds. `.github/workflows/release.yml` publishes the CLI and the extension together from a version tag. `docs/ci.md` is the user-facing reference.

## Acceptance Criteria

- [ ] `action.yml` is `runs.using: composite`, sets up Node, installs `specguard-ai@<version>` (or builds the checkout when `version` is `local`), runs `action/run-gates.mjs`, and uploads `.specguard/` excluding `.specguard/.env` and `.specguard/auth/` <!-- claim: composite-action -->
- [ ] Gates run in a fixed order: status, drift, proof, align, results, validate, security, deps; an unknown gate is rejected before anything runs <!-- claim: gate-order -->
- [ ] `fail-on` trips `missing-specs`, `drift`, `proof-failed` (failed plus error), `proof-stale`, `proof-unexercised`, `proof-unproven`, `align-below:<n>`, `results`, `validate`, `security`, and `deps` from the gates' exit codes and the `PROOFS:` line, and `none` never trips <!-- claim: fail-on -->
- [ ] A gate that did not run, or a missing proof ledger, never fails the job <!-- claim: no-run-no-fail -->
- [ ] The `results` gate runs `results ingest` with the `results` input and `run-id`, and does nothing without inputs <!-- claim: results-gate -->
- [ ] A release tag must equal the root `package.json` version, the CLI is published before the extension, and both are built at that version <!-- claim: release-lockstep -->
- [ ] CI runs typecheck, ESLint, the CLI and extension tests, the builds, checks that the bundled CLI reports the package version, and runs `status` and `proof status` on SpecGuard itself through the action <!-- claim: ci-dogfood -->

## Scenarios

### Scenario 1: A failed claim fails the job

**Steps:**
1. The `results` gate ingests a report with a failing tagged test
2. `proof status` reports `1 failed`
3. `fail-on` includes `proof-failed`

**Expected Results:**
- The job summary says `Failed on: proof-failed` and the step exits 1
