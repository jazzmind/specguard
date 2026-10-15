# Dashboard Host

<!-- module: specguard-extension/src/dashboard/host / type: feature / status: draft -->

## Overview

`DashboardHost` is the VS Code extension-side controller that bridges the SpecGuard dashboard WebView with the underlying CLI and workspace filesystem. It manages file-system watchers for spec, test, doc, and source artifacts, spawns CLI pipelines on demand, and pushes typed `DashboardEvent` messages to the WebView via a `post` callback. The host also maintains an `ActivityLogService` to record pipeline runs originating from both the extension and MCP/agent sources, and synchronises those states back to the dashboard's flow view. On disposal it tears down all watchers, timers, and in-flight CLI processes.

## Acceptance Criteria

1. On `start()`, file-system watchers are created for `**/{specs,tests,docs}/**/*.{md,ts,js}` and `**/{src,app,lib}/**/*.{ts,js,tsx,jsx}`.
2. Creating or changing a spec/test/doc artifact emits the appropriate `artifact` event to the WebView.
3. Changing a spec `.md` file schedules a coverage refresh and, when `specguard.autoDocs` is enabled, schedules an auto-docs run.
4. Source file changes schedule a debounced (30 s) background drift check; duplicate drift results (same exit code) do not produce duplicate activity-log entries.
5. `refresh()` emits `clearArtifacts`, then sequentially pushes coverage, matrix, docs, analysis, fix-plan, findings, plans, and activity-log events.
6. Running a pipeline marked `destructive` requires explicit user confirmation before the CLI is spawned; declining emits a `pipeline:log` cancellation message.
7. The `import` pipeline opens a VS Code file-picker before running; cancelling the picker aborts the run silently.
8. Concurrent runs of the same pipeline are rejected with a warning log line; the second invocation does not spawn a new process.
9. Cancelling a running pipeline kills the process, emits `pipeline:done` with `exitCode: -1`, and records an `error` entry in the activity log.
10. `runSequenceBatch` shows a single confirmation dialog for all destructive pipelines in the batch; individual per-pipeline prompts are suppressed.
11. After `analyze` or `plan-fix` completes, the host reads the corresponding JSON output file and pushes a rich result event.
12. MCP-driven pipeline states are reflected in the flow view by emitting `pipeline:start` / `pipeline:done` events derived from the activity log, without spawning new processes.
13. `dispose()` closes all watchers, clears all timers, and kills all in-flight CLI processes.
14. Opening a file path that resolves to a directory reveals it in the VS Code Explorer; a file path opens it as a text document, optionally scrolling to the specified line.

## Scenarios

### Scenario 1: Spec file created triggers artifact event and coverage refresh

**Steps:**
1. Simulate a `onDidCreate` event on the file-system watcher for `specs/my-feature.md`.
2. Observe the `post` callback invocations.

**Expected Results:**
- A `DashboardEvent` of type `artifact` with `kind: 'doc'` (or the appropriate kind for the path) is posted.
- A coverage refresh is scheduled (a subsequent `coverage` event is posted within the refresh cycle).

### Scenario 2: Source file change triggers debounced drift check

**Steps:**
1. Simulate a `onDidChange` event on the source watcher for `src/index.ts`.
2. Wait fewer than 30 seconds and observe `post` calls.
3. Wait 30 seconds (or advance fake timers by 30 000 ms).
4. Observe activity-log entries.

**Expected Results:**
- No drift-related `post` call occurs before the 30 s debounce elapses.
- After 30 s, the CLI is invoked with the `drift` argument.
- An activity-log entry with `pipeline: 'drift'` and `status: 'pass'` or `status: 'info'` is appended.

### Scenario 3: Duplicate drift result is suppressed

**Steps:**
1. Trigger a background drift run that returns exit code `3` (drift detected).
2. Trigger a second background drift run that also returns exit code `3`.
3. Inspect the activity-log entries for `pipeline: 'drift'`.

