---
title: "Traceability and Drift (developer reference)"
audience: dev
source: "specs/capabilities/traceability-and-drift.md"
generated: true
---
<a id="traceability-and-drift"></a>
# Traceability and Drift

<a id="purpose"></a>
## Purpose

Code changes faster than the documents that describe it. This capability answers, on demand and without opinion, three questions: which spec owns a file, which tests cover a requirement, and whether the code has moved since the spec was written.

It links specs to source files, tests and docs. It reports files with no spec or no test, and specs with no code or with unchecked criteria. It checks whether tests exercise each scenario and claim, and it detects source changes the spec no longer describes. Results are exposed as stable exit codes and JSON, CSV and Markdown files under `.specguard/`, so they can gate CI.

Out of scope (handled elsewhere): running tests or recording proof verdicts (conformance-testing), judging the running system in a browser (agentic-verification), writing or rewriting specs (spec-authoring), and serving the matrix over HTTP (documentation-api).

<a id="responsibilities"></a>
## Responsibilities

- **Coverage status**: per app, how many non-test source files have an owning spec and a test.
- **Gap analysis**: classify specs as unimplemented, partial or implemented, and produce build plans for unimplemented specs.
- **Traceability matrix**: spec → title, tests, docs, sources, with per-claim test linkage, as JSON or CSV.
- **Alignment**: decide which scenarios and claims no test exercises. A deterministic pre-pass runs first, and the LLM sees only what remains.
- **Drift detection**: hash-based, with a modification-time fallback. Also reports orphans and stale proofs.
- **Claim-scoped hashing** for v2 specs.
- **Unified `check`**: one trace model, written to `.specguard/trace.json`, with the proof statement leading the summary.
- **Proof statement**: four pillars per capability, a certification rule, policy gates and exit code 13.
- **Regression and workspace reports**.

Typical journeys:

| Who | Command | Purpose |
|---|---|---|
| Developer | `specguard status` | See which source files lack a spec or test before a PR |
| CI | `specguard drift --since main` | Fail when code changed in ways the spec does not describe |
| Auditor | `specguard matrix --format csv` | Spec-to-test-to-doc table with per-claim linkage |
| Tech lead | `specguard gap-analysis` | Find specs with no implementation and get build plans |
| QA | `specguard align` | Find scenarios and claims no test exercises |

<a id="interfaces"></a>
## Interfaces

**CLI**

- `specguard status`
- `specguard gap-analysis [--spec <key>] [--all] [--no-plan]`
- `specguard matrix [--out <path>] [--format json|csv] [--app <name>]`
- `specguard align [--app] [--spec] [--all] [--concurrency <n>] [--fresh] [--extra-tests <globs...>]`
- `specguard drift [--since <ref>] [--spec <key>] [--force] [--mtime]`
- `specguard check [--explain <capability>] [--strict] [--since <ref>] [--json]`, which leads with the proof statement. The legacy commands are aliases of `check` (see `planned-unified-check`).
- `specguard report` (`--run`, `--baseline`, `--workspace`). Its flags are described under `regression-report` and `workspace-report`.

**MCP tools**: `specguard_status`, `specguard_drift`, `specguard_matrix`, `specguard_gap_analysis`, `specguard_check`. `specguard_check` takes the `explain`, `strict` and `since` inputs.

**Files under `.specguard/`**

- `drift-registry.json`
- `gaps.json`
- `plans/<feature>.md`
- `plans/gap-analysis-<timestamp>.md`
- `alignment.json`
- `traceability.json` (path configurable through `matrix.output`)
- `trace.json` (written by `check`)
- `report-links.json` (optional extra links for the workspace report)

**Exit codes**

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Internal error (also `check --explain` with an unknown capability id) |
| 2 | Spec rule violations (`check`) |
| 3 | Drift detected |
| 4 | Missing specs or gaps present |
| 13 | Not certified: a blocking proof-statement reason under an enabled `proof` gate |

Codes 2, 3 and 4 take precedence over 13.

<a id="requirements"></a>
## Requirements

<a id="status-and-coverage"></a>
### Status and coverage

