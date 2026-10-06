# Dogfood: SpecGuard on itself

Run from source (`node --import tsx src/cli/index.ts <cmd>`), 2026-10-06, branch `feat/generalize`.

## Setup changes this run needed

- `.specguard/config.json`: every app now has a `test` block (`node node_modules/vitest/vitest.mjs run`, reporter `vitest`; the extension app runs in `extension/`), and the extension app excludes `extension/src/**/*.test.ts` so test files are no longer counted as source files (they produced duplicate `cli-version`, `cli`, `protocol` rows).
- Five tests in `tests/core/claim-tags.test.ts` carry `@claim:core/claim-tags#<id>` tags.
- `tests/core/extension.test.ts` was truncated (missing closing braces) and never parsed; fixed. 23 legacy LLM-generated stubs in `tests/security/` do not parse or import (truncated files, wrong paths) and are listed in `vitest.config.ts` `exclude` until regenerated with `specguard security`.

## Commands and results

| Command | Result |
|---|---|
| `status` | 120 source files, 92 specs (77%), 42 tests mapped, 28 missing specs, 0 orphans |
| `claims list` | 817 claims across `specs/**` |
| `vitest run --reporter=json --outputFile=.specguard/runs/vitest.json` | 519 tests, all passing |
| `results ingest .specguard/runs/vitest.json` | 519 tests read, 5 tagged, 5 claims stored as `proven` |
| `proof status` | 5 proven, 0 failed, 812 unproven |
| `drift` | no drift reported |

## Findings

- Missing specs (28): core `dependency-fingerprint`, `llm-replay`, `llm-runtime`, `llm-usage`, `proof-ledger`, `sentinels`, `state-ignore`, `status`, `workspace-heuristics`; pipelines `claims`, `init`, `workspace-drift`; adapters `pip-audit`, `ruff`, `sessions`; nine `cli/commands/*`; extension `cli-version`, `pipelines-view`, `project-updater`, `workspace-panel`.
- Test mapping reports 0 tests for `specguard-cli` (no `tests/cli/` dir) and for the extension (co-located `*.test.ts` are matched by name only for the `tests` glob; the status mapper does not pair `extension/src/x.test.ts` with `x.ts`).
- Cosmetic: `results ingest` ends with `0 passed, 0 skipped, 0 failed`, which reads as if nothing happened; the per-claim lines above it are the real output.
- 812 of 817 claims are unproven because only the claim-tags tests are tagged. Tagging is the remaining dogfood work.
