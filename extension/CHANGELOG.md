# SpecGuard VS Code Extension — Changelog

All notable changes are documented here.

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
