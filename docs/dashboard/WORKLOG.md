# SpecGuard Extension Dashboard — Worklog

A running log of the dashboard work, updated as we go (per the user's request to
document continuously). Newest entries at the top.

Spec: [docs/superpowers/specs/2026-06-28-specguard-extension-dashboard-design.md](../superpowers/specs/2026-06-28-specguard-extension-dashboard-design.md)

---

## 2026-06-28 — Task 2: Coverage text parser (extract + reuse)

- Extracted the private `parseStatusJson` function from `extension/src/sidebar.ts` into a new
  tested pure module `extension/src/dashboard/coverage-parse.ts` exporting `parseCoverageText`.
- Followed strict TDD: wrote the failing test first, confirmed RED, then implemented, confirmed GREEN.
- Removed the two local interface declarations (`CoverageItem`, `AppCoverage`) from `sidebar.ts`;
  both are now imported from `./dashboard/protocol.js` (shared source of truth).
- `sidebar.ts` now calls `parseCoverageText(raw)` imported from `./dashboard/coverage-parse.js` — DRY.
- `npm run lint` (tsc --noEmit) is clean; `npm run build` emits `dist/extension.js` (14.9 kb).
- Test: 1/1 passing (`parseCoverageText` parses app name, items, and summary percentage correctly).

## 2026-06-28 — Task 1: Extension test harness + flow protocol/metadata

- Installed **Vitest 3** to `extension/` as the test runner (`npm test` = `vitest run`).
- Created `extension/vitest.config.ts` with node environment, configured to discover `src/**/*.test.ts`.
- Implemented `extension/src/dashboard/protocol.ts` — shared message/model contracts between host
  and webview:
  - Event types: `pipeline:{start|log|done}`, artifact changes, matrix/coverage updates, errors.
  - Command types: run pipelines, refresh, open file.
  - `PipelineNode[]` metadata (PIPELINE_NODES) describing the flow graph per README architecture:
    inputs (docs-in, code) → pipelines (import, reverse, ...) → artifacts (specs, tests, docs, traceability).
  - `RUNNABLE_PIPELINES[]` listing the 10 pipelines runnable from the Activity tab + destructive flags.
- Added `extension/src/dashboard/protocol.test.ts` with 3 tests:
  - Non-input nodes must have upstream sources.
  - All `from` references must be valid node IDs.
  - Core pipelines (reverse, generate, drift, matrix, status) must be in RUNNABLE_PIPELINES.
- All tests pass (3/3); committed via the main git workflow.

## 2026-06-28 — Design approved, repo synced

- Synced the single working folder to the latest `origin/build/specguard-impl`
  (`8b6e0d8`); removed the duplicate worktree; stashed prior WIP (recoverable).
- Reconciled the dashboard direction with the team transcript: the dashboard is a
  **live, animated visualization inside the existing VS Code extension**, not a
  standalone web app. Marked the earlier standalone spec **superseded**.
- Confirmed against source:
  - All pipelines now implemented incl. `runValidate` / `runMatrix` / `runImport`.
  - Extension exists with a coverage tree, status bar, and CLI-spawn commands.
  - CLI has **no `--json` flag yet** (`sidebar.ts` parses text) → live data will use
    fs-watch + exit codes + reading `.specguard/traceability.json`.
- Wrote the active design spec; about to plan the build.

### Decisions
- Webview-in-extension (not standalone web app).
- No changes to shared `src/**` (another contributor owns the "plumbing").
- Centerpiece = animated README architecture diagram; tabs: Flow / Matrix / Docs /
  Activity.

### Next
- Implementation plan (writing-plans), then build task-by-task with docs per commit.

## 2026-06-28 — Implementation plan written

- Wrote the 10-task TDD plan:
  [docs/superpowers/plans/2026-06-28-specguard-extension-dashboard.md](../superpowers/plans/2026-06-28-specguard-extension-dashboard.md).
- Build setup confirmed: extension bundles via **esbuild** (CJS, `--external:vscode`),
  had **no test runner** → plan adds **Vitest** to `extension/`. Webview = **Vite +
  React** in `extension/webview/` building to `extension/media/`.
- Tested pure cores: `protocol`/node metadata, `coverage-parse` (extracted from
  `sidebar.ts`, DRY), `matrix-model` (from `traceability.json`), `flow-events`, and
  the webview `reducer`. vscode-wiring (host, panel) is build/manually verified.
- Each task commits a WORKLOG update + relevant README change alongside the code.

### Next
- Execute the plan (subagent-driven or inline), updating docs per task.