- **`status-coverage-report`**: For every configured app, status reports how many non-test source files have an owning spec and how many have a test, and lists files without a spec. Test files are never counted as source needing their own spec.
- **`status-exit-code`**: Exits 4 when any source file lacks a spec, otherwise 0. It never calls the LLM and never writes files. An app with no matching source files is not an error.
- **`no-test-by-claim-tag`**: A spec has a test when a test carries one of its claim tags or a test file matches its name. The claim tag takes precedence over the file-name fallback.
- **`proof-lines-informational`**: When a proof ledger exists, status appends a proofs summary. It never changes the exit code.
- **`canonical-keys`**: All pipelines identify specs by one canonical spec key, so tags, registry entries, matrix rows and alignment entries agree across per-app spec directories.

<a id="matrix"></a>
### Matrix

- **`matrix-links-all-artifacts`**: For every spec the matrix lists its title and its linked test, doc and source files, and exits 0. Tests come from the configured test output, test source globs and extra test sources. Output is JSON by default or CSV on request, and can be scoped to one app.
- **`per-claim-linkage`**: Each entry lists its claims with the tests whose title, tag or annotation carries the claim's tag. A test file carrying a claim tag is listed even when its name does not match the spec.

<a id="gap-analysis"></a>
### Gap analysis

- **`gap-classification`**: Each spec is unimplemented (no owning source), partial (source exists but unchecked criteria remain) or implemented. Test files are ignored when deciding whether source exists.
- **`gap-artifacts-and-plans`**: Writes `.specguard/gaps.json` on every run and an agent-readable summary plan when any gap exists. LLM implementation plans are generated only for unimplemented specs and never when planning is disabled. An LLM failure does not throw.
- **`gap-exit-code`**: Exits 4 when any gap exists, otherwise 0. Can be restricted to a single spec.

<a id="alignment"></a>
### Alignment

- **`align-prepass-first`**: Claims and scenarios are settled deterministically from claim tags and scenario names in test titles. Only what remains uncovered, with plausibly related tests, goes to the LLM.
- **`align-score-and-checkpoint`**: No LLM call for a spec with nothing uncovered. Deterministic and LLM-covered scenarios are scored together. Covered and uncovered claims are recorded per entry. `.specguard/alignment.json` is checkpointed after every spec.

<a id="drift"></a>
### Drift

- **`drift-hash-registry`**: Records a content hash per source file in a portable registry keyed by repo-relative POSIX paths. Skips the LLM when a hash is unchanged and asks for a semantic verdict only when it changed.
- **`drift-mtime-fallback`**: On the first run, or with `--mtime`, drift compares source and spec modification times and still populates the registry. `--force` re-evaluates every file regardless of hash.
- **`drift-exit-and-orphans`**: Exits 3 when any spec has drifted. A changed source file with no spec counts as drift. When git is unavailable it warns and scans all configured sources. Specs with no matching source are reported as orphans.
- **`stale-proof-is-drift`**: A stored proof whose recorded spec hash or drift-registry file hash no longer matches is reported as drift.
- **`claim-scoped-hash`**: For v2 specs a claim's hash covers only that claim's text and the Problem & Value section. Editing other claims, scenarios, frontmatter or history does not stale a proof. Changing Problem & Value does.
- **`claim-scoped-file-staleness`**: A v2 proof goes stale for a changed owned file only when no drift assessment covers that exact file version, or the assessment names the claim. A changed file nobody assessed stales every claim of its capability.
- **`capability-drift-assessments`**: Capability drift baselines a capability on its first run, then assesses only files whose content changed. It records an assessment per file version and skips lockfiles and build output without a model call. A missing verdict affects every claim. Changed files no capability owns are reported.
- **`drift-chunking`**: Large capability diffs are filtered and ranked with interface-like files first. They are packed into chunks of about 40k characters, with an oversized file reduced to headers and declarations. Chunks are capped per capability, and the remainder is reported for manual review.

<a id="provenance-and-unified-check"></a>
### Provenance and unified check

