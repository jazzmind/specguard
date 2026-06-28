# SpecGuard Extension Dashboard — Worklog

A running log of the dashboard work, updated as we go (per the user's request to
document continuously). Newest entries at the top.

Spec: [docs/superpowers/specs/2026-06-28-specguard-extension-dashboard-design.md](../superpowers/specs/2026-06-28-specguard-extension-dashboard-design.md)

---

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
