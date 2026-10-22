---
id: security-and-remediation
kind: capability
title: Security Scanning and Remediation
parent: system
value: Security and risk teams find flaws in code, dependencies, secrets and the specs themselves, and get fixes proposed with proof that behaviour was preserved, in a form other systems can automate.
status: active
sources:
  - "src/core/state/plan-store.ts"
  - "src/pipelines/security.ts"
  - "src/pipelines/remediate/**"
  - "src/adapters/docker.ts"
  - "src/adapters/npm-audit.ts"
  - "src/adapters/pip-audit.ts"
  - "src/adapters/depcheck.ts"
  - "src/core/advisory.ts"
  - "src/core/behavior-verdict.ts"
  - "src/core/plan-writer.ts"
  - "src/core/ecosystems/**"
  - "src/cli/commands/security.ts"
  - "src/cli/commands/remediate.ts"
  - "src/core/remediation-schema.ts"
  - "src/core/git-scope.ts"
  - "src/pipelines/security-scan.ts"
  - "src/pipelines/security-fix.ts"
  - "src/pipelines/security-plan.ts"
  - "src/core/auto-merge-policy.ts"
  - "src/core/sarif.ts"
tests:
  - "tests/pipelines/security.test.ts"
  - "tests/pipelines/security-audit.test.ts"
  - "tests/pipelines/remediate-e2e.test.ts"
  - "tests/pipelines/remediate-units.test.ts"
  - "tests/core/advisory.test.ts"
  - "tests/core/behavior-verdict.test.ts"
  - "tests/core/ecosystems.test.ts"
  - "tests/adapters/docker.test.ts"
  - "tests/adapters/npm-audit.test.ts"
  - "tests/adapters/python-adapters.test.ts"
  - "tests/pipelines/security-scan.test.ts"
  - "tests/pipelines/security-plan.test.ts"
docs:
  - "README.md"
  - "docs/user/security.md"
  - "docs/user/npm-audit.md"
  - "docs/user/docker.md"
  - "docs/ci-remediate.md"
  - "docs/dogfood-remediate.md"
  - "docs/examples/**"
  - "schemas/remediation-plan.v1.json"
history:
  - 2026-10-15-functional-specs-and-four-pillars
  - 2026-10-22-0-3-phase-3-test-layers-and-ci
  - 2026-10-22-0-3-phase-4-app-repair-loop-and-auto-mer
  - 2026-10-22-security-hardening-from-audit-sast-and-p
  - 2026-10-22-header-role-fix-and-spec-level-security
  - 2026-10-22-security-vuln-ignore-json-suppression-fi
  - 2026-10-22-security-spec-review-findings-containing
---

# Security Scanning and Remediation

## Problem & Value
Security review usually looks only at code. Many serious flaws are really missing or wrong requirements: an endpoint that never said who may call it, a data field nobody classified, a rate limit nobody specified. At the same time, vulnerable dependencies pile up because upgrading them is risky: nobody knows whether the upgrade changes behaviour, so the work is postponed. Findings arrive in a dozen tool-specific formats and fix plans are ad hoc, so no other system (a ticket tracker, a remediation bot, a dashboard) can reliably consume them.

This capability finds security problems in code, dependencies, secrets and the specs themselves. It turns the findings into fixes that are proven safe: a vulnerable dependency or code finding is patched in a throwaway copy of the repo, the project's own tests and the proof ledger are compared before and after, and the change is proposed with a PRESERVED, CHANGED or INCONCLUSIVE behaviour verdict. A person always merges. It also publishes one stable remediation plan format so that other systems can read plans and report progress back.

## Users & Journeys
- A developer runs `specguard security --all --with-sast` to get OWASP-annotated security test stubs for each spec, plus Semgrep findings and a dependency audit, and sees exit code 5 when real findings exist.
- A CI pipeline runs `specguard remediate --scan-only` on a schedule and fails when advisories at or above a severity threshold remain.
- A maintainer runs `specguard remediate --pr` and receives one branch and pull request per advisory group, each with a behaviour verdict and an evidence report, and merges the PRESERVED ones, except the narrow class of dependency fixes the auto-merge policy merges for them.
- A reviewer reads the evidence report for a CHANGED verdict to see exactly which previously passing test or proven claim regressed.
- A security engineer runs `security scan` and gets code, dependency, secret and spec-level findings in one plan that an external tracker ingests, and marks items fixed through `security plan set-status`.