- **`check-engine-provenance`**: A saved check trace records the tool name, package version and Node version in an additive `tool` field beside its checked-commit statement. Trace version stays 1. Readers of an older trace with no tool field treat the engine version as unknown.
- **`planned-unified-check`** (planned): One trace model (system, capability, claim) behind a single `check` command. Its legacy aliases (`status`, `gap-analysis`, `drift`, `matrix`, `align`) return identical results.
- **`planned-capability-drift`** (planned): Drift evaluated per capability from all its source files, reported at claim level, with large diffs chunked to fit the LLM context.
- **`check-exit-codes`**: The `check` summary exits 2 on spec rule violations. It exits 4 when a source file has no owning spec or a non-planned capability owns no files. Otherwise it exits 0. `--coverage`, `--gaps` and `--matrix [--csv]` render the same trace model, which is also written to `.specguard/trace.json`.

<a id="proof-statement"></a>
### Proof statement

- **`statement-four-pillars`**: Each capability is judged on four pillars, each `ok`, `fail` or `unknown`:
  - **Approved**: a person approved each claim and example row at its current wording.
  - **Testable**: the claims pass the testability lint and the capability has anchored claims.
  - **Aligned**: coverage evidence shows the owned code is reached by the claims' tests and, for a changed claim, that the change is specified.
  - **Conforms**: the proof ledger, required layers, example rows, test strength, mutation sensitivity and assurance level hold.

  Every reason carries a code, a message and a fixing command. A planned capability is evaluated on Approved and Testable only.
- **`statement-approval-own-pillar`**: Approval is its own pillar, and the statement uses the raw proof-ledger verdict with no drift-assessment opinion. An unapproved claim with a passing proof is still proven, and approval never turns a proof stale or failed.
- **`statement-certified-rule`**:
  - A capability is *certified* only when all four pillars are `ok`, all evidence was earned in CI, the commit is known, and no input file has uncommitted changes.
  - The same pillars with local or server evidence, or a dirty input, are *provisional*. Anything else is *not certified*, and a planned capability is *planned*.
  - The system is certified only when every non-planned capability is certified and no source file is unowned.
- **`statement-policy-only-blocks`**: Pillar status never depends on policy. The `proof.require*` flags (approval, testable, strength, sensitivity, conforms, alignment, ci) and `proof.strict` only decide which reasons are *blocking*. All flags are off by default, and `strict` turns all on with `enforceLayers` at `fail`. A reason whose gate is `never` (a capability that owns no files, an intent gap) never blocks.
- **`statement-degradation`**: A repository using none of the new features keeps its `check` lines and exit codes. Its statement reads not certified with exact reasons (no approvals recorded, no coverage evidence, strength not analysed), no reason blocks, and the exit code is 0.
- **`statement-exit-code-not-certified`**: Exit 13 only when at least one reason is blocking under a gate flag that is on, otherwise 0. Codes 2, 3 and 4 keep precedence.
- **`statement-blocking-precedence`**: Blocking reasons are ordered by pillar (Approved, Testable, Aligned, Conforms), failures before unknowns, capability-level before claim-level, then spec order. The capability headline names the count and the first two.
- **`statement-json-and-explain`**: Stable JSON shape: version, policy, level, counts, exit code, and per capability the pillars with reasons, blocking reasons, claims, metrics and evidence. Renders one `STATEMENT:` line per capability plus a system line. `--explain` lists pillars, each blocking reason with its fix, advisory reasons and the stated limits of the evidence.
- **`statement-is-pure`**: Composing the statement is pure and deterministic. Equal input gives deep-equal output, the input is not mutated, and the module reads no file, runs no process and calls no model.

<a id="check-integration"></a>
### `check` integration

