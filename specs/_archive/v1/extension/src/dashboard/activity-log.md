# Activity Log Service

<!-- module: specguard-extension/src/dashboard/activity-log / type: service / status: draft -->

## Overview

The Activity Log Service maintains a searchable, persistent record of all SpecGuard pipeline activity originating from the extension host, MCP tool invocations, and the CLI. It holds an in-memory ring buffer capped at 500 entries and mirrors entries to `.specguard/activity-log.json` on disk, rotating the file when it exceeds 1 MB. A VS Code OutputChannel named "SpecGuard" receives every appended entry for in-editor searching. On startup the service loads any previously persisted entries and reconciles stale `running` entries left behind by crashes or hard restarts. The service acts as the single source of truth consumed by the dashboard webview via the host file-watcher.

## Acceptance Criteria

1. **Ring buffer cap**: The in-memory buffer never holds more than 500 entries; oldest entries are evicted when the limit is exceeded.
2. **File persistence**: Every appended entry is written to `.specguard/activity-log.json`; the directory is created if absent.
3. **File rotation**: When `activity-log.json` exceeds 1 MB, the file is trimmed to the most-recent 200 entries before the new entry is appended.
4. **Running-entry deduplication**: When a terminal status (`pass`, `fail`, or `error`) is appended for a given pipeline+source pair, the most-recent matching `running` entry is removed from the in-memory buffer before the terminal entry is added.
5. **Stale running reconciliation**: On construction, any `running` entry that has no subsequent terminal entry for the same pipeline+source, or that is older than 2 hours, is rewritten to `error` status with a descriptive message, and the file is overwritten.
6. **OutputChannel formatting**: Each appended entry produces a line in the "SpecGuard" OutputChannel in the format `[<localtime>] <icon> <pipeline>[: <message>]` using the correct status icon (`⏳ ✓ ✗ ! i`).
7. **Clear all**: `clearAll()` removes all non-running entries from memory and file; passing `includeRunning = true` removes all entries including running ones.
8. **Clear completed**: `clearCompleted()` removes all entries with status `pass`, `fail`, `error`, or `info`, preserving `running` entries in memory and file.
9. **Load on startup**: Existing entries from `activity-log.json` are loaded into the in-memory buffer (capped at 500) when the service is constructed; a corrupt or missing file results in an empty buffer without throwing.
10. **Best-effort persistence**: File I/O errors during `append` or `clearAll`/`clearCompleted` are silently swallowed; the service never throws to callers due to persistence failures.

## Scenarios

### Scenario 1: Appending a `running` entry

**Steps:**
1. Construct `ActivityLogService` with a temporary workspace root containing no pre-existing log file.
2. Call `append({ pipeline: 'spec-sync', status: 'running', source: 'extension' })`.
3. Read the return value of `append`.
4. Call `getEntries()`.
5. Read the contents of `.specguard/activity-log.json`.

**Expected Results:**
- The returned `ActivityEntry` has a non-empty `id` string, a `timestamp` close to `Date.now()`, `pipeline: 'spec-sync'`, `status: 'running'`, and `source: 'extension'`.
- `getEntries()` returns an array of length 1 containing the returned entry.
- `activity-log.json` exists and, when parsed as JSON, contains an array of length 1 with the same entry.

---

### Scenario 2: Terminal status deduplicates the preceding `running` entry

**Steps:**
1. Construct `ActivityLogService` with an empty workspace root.
2. Call `append({ pipeline: 'spec-sync', status: 'running', source: 'extension' })`.
3. Call `append({ pipeline: 'spec-sync', status: 'pass', source: 'extension', durationMs: 120 })`.
4. Call `getEntries()`.

**Expected Results:**
- `getEntries()` returns an array of length 1.
- The single entry has `status: 'pass'` and `durationMs: 120`.
- No entry with `status: 'running'` is present in the returned array.

---

### Scenario 3: Ring buffer evicts oldest entries beyond 500

**Steps:**
1. Construct `ActivityLogService` with an empty workspace root.
2. Call `append` 501 times with distinct `pipeline` values and `status: 'info'`.
3. Call `getEntries()`.

**Expected Results:**
- `getEntries()` returns exactly 500 entries.
- The entry appended first (pipeline value from iteration 1) is absent from the returned array.
- The entry appended last (pipeline value from iteration 501) is present.

---

### Scenario 4: File rotation when log exceeds 1 MB

**Steps:**
1. Construct `ActivityLogService` with a workspace root whose `.specguard/activity-log.json` already exists and has a file size greater than 1,048,576 bytes (containing a valid JSON array of entries).
2. Call `append({ pipeline: 'rotate-test', status: 'info', source: 'cli' })`.
3. Read and parse `.specguard/activity-log.json`.