**Expected Results:**
- Exactly one activity-log entry for `drift` is created (the second run produces no new entry because `lastDriftCode` matches).

### Scenario 4: Running a destructive pipeline with user confirmation

**Steps:**
1. Send a `run` command for a pipeline whose `destructive` flag is `true`.
2. In the VS Code warning dialog, click **Run**.
3. Observe `post` events and activity-log entries.

**Expected Results:**
- A `pipeline:start` event is posted with the correct `pipeline` id.
- An activity-log entry with `status: 'running'` is appended before the CLI exits.
- After the CLI exits with code `0`, a `pipeline:done` event with `exitCode: 0` is posted.
- A `pipeline:lastRun` event with `status: 'pass'` is posted.

### Scenario 5: Running a destructive pipeline cancelled by user

**Steps:**
1. Send a `run` command for a pipeline whose `destructive` flag is `true`.
2. In the VS Code warning dialog, dismiss without clicking **Run**.
3. Observe `post` events.

**Expected Results:**
- A `pipeline:log` event is posted with `line: 'cancelled by user'`.
- No `pipeline:start` event is posted.
- No CLI process is spawned.

### Scenario 6: Concurrent run of the same pipeline is rejected

**Steps:**
1. Send a `run` command for pipeline `validate`; do not await completion.
2. Immediately send a second `run` command for `validate`.
3. Observe `post` events from the second invocation.

**Expected Results:**
- A `pipeline:log` event is posted containing the text `is already running`.
- Only one CLI process is active for `validate`.

### Scenario 7: Cancelling an in-flight pipeline

**Steps:**
1. Start pipeline `validate` and confirm it is running (`activeRuns` contains the handle).
2. Send a `cancel` command for `validate`.
3. Observe `post` events and activity-log entries.

**Expected Results:**
- A `pipeline:log` event with `line: '[cancelled]'` is posted.
- A `pipeline:done` event with `exitCode: -1` is posted.
- An activity-log entry with `pipeline: 'validate'`, `status: 'error'`, and `message: 'cancelled by user'` is appended.

### Scenario 8: Import pipeline opens file picker

**Steps:**
1. Send a `run` command with `pipeline: 'import'`.
2. Observe that `vscode.window.showOpenDialog` is called with `filters` containing `'Documents'`.
3. Simulate the user selecting a file at `/workspace/docs/prd.md`.
4. Observe `post` events.

**Expected Results:**
- `showOpenDialog` is called once with `canSelectMany: false`.
- A `pipeline:log` event is posted with a line containing `Importing: docs/prd.md` (relative path).
- A `pipeline:start` event is posted for `import`.

### Scenario 9: Import pipeline cancelled via file picker

**Steps:**
1. Send a `run` command with `pipeline: 'import'`.
2. Simulate the user dismissing the file picker (returns `undefined` or empty array).
3. Observe `post` events.

**Expected Results:**
- No `pipeline:start` event is posted.
- No CLI process is spawned.

### Scenario 10: runSequenceBatch shows single confirmation for destructive pipelines

**Steps:**
1. Send a `runSequenceBatch` command with pipelines `['generate', 'validate']` where `generate` is destructive.
2. Observe the number of VS Code warning dialogs shown.
3. Click **Run All**.
4. Observe `post` events for both pipelines.

**Expected Results:**
- Exactly one warning dialog is shown (not one per pipeline).
- `pipeline:start` events are posted for both `generate` and `validate` in order.

### Scenario 11: runSequenceBatch cancelled aborts all pipelines

**Steps:**
1. Send a `runSequenceBatch` command with pipelines `['generate', 'validate']` where `generate` is destructive.
2. Dismiss the confirmation dialog without clicking **Run All**.
3. Observe `post` events.

**Expected Results:**
- `pipeline:log` events with `line: 'cancelled by user (batch)'` are posted for both `generate` and `validate`.
- No `pipeline:start` events are posted.

