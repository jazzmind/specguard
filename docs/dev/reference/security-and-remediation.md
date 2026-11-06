---
title: "Security Scanning and Remediation (developer reference)"
audience: dev
source: "specs/capabilities/security-and-remediation.md"
generated: true
---
<a id="security-scanning-and-remediation"></a>
# Security Scanning and Remediation

<a id="purpose"></a>
## Purpose

This capability finds security problems in code, dependencies, secrets and the specs themselves, and turns them into fixes that are proven safe. It exists because:

- Many serious flaws are missing or wrong requirements, such as an endpoint with no stated authorization or an unclassified data field.
- Vulnerable dependencies pile up because nobody knows whether upgrading changes behaviour.
- Findings arrive in many tool-specific formats, so other systems cannot reliably consume them.

A vulnerable dependency or code finding is patched in a throwaway copy of the repo. The project's own tests and the proof ledger are compared before and after. The change is proposed with a **PRESERVED**, **CHANGED** or **INCONCLUSIVE** behaviour verdict. A person merges, except for the narrow class of dependency fixes the auto-merge policy allows. The capability also publishes one stable remediation plan format that other systems (trackers, bots, dashboards) can read and report progress against.

<a id="responsibilities"></a>
## Responsibilities

- Generate OWASP-annotated security test stubs per spec.
- Run SAST (Semgrep) and dependency audits, degrading gracefully when tools are missing.
- Detect advisories, Semgrep findings and gitleaks secrets as one detector set with one finding shape. Merge, suppress, sort and threshold them.
- Review specs for security gaps (`security scan`).
- Remediate in an isolated git worktree: baseline, minimal patch, verify, behaviour verdict, branch, evidence report, optional PR.
- Repair application code for failing claims (`remediate --from failing`).
- Emit, store, carry over and transition `RemediationPlan` documents, and export unresolved items as SARIF.
- Decide auto-merge through one pure policy and enforce it.
- Avoid shell injection and withhold SpecGuard credentials from test commands.

<a id="interfaces"></a>
## Interfaces

**CLI**
- `specguard security [--spec <key>] [--all] [--with-sast] [--app] [--force]`
- `specguard remediate [--scan-only] [--advisory <id>] [--min-severity critical|high|moderate|low] [--allow-major] [--ledger <file>] [--pr|--no-pr] [--dry-run] [--no-llm] [--app] [--force]`
- `remediate --from failing [--claim <ref>] [--max <n>]`
- `security scan [--min-severity <level>] [--no-spec-review] [--app <name>]` (plus `--sarif [file]`)
- `security fix [plan] [--item <id>] [--pr] [--dry-run] [--no-llm] [--allow-major]`
- `security plan list|show|set-status`

**MCP tools:** `specguard_security`, `specguard_security_scan`, `specguard_security_plan`, `specguard_remediate`. The remediate tool is limited to scan-only and dry-run.

**Files**
- `tests/security/<feature>.test.ts`
- `.specguard/security.json`
- `.specguard/vuln-ignore.json` (id, reason, expires)
- `.specguard/remediate.lock`
- `.specguard/remediation/<runId>.json`
- `.specguard/remediation/<runId>/baseline-proofs.json`
- `.specguard/rules/semgrep/` (optional custom rules)
- `.specguard/security/plans/<id>.json`
- `schemas/remediation-plan.v1.json`
- `.specguard/security/scan.sarif` (default SARIF output)

The Interfaces list marks the plan directory and the schema file as "Planned", while the requirements describe them as behaviour. Check the current state of the code before relying on either.

**Config:** a `remediate` block (`minSeverity`, `maxAdvisories`, `maxFilesChanged`, `maxLinesChanged`, build, typecheck and install commands, `osv`, `semgrep`, `gitleaks`), `remediate.autoMerge.enabled` and `denyPackages`, and per-app `security` settings. `test.passEnv` controls which credentials reach test commands.

**Exit codes**