- **`check-leads-with-statement`**: The summary prints the `STATEMENT:` lines and the system line before any other line. It sets the statement on the result and records it in `.specguard/trace.json` as an optional field with the trace version unchanged. All other summary lines (capability lines, TOTAL, ORPHANS, PROOFS, LAYERS, intent gaps) are unchanged.
- **`check-explain`**: `check --explain <capability>` (or the `explain` input of `specguard_check`) prints that capability's pillars, blocking reasons first with fixes, then advisory reasons. It returns the statement scoped to that capability. It exits 13 when that capability has a blocking reason and 0 otherwise. It exits 1 naming the known capabilities when the id is unknown.
- **`check-strict`**: `check --strict` (or the `strict` input) judges the statement with every `proof.require*` gate on and `enforceLayers` at `fail`, without changing the config file.
- **`check-exit-unchanged-without-gates`**: With every proof gate off, `check` returns the exit codes it returned before the statement existed.
- **`check-exit-13-only-with-gate`**: `check` exits 13 only when the statement has a blocking reason and none of 2, 3, 4 applies. Examples that each exit 13 with the reason listed:
  - an unapproved claim under `requireApproval`
  - a claim failing the lint under `requireTestable`
  - a skipped or assertion-free test under `requireStrength`
  - local evidence under `requireCi`
  - a changed claim without sensitivity evidence under `requireSensitivity`

<a id="statement-input"></a>
### Statement input