**Expected Results:**
- The parsed array length is at most 201 (200 retained from rotation + 1 new entry).
- The last element of the parsed array has `pipeline: 'rotate-test'` and `status: 'info'`.

---

### Scenario 5: Stale `running` entries are reconciled on startup

**Steps:**
1. Write a `.specguard/activity-log.json` file containing two entries: one with `status: 'running'`, `pipeline: 'p1'`, `source: 'extension'`, and a `timestamp` set to 3 hours ago; and one with `status: 'running'`, `pipeline: 'p2'`, `source: 'mcp'`, and a recent `timestamp` but no subsequent terminal entry.
2. Construct `ActivityLogService` pointing at that workspace root.
3. Call `getEntries()`.
4. Read and parse `.specguard/activity-log.json`.

**Expected Results:**
- Both entries returned by `getEntries()` have `status: 'error'`.
- The entry for `p1` has a `message` containing the substring `'stale — started >2h ago'`.
- The entry for `p2` has a `message` containing the substring `'stale — never completed'`.
- The persisted file reflects the same `error` statuses.

---

### Scenario 6: `clearAll()` preserves running entries by default

**Steps:**
1. Construct `ActivityLogService` with an empty workspace root.
2. Call `append({ pipeline: 'p1', status: 'running', source: 'extension' })`.
3. Call `append({ pipeline: 'p2', status: 'pass', source: 'extension' })`.
4. Call `clearAll()` (no arguments).
5. Call `getEntries()`.
6. Read and parse `.specguard/activity-log.json`.

**Expected Results:**
- `getEntries()` returns exactly 1 entry with `pipeline: 'p1'` and `status: 'running'`.
- The parsed file array also contains exactly 1 entry with `pipeline: 'p1'`.

---

### Scenario 7: `clearAll(true)` removes all entries including running

**Steps:**
1. Construct `ActivityLogService` with an empty workspace root.
2. Call `append({ pipeline: 'p1', status: 'running', source: 'extension' })`.
3. Call `append({ pipeline: 'p2', status: 'info', source: 'mcp' })`.
4. Call `clearAll(true)`.
5. Call `getEntries()`.
6. Read and parse `.specguard/activity-log.json`.

**Expected Results:**
- `getEntries()` returns an empty array.
- The parsed file array is empty.

---

### Scenario 8: OutputChannel receives correctly formatted line

**Steps:**
1. Spy on `vscode.window.createOutputChannel` to capture the mock OutputChannel's `appendLine` calls.
2. Construct `ActivityLogService` with an empty workspace root.
3. Call `append({ pipeline: 'my-pipeline', status: 'fail', source: 'cli', message: 'assertion failed' })`.
4. Inspect the argument passed to `appendLine`.

**Expected Results:**
- `appendLine` is called exactly once.
- The argument matches the pattern `[<time>] ✗ my-pipeline: assertion failed` where `<time>` is a non-empty string.

---

### Scenario 9: Corrupt log file results in empty buffer without throwing

**Steps:**
1. Write `.specguard/activity-log.json` with content `"not valid json {{{"`.
2. Construct `ActivityLogService` pointing at that workspace root (wrapped in a try/catch).
3. Call `getEntries()`.

**Expected Results:**
- No exception is thrown during construction.
- `getEntries()` returns an empty array.

---

### Scenario 10: `show()` reveals the OutputChannel

**Steps:**
1. Spy on `vscode.window.createOutputChannel` to capture the mock OutputChannel's `show` method.
2. Construct `ActivityLogService` with an empty workspace root.
3. Call `show()`.

**Expected Results:**
- The OutputChannel's `show` method is called with `true` as the argument (preserving editor focus).

## Security Notes

- No credentials, tokens, or secrets are stored or logged by this service. `ActivityEntry` fields are pipeline names, status codes, durations, counts, and free-form message strings supplied by callers; callers must ensure no secrets are passed in `message` or `logLines`.
- The log file is written to the workspace-local `.specguard/` directory; access is governed by the OS file-system permissions of the workspace owner.
- File I/O errors are silently swallowed to prevent denial-of-service via disk-full or permission errors; operators should monitor disk space independently.

## Dependencies

| Dependency | Role |
|---|---|
| `vscode` (OutputChannel API) | Creates and writes to the "SpecGuard" in-editor output channel |
| `fs` (Node.js built-in) | Reads, writes, and stats `.specguard/activity-log.json` |
| `path` (Node.js built-in) | Resolves the log file path relative to `workspaceRoot` |
| `DashboardHost` (host.ts) | Calls `append` for extension-host pipeline run events; watches the file to push activity to the webview |
| `server.ts` (MCP tool handler) | Appends entries directly to the log file for MCP-sourced tool invocations |