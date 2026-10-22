---
id: traceability-and-drift
kind: capability
title: Traceability and Drift
parent: system
value: At any moment a team can see how every spec relates to its code, tests, docs and proof, and be told as soon as code and specs stop agreeing.
status: active
sources:
  - "src/core/drift-registry.ts"
  - "src/core/claim-hash.ts"
  - "src/core/claim-prepass.ts"
  - "src/core/status.ts"
  - "src/pipelines/status.ts"
  - "src/pipelines/gap-analysis.ts"
  - "src/pipelines/matrix.ts"
  - "src/pipelines/align.ts"
  - "src/pipelines/drift.ts"
  - "src/cli/commands/status.ts"
  - "src/cli/commands/gap-analysis.ts"
  - "src/cli/commands/matrix.ts"
  - "src/cli/commands/drift.ts"
  - "src/cli/commands/align.ts"
  - "src/core/trace.ts"
  - "src/core/drift-assessments.ts"
  - "src/core/intent-gap.ts"
  - "src/pipelines/check.ts"
  - "src/pipelines/drift-capability.ts"
  - "src/cli/commands/check.ts"
tests:
  - "tests/core/drift-registry.test.ts"
  - "tests/core/claim-hash.test.ts"
  - "tests/core/claim-prepass.test.ts"
  - "tests/pipelines/status.test.ts"
  - "tests/pipelines/matrix.test.ts"
  - "tests/pipelines/align.test.ts"
  - "tests/pipelines/drift.test.ts"
  - "tests/pipelines/paths.test.ts"
  - "tests/regression/hirocky.test.ts"
  - "tests/pipelines/check.test.ts"
  - "tests/pipelines/drift-capability.test.ts"
docs:
  - "README.md"
history:
  - 2026-10-15-functional-specs-and-four-pillars
  - 2026-10-22-0-3-phase-1-workspace-ignore-sync-and-co
  - 2026-10-22-0-3-phase-3-test-layers-and-ci
  - 2026-10-22-security-no-data-classification-requirem
  - 2026-10-22-security-no-access-control-requirement-o
---

# Traceability and Drift

## Problem & Value
Code changes faster than the documents that describe it. Without a continuous answer to "which spec owns this file, which tests cover this requirement, and has the code moved since the spec was written?", specs rot silently and tests stop meaning anything. Reviewers and auditors cannot tell whether a requirement is implemented, tested or merely written down.

This capability computes that answer on demand and without opinion. It links specs to source files, tests and docs; reports which source files have no owning spec or no test; lists specs that have no code or still have unchecked criteria; checks whether the tests actually exercise each scenario and claim; and detects when source has changed in a way the spec no longer describes. The result is a single, CI-gateable picture of spec health, expressed in stable exit codes and JSON files under `.specguard/`.

## Users & Journeys
- A developer runs `specguard status` before opening a pull request to learn which source files still lack a spec or a test.
- A CI job runs `specguard drift --since main` and fails the build when code changed in ways the spec does not describe.
- An auditor runs `specguard matrix --format csv` to hand compliance a spec-to-test-to-doc traceability table, with per-claim test linkage.
- A tech lead runs `specguard gap-analysis` to see which specs have no implementation yet and gets a build plan per missing spec to hand to a coding agent.
- A QA engineer runs `specguard align` to learn which spec scenarios and claims no test actually exercises.