- **`statement-input-assembly`**:
  - Per claim: the approval at its current wording (or the newest approval of an older wording), the testability lint under the project config, the strength of tagged tests, and the origin, commit and evidence kind of the ledger rows the verdict rests on.
  - Per capability: coverage evidence (its own, else the suite's) and mutation evidence scored per claim, when ingested.
  - Repository: the head commit and the uncommitted files some capability depends on.
- **`statement-input-reads-tests-once`**: Each test file is read once, however many capabilities and claims cite it.
- **`statement-input-deterministic-ledger`**: Ledger verdicts are judged by hashes alone, so a changed owned file leaves a claim not conforming even when a drift assessment says the change does not affect it.
- **`statement-input-absent-is-unknown`**: Evidence the repository does not hold (no ledger, coverage, mutation report, base ref or git checkout) is passed as absent. Its pillar reads `unknown`, never `fail`. A base ref that does not resolve gives a warning and no change judgement.
- **`statement-input-change-mode`**: With `check --since <ref>`, each claim is classified added, modified or unchanged against that ref. The statement also reports the policy the change relaxed (spec `layers`, `assurance` and `evidence` frontmatter, config gates, weakened tests). Without a base, no change is judged.

<a id="reports"></a>
### Reports

- **`regression-report`**: `specguard report` writes a self-contained folder: `index.html` with inline CSS and JS and evidence copied beside it, plus `report.json` (schema `specguard-report/1`). It covers a run (`--run`, default latest) and shows:
  - totals by layer
  - a capability and claim table with per-test status, duration and attachments
  - a regression diff against a baseline (`--baseline`, default the previous run with the same label, else the previous run). The diff covers newly failing, newly proven, newly unexercised, removed and flaky.
  - a gap analysis (untested, linked-not-executed, weak-only, partial, failed, proven) with a ranked top-gaps list

  All test text is HTML-escaped.
- **`workspace-report`**: `report --workspace` builds the per-repo report for every non-ignored repo in the workspace manifest under `<out>/repos/<key>/`, each with a link back. It writes `<out>/index.html` and `workspace-report.json` (`specguard-workspace-report/1`). Per repo it shows the latest run, tests, claims proven/failed, a claim-status bar, change since baseline, evidence counts and a short run history, with totals and a link to each repo's report. A repo with no recorded run or a broken config is listed with its error and does not stop the others. Extra links come from `.specguard/report-links.json`.
- **`report-rollup-pure`**: The rollup is built from per-repo report data by pure functions (`repoEntryFromData`, `rollupWorkspace`, `historyOf`). A team server can render the same rollup from data a client published, without reading any repo.

<a id="code-map"></a>
## Code map

Grouped by directory. Roles are inferred from file names only, and the spec does not describe them individually.

**`src/core/`**

- `drift-registry.ts`
- `claim-hash.ts`
- `claim-prepass.ts`
- `status.ts`
- `trace.ts`
- `drift-assessments.ts`
- `intent-gap.ts`
- `proof-statement.ts`

**`src/pipelines/`**

- `status.ts`
- `gap-analysis.ts`
- `matrix.ts`
- `align.ts`
- `drift.ts`
- `drift-capability.ts`
- `check.ts`
- `statement-input.ts`
- `report.ts`
- `workspace-report.ts`

**`src/cli/commands/`**

- `status.ts`
- `gap-analysis.ts`
- `matrix.ts`
- `drift.ts`
- `align.ts`
- `check.ts`
- `report.ts`

Total owned files: 25.

<a id="tests"></a>
## Tests

- **Core**: `tests/core/drift-registry.test.ts`, `claim-hash.test.ts`, `claim-prepass.test.ts`, `proof-statement.test.ts`
- **Pipelines**: `tests/pipelines/status.test.ts`, `matrix.test.ts`, `align.test.ts`, `drift.test.ts`, `paths.test.ts`, `check.test.ts`, `drift-capability.test.ts`, `statement-input.test.ts`, `check-statement.test.ts`
- **Regression**: `tests/regression/multi-app.test.ts`

Behaviours the spec describes as scenarios, useful as acceptance checks:

- A new file with no spec makes `status` list it, show coverage below 100%, exit 4, make no LLM call and write no file.
- With an existing registry, a changed owned file makes `drift --since main` ask the LLM. On a drift verdict the summary reads `drift: <N> spec(s) drifted` and the exit code is 3. Unchanged files are skipped.
- With no registry, the first `drift` run does a modification-time comparison, creates the registry, and warns and scans all sources on a shallow clone or missing git history.
- Rewriting claim `a` and adding a scenario leaves claim `b`'s hash and proof intact. Editing Problem & Value changes every claim's hash.
- `matrix --format csv --out audit/trace.csv` lists every spec with tests, docs and sources, exits 0 and prints the entry count.
- With three scenarios and two claims where tests name two scenarios and tag one claim, `align` puts only the remaining scenario and claim in the prompt. A fully settled spec makes no LLM call and scores 100.

<a id="security-and-data"></a>
## Security and data

- The pipelines read source, specs and tests, and write only JSON, CSV and Markdown plans under `.specguard/`. The `report` command also writes its report folder.
- The drift registry stores hashes, timestamps and verdicts, never file content or credentials. It uses repo-relative keys, so it can be committed and compared across machines.
- Hashes detect change and are not an integrity guarantee against an adversary.
- Diffs and spec excerpts sent to the LLM for drift and alignment are subject to the configured redaction.
- LLM keys are referenced by environment variable name only and never appear in plans, `gaps.json` or the registry.
- Plan file names derive from the spec key with path separators replaced.
- Traceability output reveals spec and test names, so treat the output directory as internal.
- Report test text is HTML-escaped (`regression-report`).

<a id="extending-it"></a>
## Extending it

The spec does not define plugin hooks, so extension means changing the modules above within these constraints:

- **Identify specs by canonical key.** Any new pipeline or output must use the canonical spec key (`canonical-keys`) so it agrees with tags, registry, matrix and alignment.
- **Keep the statement pure.** Put new evidence-gathering in the statement-input assembly (`src/pipelines/statement-input.ts`) and keep the statement composer (`src/core/proof-statement.ts`) free of file, process and model access. Missing evidence must be passed as absent so its pillar reads `unknown`, not `fail`.
- **Keep policy out of pillars.** A new check that affects certification should change pillar status through evidence only. Whether it blocks belongs in a `proof.require*` gate. Gates are off by default, and `strict` and `check --strict` must turn all of them on.
- **Preserve exit-code precedence.** Codes 2, 3 and 4 outrank 13, and 13 appears only with a blocking reason under an enabled gate.
- **Keep trace output additive.** New trace data should be an optional field, as with `tool` and the statement, with the trace version unchanged. Readers of older traces must tolerate missing fields.
- **Keep the LLM last.** Deterministic checks (hashes, claim tags, scenario names) run first, and the model sees only what they cannot settle. Failures of LLM calls must not crash the run.
- **Planned work.** `planned-unified-check` and `planned-capability-drift` describe the intended direction. Legacy aliases returning identical results from one trace model, and per-capability, claim-level drift with chunked diffs, are the targets for new work.
