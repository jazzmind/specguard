# SpecGuard VS Code Extension

<!--
  module: extension/src/extension.ts, extension/src/dashboard/, extension/webview/src/
  type: core
  status: draft
-->

## Overview

The SpecGuard VS Code / Cursor extension surfaces spec coverage, pipeline status, and drift detection directly in the IDE. It registers a dedicated activity-bar sidebar (SpecGuard icon), a Coverage tree view, and a rich dashboard webview panel. The extension shells out to the `specguard` CLI for all operations; no business logic is duplicated in the extension itself.

The dashboard communicates with the extension host via VS Code's `postMessage` / `onDidReceiveMessage` API. The host translates dashboard commands into CLI invocations and pushes events (coverage, matrix, findings, activity, workspace info) back to the webview.

## Acceptance Criteria

- [ ] Extension registers a `viewsContainers.activitybar` entry (`specguard-sidebar`) so a SpecGuard icon appears in the activity bar
- [ ] Sidebar Coverage tree view uses the shared `resolveCliPath` from `dashboard/cli.ts` (with `.ts` fallback for dev workspaces)
- [ ] Sidebar shows two sections: **Coverage** (per-app spec/test counts) and **Outputs** (Specs, Tests, Docs counts, Traceability status)
- [ ] `specguard.openDashboard` command opens the dashboard webview panel (singleton — reuses existing panel if open)
- [ ] Dashboard default tab is **Overview**, not Pipelines
- [ ] Overview tab shows: workspace name, coverage summary, spec/test/doc counts, last drift/matrix status, recent activity feed, "Getting Started" guide when no specs exist
- [ ] Dashboard emits a `workspace` event on startup with folder name, path, config status, and app list
- [ ] Workspace info bar is shown at the top of all dashboard tabs
- [ ] **Pipelines tab** is workflow-oriented rows, not a column graph:
  - Bootstrap section (reverse / import) shown only when no specs exist
  - Main loop section: generate, security, validate, docs, drift, matrix, quality, deps — each as a card with description, last-run status chip, and Run button
  - Finalise section: heal, commit
- [ ] Each pipeline card shows: last run status (pass/fail/never), time since last run, inline error tail when failed
- [ ] `import` is shown as a disabled card with a hint to use the terminal
- [ ] `pipeline:lastRun` event is emitted after every run and stored in `ViewModel.lastRunInfo`
- [ ] Drift background check debounced to 30s; activity log only updated when drift state changes
- [ ] `specguard reverse --all` iterates all apps in config

## Scenarios

### Scenario 1: Sidebar icon appears and Coverage view opens

**Steps:**
1. Open a workspace containing `.specguard/config.json`
2. Click the SpecGuard icon in the activity bar

**Expected Results:**
- SpecGuard sidebar opens with the Coverage tree view
- Coverage data populates within a few seconds (auto-refresh on activate)

---

### Scenario 2: Dashboard workspace context banner

**Steps:**
1. Open the dashboard via the SpecGuard: Open Dashboard command
2. Switch to any tab (Pipelines, Matrix, Coverage, etc.)

**Expected Results:**
- A bar at the top shows: workspace folder name, "N apps" badge (green if config found, red if missing), app names, and the full workspace path
- If config is missing the badge reads "no config" in red

---

### Scenario 3: Pipelines tab — clickable nodes

**Steps:**
1. Open the Pipelines tab in the dashboard
2. Hover over a pipeline node (e.g., "drift")

**Expected Results:**
- Node shows a pointer cursor and hover highlight
- Node has a description subtitle (e.g., "Detect specs that are out of sync…")
- Clicking the node triggers `specguard drift` and the node enters the "running" state

---

### Scenario 4: Pipelines tab — import node is not clickable

**Steps:**
1. Open the Pipelines tab
2. Observe the "import" node

**Expected Results:**
- Node cursor is `not-allowed`
- Node shows "needs input" label
- Tooltip says to run `specguard import <file>` from the terminal
- Clicking does nothing

---

### Scenario 5: Matrix tab with no data

**Steps:**
1. Open the Matrix tab before running `specguard matrix`

**Expected Results:**
- Explanatory header describes what the traceability matrix is
- "No traceability data yet" message with a "Run matrix" button
- Clicking "Run matrix" triggers the matrix pipeline

---

### Scenario 6: reverse --all from dashboard

**Steps:**
1. Click the "reverse" node in the Pipelines tab
2. Dashboard sends `{ type: 'run', pipeline: 'reverse' }`

**Expected Results:**
- Host invokes `specguard reverse --all`
- CLI iterates all configured apps and generates specs for each
- Each app's output is streamed to the Activity log

## Security Notes

- The extension reads `.specguard/config.json` to display app names; it does not expose the file contents beyond app names and counts.
- CLI is spawned with the workspace environment (`process.env`); ensure `ANTHROPIC_API_KEY` is set in the user's shell environment for LLM pipelines to work.

## Dependencies

- `specs/core/cli.md` — CLI invocation contract
- `specs/pipelines/reverse-generate.md` — `--all` flag behavior
- `extension/src/dashboard/protocol.ts` — host↔webview message contracts
