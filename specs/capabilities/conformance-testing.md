---
id: conformance-testing
kind: capability
title: Conformance Testing
parent: system
value: Teams can prove, claim by claim, that the current code delivers what the specs say, and see immediately when a proof is no longer trustworthy.
status: active
sources:
  - "src/core/claim-tags.ts"
  - "src/core/test-results.ts"
  - "src/core/proof-ledger.ts"
  - "src/core/dependency-fingerprint.ts"
  - "src/core/framework-profiles.ts"
  - "src/adapters/test-runners.ts"
  - "src/pipelines/forward-generate.ts"
  - "src/pipelines/heal.ts"
  - "src/pipelines/results.ts"
  - "src/pipelines/proof.ts"
  - "src/cli/commands/generate.ts"
  - "src/cli/commands/heal.ts"
  - "src/cli/commands/results.ts"
  - "src/cli/commands/proof.ts"
  - "src/pipelines/test-run.ts"
  - "src/cli/commands/test.ts"
  - "src/core/claim-migration.ts"
tests:
  - "tests/core/claim-tags.test.ts"
  - "tests/core/test-results.test.ts"
  - "tests/core/framework-profiles.test.ts"
  - "tests/adapters/test-runners.test.ts"
  - "tests/pipelines/forward-generate.test.ts"
  - "tests/pipelines/heal.test.ts"
  - "tests/pipelines/results.test.ts"
  - "tests/pipelines/proof.test.ts"
  - "tests/mcp/ingest-tools.test.ts"
  - "tests/fixtures/results/**"
  - "tests/pipelines/test-run.test.ts"
docs:
  - "README.md"
  - "docs/ci.md"
history:
  - 2026-10-15-functional-specs-and-four-pillars
---

# Conformance Testing

## Problem & Value
A spec is only a claim until something shows the code honours it. Tests written by hand drift from the spec, tests written by an LLM may assert nothing meaningful, and a green run yesterday says little about the code changed today. Reviewers cannot tell which requirements are actually exercised, which merely have a test file with a similar name, and which proofs have silently expired.

Conformance testing turns specs into tests, runs the project's own test suite through whatever runner it uses, and reduces the results to one verdict per claim in a single proof ledger. A proof records exactly what it was based on (the claim text, the source files, the dependencies), so it goes stale the moment any of those change. Failing tests are triaged into "the test is wrong" and "the application is wrong", and only the first is ever repaired automatically.

## Users & Journeys
- A developer runs `specguard generate --spec <key>` to turn a spec's scenarios into a test file whose titles carry claim tags.
- A CI job runs the project's tests, then `specguard results ingest report.json` to record a verdict for every tagged claim without any LLM call.
- A developer runs `specguard heal` after a refactor to learn which failing tests are stale and have them rewritten, and which failures are real application bugs.
- A reviewer runs `specguard proof status` to see which claims are failed or stale before approving a release.
- An external system (a QA service, a manual test tool) posts a verdicts file with `specguard proof ingest` so its evidence appears next to the rest.
- A polyglot team points the same flow at pytest, go test, cargo test or Maven Surefire output without changing how claims are tagged.