## Requirements
- [ ] `security` generates OWASP-annotated vitest security test stubs from a spec's security notes and its source module, for one spec (`--spec`) or all specs (`--all`); each generated test carries an `// OWASP A0X: <category>` comment, accidental Markdown fences are removed, an existing security test file is never overwritten (the spec is reported as skipped), and an LLM failure for one spec is recorded as failed without stopping the others <!-- claim: owasp-test-stubs -->
- [ ] `security --with-sast` runs Semgrep in a Docker container over each app's repo and the language-appropriate dependency audit (npm or pip); when Docker, Semgrep or the audit tool is unavailable it logs a warning and continues with zero findings instead of failing <!-- claim: sast-degrades-gracefully -->
- [ ] Real SAST or audit findings are summarised into the LLM prompt so generated stubs target concrete issues; `security` exits 5 only when real findings exist (generating stubs alone exits 0) and writes a structured report to `.specguard/security.json` with every finding, counts by severity and one row per spec handled, a report failure never changing the outcome <!-- claim: security-exit-and-report -->
- [ ] `remediate` detects dependency advisories through the ecosystem's native audit and OSV, Semgrep findings and gitleaks secrets; advisories are merged across tools by id or alias keeping the highest severity, suppressed by an ignore file with expiry dates, sorted deterministically and filtered by a minimum severity (default high) <!-- claim: unified-detection -->
- [ ] `remediate --scan-only` changes nothing and exits 5 when any advisory remains after suppression and thresholding, otherwise 0; secrets are only ever reported, never auto-fixed <!-- claim: scan-only-and-secrets -->
- [ ] A remediation run refuses a dirty working tree and a fresh lock, does all work in a temporary git worktree and never touches the user's working tree, and rolling back removes the worktree and branch <!-- claim: worktree-isolation -->
- [ ] The baseline runs the tests twice to quarantine flaky tests, snapshots the proof ledger, and a baseline that is not green ends the run with exit 11 before any patch is applied <!-- claim: green-baseline-required -->
- [ ] The planner chooses the smallest fixing version (patch over minor, major only with `--allow-major`), changes only manifests and lockfiles for a dependency bump or only the files named in a code finding, and aborts and rolls back on any other changed file <!-- claim: minimal-write-allowlist -->
- [ ] After patching, the install, build, typecheck and tests run (claim-tagged tests for the affected specs first, then the full suite), the detector runs again, and heal is never run in rewrite mode so no test file is modified <!-- claim: verify-after-patch -->
- [ ] The behaviour verdict compares proof-ledger results before and after: it is CHANGED when a baseline-passing test fails or vanishes, a proven claim drops, claim or test counts fall, an advisory remains or a new one appears, or build or typecheck is red; INCONCLUSIVE when output is unparseable, no tests were selected or proofs were not re-proven; otherwise PRESERVED, with CHANGED beating INCONCLUSIVE beating PRESERVED <!-- claim: behaviour-verdict -->
- [ ] Remediation runs use one branch per advisory group named `specguard/remediate/<id>`, skip advisories whose branch or PR already exists, and write the plan, diffs, selected tests, verdict and evidence to `.specguard/remediation/<runId>.json` with a markdown pull request body <!-- claim: branch-and-evidence -->
- [ ] Without `--pr` nothing is pushed; with `--pr` the branch is pushed and a pull request opened (normal for PRESERVED, draft for CHANGED or INCONCLUSIVE); `--dry-run` leaves no branch, push, PR or report in the user's tree; nothing is merged unless the auto-merge policy below allows it, and `ship` itself never merges <!-- claim: pr-modes-no-merge -->
- [ ] `remediate` exits 8 for PRESERVED, 9 for CHANGED, 10 for INCONCLUSIVE and 11 for a setup or baseline error, and a missing external tool is reported by name as a warning rather than a raw error <!-- claim: remediate-exit-codes -->
- [ ] `security scan` runs the dependency-advisory, Semgrep and gitleaks detectors that `remediate` uses, as one detector set whose results share one finding shape; the older `security --with-sast` command remains for CI gates, and the retired `deps` gate is an alias of it <!-- claim: unified-scan -->
- [ ] `security scan` also performs a spec-level review per capability, flagging missing authorization or data-classification requirements, unspecified abuse cases or rate limits, contradictory requirements, interfaces with no owning claim, and code findings that reveal a spec gap; each finding has a type of spec, code, dependency or secret <!-- claim: spec-review -->
- [ ] Scans emit a `RemediationPlan` validated by one Zod schema and published as JSON Schema at `schemas/remediation-plan.v1.json`; each item carries finding references, severity, capability and claim links, the workspace unit when the project has a manifest, affected files, a change type (code, spec, dependency or config), the claims that must stay proven, an optional external reference, and a status that moves open, planned, in-progress, fixed, then verified or wont-fix <!-- claim: remediation-plan -->
- [ ] Plans are stored at `.specguard/security/plans/<id>.json`, served by the documentation API, and updated by other systems with `security plan set-status`; `security fix` executes plan items through the remediate executor and updates their status <!-- claim: plan-lifecycle -->
- [ ] A plan item's id is stable across scans (derived from what was found), so a later scan keeps its status, history and external reference; an item marked fixed or verified that the scanner reports again is reopened with a note; an unresolved item no longer detected is closed as fixed with the note "no longer detected" only when a detector that could have seen it ran at a severity floor covering it (a missing detector, a raised floor, an `--app` filter or a failed model review closes nothing, and spec findings are never closed by silence), a plan that cannot be read stops the scan instead of dropping every status, and items already closed and gone are dropped <!-- claim: plan-carry-over -->
- [ ] `security plan set-status` enforces the lifecycle: any state can be reopened, verified is reachable only from fixed, an unknown status, plan or item is rejected, and a stored plan that does not match the schema is never trusted; plans live behind one store interface (files by default) that serialises concurrent updates, and an update may carry the item version the caller last saw (the count of its recorded status changes), in which case a changed item is refused as a conflict and nothing is written <!-- claim: plan-transitions -->
- [ ] Resolving a spec-level item records a requirement-history decision against its capability, once <!-- claim: spec-fix-history -->
- [ ] A secret finding records only its rule and location, never the detector's message, so a plan can be handed to another system without carrying the secret <!-- claim: plan-no-secret-values -->
- [ ] `security fix` runs the remediation executor once for the selected dependency and code items, moves each item by what happened to its branch (preserved: fixed; changed: in-progress with the verdict; failed: open; skipped: planned; not attempted: open), records the branch in the item's history, re-reads the plan before writing so a status or external reference a tracker set meanwhile is kept, restores the items if the run crashes, and never patches spec or secret items <!-- claim: security-fix-statuses -->
- [ ] `security scan --sarif [file]` also writes the unresolved items of the plan as SARIF 2.1.0 (default `.specguard/security/scan.sarif`): one result per item with a level from its severity, a `security-severity` score, the item id as a stable fingerprint so GitHub tracks one alert per item, and its files and line as locations; fixed, verified and won't-fix items are left out so their alerts close <!-- claim: sarif-export -->
- [ ] Auto-merge of a remediation pull request is decided by one pure policy, and every condition must hold: `remediate.autoMerge.enabled` and `--auto-merge` are both set; the change is a dependency fix touching only manifests and lockfiles; the bump is a patch, or a minor at version 1.0 or later (never a major or unknown bump, never a package on `denyPackages`); the verdict is PRESERVED with no reasons and at least one test was selected; every claim proven in any layer before the change is proven in that layer again afterwards; risk is low and the breaking-change analysis is clean; each failed condition is listed, written to the report and posted as a pull request comment <!-- claim: auto-merge-policy -->
- [ ] When the policy allows it, the pull request is not merged at once: `gh pr merge --auto --squash` is requested only after the base branch is confirmed to have required status checks (an unprotected branch, or one whose protection cannot be read, is refused), and a failed request is reported as not armed; draft pull requests and code fixes are never auto-merged <!-- claim: auto-merge-enforcement -->
- [ ] `remediate` records test evidence by layer the way `results ingest` does, keeps what a layer proved that its test command never reaches (a browser proof is not swept to unexercised), and reports claims proven in some layer before a change and not after it, so a dependency bump that only the unit tests could re-prove is not auto-merged <!-- claim: remediate-layer-aware -->
- [ ] `remediate --from failing [--claim <ref>] [--max <n>]` repairs the application for failing claims: it takes each capability with a failing claim (a failing test or browser check in any layer), shows a fixer the failing tests, the browser findings and the capability's own source files, and writes the files it returns; the capability's source files exclude tests, specs, docs, history, configuration and manifests, and a capability with none is skipped <!-- claim: app-fix-targets -->
- [ ] A repair works in a temporary worktree like every remediation, may change only the source files it was shown (a proposal naming a test, a spec, a manifest or any other file is refused and rolled back with no branch left), stays within the file and line limits, and is checked by the behaviour verdict with the targeted claims as intended flips: they must be proven afterwards, every test and claim that passed before must still pass, and a repair that fixes nothing or breaks something is a draft pull request naming the reason <!-- claim: app-fix-loop -->
- [ ] A repair always ends in a pull request for a person: it opens only with `--pr`, is a normal pull request only when the verdict is clean, is never auto-merged, skips a capability that already has a branch or pull request, and `--dry-run` leaves no branch, push or pull request <!-- claim: app-fix-pr-only -->
- [ ] SpecGuard never builds a shell command line out of values it does not control: the editor starts the CLI without a shell (a script under `node`, a `.ts` checkout under `node --import tsx`, a Windows `.cmd` shim through `cmd.exe` with every argument double-quoted and any quote, percent sign or newline refused), a path or value placed in a terminal command is single-quoted, and what the test runner appends to a configured test command is quoted for the shell it runs in (single quotes on POSIX, double quotes under `cmd.exe`, unquotable values refused); the configured test command itself is the project's own command line and runs in a shell by design <!-- claim: no-shell-spawn -->
- [ ] The credentials SpecGuard itself uses (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `LITELLM_API_KEY`, `SPECGUARD_TOKEN`, `SPECGUARD_BOOTSTRAP_TOKEN` and the key named in `llm`) are removed from the environment of a test command, which is project code, unless the app's `test.passEnv` names them; the rest of the environment passes as usual <!-- claim: test-env-withheld -->
- [ ] An entry of `.specguard/vuln-ignore.json` suppresses an advisory only while its `expires` date is in the future; an expired entry or one with no date suppresses nothing and is reported as a warning so it is renewed or deleted on purpose, and every suppression is listed with its reason and date <!-- claim: vuln-ignore-expiry -->