| Command | Code | Meaning |
|---|---|---|
| `security`, `security scan` | 5 | Security issues found |
| `remediate` | 8 | PRESERVED |
| `remediate` | 9 | CHANGED |
| `remediate` | 10 | INCONCLUSIVE |
| `remediate` | 11 | Setup or baseline error |
| `remediate --scan-only` | 5 | Advisories remain |
| `remediate --scan-only` | 0 | No advisories remain |

For other commands, 8 is the budget-exceeded code.

**GitHub Action:** `mode: remediate` and the `security` and `scan` gates. `deps` is kept as an alias of `scan`. See the integration-surfaces capability.

<a id="requirements"></a>
## Requirements

<a id="security-test-stubs-and-sast"></a>
### Security test stubs and SAST
- **owasp-test-stubs**: `security` generates OWASP-annotated vitest stubs from a spec's security notes and source module, for `--spec` or `--all`.
  - Each test carries an `// OWASP A0X: <category>` comment.
  - Accidental Markdown fences are removed.
  - An existing security test file is never overwritten; the spec is reported as skipped.
  - An LLM failure for one spec is recorded as failed without stopping the others.
- **sast-degrades-gracefully**: `--with-sast` runs Semgrep in Docker over each app's repo, plus the npm or pip audit. If Docker, Semgrep or the audit tool is missing, it warns and continues with zero findings.
- **security-exit-and-report**: Real findings are summarised into the LLM prompt. `security` exits 5 only when real findings exist (stubs alone exit 0). It writes `.specguard/security.json` with every finding, counts by severity and one row per spec. A report failure never changes the outcome.

<a id="detection"></a>
### Detection
- **unified-detection**: `remediate` detects advisories through the ecosystem's native audit and OSV, plus Semgrep findings and gitleaks secrets.
  - Advisories are merged across tools by id or alias, keeping the highest severity.
  - They are suppressed by the ignore file, sorted deterministically, and filtered by minimum severity (default high).
- **scan-only-and-secrets**: `--scan-only` changes nothing. It exits 5 if any advisory remains after suppression and thresholding, otherwise 0. Secrets are only reported, never auto-fixed.
- **vuln-ignore-expiry**: An ignore entry suppresses only while `expires` is in the future. Expired or undated entries suppress nothing and are reported as warnings. Every suppression is listed with its reason and date.
- **unified-scan**: `security scan` runs the same dependency, Semgrep and gitleaks detectors as `remediate`, with one shared finding shape. `security --with-sast` remains for CI gates, and the retired `deps` gate is an alias of it.
- **spec-review**: `security scan` reviews each capability's spec for:
  - missing authorization or data-classification requirements
  - unspecified abuse cases or rate limits
  - contradictory requirements
  - interfaces with no owning claim
  - code findings that reveal a spec gap

  Finding type is spec, code, dependency or secret.

<a id="remediation-pipeline"></a>
### Remediation pipeline
- **worktree-isolation**: A run refuses a dirty working tree and a fresh lock. All work happens in a temporary git worktree. Rollback removes the worktree and branch.
- **green-baseline-required**: The baseline runs tests twice to quarantine flaky tests and snapshots the proof ledger. A non-green baseline ends the run with exit 11 before any patch.
- **minimal-write-allowlist**: The planner picks the smallest fixing version (patch over minor; major only with `--allow-major`). It changes only manifests and lockfiles for a dependency bump, or only the files named in a code finding. Any other changed file aborts and rolls back.
- **verify-after-patch**: After patching, install, build, typecheck and tests run (claim-tagged tests for affected specs first, then the full suite). The detector runs again. Heal is never run in rewrite mode, so no test file is modified.
- **behaviour-verdict**: The verdict compares proof-ledger results before and after.
  - CHANGED when a baseline-passing test fails or vanishes, a proven claim drops, claim or test counts fall, an advisory remains or a new one appears, or build or typecheck is red.
  - INCONCLUSIVE when output is unparseable, no tests were selected, or proofs were not re-proven.
  - Otherwise PRESERVED. Precedence is CHANGED, then INCONCLUSIVE, then PRESERVED.