## Requirements
- [ ] Generation turns every scenario of a spec into one test block titled with the scenario name, importing the module the spec declares, for a single spec or all specs and optionally limited to one app. <!-- claim: generate-per-scenario -->
- [ ] Generation supports unit, integration and end-to-end test types, uses the owning app's framework unless overridden, and uses a browser framework for end-to-end tests in TypeScript. <!-- claim: generate-test-types -->
- [ ] When a spec has claims, the generation prompt lists each claim with its exact tag and requires it in the verifying test's title, and generation warns about every claim whose tag is missing from the output while still writing the file. <!-- claim: generate-claim-tags -->
- [ ] Generation never overwrites an existing test file unless forced, strips stray Markdown fences from LLM output, and records an LLM failure for one spec without stopping the others. <!-- claim: generate-safe-writes -->
- [ ] A claim tag is recognised in the forms `@claim:<spec>#<id>`, `[claim: <spec>#<id>]` and `[claims: a#b, c#d]`, in titles, tags and annotations, with an optional repository prefix, and all consumers read tags through the same logic. <!-- claim: claim-tag-forms -->
- [ ] Tests are run through a runner adapter for vitest, jest, playwright, pytest, any JUnit-producing runner, go and cargo, and results are always read from the reporter's output file, never scraped from stdout. <!-- claim: runner-adapters -->
- [ ] Adapters inject the reporter flags the runner needs (with a single separator for npm scripts), run the command verbatim when a results file is configured, pass a test selection as file arguments, merge a results glob, kill a run that exceeds its timeout, and can run inside a Docker sandbox with the repository mounted, where a missing Docker or image is a clear failure that never falls back to the host. <!-- claim: runner-invocation -->
- [ ] Reporter output of every supported format is normalised into one result shape covering passes, failures and skips, the format can be auto-detected, and unparseable input is a named error rather than an empty list. <!-- claim: normalised-results -->
- [ ] A claim's verdict is failed when any tagged test fails, proven when at least one passes and none fail, and unexercised otherwise, with counts of exercised tests and counterexamples. <!-- claim: claim-verdict-rule -->
- [ ] The proof ledger stores proven, failed, unexercised and error verdicts; stale is computed and never stored, and unproven means the ledger has no row for the claim. <!-- claim: ledger-verdict-states -->
- [ ] A proof is stale when the spec (or, for v2 specs, the claim) hash changed, when a source file recorded at ingest changed on disk, or when the repository's dependency fingerprint changed; a file that vanished from the registry alone does not make it stale. <!-- claim: stale-rule -->
- [ ] Each stored row records the claim hash, the source file hashes taken from the spec's declared sources, the dependency fingerprint, the run id, the git revision and the evidence path, so editing one source file stales exactly the claims of the specs that declare it. <!-- claim: ledger-records-basis -->
- [ ] Ingesting verdicts rejects a file without a run id or verdicts, fails and does not store a verdict for an unparseable reference, missing spec or unknown claim, and lets a later ingest replace an earlier row. <!-- claim: ingest-validation -->
- [ ] `results ingest` merges several report files before aggregating, detects or accepts an explicit format, accepts a run id, records a repo-relative evidence path, and exits 2 when any claim failed or a file could not be parsed. <!-- claim: results-ingest -->
- [ ] A partial ingest only writes verdicts for claims present in the results, while the sweep option stores unexercised for absent claims only on a declared full run and never downgrades a still-matching proven claim. <!-- claim: partial-and-sweep -->
- [ ] `proof ingest` and `results ingest` share one code path, write identical rows for identical verdicts, and use a ledger path from `--ledger`, then `paths.proofLedger`, then `.specguard/proofs.json`, kept portable with repo-relative keys. <!-- claim: shared-ingest-and-ledger-path -->
- [ ] `proof status` lists failed and stale claims and exits 2 when any exist, while `status` shows proof counts without changing its exit code and `drift` reports each stale proof. <!-- claim: proof-reporting -->
- [ ] Healing runs one job per distinct test command, classifies each failing test as a test bug or an application bug, rewrites only test code and re-runs up to the retry budget, and never modifies application source. <!-- claim: heal-classifies-failures -->
- [ ] Healing treats a missing or unparseable report as a failure even when the runner exited 0 unless told to be lenient, exits 7 while any test remains broken including application bugs, and with classify-only never writes or re-runs. <!-- claim: heal-exit-and-safety -->
- [ ] Framework detection recognises common web, API and CLI frameworks from the repository's manifests, falls back to a generic profile and honours an explicit entry-point override. <!-- claim: framework-profiles -->
- [ ] `test run` runs each configured app's tests through its runner adapter, reads the report from the file the runner writes, and ingests the verdicts into the proof ledger in one step, so tests run locally and results produced by CI land in the same ledger <!-- claim: test-run-ingests -->
- [ ] `test run` exits non-zero when a suite fails, when a runner produces no readable report, or when a tagged claim fails, even if no failing test carries a claim tag <!-- claim: test-run-fails-honestly -->
- [ ] A proof records what produced it: a test run leaves `evidence` unset and an agentic browser run records `agentic` <!-- claim: proof-evidence-kind -->
- [ ] `test generate`, `test run` and `test heal` group the test commands; the older `generate` and `heal` names keep working <!-- claim: test-command-group -->
- [ ] After a consolidation, results that still carry old claim tags are accepted for one release through `.specguard/claim-migration.json` and recorded under the new claim refs <!-- claim: old-claim-tags-accepted -->

## Scenarios
### Scenario 1: Spec to tagged tests
**Steps:**
1. A capability spec has two claims and three scenarios.
2. A developer runs `specguard generate --spec <key> --type unit`.

