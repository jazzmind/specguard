# SpecGuard MCP – Result Formatting Helpers

<!-- module: specguard-mcp/format / type: utility / status: draft -->

## Overview

This module provides pure formatting helpers for the SpecGuard MCP server, converting internal `PipelineResult` objects and arbitrary values into `ToolResult` structures that are structurally compatible with the MCP SDK's `CallToolResult` type. It is intentionally free of SDK and transport imports so that all helpers can be exercised in unit tests without starting an MCP server. Three public builder functions cover the three outcome categories a tool handler can produce: pipeline success, plain text, and error. A fourth helper, `formatResult`, renders a `PipelineResult` as a human-readable summary with an appended raw JSON block for machine consumers.

## Acceptance Criteria

1. `formatResult` MUST produce a header line containing the pipeline name, `created`, `updated`, `skipped`, `failed`, and `exitCode` counts.
2. `formatResult` MUST include each message from `result.messages` when the array is non-empty, separated from the header by a blank line.
3. `formatResult` MUST include an `Items:` section listing every item's key, status, optional path, and optional message when `result.items` is non-empty.
4. `formatResult` MUST append the full raw JSON of the result (pretty-printed, 2-space indent) after a `Raw result:` label.
5. `toolResult` MUST return a `ToolResult` whose `content` array contains exactly one `TextContent` block of type `"text"` with the output of `formatResult`.
6. `textResult` MUST return a `ToolResult` whose `content` array contains exactly one `TextContent` block of type `"text"` with the supplied string verbatim.
7. `errorResult` MUST return a `ToolResult` with `isError: true` and a single `TextContent` block whose text begins with `"Error: "` followed by the error message.
8. `errorResult` MUST extract `.message` from `Error` instances and call `String()` on all other thrown values.
9. No function in this module may import from MCP SDK or transport layers.

## Scenarios

### Scenario 1: Format a pipeline result with messages and items

**Steps:**
1. Construct a `PipelineResult` with `pipeline: "generate"`, `created: 1`, `updated: 0`, `skipped: 2`, `failed: 0`, `exitCode: 0`, `messages: ["All specs up to date"]`, and one item `{ key: "auth/login", status: "created", path: "specs/auth/login.md", message: "New file" }`.
2. Call `formatResult(result)`.
3. Inspect the returned string.

**Expected Results:**
- The first line equals `[generate] created=1 updated=0 skipped=2 failed=0 exitCode=0`.
- The string contains a blank line followed by `All specs up to date`.
- The string contains a line `Items:`.
- The string contains a line matching `  - auth/login: created (specs/auth/login.md) — New file`.
- The string contains a line `Raw result:` followed by valid JSON that round-trips to the original `PipelineResult` object.

### Scenario 2: Format a pipeline result with no messages and no items

**Steps:**
1. Construct a `PipelineResult` with `pipeline: "validate"`, `created: 0`, `updated: 0`, `skipped: 0`, `failed: 0`, `exitCode: 0`, `messages: []`, and `items: []`.
2. Call `formatResult(result)`.
3. Inspect the returned string.

**Expected Results:**
- The first line equals `[validate] created=0 updated=0 skipped=0 failed=0 exitCode=0`.
- The string does NOT contain the word `Items:`.
- The string contains `Raw result:` followed by valid JSON.
- No extra blank lines appear between the header and `Raw result:` beyond those introduced by the raw-result block itself.

### Scenario 3: Format an item with no path and no message

**Steps:**
1. Construct a `PipelineResult` with one item `{ key: "core/types", status: "skipped" }` (no `path`, no `message`).
2. Call `formatResult(result)`.
3. Inspect the `Items:` section of the returned string.

**Expected Results:**
- The item line equals `  - core/types: skipped` with no trailing path or dash-separated message.

### Scenario 4: Build a successful tool result

**Steps:**
1. Construct any valid `PipelineResult` with `failed: 0`.
2. Call `toolResult(result)`.
3. Inspect the returned `ToolResult`.

**Expected Results:**
- `content` is an array of length 1.
- `content[0].type` equals `"text"`.
- `content[0].text` equals the output of `formatResult(result)` for the same input.

### Scenario 5: Build a plain text tool result

**Steps:**
1. Call `textResult("Spec list: auth/login, core/types")`.
2. Inspect the returned `ToolResult`.

**Expected Results:**
- `content` is an array of length 1.
- `content[0].type` equals `"text"`.
- `content[0].text` equals `"Spec list: auth/login, core/types"` exactly.
- `isError` is `undefined` or absent.

### Scenario 6: Build an error tool result from an Error instance

**Steps:**
1. Call `errorResult(new Error("Pipeline timed out"))`.
2. Inspect the returned `ToolResult`.

**Expected Results:**
- `isError` is `true`.
- `content` is an array of length 1.
- `content[0].type` equals `"text"`.
- `content[0].text` equals `"Error: Pipeline timed out"`.

### Scenario 7: Build an error tool result from a non-Error thrown value

**Steps:**
1. Call `errorResult("unexpected string error")`.
2. Inspect the returned `ToolResult`.

**Expected Results:**
- `isError` is `true`.
- `content[0].text` equals `"Error: unexpected string error"`.

### Scenario 8: Build an error tool result from a numeric thrown value

**Steps:**
1. Call `errorResult(42)`.
2. Inspect the returned `ToolResult`.

**Expected Results:**
- `isError` is `true`.
- `content[0].text` equals `"Error: 42"`.

## Security Notes

- This module performs no authentication, authorisation, or network I/O.
- The raw JSON appended by `formatResult` may include file paths from the repository; callers must ensure the resulting `ToolResult` is only surfaced to authorised MCP clients.
- No secret-like values (API keys, tokens, credentials) are handled or expected in `PipelineResult` data; if such values appear in item messages or paths they will be reproduced verbatim in the output — pipeline stages upstream must redact them before passing results to this module.

## Dependencies

| Dependency | Kind | Purpose |
|---|---|---|
| `../core/types.js` – `PipelineResult` | Internal type import | Defines the shape of pipeline output consumed by all three builder functions |
| MCP SDK (`CallToolResult`) | Structural compatibility only (no runtime import) | `ToolResult` is kept structurally compatible via an index signature; no SDK symbols are imported at runtime |