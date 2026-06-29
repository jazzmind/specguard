# SpecGuard VS Code Extension — Changelog

All notable changes are documented here.

## [0.1.14] — 2026-06-29

### ✨ New

- feat(dashboard): release version 0.1.11 with activity log enhancements and new pipeline commands (`46bfd22`)
- feat(dashboard): release version 0.1.10 with batch pipeline execution and coverage enhancements (`0a325f7`)
- feat(dashboard): release version 0.1.8 with coverage augmentation improvements (`0dabb5d`)
- feat(dashboard): release version 0.1.6 with import functionality enhancements (`f6186dc`)
- feat(specguard): enhance CLI commands and documentation (`f532be0`)
- feat(dashboard): update version to 0.1.2 and enhance sidebar functionality (`d3a80b7`)
- feat(dashboard): enhance activity logging and auto-docs functionality (`874f866`)
- feat(dashboard): chain webview build, packaging, README + verification (`d5444db`)
- feat(dashboard): matrix, docs, and activity tabs (`304b056`)
- feat(dashboard): animated system-flow view (`41a642a`)
- feat(dashboard): webview scaffold, tested event reducer, vite→media build (`76112e3`)
- feat(dashboard): webview panel + openDashboard command/menu (`f1866ce`)
- feat(dashboard): CLI runner + host (watchers, run, coverage, matrix) (`f597522`)
- feat(dashboard): pure flow-event + cli-arg mappers (`3a44ecf`)
- feat(dashboard): traceability.json → matrix model transform (`b2b9eaf`)
- feat(dashboard): extract+test coverage parser, reuse in sidebar (`e096532`)
- feat(dashboard): extension test harness + flow protocol and node metadata (`a38c0bd`)

### 🐛 Fixed

- fix(dashboard): host-side modal confirm for destructive runs + review cleanups (`4072b98`)
- fix(dashboard): derive Activity default pipeline from RUNNABLE_PIPELINES (`618cdad`)
- fix(dashboard): strong CSP nonce + track webview message disposable (`8a2d496`)

### ⚡ Improved

- Update .gitignore to exclude VSIX files and modify the specguard extension binary (`8f0b7b0`)
- Enhance CLI functionality with new commands and improve security pipeline (`8b6e0d8`)
- Update README to further refine instructions for the self-healing test pipeline, expand on defect attribution categories, and enhance clarity on the validation memory feature. Improved sections on authentication handling and evidence-backed issue reporting for better user guidance. (`1c7c81d`)
- Update README to clarify the self-healing test pipeline, introduce defect attribution categories, and outline the validation memory feature. Added details on authentication handling and evidence-backed issue reporting for improved clarity and usability. (`bd0ac2a`)
- Enhance README with detailed features and architecture of SpecGuard. Added new functionalities including test self-healing, hybrid security analysis, and requirement-to-test traceability. Updated CLI commands and clarified import pipeline for external documents. (`baf57e0`)

### 🔧 Internal

- chore: remove outdated documentation files and enhance SpecGuard skill coverage (`dae362e`)
- specguard(gap-analysis): 17 file(s) in .specguard, docs, specs (`829682d`)
- chore(release): bump version to 0.1.3 and update activity log (`ea117b8`)
- chore(dashboard): commit rebuilt webview bundle + untrack SDD scratch (`7c82c95`)
- docs(dashboard): 10-task TDD plan for the extension-webview dashboard (`a116d66`)
- docs(dashboard): pivot to live extension-webview visualization spec (`0d7f8d7`)
- docs(dashboard): implementation plan + align drift view to real pipeline (`29d8425`)
- docs(dashboard): correct streaming approach to post-hoc SSE (`07e1eb8`)
- docs(dashboard): SpecGuard developer control-panel design spec (`b434273`)
- Implement validate, matrix, and import commands in CLI; enhance security pipeline with SAST integration (`d12869f`)
- Phase 5: security + docs pipelines + MCP server, wired into CLI (`8e311f9`)
- Phase 4: forward-generate + heal pipelines, wired into CLI (`8537bb3`)
- Phase 3: status + drift pipelines, wired into CLI (`60520ba`)
- Phase 2: CLI shell (commander) + reverse-generate pipeline (`de2c713`)
- Phase 1: core foundation — spec-parser, config/reader/writer, llm adapter (`2663b48`)
- Phase 0: project scaffold (config, types, exit-codes, errors) (`e9e3177`)
- Refine README to include updated instructions for the self-healing test pipeline, enhance defect attribution categories, and provide clearer guidelines on the validation memory feature. Improved sections on authentication handling and evidence-backed issue reporting for better user understanding. (`f11c8bd`)
- docs: add QA Agent README (`0d5f37f`)
## [0.1.13] — 2026-06-29

_No notable changes collected from git log._
## [0.1.12] — 2026-06-29

_No notable changes collected from git log._
## [0.1.11] — 2026-06-29

_No notable changes collected from git log._
## [0.1.10] — 2026-06-29

_No notable changes collected from git log._
## [0.1.9] — 2026-06-29

_No notable changes collected from git log._
## [0.1.8] — 2026-06-29

_No notable changes collected from git log._
## [0.1.7] — 2026-06-29

_No notable changes collected from git log._
## [0.1.6] — 2026-06-28

_No notable changes collected from git log._
## [0.1.5] — 2026-06-28

_No notable changes collected from git log._
## [0.1.4] — 2026-06-28

_No notable changes collected from git log._
## [0.1.3] — 2026-06-28

_No notable changes collected from git log._
## [0.1.2] — 2026-06-28

_No notable changes collected from git log._
## [0.1.1] — 2026-06-28

_No notable changes collected from git log._
## [0.1.0] — 2026-06-28

### ✨ New

- **Dashboard** — React webview panel with Pipelines, Activity, Findings, Coverage, Matrix, and Docs tabs
- **Activity Feed** — real-time stream of all pipeline runs triggered from the extension or by MCP agents; entries sourced from `.specguard/activity-log.json`
- **Findings View** — filterable table of lint, security, dependency, and dead-code findings from `specguard quality` / `specguard deps`
- **Coverage View** — per-app donut charts and spec/test bar charts; missing-specs expandable list
- **Flow View** — clickable pipeline node graph showing the full SpecGuard architecture
- **Traceability Matrix tab** — renders `.specguard/traceability.json` produced by `specguard matrix`
- **Docs tab** — displays generated user documentation from `specguard docs`
- **Status bar** — live spec coverage percentage
- **Coverage sidebar** — Explorer tree view of spec/test coverage per app
- **MCP registration** — `SpecGuard: Register MCP Server (Cursor)` command writes `.cursor/mcp.json`
- **Source file drift watcher** — auto-runs `specguard drift` in the background when `src/**` files change (debounced 5s)
- **Auto-docs setting** (`specguard.autoDocs`) — regenerates docs automatically when a spec changes (debounced 3s)
- **Context menu commands** — Generate Tests and Security Scan on `.md` spec files in the Explorer

### 🔧 Internal

- Activity log service with in-memory ring buffer (500 entries) and `.specguard/activity-log.json` persistence (1 MB rotate)
- MCP tool handlers wrapped with `withActivityLog` so agent-triggered runs appear in the Activity Feed without polling
- `release` script (`npm run release [patch|minor|major]`) for version bump + changelog + `.vsix` packaging
