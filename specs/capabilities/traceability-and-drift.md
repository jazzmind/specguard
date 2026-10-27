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
  - "src/core/proof-statement.ts"
  - "src/pipelines/statement-input.ts"
tests:
  - "tests/core/drift-registry.test.ts"
  - "tests/core/claim-hash.test.ts"
  - "tests/core/claim-prepass.test.ts"
  - "tests/pipelines/status.test.ts"
  - "tests/pipelines/matrix.test.ts"
  - "tests/pipelines/align.test.ts"
  - "tests/pipelines/drift.test.ts"
  - "tests/pipelines/paths.test.ts"
  - "tests/regression/multi-app.test.ts"
  - "tests/pipelines/check.test.ts"
  - "tests/pipelines/drift-capability.test.ts"
  - "tests/core/proof-statement.test.ts"
  - "tests/pipelines/statement-input.test.ts"
  - "tests/pipelines/check-statement.test.ts"
docs:
  - "README.md"
history:
  - 2026-10-15-functional-specs-and-four-pillars
  - 2026-10-22-0-3-phase-1-workspace-ignore-sync-and-co
  - 2026-10-22-0-3-phase-3-test-layers-and-ci
  - 2026-10-22-security-no-data-classification-requirem
  - 2026-10-22-security-no-access-control-requirement-o
  - 2026-10-26-proof-statement-is-a-pure-composition-wi
  - 2026-10-26-check-leads-with-the-proof-statement-exi
  - 2026-10-27-check-traces-record-the-engine-version-u
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
- [ ] A saved check trace records the checking tool's name, package version and Node version in an additive `tool` field beside its existing checked-commit statement, keeping trace version 1; readers of an older trace with no tool field treat the engine version as unknown <!-- claim: check-engine-provenance -->
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
- [ ] The proof statement judges each capability on four pillars, each `ok`, `fail` or `unknown`: Approved (a person approved each claim and example row at its current wording), Testable (the claims pass the testability lint and the capability has anchored claims), Aligned (coverage evidence shows the owned code is reached by the claims' tests, and for a changed claim that the change is specified) and Conforms (the proof ledger, required layers, example rows, test strength, mutation sensitivity and assurance level hold); every reason is listed with a code, a message and a command that fixes it, and a planned capability is evaluated on Approved and Testable only <!-- claim: statement-four-pillars -->
- [ ] The statement keeps approval in its own pillar and takes the raw proof-ledger verdict with no drift-assessment opinion: an unapproved claim with a passing proof is still proven, and approval never turns a proof stale or failed <!-- claim: statement-approval-own-pillar -->
- [ ] A capability is certified at a commit only when all four pillars are `ok`, every piece of evidence it used was earned in CI, the commit is known and none of the capability's input files has uncommitted changes; the same pillars with local or server evidence or a dirty input are provisional, anything else is not certified, a planned capability is planned, and the system is certified only when every non-planned capability is certified and no source file is unowned <!-- claim: statement-certified-rule -->
- [ ] Pillar status never depends on policy: the `proof.require*` gate flags (approval, testable, strength, sensitivity, conforms, alignment, ci) and `proof.strict` decide only which reasons are marked blocking, with every flag off by default and `strict` turning all on with `enforceLayers` at `fail`; a reason whose gate is `never` (a capability that owns no files, an intent gap) never blocks <!-- claim: statement-policy-only-blocks -->
- [ ] A repository that uses none of the new features keeps its `check` lines and exit codes: its statement reads not certified with the exact reasons (no approvals recorded, no coverage evidence, strength not analysed), no reason blocks, and the statement exit code is 0 <!-- claim: statement-degradation -->
- [ ] The statement's exit code is 13 (not certified) only when at least one reason is blocking under a gate flag that is on, and 0 otherwise; the existing codes 2, 3 and 4 keep their precedence over it <!-- claim: statement-exit-code-not-certified -->
- [ ] Blocking reasons are ordered by pillar (Approved, Testable, Aligned, Conforms), failures before unknowns, capability-level reasons before claim-level ones, then spec order, and the capability headline names the count and the first two <!-- claim: statement-blocking-precedence -->
- [ ] The statement serialises to a stable JSON shape (version, policy, level, counts, exit code and per capability the pillars with their reasons, blocking reasons, claims, metrics and evidence), renders one `STATEMENT:` line per capability and a system line, and `--explain` text lists the pillars, each blocking reason with its fix, the advisory reasons and the stated limits of the evidence <!-- claim: statement-json-and-explain -->
- [ ] Composing the statement is pure and deterministic: the same input gives a deep-equal output, the input is not changed, and the module reads no file, runs no process and calls no model <!-- claim: statement-is-pure -->
- [ ] The `check` summary prints one `STATEMENT:` line per capability and a system line before any other line, sets the statement on the result and records it in `.specguard/trace.json` as an optional field with the trace version unchanged, and every other summary line (capability lines, TOTAL, ORPHANS, PROOFS, LAYERS, intent gaps) stays as it was <!-- claim: check-leads-with-statement -->
- [ ] `check --explain <capability>` (and the `explain` input of `specguard_check`) prints that capability's pillars, its blocking reasons first with the command that fixes each and then its advisory reasons, returns the statement scoped to that capability, exits 13 when that capability has a blocking reason and 0 otherwise, and exits 1 naming the known capabilities when the id is unknown <!-- claim: check-explain -->
- [ ] `check --strict` (and the `strict` input of `specguard_check`) judges the statement with every `proof.require*` gate on and `enforceLayers` at `fail`, without changing the config file <!-- claim: check-strict -->
- [ ] With every proof gate off `check` returns the exit codes it returned before the statement existed, because the statement contributes 0 whatever its pillars say <!-- claim: check-exit-unchanged-without-gates -->
- [ ] The `check` summary exits 13 only when the statement has a blocking reason and none of codes 2, 3 and 4 applies, so an unapproved claim under `requireApproval`, a claim that fails the lint under `requireTestable`, a skipped or assertion-free test under `requireStrength`, local evidence under `requireCi` and a changed claim without sensitivity evidence under `requireSensitivity` each exit 13 with that reason listed <!-- claim: check-exit-13-only-with-gate -->
- [ ] The statement input is assembled from the repository: per claim the approval at its current wording (or the newest approval of an older wording), the testability lint under the project config, the strength of the tests tagged to it, and the origin, commit and evidence kind of the ledger rows its verdict rests on; per capability the coverage evidence (its own, else the suite's) and the mutation evidence scored per claim, when ingested; and the head commit with the uncommitted files some capability depends on <!-- claim: statement-input-assembly -->
- [ ] Each test file is read once for the statement, however many capabilities and claims cite it <!-- claim: statement-input-reads-tests-once -->
- [ ] The statement takes ledger verdicts judged by hashes alone, so a changed owned file leaves a claim not conforming even when a drift assessment says the change does not affect it <!-- claim: statement-input-deterministic-ledger -->
- [ ] Evidence the repository does not hold (no ledger, coverage, mutation report, base ref or git checkout) is passed as absent, so its pillar reads unknown and never fail, and a base ref that does not resolve gives a warning and no change judgement <!-- claim: statement-input-absent-is-unknown -->
- [ ] With a base ref (`check --since <ref>`) the statement classifies each claim as added, modified or unchanged against that ref and reports the policy the change relaxed (spec `layers`, `assurance` and `evidence` frontmatter, config gates and weakened tests); without a base no change is judged <!-- claim: statement-input-change-mode -->

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
- `specguard check [--explain <capability>] [--strict] [--since <ref>] [--json]`: the summary leads with the proof statement; the same inputs (`explain`, `strict`, `since`) on `specguard_check`.
- Exit codes: 0 success, 3 drift detected, 4 missing specs or gaps present, 1 internal error, 13 not certified (a blocking proof-statement reason under an enabled `proof` gate).
- `specguard check` with the legacy commands as aliases.

## Out of Scope
- Running tests or recording proof verdicts (see conformance-testing).
- Judging the running system in a browser (see agentic-verification).
- Writing or rewriting specs (see spec-authoring).
- Serving the matrix over HTTP (see documentation-api).
