# CLI Resolver and Process Spawner

<!-- module: specguard-extension/src/dashboard/cli / type: utility / status: draft -->

## Overview

This module provides the CLI resolution and process-spawning infrastructure for the SpecGuard VS Code extension. It locates the `specguard` CLI binary using a four-level priority chain: an explicit VS Code setting, a local npm install, a development source path, and a bundled fallback. It spawns CLI subprocesses with streaming line-by-line output and supports mid-flight cancellation via a `SpawnHandle`. Environment variables are merged from both the shell environment and a `.specguard/.env` file in the workspace, with shell values taking precedence.

## Acceptance Criteria

- AC-1: `resolveCliPath` returns the value of `specguard.cliPath` when that setting is non-empty, without checking the filesystem.
- AC-2: When `specguard.cliPath` is unset, `resolveCliPath` returns the path to `{workspace}/node_modules/.bin/specguard` if that file exists.
- AC-3: When neither AC-1 nor AC-2 applies, `resolveCliPath` returns `{workspace}/src/cli/index.ts` if that file exists.
- AC-4: When none of AC-1 through AC-3 applies and `_extensionPath` is set, `resolveCliPath` returns `{extensionPath}/dist/cli.js` if that file exists.
- AC-5: When no CLI path is resolvable, `resolveCliPath` returns an empty string.
- AC-6: `spawnCli` called with an empty `cliPath` returns a `SpawnHandle` whose `promise` rejects with an error message directing the user to set `specguard.cliPath` or run `npm install specguard`.
- AC-7: `.js` CLI paths are invoked via `node`; `.ts` CLI paths are invoked via `npx tsx`; all other paths are invoked directly.
- AC-8: On Windows, all spawned processes use `shell: true` regardless of CLI path type.
- AC-9: `buildEnv` merges `.specguard/.env` key-value pairs with `process.env`, with `process.env` values taking precedence over `.env` file values.
- AC-10: `loadDotEnv` ignores blank lines and lines beginning with `#`, and strips surrounding single or double quotes from values.
- AC-11: `spawnCli` streams both stdout and stderr line-by-line to the `onLine` callback, flushing any remaining buffer content on process close.
- AC-12: Calling `kill()` on a `SpawnHandle` sends `SIGTERM` to the child process without throwing if the process has already exited.

## Scenarios

### Scenario 1: Explicit CLI path setting takes priority

**Steps:**
1. Set the VS Code workspace configuration `specguard.cliPath` to `/custom/path/specguard`.
2. Ensure `{workspace}/node_modules/.bin/specguard` exists on disk.
3. Call `resolveCliPath(workspaceRoot)`.

**Expected Results:**
- The returned string equals `/custom/path/specguard`.
- No filesystem stat calls are made for the local bin or source paths.

---

### Scenario 2: Falls back to local npm binary

**Steps:**
1. Ensure `specguard.cliPath` is empty or unset.
2. Create the file `{workspace}/node_modules/.bin/specguard` on disk.
3. Call `resolveCliPath(workspaceRoot)`.

**Expected Results:**
- The returned string equals `{workspace}/node_modules/.bin/specguard`.

---

### Scenario 3: Falls back to development source path

**Steps:**
1. Ensure `specguard.cliPath` is empty or unset.
2. Ensure `{workspace}/node_modules/.bin/specguard` does not exist.
3. Create the file `{workspace}/src/cli/index.ts` on disk.
4. Call `resolveCliPath(workspaceRoot)`.

**Expected Results:**
- The returned string equals `{workspace}/src/cli/index.ts`.

---

### Scenario 4: Falls back to bundled CLI

**Steps:**
1. Ensure `specguard.cliPath` is empty or unset.
2. Ensure neither `{workspace}/node_modules/.bin/specguard` nor `{workspace}/src/cli/index.ts` exist.
3. Call `setExtensionPath('/ext')`.
4. Create the file `/ext/dist/cli.js` on disk.
5. Call `resolveCliPath(workspaceRoot)`.

