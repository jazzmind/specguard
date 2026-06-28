# SpecGuard Extension Dashboard — Design

<!--
  topic: specguard-extension-dashboard
  date: 2026-06-28
  status: approved
  branch: feat/dashboard
  supersedes: 2026-06-28-specguard-dashboard-design.md
-->

## Overview

A **live, animated visualization of SpecGuard at work**, delivered as a **Webview
panel inside the existing VS Code / Cursor extension** (`extension/`). SpecGuard
runs many pipelines (import, reverse, generate, heal, validate, security, docs,
drift, matrix) and "a lot of it happens behind the scenes." This dashboard makes it
**visible in real time and fun to watch**: you see the components of the system and
how data flows through them as specs, tests, docs, and the traceability matrix
materialize.

The centerpiece is an animated rendering of SpecGuard's own README architecture
diagram. Secondary tabs show the traceability matrix, the generated user docs, and
an activity/runner. It builds **on top of** the existing extension (coverage tree,
status bar, command wiring) — not a separate app.

## Goals

- Watch SpecGuard run **in real time**: pipeline nodes light up, artifacts appear.
- Make it **engaging** — "fun to watch," with interactive animations.
- Show **how the system works** even when idle (a living architecture diagram).
- Surface **generated user documentation** (a capability the team wants made visible).
- Visualize the **requirement → spec → test → result traceability matrix**.
- Stay inside the extension; reuse its existing CLI/coverage plumbing.

## Non-Goals / Out of Scope

