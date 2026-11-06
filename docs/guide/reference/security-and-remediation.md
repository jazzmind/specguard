---
title: "Security Scanning and Remediation"
audience: user
source: "specs/capabilities/security-and-remediation.md"
generated: true
---
<a id="security-scanning-and-remediation"></a>
# Security Scanning and Remediation

SpecGuard finds security problems in your code, dependencies, secrets and specs. It proposes fixes for them, and for dependency and code fixes it shows whether the project's behaviour was preserved. It also produces one standard remediation plan that other tools, such as ticket trackers, bots and dashboards, can read and update.

<a id="why-it-exists"></a>
## Why it exists

- **Many serious flaws are missing requirements, not bugs.** Examples are an endpoint that never said who may call it, a data field nobody classified, or a rate limit nobody specified. Reviews that only read code miss these, so SpecGuard reviews the specs too.
- **Vulnerable dependencies pile up because upgrading feels risky.** Nobody knows whether an upgrade changes behaviour, so it gets postponed. SpecGuard tries the upgrade in a throwaway copy of your project and compares your tests and proven claims before and after.
- **Findings come in many tool-specific formats.** SpecGuard publishes one stable plan format, so other systems can consume findings and report progress back.

<a id="what-you-can-do"></a>
## What you can do

<a id="generate-security-tests-and-run-a-quick-scan"></a>
### Generate security tests and run a quick scan
- Run `specguard security --spec <key>` for one spec, or `specguard security --all` for every spec. SpecGuard writes security test stubs based on each spec's security notes and its source code. Each test is labelled with the relevant OWASP category.
- Add `--with-sast` to also run Semgrep and a dependency audit (npm or pip). Real findings are fed into test generation, so the stubs target concrete issues.
- Existing security test files are never overwritten. Those specs are reported as skipped.
- If test generation fails for one spec, it is recorded as failed and the others continue.
- A structured report is saved with every finding, counts by severity and one row per spec handled.

<a id="check-for-vulnerable-dependencies-and-secrets"></a>
### Check for vulnerable dependencies and secrets
- `specguard remediate --scan-only` changes nothing. It lists advisories from dependency audits, OSV, Semgrep and gitleaks (for secrets).
- Duplicate advisories from different tools are merged, and the highest severity is kept.
- Use `--min-severity` to set the threshold (default is high). Use `--advisory <id>` to focus on one advisory.
- To suppress a known advisory, add it to the ignore list with a reason and an expiry date. It stays suppressed only while the date is in the future. Expired or undated entries suppress nothing and are reported as warnings. Every suppression is listed with its reason and date.

<a id="get-proven-safe-fixes"></a>
### Get proven-safe fixes
- `specguard remediate` patches each advisory group in a temporary copy of the repo, on its own branch. It runs install, build, typecheck and tests, and compares your proven claims before and after.
- Add `--pr` to push the branch and open a pull request. Without it, nothing is pushed. `--dry-run` leaves no branch, push, pull request or report in your project.
- The planner picks the smallest fixing version: patch before minor, and major only with `--allow-major`.
- Dependency fixes may change only dependency manifests and lockfiles. Code fixes may change only the files named in the finding. Anything else aborts the run and rolls it back.
- Branches are named `specguard/remediate/<id>`. Advisories that already have a branch or pull request are skipped.

<a id="repair-failing-claims"></a>
### Repair failing claims
- `specguard remediate --from failing` (optionally with `--claim <ref>` and `--max <n>`) repairs the application for capabilities with failing claims. A failing test or browser check in any layer counts.
- A fixer sees the failing tests, any browser findings and the capability's own source files, and may change only those source files. A proposal that touches a test, a spec, a manifest or any other file is refused and rolled back, with no branch left behind.
- The claims being fixed must be proven afterwards, and everything that passed before must still pass.
- A repair always ends in a pull request for a person to review. It is never auto-merged. It is a normal pull request only when the verdict is clean, otherwise a draft that names the reason.

<a id="build-a-tracked-remediation-plan"></a>
### Build a tracked remediation plan
- `specguard security scan` combines code, dependency, secret and spec-level findings into one plan. The spec-level review flags:
  - missing authorization or data-classification requirements
  - unspecified abuse cases or rate limits
  - contradictory requirements
  - interfaces with no owning claim
  - code findings that reveal a spec gap
- Options: `--min-severity`, `--no-spec-review`, `--app <name>`, and `--sarif [file]`.
- `--sarif` also writes unresolved items in SARIF format for GitHub code scanning. Each item is tracked as a single alert, and fixed, verified or won't-fix items are left out so their alerts close.
- Each item has a finding type (spec, code, dependency or secret) and a change type (code, spec, dependency or config). It also carries severity, capability and claim links, affected files, the claims that must stay proven, and an optional external reference.
- View plans with `specguard security plan list` and `specguard security plan show`.
- External systems update progress with `specguard security plan set-status`.
- `specguard security fix [plan]` executes the dependency and code items of a plan through the same safe process as `remediate`. Use `--item <id>` to pick one item. It never patches spec or secret items.

<a id="use-it-from-other-tools"></a>
### Use it from other tools
- The editor integration and AI-assistant tools are available. The assistant's remediate tool is limited to scan-only and dry-run, because creating branches and pull requests has effects outside your machine.
- The GitHub Action supports a remediate mode plus the `security` and `scan` gates. The older `deps` gate is an alias of `scan`.