## Scenarios
### Scenario 1: Safe dependency upgrade
**Steps:**
1. A project has a vulnerable direct dependency, a passing test suite and a clean working tree.
2. The developer runs `specguard remediate --pr`.

**Expected Results:**
- The patch is applied in a temporary worktree on branch `specguard/remediate/<id>` and only manifests and lockfiles change.
- Tests before and after match, so the verdict is PRESERVED.
- A normal (non-draft) pull request is opened with the evidence summary and the command exits 8.

### Scenario 2: Upgrade changes behaviour
**Steps:**
1. The patched dependency changes a function that a currently passing test relies on.
2. The developer runs `specguard remediate --pr`.

**Expected Results:**
- The baseline-passing test fails in the patched run and is listed by id.
- The verdict is CHANGED, a draft pull request lists the differences, and the command exits 9.
- The user's own working tree is untouched.

### Scenario 3: Scheduled gate on advisories
**Steps:**
1. CI runs `specguard remediate --scan-only --min-severity high` nightly.
2. One advisory is covered by an unexpired ignore entry and another is not.

**Expected Results:**
- The ignored advisory is reported as ignored with its reason and expiry.
- The other advisory is listed and the job exits 5.
- After the ignore entry expires, it stops suppressing.

### Scenario 4: Unreliable baseline
**Steps:**
1. The project's test suite fails on the unmodified code, or its output cannot be parsed.
2. The developer runs `specguard remediate`.