- **branch-and-evidence**: One branch per advisory group, named `specguard/remediate/<id>`. Advisories whose branch or PR already exists are skipped. Plan, diffs, selected tests, verdict and evidence are written to `.specguard/remediation/<runId>.json`, with a markdown PR body.
- **pr-modes-no-merge**: Without `--pr` nothing is pushed. With `--pr` the branch is pushed and a PR opened (normal for PRESERVED, draft for CHANGED or INCONCLUSIVE). `--dry-run` leaves no branch, push, PR or report in the user's tree. Nothing merges unless the auto-merge policy allows it, and `ship` itself never merges.
- **remediate-exit-codes**: 8 PRESERVED, 9 CHANGED, 10 INCONCLUSIVE, 11 setup or baseline error. A missing external tool is reported by name as a warning.
- **remediate-layer-aware**: Test evidence is recorded by layer, as `results ingest` does. What a layer proved that its test command never reaches (for example a browser proof) is kept, not swept to unexercised. Claims proven in some layer before a change and not after are reported. A bump that only unit tests could re-prove is not auto-merged.

<a id="application-repair"></a>
### Application repair
- **app-fix-targets**: `remediate --from failing [--claim <ref>] [--max <n>]` takes each capability with a failing claim (a failing test or browser check in any layer). A fixer is shown the failing tests, browser findings and the capability's own source files, and the files it returns are written. Source files exclude tests, specs, docs, history, configuration and manifests. A capability with none is skipped.
- **app-fix-loop**: A repair runs in a temporary worktree and may change only the source files it was shown. A proposal naming a test, spec, manifest or other file is refused and rolled back with no branch left. It stays within file and line limits. The verdict treats the targeted claims as intended flips: they must be proven afterwards, and everything that passed before must still pass. A repair that fixes nothing or breaks something becomes a draft PR naming the reason.
- **app-fix-pr-only**: A repair always ends in a PR for a person. It opens only with `--pr`, is normal only when the verdict is clean, and is never auto-merged. It skips a capability that already has a branch or PR. `--dry-run` leaves no branch, push or PR.

<a id="remediation-plans"></a>
### Remediation plans
- **remediation-plan**: Scans emit a `RemediationPlan` validated by one Zod schema and published as `schemas/remediation-plan.v1.json`. Each item carries:
  - finding references, severity, capability and claim links
  - the workspace unit (when the project has a manifest) and affected files
  - a change type (code, spec, dependency or config)
  - the claims that must stay proven
  - an optional external reference
  - a status: open, planned, in-progress, fixed, then verified or wont-fix
- **plan-lifecycle**: Plans live at `.specguard/security/plans/<id>.json`, are served by the documentation API, and are updated by other systems with `security plan set-status`. `security fix` executes plan items through the remediate executor and updates their status.
- **plan-carry-over**: Item ids are stable across scans (derived from what was found), so status, history and external reference persist.
  - A fixed or verified item reported again is reopened with a note.
  - An unresolved item no longer detected is closed as fixed with the note "no longer detected", only when a detector that could have seen it ran at a severity floor covering it.
  - A missing detector, a raised floor, an `--app` filter or a failed model review closes nothing, and spec findings are never closed by silence.
  - An unreadable plan stops the scan instead of dropping statuses.
  - Closed items that are gone are dropped.
- **plan-transitions**: `set-status` enforces the lifecycle.
  - Any state can be reopened, and verified is reachable only from fixed.
  - An unknown status, plan or item is rejected, and a stored plan that does not match the schema is never trusted.
  - Plans sit behind one store interface (files by default) that serialises concurrent updates.
  - An update may carry the item version the caller last saw (the count of its recorded status changes). A changed item is refused as a conflict and nothing is written.