<a id="what-to-expect"></a>
## What to expect

<a id="the-behaviour-verdict"></a>
### The behaviour verdict
Every fix gets one of three verdicts:

| Verdict | Meaning | Pull request | Exit code |
|---|---|---|---|
| **PRESERVED** | Tests and proven claims match before and after. | Normal | 8 |
| **CHANGED** | Something regressed: a passing test failed or vanished, a proven claim dropped, counts fell, an advisory remains or a new one appeared, or build/typecheck is red. | Draft, with differences listed | 9 |
| **INCONCLUSIVE** | Output could not be parsed, no tests were selected, or proofs were not re-proven. | Draft | 10 |

CHANGED outranks INCONCLUSIVE, which outranks PRESERVED. A reviewer can open the evidence report for a CHANGED verdict to see exactly which test or claim regressed.

<a id="exit-codes"></a>
### Exit codes
- `security` and `security scan` exit **5** only when real findings exist. Generating stubs alone exits 0.
- `remediate --scan-only` exits **5** if any advisory remains after suppression and thresholding, otherwise 0.
- `remediate` exits **8, 9 or 10** for the verdicts above, and **11** for a setup or baseline error.

<a id="before-any-patch-is-applied"></a>
### Before any patch is applied
- The run refuses to start if your working tree has uncommitted changes, or if another remediation is already running.
- All work happens in a temporary copy, and your own working tree is never touched. Rolling back removes the copy and branch.
- The tests run twice first. Tests whose results differ between the two runs are reported as flaky and excluded. If the baseline is not green, or its output can't be read, the run stops with exit 11 and no patch is applied.
- Test files are never rewritten to make a patch pass.

<a id="when-tools-are-missing"></a>
### When tools are missing
A missing tool (Docker, Semgrep, the audit tool, gitleaks) is reported by name as a warning, and the scan continues with zero findings from that tool. It does not fail.

<a id="secrets"></a>
### Secrets
Secrets are only reported, never auto-fixed. A secret finding records just its rule and location, never the secret itself, so a plan can be shared safely. Leaked secrets must be rotated by a person.

<a id="plans-keep-their-history"></a>
### Plans keep their history
- Item ids are stable across scans, so a later scan keeps each item's status, history and external reference.
- Statuses move through open, planned, in-progress, fixed, then verified (or wont-fix). Any item can be reopened, and verified is reachable only from fixed. Unknown statuses, plans or items are rejected.
- If you pass the item version you last saw and it has changed, the update is refused as a conflict and nothing is written.
- If a scan finds something again that was marked fixed or verified, the item is reopened with a note.
- An unresolved item that is no longer detected is closed as fixed, with the note "no longer detected". This happens only if a detector that could have seen it actually ran at a severity floor that covers it. A missing detector, a raised severity floor, an `--app` filter or a failed model review closes nothing. Spec findings are never closed just because they stopped appearing.
- If a stored plan can't be read, the scan stops rather than losing every status.
- Resolving a spec-level item records a decision in that capability's requirement history, once.
- `security fix` moves items according to what happened to their branch:
  - preserved: fixed
  - changed: in-progress, with the verdict
  - failed: open
  - skipped: planned
  - not attempted: open
- It records the branch in the item's history and keeps any status a tracker set in the meantime.

<a id="merging"></a>
### Merging
A person normally merges. The one exception is a narrow, opt-in auto-merge for dependency fixes. **Every** condition must hold:
- Auto-merge is enabled in the project's configuration **and** `--auto-merge` is passed on the command line.
- The change is a dependency fix touching only manifests and lockfiles.
- The bump is a patch, or a minor at version 1.0 or later. Never a major, an unknown bump, or a denied package.
- The verdict is PRESERVED with no reasons, and at least one test was selected.
- Every claim proven in any layer before the change is still proven in that layer afterwards. A bump that only unit tests could re-prove is not auto-merged.
- Risk is low and the breaking-change analysis is clean.

Any failed condition is listed in the report and posted as a pull request comment. When everything passes, SpecGuard doesn't merge immediately. It asks GitHub to merge once checks pass, and only if the base branch has required status checks. An unprotected branch, or one whose protection can't be read, is refused, and a failed request is reported as not armed. Draft pull requests and code fixes are never auto-merged.

<a id="privacy-and-safety"></a>
### Privacy and safety
- File contents or finding summaries are sent to your configured LLM only for stub generation, spec-level review, changelog analysis and code fixes. For a code fix, only the file named in the finding is sent. API keys are never logged or written to reports.
- LLM-suggested edits are treated as untrusted. They are limited to allowed files and to file and line limits.
- SpecGuard's own credentials are removed from the environment of your test commands, unless the app's configuration explicitly lets them through.
- Reports can contain package names and file paths, so treat them as internal.

<a id="not-included"></a>
### Not included
- Merging other than the narrow policy above, or rewriting tests to make a patch pass.
- Fixing or rotating leaked secrets.
- Replacing a vulnerability-management or ticketing system. Plans are meant to be consumed by those systems.
- A general-purpose code-scanning engine. Detection is done by Semgrep, OSV, gitleaks and the ecosystem audit tools.
- An HTTP endpoint for updating plan status. Updates go through the command line for now.