**Expected Results:**
- The returned string equals `/ext/dist/cli.js`.

---

### Scenario 5: Returns empty string when no CLI is found

**Steps:**
1. Ensure `specguard.cliPath` is empty or unset.
2. Ensure none of the candidate paths exist on disk.
3. Ensure `_extensionPath` is undefined or its `dist/cli.js` does not exist.
4. Call `resolveCliPath(workspaceRoot)`.

**Expected Results:**
- The returned string is `''` (empty string).

---

### Scenario 6: spawnCli rejects when cliPath is empty

**Steps:**
1. Call `spawnCli('', ['status'], workspaceRoot, () => {})`.
2. Await the `promise` property of the returned `SpawnHandle`.

**Expected Results:**
- The promise rejects with an `Error`.
- The error message contains the text `SpecGuard CLI not found`.
- The error message contains a reference to `specguard.cliPath`.
- The error message contains a reference to `npm install specguard`.
- Calling `kill()` on the handle does not throw.

---

### Scenario 7: spawnCli streams output line-by-line for a .js CLI

**Steps:**
1. Provide a valid `.js` CLI path (e.g., `/ext/dist/cli.js`).
2. Collect all strings passed to the `onLine` callback.
3. Call `spawnCli('/ext/dist/cli.js', ['--version'], workspaceRoot, onLine)`.
4. Await the returned `promise`.

**Expected Results:**
- The child process is spawned with `node` as the command and `['/ext/dist/cli.js', '--version']` as arguments.
- Each complete line from stdout and stderr is delivered individually to `onLine`.
- Any partial line remaining in the buffer at process close is delivered to `onLine`.
- The promise resolves with a numeric exit code.

---

### Scenario 8: kill() terminates a running process

**Steps:**
1. Call `spawnCli` with a CLI path that starts a long-running process.
2. Capture the returned `SpawnHandle`.
3. Call `handle.kill()` before the process exits naturally.
4. Await `handle.promise`.

**Expected Results:**
- The child process is terminated.
- `handle.promise` resolves (does not remain pending indefinitely).
- No exception is thrown by `kill()`.

---

### Scenario 9: .env file values are overridden by shell environment

**Steps:**
1. Create `{workspace}/.specguard/.env` containing a line `MY_VAR=from_file`.
2. Set `process.env.MY_VAR` to `from_shell`.
3. Spawn a CLI process via `spawnCli` with `cwd` set to `workspaceRoot`.

**Expected Results:**
- The spawned process receives `MY_VAR=from_shell` in its environment (shell value wins).

---

### Scenario 10: .env file comments and blank lines are ignored

**Steps:**
1. Create `{workspace}/.specguard/.env` with the following content:
   ```
   # This is a comment
   
   VALID_KEY=valid_value
   ```
2. Spawn a CLI process via `spawnCli` with `cwd` set to `workspaceRoot`.

**Expected Results:**
- The spawned process environment contains `VALID_KEY=valid_value`.
- No key named `# This is a comment` or empty-string key is present in the environment.

## Security Notes

- The `.specguard/.env` file may contain sensitive credentials such as API keys. Its contents must never be logged, echoed to the `onLine` callback, or included in error messages. The spec redacts all such values.
- `process.env` values always take precedence over `.env` file values, preventing a malicious or misconfigured `.env` file from overriding inherited shell credentials.
- The `npx specguard` fallback is intentionally omitted to prevent resolution of an unrelated third-party npm package (`specguard@0.2.1`) that could execute arbitrary code.
- The explicit `specguard.cliPath` setting should be validated by the caller to ensure it does not point to an untrusted executable.

## Dependencies

- `vscode` — workspace configuration API (`vscode.workspace.getConfiguration`).
- `child_process` (Node.js built-in) — `spawn` for subprocess execution.
- `path` (Node.js built-in) — cross-platform path construction.
- `fs` (Node.js built-in) — filesystem existence checks and `.env` file reading.
- `tsx` (via `npx`) — TypeScript execution for development `.ts` CLI paths.