- **spec-fix-history**: Resolving a spec-level item records a requirement-history decision against its capability, once.
- **plan-no-secret-values**: A secret finding records only its rule and location, never the detector's message.
- **security-fix-statuses**: `security fix` runs the executor once for the selected dependency and code items.
  - Item status follows the branch outcome: preserved → fixed; changed → in-progress with the verdict; failed → open; skipped → planned; not attempted → open.
  - The branch is recorded in the item's history.
  - The plan is re-read before writing, so a status or external reference set by a tracker meanwhile is kept.
  - Items are restored if the run crashes.
  - Spec and secret items are never patched.
- **sarif-export**: `security scan --sarif [file]` writes unresolved items as SARIF 2.1.0.
  - One result per item, with a level from severity and a `security-severity` score.
  - The item id is the stable fingerprint, so GitHub tracks one alert per item.
  - Files and line become locations.
  - Fixed, verified and won't-fix items are omitted so their alerts close.

<a id="auto-merge"></a>
### Auto-merge
- **auto-merge-policy**: One pure policy decides, and every condition must hold:
  - `remediate.autoMerge.enabled` and `--auto-merge` are both set.
  - The change is a dependency fix touching only manifests and lockfiles.
  - The bump is a patch, or a minor at version 1.0 or later. Never a major or unknown bump, and never a package on `denyPackages`.
  - The verdict is PRESERVED with no reasons, and at least one test was selected.
  - Every claim proven in any layer before the change is proven in that layer again afterwards.
  - Risk is low and the breaking-change analysis is clean.

  Each failed condition is listed, written to the report and posted as a PR comment.
- **auto-merge-enforcement**: When the policy allows it, `gh pr merge --auto --squash` is requested only after the base branch is confirmed to have required status checks. An unprotected branch, or one whose protection cannot be read, is refused. A failed request is reported as not armed. Draft PRs and code fixes are never auto-merged.

<a id="process-safety"></a>
### Process safety
- **no-shell-spawn**: SpecGuard never builds a shell command line from values it does not control.
  - The editor starts the CLI without a shell: a script under `node`, a `.ts` checkout under `node --import tsx`, or a Windows `.cmd` shim through `cmd.exe` with every argument double-quoted and any quote, percent sign or newline refused.
  - A path or value placed in a terminal command is single-quoted.
  - What the test runner appends to a configured test command is quoted for its shell (single quotes on POSIX, double quotes under `cmd.exe`, unquotable values refused).
  - The configured test command itself is the project's own command line and runs in a shell by design.
- **test-env-withheld**: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `LITELLM_API_KEY`, `SPECGUARD_TOKEN`, `SPECGUARD_BOOTSTRAP_TOKEN` and the key named in `llm` are removed from a test command's environment unless the app's `test.passEnv` names them. The rest of the environment passes as usual.

<a id="code-map"></a>
## Code map

**Sources**
- Pipelines and commands:
  - `src/pipelines/security.ts`
  - `src/pipelines/security-scan.ts`
  - `src/pipelines/security-fix.ts`
  - `src/pipelines/security-plan.ts`
  - `src/pipelines/remediate/**`
  - `src/cli/commands/security.ts`
  - `src/cli/commands/remediate.ts`
- Core logic:
  - `src/core/advisory.ts`
  - `src/core/behavior-verdict.ts`
  - `src/core/auto-merge-policy.ts`
  - `src/core/remediation-schema.ts`
  - `src/core/plan-writer.ts`
  - `src/core/sarif.ts`
  - `src/core/git-scope.ts`
  - `src/core/ecosystems/**`
  - `src/core/state/plan-store.ts`
- Adapters: `src/adapters/docker.ts`, `npm-audit.ts`, `pip-audit.ts`, `depcheck.ts` (all under `src/adapters/`)

The capability owns 42 files in total.

<a id="tests"></a>
## Tests

- Pipelines:
  - `tests/pipelines/security.test.ts`
  - `security-audit.test.ts`
  - `remediate-e2e.test.ts`
  - `remediate-units.test.ts`
  - `security-scan.test.ts`
  - `security-plan.test.ts`
- Core:
  - `tests/core/advisory.test.ts`
  - `behavior-verdict.test.ts`
  - `ecosystems.test.ts`