**Expected Results:**
- One test file is written with one test per scenario.
- Titles of the tests that verify the claims include the exact `@claim:` tags.
- Running again without `--force` skips the file and makes no LLM call.

### Scenario 2: CI records proof from a normal test run
**Steps:**
1. CI runs the suite with a JSON or JUnit reporter.
2. CI runs `specguard results ingest report.json --run-id build-42`.

**Expected Results:**
- Each tagged claim gets `proven`, `failed` or `unexercised` according to its tests.
- Each row carries the source hashes and dependency fingerprint of that moment.
- The command exits 2 if any claim failed and 0 otherwise.

### Scenario 3: A source edit invalidates only the right proofs
**Steps:**
1. Proofs exist for claims in two specs; only the first declares `src/a.ts`.
2. A developer edits `src/a.ts`.
3. `specguard proof status` runs.

**Expected Results:**
- Claims of the first spec are reported stale.
- Claims of the second spec remain proven.
- The command exits 2 because stale proofs exist.

### Scenario 4: Heal separates test bugs from application bugs
**Steps:**
1. After a refactor two tests fail: one asserts an old label, one catches a real regression.
2. A developer runs `specguard heal`.

**Expected Results:**
- The stale assertion is classified as a test bug, rewritten and the suite re-run.
- The regression is reported as an application bug with a reason and no source is changed.
- The command exits 7 because the suite is still red.

### Scenario 5: A broken report is not a pass
**Steps:**
1. The test command exits 0 but writes no parseable results file.
2. A developer runs `specguard heal`.

**Expected Results:**
- The run is reported as a failure with exit code 7.
- With `--lenient` the same situation is treated as passing.

### Scenario 6: External evidence is submitted
**Steps:**
1. A QA service writes a verdicts file with a run id and verdicts for claim references.
2. It runs `specguard proof ingest verdicts.json`.

**Expected Results:**
- Valid claims are stored, replacing earlier rows for the same claim.
- A reference to a claim with no anchor in its spec is reported as failed and not stored.

### Scenario 7: A polyglot suite
**Steps:**
1. A Python service configures `test: { command: "pytest" }`.
2. `heal` or `results ingest` runs against the generated JUnit XML.

**Expected Results:**
- Pytest runs with a JUnit reporter flag and results are read from the file.
- Claim tags in test names or properties map to claims exactly as for other runners.

## Security & Data Considerations
Test commands come from the repository's own configuration and run with the developer's or CI's privileges; the Docker sandbox option isolates them when the code is not trusted. Heal and generate send test code, spec text and failure messages to the LLM and are subject to configured redaction, and heal only ever writes test files. Verdict files from external systems are untrusted input: they are schema-checked, every claim reference must resolve to an anchored claim, and unknown references are rejected rather than stored. The ledger holds hashes, counts and relative paths, never secrets, and its keys are repo-relative so it is portable. Evidence paths must stay inside the repository.

## Interfaces
- CLI: `specguard generate [--spec <key>] [--all] [--app <name>] [--framework <name>] [--force] [--type unit|integration|e2e]`; `specguard heal [--spec] [--all] [--app] [--max-retries <n>] [--classify-only] [--lenient]`; `specguard results ingest <file...> [--format auto|vitest|jest|playwright|junit|pytest|go|cargo] [--run-id <id>] [--unexercised|--sweep] [--full-run] [--ledger <file>]`; `specguard proof ingest <verdicts> [--ledger <file>]`; `specguard proof status [--ledger <file>]`.
- MCP tools: `specguard_generate`, `specguard_heal`, `specguard_results_ingest`, `specguard_proof_ingest`, `specguard_proof_status`.
- Files: `.specguard/proofs.json` (or `paths.proofLedger`, workspace root when a workspace file exists); per-app config `test: { command, cwd, reporter, resultsFile, timeoutMs, image }`; `heal.maxRetries`, `heal.testCommand`.
- Claim tag: `@claim:<specKey>#<claimId>`.
- Exit codes: 0 success, 2 failed or stale claims or unparseable results, 7 heal failed.

## Out of Scope
- Replacing the project's test runner or CI system.
- Judging the running system in a browser (see agentic-verification).
- Detecting drift between source and specs (see traceability-and-drift).
- Repairing application source code (see security-and-remediation for planned fixes).
