# Remediate pipeline

<!--
  module: src/pipelines/remediate/index.ts
  type: pipeline
  status: draft
-->

## Overview

`specguard remediate` patches a vulnerable dependency or a Semgrep finding in a temporary git worktree, runs the project's own tests before and after, and proposes the change only with evidence about whether behavior was preserved. Humans always merge: it never merges and never pushes unless `--pr` is given. It is the one opt-in exception to SpecGuard's "no git/PR management" rule.

Loop: detect (ecosystem audit + OSV, Semgrep, gitleaks) -> dedupe, ignore, threshold -> clean-tree and lock check -> baseline in a worktree (tests twice for flakes, environment fingerprint, ledger snapshot) -> plan (smallest fixing version, changelog, LLM breaking-change analysis, risk) -> apply with a write allowlist -> install, build, typecheck -> select tests (claim-tagged first, then the full suite always) -> patched ledger -> re-detect -> verdict -> evidence JSON and PR body -> commit on `specguard/remediate/<id>` -> optional push and `gh pr create`.

Exit codes for this command: 0 nothing to do, 5 findings present (`--scan-only`), 8 branch/PR produced and PRESERVED, 9 CHANGED (draft PR or rolled back), 10 INCONCLUSIVE, 11 baseline not green or tool/setup error (including a reached LLM budget).

## Acceptance Criteria

- [ ] `--scan-only` lists advisories after dedupe, the ignore file and `--min-severity` (default high) and changes nothing; it exits 5 when any remain and 0 otherwise <!-- claim: scan-only -->
- [ ] Semgrep findings are patchable only in the files named by the finding, and gitleaks secrets are reported only, never auto-fixed <!-- claim: sast-secrets -->
- [ ] The run refuses a dirty working tree and a fresh `.specguard/remediate.lock`, and a stale lock is replaced <!-- claim: refuse-dirty-lock -->
- [ ] All work happens in a temporary git worktree; the user's working tree is never modified, and rollback removes the worktree and the branch <!-- claim: worktree-only -->
- [ ] The baseline runs each configured test command twice; test ids whose status differs between the runs are quarantined and reported <!-- claim: baseline-flaky -->
- [ ] A baseline that is not green (failing or unparseable tests, apart from quarantined ones) ends the run with exit 11 and no patch is applied <!-- claim: baseline-not-green -->
- [ ] The baseline snapshots the proof ledger to `.specguard/remediation/<runId>/baseline-proofs.json` and records an environment fingerprint <!-- claim: baseline-snapshot -->
- [ ] The planner picks the smallest fixing version (patch over minor); a major bump needs `--allow-major` and is otherwise skipped with a reason <!-- claim: plan-smallest -->
- [ ] Changelog notes are fetched through an injectable HTTP function and summarized by the LLM layer (budget and replay apply); a failed fetch or LLM call never blocks the run and lowers confidence in the risk score <!-- claim: plan-changelog -->
- [ ] One branch per advisory group named `specguard/remediate/<id>`; a re-run skips an advisory whose branch or PR already exists <!-- claim: idempotent -->
- [ ] A dependency bump may only change manifests and lockfiles, a code fix only the files named in the finding, and limits on file and line counts apply; any other changed file aborts the run, rolls back and exits 11 <!-- claim: write-allowlist -->
- [ ] After apply the ecosystem install, then the configured build and typecheck commands, run in the worktree <!-- claim: apply-install-build -->
- [ ] Tests run in order: claim-tagged tests for the affected specs first (fast failure), then the full suite always, and results are ingested into a patched proof ledger <!-- claim: select-then-full -->
- [ ] The detector runs again after the patch to confirm the advisory is gone and nothing at or above the threshold is new <!-- claim: redetect -->
- [ ] `heal` is never run in rewrite mode during remediation; no test file is changed by the run <!-- claim: no-test-rewrite -->
- [ ] The verdict comes from `behavior-verdict` and is written with the plan, diffs, selected tests, summaries and evidence paths to `.specguard/remediation/<runId>.json` together with a markdown PR body <!-- claim: evidence-report -->
- [ ] Without `--pr` nothing is pushed; with `--pr` the branch is pushed and `gh pr create` runs through an injectable runner; PRESERVED opens a normal PR and CHANGED or INCONCLUSIVE open a draft listing the differences <!-- claim: pr-modes -->
- [ ] The commit stages only the paths allowed for the change type <!-- claim: scoped-commit -->
- [ ] `--dry-run` runs the whole loop but makes no change outside the temporary worktree: no branch, no push, no PR, no report in the user's tree <!-- claim: dry-run -->
- [ ] There is no auto-merge anywhere <!-- claim: no-auto-merge -->
- [ ] The MCP tool `specguard_remediate` supports scan-only and dry-run only <!-- claim: mcp-readonly -->
- [ ] Exit codes map: PRESERVED 8, CHANGED 9, INCONCLUSIVE 10, setup/baseline error 11 <!-- claim: exit-map -->
- [ ] A dependency bump makes stored proofs stale through the dependency fingerprint, and the patched ledger re-proves them with the new fingerprint <!-- claim: proofs-restale -->

## Scenarios

### Scenario 1: Safe bump

**Steps:**
1. Project with a vulnerable direct dependency and a passing suite
2. Run `specguard remediate --pr`

**Expected Results:**
- Verdict PRESERVED, branch `specguard/remediate/<id>`, a normal PR body recorded, exit 8

### Scenario 2: Bump changes behavior

**Steps:**
1. The patched dependency changes a function a test depends on

**Expected Results:**
- A baseline-passing test fails, verdict CHANGED, draft PR, exit 9

## Dependencies

- specs/core/advisory.md
- specs/core/ecosystems.md
- specs/core/behavior-verdict.md
- specs/adapters/test-runners.md
- specs/pipelines/proof.md
- specs/pipelines/git-ops.md