## Requirements
- [ ] Status reports, for every configured app, how many non-test source files have an owning spec and how many have a test, and lists the files without a spec; test files are never counted as source files that need their own spec. <!-- claim: status-coverage-report -->
- [ ] Status exits with the missing-specs code (4) when any source file lacks a spec and 0 otherwise, never calls the LLM and never writes files; an app with no matching source files is not an error. <!-- claim: status-exit-code -->
- [ ] A spec counts as having a test when a test carries one of its claim tags or a test file matches its name, with the claim tag taking precedence over the file-name fallback. <!-- claim: no-test-by-claim-tag -->
- [ ] When a proof ledger exists status appends a proofs summary, and that summary never changes the exit code. <!-- claim: proof-lines-informational -->
- [ ] All pipelines identify specs by one canonical spec key, so tags, registry entries, matrix rows and alignment entries agree across per-app spec directories. <!-- claim: canonical-keys -->
- [ ] The traceability matrix lists, for every spec, its title and the test files, doc files and source files linked to it, and exits 0 because it is informational. Tests are discovered from the configured test output, test source globs and extra test sources, and the matrix is written as JSON by default or CSV on request, scoped to one app when asked. <!-- claim: matrix-links-all-artifacts -->
- [ ] Each matrix entry lists its claims with the tests whose title, tag or annotation carries that claim's tag, and a test file that carries a claim tag is listed even when its name does not match the spec. <!-- claim: per-claim-linkage -->
- [ ] Gap analysis classifies each spec as unimplemented (no owning source), partial (source exists but unchecked criteria remain) or implemented, ignoring test files when deciding whether source exists. <!-- claim: gap-classification -->
- [ ] Gap analysis writes `.specguard/gaps.json` on every run, writes an agent-readable summary plan when any gap exists, generates LLM implementation plans only for unimplemented specs and never when planning is disabled, and survives an LLM failure without throwing. <!-- claim: gap-artifacts-and-plans -->
- [ ] Gap analysis exits with the missing-specs code (4) when any gap exists and 0 otherwise, and can be restricted to a single spec. <!-- claim: gap-exit-code -->
- [ ] Alignment settles claims and scenarios deterministically from claim tags and scenario names in test titles, and sends only what remains uncovered, with the tests that plausibly relate to it, to the LLM. <!-- claim: align-prepass-first -->
- [ ] Alignment makes no LLM call for a spec with nothing left uncovered, scores deterministic and LLM-covered scenarios together, records covered and uncovered claims per entry, and checkpoints `.specguard/alignment.json` after every spec. <!-- claim: align-score-and-checkpoint -->
- [ ] Drift records a content hash per source file in a portable drift registry keyed by repo-relative POSIX paths, skips the LLM when a file's hash is unchanged, and asks the LLM for a semantic verdict only when it changed. <!-- claim: drift-hash-registry -->
- [ ] On the first run, or with `--mtime`, drift falls back to comparing source and spec modification times, and it still populates the registry; `--force` re-evaluates every file regardless of hash. <!-- claim: drift-mtime-fallback -->
- [ ] Drift exits with the drift code (3) when any spec has drifted, treats a changed source file with no spec as drift, warns and scans all configured sources when git is unavailable, and reports specs with no matching source as orphans. <!-- claim: drift-exit-and-orphans -->
- [ ] A stored proof whose recorded spec hash or drift-registry file hash no longer matches is reported as drift. <!-- claim: stale-proof-is-drift -->
- [ ] For v2 specs a claim's hash covers only that claim's text and the Problem & Value section, so editing other claims, scenarios, frontmatter or history does not make a proof stale, while changing Problem & Value does. <!-- claim: claim-scoped-hash -->
- [ ] one trace model (system, capability, claim) behind a single `check` command whose legacy aliases (`status`, `gap-analysis`, `drift`, `matrix`, `align`) return identical results. <!-- claim: planned-unified-check -->
- [ ] drift is evaluated per capability from all of its source files, reports at claim level, and chunks large diffs so a capability-sized spec stays within the LLM context. <!-- claim: planned-capability-drift -->
- [ ] `check` summary exits 2 on spec rule violations, 4 when a source file has no owning spec or a non-planned capability owns no files, and 0 otherwise; `--coverage`, `--gaps` and `--matrix [--csv]` render the same trace model, which is also written to `.specguard/trace.json` <!-- claim: check-exit-codes -->
- [ ] A v2 proof goes stale for a changed owned file only when no drift assessment covers that exact file version, or the assessment names the claim; a changed file nobody assessed stales every claim of its capability <!-- claim: claim-scoped-file-staleness -->
- [ ] Capability drift baselines a capability on its first run, afterwards assesses only files whose content changed, records an assessment per file version, skips lockfiles and build output without a model call, treats a missing verdict as affecting every claim, and reports changed files no capability owns <!-- claim: capability-drift-assessments -->
- [ ] Large capability diffs are filtered, ranked with interface-like files first, packed into chunks of about 40k characters (an oversized file reduced to headers and declarations), and capped per capability with the remainder reported for manual review <!-- claim: drift-chunking -->

## Scenarios
### Scenario 1: A new file has no spec
**Steps:**
1. A developer adds a source file that no spec lists or matches.
2. They run `specguard status`.

