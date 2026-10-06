# Dogfood: `specguard remediate` on HiRocky (read-only)

Date: 2026-10-06. HiRocky (`/Users/wsonnenreich/Code/hirocky`) was never touched: the repo was copied to a scratch directory (without `node_modules`, `.data`, env files, reports), a minimal `.specguard/config.json` was added to the copy only (HiRocky has none), and the copy was committed to a fresh local git repo.

## Scan (`remediate --scan-only --json`) - real tools

- Wall time about 11 s. Exit 5 (findings present).
- Detectors that actually ran: `npm audit` (real registry) and OSV-Scanner through the `ghcr.io/google/osv-scanner` Docker image (no local binary installed). gitleaks is not installed, so the secret scan was skipped with a warning (not silently). Semgrep was disabled in the config.
- At or above `high`: 3 advisories, all critical and all transitive: `shell-quote` 1.9.0 (GHSA-pqg4-j6r4-53mv, fix 1.11.0), `tinypool` 1.1.1 (GHSA-5gmw-xhrv-c9v3 fix 2.1.1, GHSA-85c8-ppgw-ccpr fix 2.1.2). 4 more below the threshold.

## Full `--dry-run --no-llm` - real npm and git, about 3 min 40 s

- Plan: `shell-quote` 1.9.0 -> 1.11.0 (minor, pinned via `overrides`, risk medium). `tinypool` was skipped: the only fix is a major bump (needs `--allow-major`).
- The baseline ran (install in a temporary worktree, then `npm test`) and was **not green**: exit 11, nothing patched. Reason: the configured `npm test` fans out over npm workspaces, so the single `--reporter=json --outputFile` that SpecGuard injects is never written as one file ("results file was not written"). An unparseable run counts as a failure by design.
- Conclusion: to remediate HiRocky, give each workspace its own `apps[]` entry with `test.cwd`/`test.command` (or a `test.resultsFile` glob matching the per-workspace reports). The dry-run left no branch, no worktree and no files in the source tree.

## What this shows

Detection works against real data. The safety rails behaved: an unparseable baseline aborts before any change. The patch/verify/verdict path was not reached on HiRocky; it is exercised by the end-to-end fixtures in `tests/pipelines/remediate-e2e.test.ts` (stubbed `npm install`, real git, real vitest).
