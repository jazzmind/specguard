# MCP Server

<!--
  module: src/mcp/server.ts
  type: core
  status: draft
-->

## Overview

The SpecGuard MCP (Model Context Protocol) server. Exposes every SpecGuard
pipeline as an MCP tool over a stdio transport, so an MCP-capable client
(Cursor, Claude Desktop, etc.) can drive the same pipelines the `specguard`
CLI drives. The server is a thin wiring layer: each tool loads config via
`loadConfig`, maps the tool input to the pipeline's typed `opts`, calls the
**same** pipeline function the CLI calls, and returns the resulting
`PipelineResult` formatted as text content. It contains no business logic.

Built with `@modelcontextprotocol/sdk` v1 (`McpServer` + `StdioServerTransport`)
and `zod` raw-shape input schemas via `server.registerTool`. The bin entry
`specguard-mcp` maps to `dist/mcp/server.js`.

## Acceptance Criteria

- [ ] Server starts on a `StdioServerTransport` when run as the main module
- [ ] Importing `src/mcp/server.ts` does NOT start the transport (no hang) —
      startup is guarded behind a main-module check
- [ ] Exactly one tool is registered per pipeline plus two utility tools and
      two not-yet-implemented stubs (see Tools)
- [ ] Each pipeline tool loads config via `loadConfig` (cwd = `process.cwd()` or
      an optional `cwd` argument) and calls the matching pipeline function
- [ ] Each tool returns `{ content: [{ type: 'text', text }] }` where text
      includes the pipeline messages and counts (created/updated/skipped/failed)
- [ ] On error a tool returns `{ content: [...], isError: true }` instead of throwing
- [ ] `specguard_validate` and `specguard_matrix` return a "not yet implemented"
      text result (mirrors the CLI stubs) so the tool surface is complete
- [ ] A shared helper formats a `PipelineResult` into the text summary

## Tools

| Tool | Backing function | Input |
|---|---|---|
| `specguard_reverse` | `runReverseGenerate` | `app`, `file?`, `force?`, `cwd?` |
| `specguard_generate` | `runForwardGenerate` | `spec?`, `all?`, `framework?`, `app?`, `force?`, `cwd?` |
| `specguard_heal` | `runHeal` | `spec?`, `all?`, `maxRetries?`, `cwd?` |
| `specguard_status` | `runStatus` | `cwd?` |
| `specguard_drift` | `runDrift` | `since?`, `spec?`, `cwd?` |
| `specguard_security` | `runSecurity` | `spec?`, `all?`, `withSast?`, `cwd?` |
| `specguard_docs` | `runDocGenerate` | `spec?`, `all?`, `out?`, `cwd?` |
| `specguard_validate` | (stub) | — returns "not yet implemented" |
| `specguard_matrix` | (stub) | — returns "not yet implemented" |
| `specguard_read_spec` | utility | `specKey?` or `path?`, `cwd?` |
| `specguard_write_spec` | utility | `path`, `content` |

Each backing function is the identical export the CLI subcommand dispatches to
(see `specs/core/cli.md`).

## Scenarios

### Scenario 1: Module imports without starting transport

**Steps:**
1. `import('./src/mcp/server.js')` from a smoke-test script (not main module)

**Expected Results:**
- The module loads, registers tools, and returns without connecting a transport
- The process does not hang

---

### Scenario 2: A pipeline tool returns a formatted result

**Steps:**
1. Client calls `specguard_status` with no arguments
2. The handler loads config and calls `runStatus`

**Expected Results:**
- A single text content block is returned
- The text contains the pipeline name, counts, and message lines
- No exception escapes the handler

---

### Scenario 3: Config missing — tool reports an error

**Steps:**
1. Client calls a pipeline tool from a directory with no `.specguard/config.json`

**Expected Results:**
- The handler catches the `ConfigNotFoundError`
- Returns `{ isError: true }` with a text block describing the failure
- The server stays up for subsequent calls

---

### Scenario 4: Utility read_spec returns content + parsed summary

**Steps:**
1. Client calls `specguard_read_spec` with a `path` to an existing spec

**Expected Results:**
- Returns the raw file content plus a parsed summary (title, specKey, scenario count)
  produced via `parseSpecContent`

## Security Notes

- The server resolves the LLM API key from the env var named in config
  (`llm.apiKeyEnv`) at pipeline-call time. The key value is never echoed in any
  tool result. Tool results contain only `PipelineResult` data (messages/counts).
- `specguard_write_spec` writes through `writer.writeFile`, which creates parent
  directories. Callers are trusted (local stdio client); no path sandboxing
  beyond the host filesystem permissions is performed.

## Dependencies

- `specs/core/cli.md` — the subcommand → pipeline mapping mirrored here
- `specs/core/config.md` — `loadConfig`
- `specs/core/spec-parser.md` — `parseSpecContent` for the read-spec utility