This spec is the **VS Code extension + visualization** lane only. Explicitly NOT
here (owned by another contributor's "plumbing" work):

- Git commit-to-repository behavior.
- Making security scanning / test generation actually execute correctly.
- Evaluating SpecGuard against external PRDs (Nate's PRDs) — a separate validation
  activity. The viz *reflects* these when they run; it does not implement them.

Also out of scope: replacing the existing coverage tree sidebar (it stays), and any
change to the shared CLI/core (`src/**`).

## Architecture

### Home & surfaces

- A new command **`specguard.openDashboard`** ("SpecGuard: Open Dashboard") opens a
  `WebviewPanel`. A matching item is added to the existing SpecGuard view container.
- The **coverage TreeView and status bar stay as they are**; the webview is the
  rich, animated surface beside them and links to the tree for per-spec coverage.

### Two-process model

```
┌── Extension host (Node, in extension/src) ───────────────┐
│  dashboard-host.ts                                        │
│   • spawns CLI pipelines (cp.spawn, existing pattern)     │
│   • FileSystemWatcher on specs/ tests/ docs/              │
│   • reads .specguard/traceability.json                   │
│   • posts typed events  ──postMessage──▶                  │
└───────────────────────────────────────────────────────────┘
              │ DashboardEvent (typed messages)
              ▼
┌── Webview (Vite+React bundle in extension/media) ─────────┐
│  Flow · Matrix · Docs · Activity tabs                     │
│   • pure view; animates off events                        │
│   • posts commands back (run pipeline, open file)         │
└───────────────────────────────────────────────────────────┘
```

The extension host is the only thing that touches the filesystem/CLI; the webview is
a pure, sandboxed view driven by messages. This keeps the webview testable and the
host logic isolated.

## Centerpiece: Live System-Flow View

An animated node graph mirroring the README architecture:

```
[PRD/Jira/MD] ─import─┐
                      ├─▶ [Spec Parser] ─▶ [Specs] ─┬─generate─▶ [Tests] ─heal─▶ ✓/✗
[code] ──────reverse──┘                             ├─security─▶ [Sec tests]
                                                    ├─validate─▶ [Issues]
                                                    ├─docs─────▶ [User Docs]
                                                    ├─drift────▶ [Staleness]
                                                    └─matrix───▶ [Traceability]
```

- Each pipeline node animates `idle → running (pulsing) → done | failed` as it
  executes. Artifacts (specs, tests, docs) flow along edges and pop in as files
  appear on disk.
- Idle state renders the full diagram, so it doubles as a "how SpecGuard works" map.
- Click a node → detail panel: description, last-run counts
  (created/updated/skipped/failed), and recent log lines.

## Data Flow & Real-Time Mechanism

Three real-time signals, **none of which modify the shared CLI/core** (keeps this
work conflict-free with the plumbing contributor):

1. **Filesystem watchers** — `vscode.workspace.createFileSystemWatcher` on
   `**/specs/**/*.md`, `**/tests/**/*.{ts,js}`, `**/docs/**/*.md`. A create/change
   event → a `DashboardEvent` that animates the matching artifact appearing. This is
   the primary "watch it happen live" signal and needs no CLI change.
2. **CLI spawn lifecycle** — running a pipeline via `cp.spawn` yields start / stdout
   chunks / exit code. Nodes light up on start, settle on exit, log lines stream
   into the node detail as stdout arrives.
3. **Artifacts on disk** — the **Matrix** reads `.specguard/traceability.json`
   directly (already structured JSON). **Coverage** reuses the existing lenient
   text parser from `sidebar.ts`.

**Note on structured output:** the CLI has **no `--json` flag yet** (`sidebar.ts`
scrapes text). If the plumbing contributor later adds `--json`, the host swaps the
text parse for structured `PipelineResult` — a drop-in upgrade. Until then, live
animation is driven by fs-watch + exit codes + disk artifacts, which is sufficient.

### Event contract (host → webview)

```ts
type DashboardEvent =
  | { type: 'pipeline:start'; pipeline: string }
  | { type: 'pipeline:log'; pipeline: string; line: string }
  | { type: 'pipeline:done'; pipeline: string; exitCode: number;
      counts?: { created: number; updated: number; skipped: number; failed: number } }
  | { type: 'artifact'; kind: 'spec' | 'test' | 'doc'; path: string; change: 'create' | 'update' }
  | { type: 'matrix'; data: MatrixModel }
  | { type: 'coverage'; data: AppCoverage[] }
  | { type: 'error'; scope: string; message: string };
```

### Command contract (webview → host)

```ts
type DashboardCommand =
  | { type: 'run'; pipeline: string; args?: string[] }
  | { type: 'refresh' }
  | { type: 'openFile'; path: string };
```

## Secondary Tabs

- **Matrix** — animated grid built from `.specguard/traceability.json`. The file is
  `{ generatedAt, entries: [{ specKey, title, appName, sourceModule, tests[], docs[] }] }`,
  so rows are **spec entries** and columns show **source module · has tests · has
  docs** (the test/doc coverage of each spec), grouped by `appName`; cells fill in as
  coverage grows. (Pass/fail *results* are not in this file — they require test-run
  output from `heal`/`generate`; showing a green/red result column is future work.)
- **Docs** — renders the generated user documentation (the `docs` pipeline output),
  so the team can *see* docs being produced. Read-only markdown render.
- **Activity / Runner** — trigger any of the 11 commands (including now-implemented
  `validate` / `matrix` / `import`), with animated counters (specs, tests, healed,
  findings) and a live log. Costly pipelines confirm before running.

## Error Handling

- CLI non-zero exit (other than the documented coverage code `4`) → `error` event;
  the node turns red and the detail shows stderr/last lines. Never a blank webview.
- Missing `.specguard/config.json` → friendly "run SpecGuard: Init" prompt (reuse
  the existing `specguard.init` command).
- Missing/!valid `traceability.json` → Matrix tab shows an empty-state with a "Run
  matrix" button.

## Tech & Build

- **Webview UI:** Vite + React + TypeScript, bundled to `extension/media/` and loaded
  by the panel via a CSP-locked HTML shell. Lightweight **SVG/CSS animations** for
  the flow graph (few deps, smooth, "fun to watch").
- **Extension host:** stays TypeScript/ESM as today; new `dashboard-host.ts` +
  `dashboard-panel.ts` (panel lifecycle, message bridge). Reuses `resolveCliPath`
  and the `cp.spawn` runner already in the extension.
- **Shared types:** the host imports result/coverage shapes from `src/core/types.ts`
  where useful; the event/command contracts live in one `dashboard-protocol.ts`
  shared by host and webview.

## Testing

- **Vitest on pure transforms** (the high-value, deterministic core):
  - `traceability.json → MatrixModel`
  - `status text → AppCoverage[]` (extract/reuse the `sidebar.ts` parser)
  - `fs/CLI events → DashboardEvent[]`
- **Host messaging** tested in isolation with a mock webview (assert the right
  `DashboardEvent`s are posted for given fs/CLI inputs). No real LLM calls.
- Webview kept thin; component logic that matters (animation state machine inputs)
  lives in tested pure functions.

## Documentation As We Go

Per the user's standing request, documentation is produced **continuously**, not at
the end:

- `docs/dashboard/WORKLOG.md` — a running log updated each meaningful step (what was
  built, decisions, how to run it).
- `extension/README.md` (or its dashboard section) updated in the **same commit** as
  the feature it describes.
- Each task's commit includes the doc change for that task.

## Open Questions / Future Work

- Upgrade live data to structured `--json` once the CLI supports it.
- Optional: drive richer animation from per-line stdout if the CLI prints
  progressively (currently messages arrive at completion).
- Possible "demo mode" that replays a recorded run for presentations.
