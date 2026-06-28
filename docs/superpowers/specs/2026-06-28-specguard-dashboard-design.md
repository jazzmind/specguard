# SpecGuard Dashboard — Design

<!--
  topic: specguard-dashboard
  date: 2026-06-28
  status: approved
  branch: feat/dashboard (worktree off build/specguard-impl)
-->

## Overview

A local, single-user **developer control panel** for SpecGuard. It surfaces
the state of an app's Living Specifications — coverage, drift, and the parsed
specs themselves — and lets the developer trigger any SpecGuard pipeline and
watch it run with live streaming logs.

The headline view is the **Drift monitor**: "which specs are stale versus their
source code?" Everything else exists to make that question answerable and
actionable.

The dashboard is a thin HTTP shell over the **exact pipeline functions the CLI
already calls** (`runDrift`, `runStatus`, `runReverseGenerate`, …). There is zero
business-logic duplication: the dashboard cannot behave differently from the
CLI because it *is* the CLI's code path. It is config-driven — it reads
`.specguard/config.json` the same way the CLI does and works for any app in the
config, not just SpecGuard-on-itself.

Optimized for **utility**, not demo flash.

## Goals

- See spec coverage, drift, and parsed specs for any configured app at a glance.
- Trigger any pipeline from the UI and watch it stream, then see the typed result.
- Reuse `src/core/types.ts` and the pipeline functions verbatim — no forked logic.
- Stay close to the codebase's lean TS-ESM, minimal-dependency aesthetic.
- Be safe by construction: local-only bind, guardrails on costly/destructive runs.

## Non-Goals (v1)

- **Traceability matrix** view (requirement→spec→test→result grid) — future work.
- **Generated-artifact viewer** (read generated tests/docs/security stubs) — future work.
- Multi-user, auth, or any remote/hosted deployment.
- Editing specs from the UI (it reads specs; authoring stays in the editor/CLI).

## Architecture

### Topology

```
specguard-dashboard/        # the worktree (branch feat/dashboard, off build/specguard-impl)
  dashboard/
    server/                 # Hono, ESM, TS — imports ../../src pipeline fns directly
      index.ts              # boots server, serves built web/, mounts API
      api.ts                # route handlers → call pipeline functions
      runner.ts             # wraps pipeline calls, captures logs, streams via SSE
    web/                    # Vite + React + TS frontend
      src/
        types.ts            # re-exports from ../../src/core/types.ts (single source of truth)
        api.ts              # typed fetch/SSE client
        views/
          DriftView.tsx     # headline view
          CoverageView.tsx
          SpecExplorer.tsx
          RunnerView.tsx
        components/
          SpecPanel.tsx     # shared rendered-spec component (drift drilldown + explorer)
```

The `dashboard/` directory is **self-contained**. The only change outside it is a
one-line `package.json` script (`"dashboard"`). This minimizes merge conflicts
with the team working on the core CLI.

### Stack rationale

- **Server: Hono** — modern, TypeScript-first, ESM-native, tiny. Same minimalist
  spirit as `commander`. Imports the existing pipeline functions directly.
- **Frontend: Vite + React + TypeScript** — so the UI imports the same
  `src/core/types.ts` the CLI uses. Type-safe end to end.

### Launch

`npm run dashboard` → builds `web/`, starts the Hono server, opens the browser.
The server **binds `127.0.0.1`** only. It runs LLM pipelines and writes files,
so it must never be exposed to a network.

## Views

### 1. Drift monitor (primary)

Answers "which specs are stale versus their code?"

- **Data source:** `runDrift(config, opts)` — compares source-file mtime vs. spec
  mtime and maps changed files → specs via config globs.
- **Layout:** a table, one row per spec, grouped by app:
  - Spec key (`core/spec-parser`) · status badge (`stable`/`draft`) · linked source
    module · **drift state**: `in sync` (green) / `source newer` (amber) /
    `no spec` (red) / `orphan spec` (gray — spec with no source).
  - Source and spec last-changed timestamps, side by side.
  - "Changed since" control: `HEAD~1` default, or pick a git ref — passed straight
    to the pipeline's `--since`.
- **Drilldown:** click a drifting row → side panel shows the parsed spec (overview,
  acceptance criteria, scenarios) next to the source files that changed after it.
- **One action:** "Regenerate spec" on a drifting row → `runReverseGenerate` with
  `force` for that file, streams logs, refreshes the row.

### 2. Coverage (secondary)