### Scenario 12: openFile command opens a text document at a specific line

**Steps:**
1. Send an `openFile` command with `path: 'specs/auth.md'` and `line: 10`.
2. Observe VS Code API calls.

**Expected Results:**
- `vscode.window.showTextDocument` is called with the resolved URI for `specs/auth.md`.
- The editor selection is set to line 9 (0-indexed), column 0.
- `revealRange` is called with `TextEditorRevealType.InCenter`.

### Scenario 13: openFile command reveals a directory in Explorer

**Steps:**
1. Send an `openFile` command with `path: 'specs'` where `specs` is a directory.
2. Observe VS Code API calls.

**Expected Results:**
- `vscode.commands.executeCommand` is called with `'revealInExplorer'` and the URI for `specs`.
- `vscode.window.showTextDocument` is not called.

### Scenario 14: MCP-driven running pipeline reflected in flow view

**Steps:**
1. Append an activity-log entry with `source: 'mcp'`, `pipeline: 'validate'`, `status: 'running'`.
2. Trigger `_syncMcpNodeStates()` (e.g., via the activity-log file watcher callback).
3. Observe `post` events.

**Expected Results:**
- A `pipeline:start` event with `pipeline: 'validate'` is posted.
- No CLI process is spawned by the extension.

### Scenario 15: MCP-driven completed pipeline reflected in flow view

**Steps:**
1. Append an activity-log entry with `source: 'mcp'`, `pipeline: 'validate'`, `status: 'pass'`, and a `message`.
2. Trigger `_syncMcpNodeStates()`.
3. Observe `post` events.

**Expected Results:**
- A `pipeline:done` event with `pipeline: 'validate'` and `exitCode: 0` is posted.
- A `pipeline:lastRun` event with `status: 'pass'` and `tail` containing the message is posted.

### Scenario 16: dispose tears down all resources

**Steps:**
1. Call `start()` to initialise watchers and timers.
2. Start a pipeline run so `activeRuns` is non-empty.
3. Call `dispose()`.
4. Observe resource cleanup.

**Expected Results:**
- The file-system watcher `dispose()` methods are called.
- The activity-log file watcher `close()` is called.
- All pending timers are cleared.
- The in-flight CLI process handle's `kill()` method is called.
- `activeRuns` is empty after disposal.

## Security Notes

- No API keys, tokens, or credentials are present in this source file.
- The `openFile` handler resolves paths with `path.resolve(workspaceRoot, cmd.path)` before use; callers should ensure `cmd.path` is validated upstream to prevent path-traversal outside the workspace.
- CLI binary resolution is delegated to `resolveCliPath`; the resolved path should be verified to be within expected installation directories before execution.
- Destructive pipeline confirmation dialogs use `{ modal: true }` to prevent accidental bypassing.

## Dependencies

| Dependency | Role |
|---|---|
| `vscode` (FileSystemWatcher, window, workspace, commands, Uri, Position, Selection, Range) | Workspace file watching, UI dialogs, editor navigation |
| `fs` (Node.js) | Synchronous file existence checks, directory creation, activity-log file watching |
| `path` (Node.js) | Path resolution and relative-path computation |
| `./protocol` (`DashboardEvent`, `DashboardCommand`, `RUNNABLE_PIPELINES`, related types) | Typed event/command protocol between host and WebView |
| `./cli` (`resolveCliPath`, `spawnCli`, `SpawnHandle`) | CLI binary resolution and process spawning |
| `./coverage-parse` (`parseCoverageText`, `augmentCoverageFromDisk`) | Parsing CLI `status` output into coverage data |
| `./matrix-model` (`toMatrixModel`) | Converting raw traceability JSON to matrix model |
| `./flow-events` (`artifactEventFor`, `cliArgsFor`) | Mapping file paths and pipeline ids to events/CLI arguments |
| `./activity-log` (`ActivityLogService`) | Persistent activity-log read/write/clear operations |