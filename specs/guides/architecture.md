---
id: architecture
kind: journey
title: "SpecGuard architecture"
audience: dev
order: 1
related:
  - platform-foundation
  - integration-surfaces
  - documentation-api
  - proof-store
---

# SpecGuard architecture

## Goal
Learn how SpecGuard is put together, so you know where a change belongs and which spec owns it.

## Prerequisites
Read [Core concepts](../guide/concepts.md). You need Node.js 20 or newer to build it.

## Steps
### One core, several surfaces
SpecGuard is a TypeScript ESM program. One core exposes the same pipelines through several surfaces, so a behavior is written once.

```
           CLI (`specguard`)     MCP server (`specguard-mcp`)     VS Code extension     Team server / `serve` API
                      \                    |                              |                      /
                       +---------------- pipelines (src/pipelines) -------+---------------------+
                                           |
                       core (src/core): specs, claims, proofs, config, llm, reader, writer
```

| Directory | What lives there |
|---|---|
| `src/core/` | The foundation: types, spec parser and graph, claims, proof ledger and statement, config, LLM chokepoint, reader and writer, exit codes |
| `src/pipelines/` | One file per pipeline. Each exports one async function that takes a config and options and returns a `PipelineResult` |
| `src/cli/` | The commander entry point; each subcommand delegates to a handler in `src/cli/commands/` and contains no business logic |
| `src/mcp/` | The MCP server that exposes pipelines as tools (`specguard_<name>`) |
| `src/server/` | The read-only `serve` API and the team server, with the documentation service |
| `src/plugins/` | Built-in plugins and the plugin loader |
| `src/adapters/` | Runner adapters: Playwright, Docker, Semgrep and the auth state machine |
| `src/hooks/` | The agent edit guard and history-capture hooks |
| `extension/` | The VS Code extension host and its React webview |
| `specs/` | SpecGuard's own specs: the source of truth for all of the above |

### Rules the code follows
- Model calls go through `src/core/llm.ts`, never straight to a provider SDK. It handles providers, fallback, retries, budget, replay and redaction.
- File I/O in pipelines goes through `src/core/reader.ts` and `src/core/writer.ts`. The writer replaces a file atomically, so a reader never sees half of one.
- Zod schemas for model output are defined in the pipeline that uses them.
- Typed exit codes (`src/core/exit-codes.ts`) are stable; CI and the MCP server depend on them.

### Specs, claims and proofs in the code
The spec parser (`src/core/spec-parser.ts`) reads frontmatter and sections; the spec graph (`src/core/spec-graph.ts`) builds the tree of system, capabilities and components, resolves the files each spec owns from its `sources` globs and reports rule violations. Claims (`src/core/claims.ts`) are requirement bullets with stable ids and a content hash. Test results are normalised (`src/core/test-results.ts`) and merged into the proof ledger (`src/core/proof-ledger.ts`) per claim and layer. The proof statement (`src/core/proof-statement.ts`) judges each capability on four pillars from that evidence. CI evidence is a git note (`src/core/proof-note.ts`, `src/core/proof-store.ts`).

### State on disk
Committed: `specs/`, `.specguard/config.json`, `.specguard/changes/`, and generated documentation. Local runtime state, kept out of git: `.specguard/proofs.json`, `.specguard/runs/`, `.specguard/cache/`, the activity log, the LLM usage log and agent requests. A repository set up or migrated by SpecGuard ignores these for you (`specguard migrate`).

### Documentation is generated from the specs
`specguard docs build` (`src/pipelines/doc-build.ts`) turns the guide specs under `specs/guides/` and the capability specs into this documentation set. Guides, the index, the manifest and the help topics are rendered deterministically. A capability's reference page is written by the model through the documentation service (`src/server/docs.ts`) and is regenerated only when its spec changes, which the committed `docs/manifest.json` records. The same service backs `GET /api/v1/docs/:audience/:id` on `specguard serve`.

### Plugins
A plugin bundles any of: CLI and MCP commands, contract importers, catalog providers, discoverers, security detectors, documentation renderers and endpoint extractors. Core knows nothing about a particular platform; layout and tooling come from a plugin and config. See [Extending SpecGuard with plugins](extending-with-plugins.md).

### Workspaces and the team server
A workspace (`src/core/workspace.ts`) is a manifest of repositories and units; contracts (`src/core/contracts.ts`) are edges between their specs; the rollup (`src/core/workspace-rollup.ts`) is the combined picture. The team server (`src/server/`) stores published snapshots (Postgres, or files) and serves them with the same documents; it is optional, and every command works without it.

## Outcome
You can place a change: a new behavior goes in a pipeline behind a thin CLI handler, backed by a spec, with its tests tagged to the requirement.

## Related
- [Developing SpecGuard](developing-specguard.md)
- [Extending SpecGuard with plugins](extending-with-plugins.md)
- [Core concepts](../guide/concepts.md)