**Expected Results:**
- No patch is applied and the worktree is removed.
- The command exits 11 and explains that the baseline is not green.
- Tests whose status differed between the two baseline runs are reported as flaky and excluded.

### Scenario 5: Security stubs with SAST unavailable
**Steps:**
1. A developer runs `specguard security --all --with-sast` on a machine without Docker.

**Expected Results:**
- A warning says the SAST scan could not run, and no exception is thrown.
- Stubs are still written under `tests/security/`, existing ones are skipped, and the exit code is 0.

### Scenario 6: Spec-level finding becomes a tracked plan item
**Steps:**
1. `security scan` reviews a capability whose interface accepts uploads but has no authorization requirement.
2. The resulting plan is written to `.specguard/security/plans/<id>.json` and an external tracker imports it.
3. After the spec is amended, the tracker runs `security plan set-status` for the item.

**Expected Results:**
- The item has finding type spec, change type spec, a link to the capability, and status open.
- The tracker's update moves it to fixed and a later verification moves it to verified.
- The schema file `schemas/remediation-plan.v1.json` validates the plan.

## Security & Data Considerations
- The pipelines read source files, dependency manifests and test results, and send file contents or finding summaries to the configured LLM only for stub generation, spec-level review, changelog analysis and code fixes. Only the file named by a finding is sent for a code fix. LLM keys are referenced by environment variable name and never logged or written to reports.
- Secrets reported by gitleaks are redacted and are never auto-fixed or committed; they must be rotated by a person. Reports under `.specguard/` can contain package names and file paths and should be treated as internal.
- LLM-suggested edits are untrusted input: remediation limits writes with an allowlist and file and line limits, and `security fix` is the only thing that applies a plan item.
- Remediation merges only what the auto-merge policy allows (a dependency patch or 1.x minor that provably keeps every proof, on a protected branch, when asked in config and on the command line), never rewrites tests, and works only in a temporary worktree. The MCP remediate tool is limited to scan-only and dry-run because branch, push and pull-request creation have effects outside the machine.
- Semgrep and OSV run through Docker or local binaries; a missing tool degrades to a warning.

