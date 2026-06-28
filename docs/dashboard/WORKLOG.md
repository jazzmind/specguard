# SpecGuard Extension Dashboard — Worklog

A running log of the dashboard work, updated as we go (per the user's request to
document continuously). Newest entries at the top.

Spec: [docs/superpowers/specs/2026-06-28-specguard-extension-dashboard-design.md](../superpowers/specs/2026-06-28-specguard-extension-dashboard-design.md)

---

## 2026-06-28 — Task 6: Webview panel + command/menu registration

- Created `extension/src/dashboard/panel.ts` — singleton `WebviewPanel` implementation.
  - `openDashboardPanel(context)`: creates or reveals the panel; guards against missing
    workspace folder with a user-facing error message.
  - Wires `DashboardHost` ↔ webview messaging: host emits `DashboardEvent` via
    `panel.webview.postMessage`, webview sends `DashboardCommand` back via
    `onDidReceiveMessage`.
  - `renderHtml()`: generates CSP-nonce-guarded HTML; references `media/main.js` (built
    by Task 7) via `webview.asWebviewUri` so the build does not crash when the bundle
    is absent; conditionally adds `media/main.css` link tag only when the file exists.
  - `panel.onDidDispose`: calls `host.dispose()` and resets the singleton so a new panel
    can be opened after the user closes it.
- Modified `extension/src/commands.ts`:
  - Added `import { openDashboardPanel } from './dashboard/panel.js'` at the top.
  - Registered `specguard.openDashboard` command following the existing pattern inside
    `registerCommands(context, ...)`.
- Modified `extension/package.json`:
  - Added `specguard.openDashboard` to `contributes.commands` with `$(graph)` icon.
  - Added `view/title` menu entry (when `view == specguard.coverageView`, group: navigation).
  - Added `"onCommand:specguard.openDashboard"` to `activationEvents`.
- `extension.ts`: no changes needed — it already calls `registerCommands(context, ...)`.
- `npm run lint` (tsc --noEmit): clean (0 errors, 0 warnings).
- `npm run build` (esbuild): emits `dist/extension.js` 21.8 kb, `dist/extension.js.map` 41.7 kb.
- IDE note: VS Code emits an advisory warning that `onCommand:specguard.openDashboard` in
  `activationEvents` is auto-generated from `contributes`; kept per task brief.

## 2026-06-28 — Task 5: CLI runner + dashboard host (vscode wiring)

- Implemented `extension/src/dashboard/cli.ts` — resolves the CLI binary path and spawns
  it with stdout/stderr streamed line-by-line via an `onLine` callback.
  - `resolveCliPath(workspaceRoot)`: checks `specguard.cliPath` setting first, then
    `node_modules/.bin/specguard`, then `src/cli/index.ts`, falling back to the local bin path.
  - `spawnCli(cliPath, args, cwd, onLine)`: dispatches to `node` (`.js`), `npx tsx` (`.ts`),
    or direct execution based on the path extension; uses `shell: true` on Windows.
- Implemented `extension/src/dashboard/host.ts` — `DashboardHost` class wiring vscode
  filesystem watchers, command handling, pipeline execution, and coverage/matrix refresh.
  - `start()`: creates a `FileSystemWatcher` for `**/{specs,tests,docs}/**/*.{md,ts,js}`,
    posts `artifact` events on create/change, and calls `refresh()` immediately.
  - `handle(cmd)`: dispatches `refresh`, `openFile` (via `showTextDocument`), and `run`
    commands.
  - `run(pipeline, extra)`: posts `pipeline:start`, spawns CLI streaming logs as
    `pipeline:log` events, posts `pipeline:done` with exit code, then calls `refresh()`.
  - `refresh()`: runs `specguard status` and posts `coverage` event via `parseCoverageText`;
    reads `.specguard/traceability.json` and posts `matrix` event via `toMatrixModel`.
    Both are best-effort with independent error handling posting `error` events on failure.
  - `dispose()`: disposes the watcher.
- Also fixed a pre-existing TypeScript error in `flow-events.test.ts` (Task 4 artifact):
  optional-chained `.kind` access on a discriminated union now uses `toMatchObject` to avoid
  the TS2339 narrowing error.
- `npm run lint` (tsc --noEmit): clean.
- `npm run build` (esbuild): emits `dist/extension.js` 14.9 kb, `dist/extension.js.map` 27.8 kb.

## 2026-06-28 — Task 4: Flow event mappers + CLI arg builder (pure)

- Implemented `extension/src/dashboard/flow-events.ts` — pure mappers for file-change
  classification and CLI argument construction.
- Exports two functions:
  - `artifactEventFor(path: string, change: 'create' | 'update'): DashboardEvent | null`
    classifies file paths into artifact kinds (spec, test, doc) using normalized regexes
    that handle both `/` and `\` path separators. Returns null for untracked paths.
  - `cliArgsFor(pipeline: string, extra?: string[]): string[]` builds CLI argument
    arrays for pipeline execution (pipeline name + optional extra flags).
- Followed strict TDD: wrote failing test first (RED), confirmed module-not-found error,
  implemented both functions, confirmed GREEN (4/4 tests passing).
- Added `extension/src/dashboard/flow-events.test.ts` with four test cases:
  - Spec path classification (`specs/core/parser.md` → kind: 'spec').
  - Test and doc path classification (`.test.ts`, `.spec.js`, `.md` under docs/).
  - Unrelated paths ignored (src/ prefixed paths return null).
  - CLI args: pipeline-only and pipeline + extras both work correctly.
- No linting issues; pure TS module with no external dependencies.

## 2026-06-28 — Task 3: Matrix model transform

- Implemented `extension/src/dashboard/matrix-model.ts` — pure transform from
  `.specguard/traceability.json` shape to flat `MatrixModel` render-ready structure.
- Exports `toMatrixModel(raw: unknown): MatrixModel` function that:
  - Safely handles malformed/null input, returning `{ generatedAt: null, rows: [] }`.
  - Maps `TraceabilityEntry[]` (specKey, title, appName, tests, docs, sourceModule) to
    `MatrixRow[]` with coverage flags (hasTests, testCount, hasDocs).
  - Preserves `generatedAt` timestamp from the JSON file.
- Followed strict TDD: wrote failing test first (RED), confirmed import error, then
  implemented function, confirmed GREEN (2/2 tests passing).
- Added `extension/src/dashboard/matrix-model.test.ts` with two test cases:
  - Correct mapping of entries with coverage flags (tests present vs. absent).
  - Graceful handling of null/empty input (malformed JSON).
- `npm run lint` (tsc --noEmit) is clean; no build changes needed (pure TS module).

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
