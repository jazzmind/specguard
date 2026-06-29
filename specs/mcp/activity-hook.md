# Activity Hook – MCP Activity Log Writer

<!-- module: specguard-mcp/activity-hook / type: utility / status: draft -->

## Overview

The Activity Hook module provides a standalone, best-effort writer for appending `ActivityEntry` objects to `.specguard/activity-log.json` within a given workspace root. It is used exclusively by the MCP server and has no dependency on the VS Code extension host, relying only on Node.js built-ins. The VS Code extension watches the produced file to display agent actions in the SpecGuard dashboard. The module enforces a 1 MB file-size cap by retaining only the most recent 200 entries when the limit is exceeded. All errors are silently swallowed so that a log-write failure never crashes the MCP server.

## Acceptance Criteria

- AC-1: `appendActivityLogEntry` creates `.specguard/activity-log.json` (and any missing parent directories) when the file does not yet exist.
- AC-2: Each written entry contains a unique `id` (format `<epoch>-<5-char alphanumeric>`) and a `timestamp` (Unix milliseconds), in addition to all caller-supplied fields.
- AC-3: Successive calls append entries to the existing array rather than overwriting previous entries.
- AC-4: When the existing log file exceeds 1 048 576 bytes, only the most recent 200 entries are retained before the new entry is appended.
- AC-5: If the log file contains invalid JSON, the file is treated as empty and a fresh array is started.
- AC-6: `appendActivityLogEntry` never throws under any error condition (missing permissions, corrupt file, full disk, etc.).
- AC-7: The written file is valid JSON containing a top-level array of `ActivityEntry` objects, pretty-printed with 2-space indentation.
- AC-8: The `source` field of entries written by this module must be `'mcp'`.

## Scenarios

### Scenario 1: First write creates directory and file

**Steps:**
1. Ensure `.specguard/` does not exist under a temporary workspace root.
2. Call `appendActivityLogEntry(workspaceRoot, { pipeline: 'test-pipeline', status: 'info', source: 'mcp' })`.
3. Check whether `.specguard/activity-log.json` exists on disk.
4. Read and parse the file contents as JSON.

**Expected Results:**
- The directory `.specguard/` is created.
- The file `.specguard/activity-log.json` exists.
- The parsed value is an array containing exactly one object.
- The single object has a `pipeline` value of `'test-pipeline'`, `status` of `'info'`, and `source` of `'mcp'`.
- The object has an `id` property matching the pattern `/^\d+-[a-z0-9]{5}$/`.
- The object has a numeric `timestamp` property greater than `0`.

### Scenario 2: Subsequent writes append to existing entries

**Steps:**
1. Call `appendActivityLogEntry(workspaceRoot, { pipeline: 'pipe-a', status: 'running', source: 'mcp' })`.
2. Call `appendActivityLogEntry(workspaceRoot, { pipeline: 'pipe-b', status: 'pass', source: 'mcp' })`.
3. Read and parse `.specguard/activity-log.json`.

**Expected Results:**
- The parsed array contains exactly two objects.
- The first object has `pipeline` equal to `'pipe-a'`.
- The second object has `pipeline` equal to `'pipe-b'`.
- Both objects have distinct `id` values.

### Scenario 3: Optional fields are persisted when supplied

**Steps:**
1. Call `appendActivityLogEntry(workspaceRoot, { pipeline: 'pipe-c', status: 'fail', source: 'mcp', message: 'Something failed', durationMs: 420, counts: { failed: 3 } })`.
2. Read and parse `.specguard/activity-log.json`.

**Expected Results:**
- The single entry has `message` equal to `'Something failed'`.
- The entry has `durationMs` equal to `420`.
- The entry has `counts.failed` equal to `3`.

### Scenario 4: File exceeding 1 MB is trimmed to the last 200 entries before appending

**Steps:**
1. Write a pre-built JSON array of 300 `ActivityEntry` objects to `.specguard/activity-log.json` such that the file size exceeds 1 048 576 bytes.
2. Call `appendActivityLogEntry(workspaceRoot, { pipeline: 'new-entry', status: 'pass', source: 'mcp' })`.
3. Read and parse `.specguard/activity-log.json`.

**Expected Results:**
- The parsed array contains exactly 201 entries (200 retained + 1 new).
- The last entry has `pipeline` equal to `'new-entry'`.
- The retained entries are the last 200 from the original 300 (i.e., entries at original indices 100–299).

### Scenario 5: Corrupt JSON file is treated as empty

**Steps:**
1. Write the string `"not valid json{{{"` to `.specguard/activity-log.json`.
2. Call `appendActivityLogEntry(workspaceRoot, { pipeline: 'recovery', status: 'info', source: 'mcp' })`.
3. Read and parse `.specguard/activity-log.json`.

**Expected Results:**
- No exception is thrown by `appendActivityLogEntry`.
- The parsed value is an array containing exactly one object.
- The single object has `pipeline` equal to `'recovery'`.

### Scenario 6: Function does not throw when the workspace root is unwritable

**Steps:**
1. Set up a workspace root path that is not writable (e.g., a non-existent root on a read-only path, or mock `fs.mkdirSync` to throw `EACCES`).
2. Wrap a call to `appendActivityLogEntry(workspaceRoot, { pipeline: 'safe', status: 'error', source: 'mcp' })` in a try/catch.

**Expected Results:**
- No exception propagates out of `appendActivityLogEntry`.
- The catch block in the test is never reached.

### Scenario 7: Written file is valid pretty-printed JSON

**Steps:**
1. Call `appendActivityLogEntry(workspaceRoot, { pipeline: 'format-check', status: 'pass', source: 'mcp' })`.
2. Read the raw file content of `.specguard/activity-log.json` as a string.

**Expected Results:**
- The raw string can be parsed by `JSON.parse` without error.
- The raw string contains newline characters and two-space indentation (i.e., matches the output of `JSON.stringify(value, null, 2)`).

## Security Notes

- No credentials, tokens, or secret values are read or written by this module.
- The log file is written to a workspace-local path (`.specguard/activity-log.json`) and is not transmitted over any network.
- Entry `id` values are generated from `Date.now()` and `Math.random()`; they are not cryptographically secure and must not be used as security tokens.
- Callers are responsible for ensuring that `message` and other free-text fields do not contain sensitive information before passing them to this function.

## Dependencies

- `node:fs` – directory creation, file existence checks, stat, read, and write operations.
- `node:path` – construction of the log file path from `workspaceRoot`.
- No VS Code extension host APIs; no third-party packages.
- The VS Code extension's `ActivityLogService` must read the same `.specguard/activity-log.json` file format (top-level JSON array of `ActivityEntry` objects) for dashboard display to function correctly.