# SpecGuard MCP Server

<!-- module: specguard-mcp/server / type: feature / status: draft -->

## Overview

The SpecGuard MCP server exposes every SpecGuard pipeline as a named MCP tool over a stdio transport. It is built and configured by `buildServer()`, which registers all tools but does not connect a transport; the transport is started only when the module is executed as the main entry point, allowing safe import in tests. Each tool resolves a working directory, loads configuration via `loadConfig`, delegates to the corresponding pipeline function, and returns a `PipelineResult` formatted as text content. Every tool invocation is wrapped with activity logging that writes start, end, and error entries to `.specguard/activity-log.json` so that external dashboards can observe real-time agent activity. The server is identified by the name `specguard-mcp` at version `0.1.0`.

## Acceptance Criteria

- AC1: `buildServer()` returns a configured `McpServer` instance without connecting a transport or blocking the process.
- AC2: The server registers exactly the following tools: `specguard_reverse`, `specguard_generate`, `specguard_heal`, `specguard_status`, `specguard_drift`, `specguard_security`, `specguard_docs`, `specguard_validate`, `specguard_matrix`, `specguard_import`, `specguard_quality`, `specguard_deps`, `specguard_commit`, `specguard_analyze`, `specguard_plan_fix`, `specguard_read_spec`, and `specguard_write_spec`.
- AC3: When a tool is invoked, a `running` activity log entry is written before the pipeline executes, and a `pass` or `fail` entry (with `durationMs`) is written after it completes.
- AC4: When a pipeline throws, an `error` activity log entry is written with the error message and `durationMs`, and the tool returns an error result rather than propagating the exception.
- AC5: The `cwd` input parameter, when provided, is resolved to an absolute path via `path.resolve`; when absent, `process.cwd()` is used.
- AC6: `specguard_read_spec` accepts either `specKey` or `path`; supplying neither returns an error result with the message "Provide either specKey or path."
- AC7: `specguard_analyze` appends a human-readable recommendations summary to the pipeline result messages; when no recommendations exist the summary reads "Workspace is healthy — nothing to do."
- AC8: `specguard_plan_fix` appends the generated plan as formatted text to the result messages and notes that the plan is saved to `.specguard/fix-plan.json`; when plan generation fails the message reads "Failed to generate fix plan."
- AC9: `specguard_commit` never stages or commits source code files — only SpecGuard-generated files (tests, docs, specs, `.specguard/` reports).
- AC10: The stdio transport is connected only when the file is executed as the main module (i.e., `import.meta.url` matches the resolved entry point).

## Scenarios

### Scenario 1: Server builds without connecting transport

**Steps:**
1. Import `buildServer` from `src/mcp/server.ts` in a test environment.
2. Call `buildServer()`.
3. Assert the return value is a non-null object.
4. Assert no stdio transport has been opened (process stdin/stdout remain unmodified).

**Expected Results:**
- `buildServer()` returns an `McpServer` instance.
- No transport connection side-effects occur during import or `buildServer()` invocation.

---

### Scenario 2: Tool invocation writes activity log entries

**Steps:**
1. Mock `appendActivityLogEntry` to capture calls.
2. Mock `loadConfig` to return a minimal valid config.
3. Mock `runStatus` to return a successful `PipelineResult`.
4. Call the `specguard_status` tool handler with `{ cwd: '/tmp/project' }`.
5. Await the returned promise.

**Expected Results:**
- `appendActivityLogEntry` is called first with `{ pipeline: 'status', status: 'running', source: 'mcp' }` and cwd `'/tmp/project'`.
- `appendActivityLogEntry` is called second with `{ pipeline: 'status', status: 'pass', source: 'mcp' }` and a numeric `durationMs` ≥ 0.
- The tool returns a result object with no `isError` flag set to `true`.

---

### Scenario 3: Pipeline error writes error activity log entry and returns error result

**Steps:**
1. Mock `appendActivityLogEntry` to capture calls.
2. Mock `loadConfig` to return a minimal valid config.
3. Mock `runDrift` to throw `new Error('git not found')`.
4. Call the `specguard_drift` tool handler with `{ cwd: '/tmp/project' }`.
5. Await the returned promise.

**Expected Results:**
- `appendActivityLogEntry` is called with `{ pipeline: 'drift', status: 'error', source: 'mcp', message: 'git not found' }` and a numeric `durationMs`.
- The tool returns an error result (not a thrown exception).
- The process does not crash.

---

### Scenario 4: `cwd` parameter resolves correctly

**Steps:**
1. Mock `loadConfig` to capture the path argument it receives.
2. Mock `runStatus` to return a successful `PipelineResult`.
3. Call the `specguard_status` tool handler with `{ cwd: 'relative/path' }`.
4. Await the returned promise.
5. Assert the path passed to `loadConfig`.

**Expected Results:**
- `loadConfig` receives an absolute path equivalent to `path.resolve('relative/path')`.

---

### Scenario 5: `specguard_status` tool invoked without `cwd` uses `process.cwd()`

**Steps:**
1. Mock `loadConfig` to capture the path argument.
2. Mock `runStatus` to return a successful `PipelineResult`.
3. Call the `specguard_status` tool handler with `{}` (no `cwd`).
4. Await the returned promise.

**Expected Results:**
- `loadConfig` receives a path equal to `process.cwd()`.

---