**Expected Results:**
- The report lists the file as missing a spec and the totals show coverage below 100%.
- The command exits with code 4.
- No LLM call is made and no file is written.

### Scenario 2: Source changes in a way the spec does not describe
**Steps:**
1. A registry already exists from an earlier `specguard drift` run.
2. A developer changes an exported function's behaviour in a source file owned by a spec.
3. CI runs `specguard drift --since main`.

**Expected Results:**
- The changed file's hash differs from the registry, so the LLM is asked whether the diff affects the spec.
- When the verdict is drift, the spec is listed, the summary reads `drift: <N> spec(s) drifted` and the exit code is 3.
- Unchanged files are skipped without an LLM call.

### Scenario 3: First drift run on an existing repository
**Steps:**
1. A repository has specs but no `.specguard/drift-registry.json`.
2. The developer runs `specguard drift`.

**Expected Results:**
- A modification-time comparison reports source files newer than their specs.
- The registry is created with a hash per source file so later runs use hashes.
- The command does not fail on a shallow clone or missing git history; it warns and scans all sources.

### Scenario 4: Editing one claim does not stale another claim's proof
**Steps:**
1. A capability spec has claims `a` and `b`, and a proof exists for `b`.
2. A developer rewrites the text of claim `a` and adds a scenario.
3. Status or drift is run.

**Expected Results:**
- The claim hash of `b` is unchanged, so its proof is not stale.
- The claim hash of `a` changed, so any proof of `a` is stale.
- If the Problem & Value section is edited, every claim's hash changes.

### Scenario 5: Auditor exports the traceability matrix
**Steps:**
1. Tests carry `@claim:<specKey>#<claimId>` tags in their titles.
2. The auditor runs `specguard matrix --format csv --out audit/trace.csv`.

**Expected Results:**
- The file lists every spec with its tests, docs and source modules.
- Claim linkage in the JSON form shows which tests carry each claim, including test files whose names do not match the spec.
- The command exits 0 and prints how many entries were written.

### Scenario 6: Alignment only spends tokens on what is uncovered
**Steps:**
1. A spec has three scenarios and two claims. Tests name two scenarios in their titles and tag one claim.
2. The developer runs `specguard align`.

**Expected Results:**
- Only the remaining scenario and claim are placed in the LLM prompt, with tests that relate to the spec.
- A spec whose scenarios and claims are all settled makes no LLM call and scores 100.
- `.specguard/alignment.json` records covered and uncovered claims for the spec.

## Security & Data Considerations
These pipelines read source, specs and tests and write only JSON, CSV and Markdown plans under `.specguard/`. The drift registry stores hashes, timestamps and verdicts, never file content or credentials, and uses repo-relative keys so it can be committed and compared across machines. Hashes detect change; they are not an integrity guarantee against an adversary. Diffs and spec excerpts sent to the LLM for drift and alignment are subject to the configured redaction. LLM keys are referenced by environment variable name only and never appear in plans, `gaps.json` or the registry. Plan file names derive from the spec key with path separators replaced. Traceability output reveals spec and test names, so treat the output directory as internal.

## Interfaces
- CLI: `specguard status`, `specguard gap-analysis [--spec <key>] [--all] [--no-plan]`, `specguard matrix [--out <path>] [--format json|csv] [--app <name>]`, `specguard align [--app] [--spec] [--all] [--concurrency <n>] [--fresh] [--extra-tests <globs...>]`, `specguard drift [--since <ref>] [--spec <key>] [--force] [--mtime]`.
- MCP tools: `specguard_status`, `specguard_drift`, `specguard_matrix`, `specguard_gap_analysis`, `specguard_check`.
- Files under `.specguard/`: `drift-registry.json`, `gaps.json`, `plans/<feature>.md`, `plans/gap-analysis-<timestamp>.md`, `alignment.json`, `traceability.json` (path configurable through `matrix.output`).
- Exit codes: 0 success, 3 drift detected, 4 missing specs or gaps present, 1 internal error.
- `specguard check` with the legacy commands as aliases.

## Out of Scope
- Running tests or recording proof verdicts (see conformance-testing).
- Judging the running system in a browser (see agentic-verification).
- Writing or rewriting specs (see spec-authoring).
- Serving the matrix over HTTP (see documentation-api).