- Adapters:
  - `tests/adapters/docker.test.ts`
  - `npm-audit.test.ts`
  - `python-adapters.test.ts`

The spec's scenarios give the end-to-end cases to cover:
- Safe dependency upgrade: PRESERVED, normal PR, exit 8.
- Behaviour-changing upgrade: CHANGED, draft PR, exit 9, working tree untouched.
- Scheduled gate with ignore entries: ignored advisory reported with reason and expiry, other advisory exits 5, an expired entry stops suppressing.
- Unreliable baseline: exit 11, no patch, worktree removed, flaky tests reported and excluded.
- Stubs with SAST unavailable: warning, stubs still written, existing ones skipped, exit 0.
- Spec-level finding becoming a tracked plan item: finding and change type spec, status open, fixed then verified via `set-status`, plan validates against the JSON Schema.

<a id="security-and-data"></a>
## Security and data

- **Data sent to the LLM.** Source files, manifests and test results are read. File contents or finding summaries go to the configured LLM only for stub generation, spec review, changelog analysis and code fixes. Only the file named by a finding is sent for a code fix. LLM keys are referenced by environment variable name and never logged or written to reports.
- **Secrets.** gitleaks results are redacted and never auto-fixed or committed. A person must rotate them. Plans record only rule and location (**plan-no-secret-values**).
- **Untrusted LLM edits.** Writes are limited by the allowlist and file and line limits. `security fix` is the only thing that applies a plan item.
- **Merging.** Only what the auto-merge policy allows is merged. Tests are never rewritten, and work happens only in a temporary worktree. The MCP remediate tool is scan-only and dry-run because branch, push and PR creation have effects outside the machine.
- **Tools.** Semgrep and OSV run through Docker or local binaries. A missing tool degrades to a warning.
- **Reports.** Files under `.specguard/` can contain package names and file paths and should be treated as internal.
- **Credentials and shells.** See **test-env-withheld** and **no-shell-spawn** above.

<a id="extending-it"></a>
## Extending it

The spec does not describe extension steps, so this section only restates the constraints any change must respect.

- **Detectors.** `security scan` and `remediate` share one detector set and one finding shape. A new detector's results must fit that shape and the merge-by-id/alias, ignore, sort and threshold rules. For plan carry-over, a detector can close "no longer detected" items only if it ran at a severity floor that covers them.
- **Plan format.** `RemediationPlan` is defined by one Zod schema and published as `schemas/remediation-plan.v1.json`. Change both together, and keep stored-plan validation strict (**plan-transitions**). Item ids must stay stable across scans (**plan-carry-over**). Secret findings must never carry detector messages.
- **Plan storage.** Plans sit behind one store interface (`src/core/state/plan-store.ts` is in the code map) that serialises concurrent updates. Keep new storage behind that interface, and keep the item-version conflict check.
- **Fix targets.** Spec and secret items are never patched. Any new fix path must stay inside the write allowlist, the file and line limits, and the worktree, and must be judged by the behaviour verdict.
- **Auto-merge.** The policy is one pure function (`src/core/auto-merge-policy.ts`). A new condition must be added there as an additional required condition, and each failure must be listed in the report and PR comment. Enforcement still requires confirmed branch protection.
- **Shell and environment.** New process launches must follow **no-shell-spawn**, and any new SpecGuard credential belongs in the set withheld from test commands.
- **Tools.** Handle a missing external tool as a named warning, not a raw error (**remediate-exit-codes**, **sast-degrades-gracefully**).

**Scope notes**
- Out of scope: rewriting or deleting tests to make a patch pass, auto-fixing or rotating secrets, replacing a vulnerability-management or ticketing system, and acting as a general-purpose SAST engine.
- Deferred: an HTTP write endpoint for plan status. Updates go through the CLI first.
- The spec's Out of Scope lists "Auto-merging any change", but **auto-merge-policy** and **auto-merge-enforcement** define a narrow auto-merge path. Treat the requirements as authoritative and confirm the intent.
