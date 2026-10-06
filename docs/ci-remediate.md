# Automated remediation in CI

`specguard remediate` patches a vulnerable dependency (or a Semgrep finding) in a throwaway git worktree, runs your own tests before and after, and proposes the change only with evidence about whether behavior was preserved. Humans always merge: there is no auto-merge.

## What a run does

1. Detect: ecosystem audit plus OSV-Scanner (when installed), Semgrep findings (code fixes touch only the files named in the finding), gitleaks secrets (reported, never auto-fixed: rotate them).
2. Refuse on a dirty working tree or a fresh `.specguard/remediate.lock`.
3. Baseline in a worktree: install, build, typecheck, run each app's tests twice (flaky ids are quarantined), snapshot the proof ledger and an environment fingerprint.
4. Plan: smallest fixing version (patch over minor; major only with `--allow-major`), release notes, LLM breaking-change analysis (budget and replay apply), risk score, one branch `specguard/remediate/<id>` per advisory group. Re-runs skip advisories whose branch or PR exists.
5. Apply with a write allowlist (dependency bump: manifests and lockfiles only; code fix: the finding's files only) and size limits. Anything else aborts and rolls back.
6. Verify: claim-tagged and importing tests first, then always the full suite; results go to a patched proof ledger; the detector runs again.
7. Verdict from `src/core/behavior-verdict.ts`: PRESERVED, CHANGED or INCONCLUSIVE.
8. Ship: commit on the branch with scoped staging. With `--pr`: push and `gh pr create` (normal PR for PRESERVED, draft otherwise).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Nothing to remediate (or every advisory already has a branch/PR) |
| 5 | Findings present (`--scan-only`, or nothing could be planned automatically) |
| 8 | Branch/PR produced, verdict PRESERVED |
| 9 | Verdict CHANGED (draft PR, or branch left for review) |
| 10 | Verdict INCONCLUSIVE |
| 11 | Baseline not green, or tool/setup error |

Exit 8 is also `ExitCode.BudgetExceeded` for the other commands; under `remediate` an exhausted LLM budget only disables the LLM analysis (a keyword heuristic is used), it never ends the run.

## CLI

```
specguard remediate [--scan-only] [--advisory <id>] [--min-severity critical|high|moderate|low]
                    [--allow-major] [--ledger <file>] [--pr | --no-pr] [--dry-run] [--no-llm]
                    [--app <name>] [--json]
```

Config (`.specguard/config.json`, all optional):

```json
"remediate": { "minSeverity": "high", "maxAdvisories": 5, "maxFilesChanged": 20, "maxLinesChanged": 2000,
               "buildCommand": "npm run build", "typecheckCommand": "npm run typecheck",
               "installCommand": "npm ci", "stepTimeoutMs": 600000, "sandbox": "local",
               "baseBranch": "main", "osv": true, "semgrep": true, "gitleaks": true }
```

Suppress a known advisory with `.specguard/vuln-ignore.json`; an entry stops suppressing when `expires` passes:

```json
{ "ignore": [ { "id": "GHSA-xxxx-xxxx-xxxx", "reason": "not reachable, tracked in SEC-123", "expires": "2026-12-31" } ] }
```

## Workflow

Copy [`docs/examples/specguard-remediate.yml`](examples/specguard-remediate.yml). It runs on `schedule` and `workflow_dispatch`, uses a concurrency group, and asks only for `contents: write` and `pull-requests: write`.

## What you must provision

- `GITHUB_TOKEN` with those two permissions. PRs opened with the default token do not trigger other workflows: use a fine-grained PAT or GitHub App token as `github-token` if your required checks must run on the PR.
- Repository setting "Allow GitHub Actions to create and approve pull requests".
- Tools on the runner, all optional but recommended: `osv-scanner` (universal detector; the action tries `go install`), `govulncheck` (Go), `cargo-audit` (Rust), `pip-audit` (Python), `gitleaks` (secrets), Docker (Semgrep). A missing tool is reported as a warning, never silently skipped.
- Your tests must write machine-readable reports (vitest/jest/pytest/go/cargo/junit are built in) and be configured under each app's `test` block. An unparseable run counts as a failure.
- An LLM key only for the optional breaking-change analysis and Semgrep code fixes.

## Over MCP

`specguard_remediate` supports scan-only and dry-run only. Creating branches, pushing and opening PRs have side effects outside the machine and are left to the CLI or CI.

## Known limits

- Proof staleness uses the lockfile found at or above the config root; apps with their own lockfile in a subfolder get `INCONCLUSIVE` for the proof-restale check.
- Claims with no exercising test in the baseline make a run INCONCLUSIVE (`remediate.strictUnexercised: false` relaxes this).
- Test selection uses an import scan and the drift registry; runners that cannot take a file selection (cargo, maven) run the full suite only.