### Scenario 6: `specguard_read_spec` with neither `specKey` nor `path` returns error

**Steps:**
1. Call the `specguard_read_spec` tool handler with `{}`.
2. Await the returned promise.

**Expected Results:**
- The result has `isError` set to `true`.
- The result content includes the text "Provide either specKey or path."

---

### Scenario 7: `specguard_read_spec` resolves `specKey` against first app's `specDir`

**Steps:**
1. Mock `loadConfig` to return a config with one app whose `specDir` is `'specs'` and `rootDir` is `'/project'`.
2. Mock `readFile` to return a valid spec Markdown string when called with `/project/specs/core/my-feature.md`.
3. Mock `parseSpecContent` to return a parsed spec object.
4. Call the `specguard_read_spec` tool handler with `{ specKey: 'core/my-feature', cwd: '/project' }`.
5. Await the returned promise.

**Expected Results:**
- `readFile` is called with the absolute path `/project/specs/core/my-feature.md`.
- The result content includes `specKey: core/my-feature` and the raw file content.
- No error is returned.

---

### Scenario 8: `specguard_analyze` appends recommendations summary

**Steps:**
1. Mock `loadConfig` to return a minimal valid config.
2. Mock `runAnalyze` to return a `PipelineResult` with `analysisReport.recommendations` containing two entries: `{ priority: 'high', pipeline: 'drift', reason: 'stale specs' }` and `{ priority: 'low', pipeline: 'quality', reason: 'lint errors' }`.
3. Call the `specguard_analyze` tool handler with `{ cwd: '/project' }`.
4. Await the returned promise.

**Expected Results:**
- The result messages array contains a string beginning with "2 recommendation(s):".
- The summary includes `[high] drift: stale specs` and `[low] quality: lint errors`.

---

### Scenario 9: `specguard_analyze` with no recommendations returns healthy message

**Steps:**
1. Mock `loadConfig` to return a minimal valid config.
2. Mock `runAnalyze` to return a `PipelineResult` with `analysisReport.recommendations` as an empty array.
3. Call the `specguard_analyze` tool handler with `{ cwd: '/project' }`.
4. Await the returned promise.

**Expected Results:**
- The result messages array contains the string "Workspace is healthy — nothing to do."

---

### Scenario 10: `specguard_plan_fix` formats plan and notes save location

**Steps:**
1. Mock `loadConfig` to return a minimal valid config.
2. Mock `runPlanFix` to return a result with `plan: { title: 'Fix drift', summary: 'Update stale specs', steps: [{ id: '1', description: 'Run specguard reverse' }] }`.
3. Call the `specguard_plan_fix` tool handler with `{ pipeline: 'drift', issues: 'Three specs are stale', cwd: '/project' }`.
4. Await the returned promise.

**Expected Results:**
- The result messages array contains a string including "Fix Plan: Fix drift".
- The message includes "  1: Run specguard reverse".
- The message includes "Plan saved to .specguard/fix-plan.json — present to user for approval before executing."

---

### Scenario 11: `specguard_plan_fix` when plan generation fails

**Steps:**
1. Mock `loadConfig` to return a minimal valid config.
2. Mock `runPlanFix` to return a result with `plan` set to `null` or `undefined`.
3. Call the `specguard_plan_fix` tool handler with `{ pipeline: 'validate', issues: 'Login scenario fails', cwd: '/project' }`.
4. Await the returned promise.

**Expected Results:**
- The result messages array contains the string "Failed to generate fix plan."

## Security Notes

- No API keys, tokens, or credentials appear in this source file; none are reproduced here.
- The `cwd` parameter accepted by every tool is resolved via `path.resolve` before use; callers should ensure that the MCP server process runs with appropriate filesystem permissions, as an arbitrary `cwd` could cause config to be loaded from unintended directories.
- `specguard_commit` is documented to stage and commit only SpecGuard-generated files and must never commit source code; this constraint must be enforced in the `runGitOps` pipeline implementation.
- The `specguard_import` tool accepts an `https://` URL as a source; the underlying `runImport` pipeline is responsible for validating and sanitising remote content before writing it to disk.

## Dependencies

- `@modelcontextprotocol/sdk` — `McpServer`, `StdioServerTransport`
- `zod` — input schema validation for all tool definitions
- `../core/config` — `loadConfig`
- `../core/spec-parser` — `parseSpecContent`
- `../core/reader` — `readFile`
- `../core/writer` — `writeFile`
- `../pipelines/reverse-generate` — `runReverseGenerate`
- `../pipelines/forward-generate` — `runForwardGenerate`
- `../pipelines/heal` — `runHeal`
- `../pipelines/status` — `runStatus`
- `../pipelines/drift` — `runDrift`
- `../pipelines/security` — `runSecurity`
- `../pipelines/doc-generate` — `runDocGenerate`
- `../pipelines/validate` — `runValidate`
- `../pipelines/matrix` — `runMatrix`
- `../pipelines/import` — `runImport`
- `../pipelines/code-quality` — `runCodeQuality`
- `../pipelines/dep-check` — `runDepCheck`
- `../pipelines/git-ops` — `runGitOps`
- `../pipelines/analyze` — `runAnalyze`
- `../pipelines/plan-fix` — `runPlanFix`
- `./format` — `errorResult`, `textResult`, `toolResult`, `ToolResult`
- `./activity-hook` — `appendActivityLogEntry`