From `runStatus`: per-app totals, % specs, % tests, list of files missing specs.
The big-picture summary above the drift detail.

### 3. Spec explorer (secondary)

Read-only list of all parsed specs (`loadAllSpecs`); click to read a rendered
spec via the shared `SpecPanel` component (also used by the drift drilldown).

### 4. Pipeline runner (secondary)

Generic panel: pick a pipeline, set its flags, run, watch the SSE log stream, see
the returned `PipelineResult` (created/updated/skipped/failed + per-item detail).
Costly/destructive pipelines (`reverse`, `generate`, `heal`, `security`) require a
confirm step.

Only **implemented** pipelines are runnable: `reverse` (`runReverseGenerate`),
`generate` (`runForwardGenerate`), `heal` (`runHeal`), `security` (`runSecurity`),
`docs` (`runDocGenerate`), `drift` (`runDrift`), `status` (`runStatus`). The CLI
also defines `validate`, `matrix`, and `import` as **stub** subcommands with no
pipeline implementation yet — the runner shows these disabled with a "not yet
implemented" note, matching CLI behavior, until they land.

## Data Flow

### Reads

`GET /api/status`, `GET /api/drift`, `GET /api/specs` → server calls the pipeline
function, returns JSON (`PipelineResult` / `ParsedSpec[]`). Frontend renders.

### Triggers (streaming)

`POST /api/run/:pipeline` opens a **Server-Sent Events** stream. `runner.ts`
patches the pipeline's logger so each line is emitted as an SSE `log` event; a
final `result` event carries the `PipelineResult`. The frontend appends logs live,
then refreshes the affected views.

### Error handling

- A pipeline throwing `SpecGuardError` → server maps to `{ error, exitCode }`
  (reusing `src/core/exit-codes.ts`) with an HTTP 4xx/5xx status; the frontend
  shows it inline — never a blank screen.
- Missing config → friendly "run `specguard init`" message.

## Interfaces (contracts)

| Endpoint | Method | Returns | Backed by |
|----------|--------|---------|-----------|
| `/api/config` | GET | `{ apps: AppConfig[] }` (sans secrets) | `loadConfig` |
| `/api/status` | GET | `PipelineResult` | `runStatus` |
| `/api/drift?since=<ref>` | GET | `PipelineResult` | `runDrift` |
| `/api/specs` | GET | `ParsedSpec[]` | `loadAllSpecs` |
| `/api/run/:pipeline` | POST (SSE) | `log` events + final `result` | the matching `run*` fn |

The frontend's `web/src/types.ts` re-exports the canonical types from
`src/core/types.ts` so request/response shapes are checked at compile time on both
sides.

## Testing

- **Server:** Vitest. Mock the pipeline functions; assert routes return the right
  JSON and that SSE framing (`log` events then a terminal `result` event) is
  correct. No real LLM calls — same rule as the rest of the repo.
- **Frontend:** keep it thin enough to verify by unit-testing the typed API client
  and the drift-table transform (raw `PipelineResult` → grouped rows). No heavy
  component/e2e harness in v1.
- Tests run under the existing `vitest` suite so CI stays single-command.

## Git / Team Collaboration Workflow

- Work happens in an **isolated worktree** at `specguard-dashboard/` on branch
  **`feat/dashboard`**, based off `build/specguard-impl` (the branch that actually
  contains the pipeline implementation; `main` is currently only the bootstrap
  scaffold).
- **Self-contained `dashboard/` folder** — no edits to `src/` except the one-line
  `package.json` script. Minimizes conflicts with core-CLI work.
- **Conventional Commits** (`feat(dashboard): …`), small atomic commits,
  checkpointed frequently.
- **Draft PR early** against the integration branch, description linking this spec,
  for incremental review. Squash-merge when green.
- **CI-friendly:** dashboard tests run in the existing vitest suite; the dashboard
  build never breaks the CLI's `tsc`.

> **Repo-state note for the team:** the SpecGuard implementation is not yet on
> `main` — it lives on `build/specguard-impl` (unpushed at design time). The
> recommended next infrastructure step is to push/merge `build/specguard-impl`
> into `main` so all feature branches, including this one, share `main` as their
> base. Until then, `feat/dashboard` is based on `build/specguard-impl`.

## Open Questions / Future Work

- Add the **traceability matrix** view once the `matrix` pipeline output stabilizes.
- Add a **generated-artifact viewer** for tests/docs/security stubs.
- Optional file-watch auto-refresh (re-run `drift`/`status` on source change).