## Interfaces
- CLI: `specguard security [--spec <key>] [--all] [--with-sast] [--app] [--force]`, `specguard remediate [--scan-only] [--advisory <id>] [--min-severity critical|high|moderate|low] [--allow-major] [--ledger <file>] [--pr|--no-pr] [--dry-run] [--no-llm] [--app] [--force]`.
- CLI: `security scan [--min-severity <level>] [--no-spec-review] [--app <name>]`, `security fix [plan] [--item <id>] [--pr] [--dry-run] [--no-llm] [--allow-major]`, `security plan list|show|set-status`.
- MCP tools: `specguard_security`, `specguard_security_scan`, `specguard_security_plan`, `specguard_remediate` (scan-only and dry-run only).
- Files: `tests/security/<feature>.test.ts`, `.specguard/security.json`, `.specguard/vuln-ignore.json` (id, reason, expires), `.specguard/remediate.lock`, `.specguard/remediation/<runId>.json` and `.specguard/remediation/<runId>/baseline-proofs.json`, `.specguard/rules/semgrep/` (optional custom rules). Planned: `.specguard/security/plans/<id>.json`, `schemas/remediation-plan.v1.json`.
- Config: `remediate` block (`minSeverity`, `maxAdvisories`, `maxFilesChanged`, `maxLinesChanged`, build, typecheck and install commands, `osv`, `semgrep`, `gitleaks`), per-app `security` settings.
- Exit codes: security and security scan use 5 for security issues; remediate uses 8 PRESERVED, 9 CHANGED, 10 INCONCLUSIVE, 11 setup or baseline error (8 is the budget-exceeded code for other commands).
- GitHub Action: `mode: remediate` and the `security` and `scan` gates (`deps` is kept as an alias of `scan`) (see the integration-surfaces capability).

## Out of Scope
- Auto-merging any change, or rewriting or deleting tests to make a patch pass.
- Auto-fixing or rotating leaked secrets.
- Replacing a dedicated vulnerability management or ticketing system; plans are consumed by those systems.
- A general-purpose SAST engine: Semgrep, OSV, gitleaks and ecosystem audit tools do the detection.
- Planned and deferred: an HTTP write endpoint for plan status (updates go through the CLI first).
