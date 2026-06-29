# CLI Command Helpers — Config Loading and Error Translation

<!-- module: specguard-cli/commands/helpers / type: utility / status: draft -->

## Overview

This module provides shared helper utilities consumed by every SpecGuard CLI subcommand, keeping individual command handlers thin. Its primary responsibility is loading the `SpecGuardConfig` by delegating to the core `loadConfig` function, with optional path resolution driven by the global `--config` flag. When a `ConfigNotFoundError` is raised, the helper writes an actionable message to `stderr` and exits with `ExitCode.InternalError`; all other errors propagate to the top-level handler. The `resolveSearchDir` function normalises the `--config` value into a directory path that `loadConfig` can walk upward from, accepting either a bare directory, a `.specguard` directory, or a full `config.json` path.

## Acceptance Criteria

1. When `--config` is not supplied, `loadCliConfig` searches from `process.cwd()`.
2. When `--config` points to a directory, that directory is used as the search root.
3. When `--config` contains a `/.specguard/` segment, the portion before that segment is used as the search root.
4. When `--config` ends with `/.specguard`, the parent directory is used as the search root.
5. When `loadConfig` throws `ConfigNotFoundError`, the message `No config found. Run \`specguard init\` to create one.` is written to `stderr` and the process exits with `ExitCode.InternalError`.
6. When `loadConfig` throws any error other than `ConfigNotFoundError`, the error is re-thrown and not swallowed.
7. Backslash path separators in `--config` values are normalised to forward slashes before resolution.

## Scenarios

### Scenario 1: No `--config` option provided

**Steps:**
1. Call `loadCliConfig({})` (no `config` property).
2. Observe the argument passed to `loadConfig`.

**Expected Results:**
- `loadConfig` is called with the current working directory (`process.cwd()`).

---

### Scenario 2: `--config` points to a plain directory

**Steps:**
1. Call `loadCliConfig({ config: '/projects/myapp' })`.
2. Observe the argument passed to `loadConfig`.

**Expected Results:**
- `loadConfig` is called with `/projects/myapp`.

---

### Scenario 3: `--config` contains a `/.specguard/config.json` path

**Steps:**
1. Call `loadCliConfig({ config: '/projects/myapp/.specguard/config.json' })`.
2. Observe the argument passed to `loadConfig`.

**Expected Results:**
- `loadConfig` is called with `/projects/myapp`.

---

### Scenario 4: `--config` ends with `/.specguard`

**Steps:**
1. Call `loadCliConfig({ config: '/projects/myapp/.specguard' })`.
2. Observe the argument passed to `loadConfig`.

**Expected Results:**
- `loadConfig` is called with `/projects/myapp`.

---

### Scenario 5: `--config` uses backslash separators (Windows-style path)

**Steps:**
1. Call `loadCliConfig({ config: 'C:\\projects\\myapp\\.specguard\\config.json' })`.
2. Observe the argument passed to `loadConfig`.

**Expected Results:**
- `loadConfig` is called with `C:/projects/myapp`.

---

### Scenario 6: Config file not found

**Steps:**
1. Configure `loadConfig` to throw a `ConfigNotFoundError`.
2. Call `loadCliConfig({})`.
3. Observe `process.stderr` output.
4. Observe the process exit code.

**Expected Results:**
- `process.stderr` receives the string `No config found. Run \`specguard init\` to create one.\n`.
- The process exits with `ExitCode.InternalError`.

---

### Scenario 7: Unexpected error from `loadConfig`

**Steps:**
1. Configure `loadConfig` to throw a generic `Error` (not `ConfigNotFoundError`).
2. Call `loadCliConfig({})` inside a try/catch.
3. Observe whether the error is caught by the helper or propagates.

**Expected Results:**
- The error propagates out of `loadCliConfig` uncaught.
- Nothing is written to `stderr` by the helper.
- `process.exit` is not called.

---

### Scenario 8: `--config` path resolves to root

**Steps:**
1. Call `loadCliConfig({ config: '/.specguard/config.json' })`.
2. Observe the argument passed to `loadConfig`.

**Expected Results:**
- `loadConfig` is called with `/` (the filesystem root, not an empty string).

## Security Notes

- No credentials, API keys, or tokens are handled by this module.
- The `--config` path value is accepted from user input; path traversal is the responsibility of the downstream `loadConfig` implementation, not this helper.
- No secret values are present in this source file.

## Dependencies

| Dependency | Role |
|---|---|
| `../../core/config.js` — `loadConfig` | Performs the actual filesystem search and config parsing |
| `../../core/types.js` — `SpecGuardConfig` | Type contract for the returned configuration object |
| `../../core/errors.js` — `ConfigNotFoundError` | Sentinel error type used to detect missing config |
| `../../core/exit-codes.js` — `ExitCode` | Provides the `InternalError` exit code constant |
| `process.cwd()` | Default search directory when no `--config` is supplied |
| `process.stderr` | Output channel for the missing-config user message |
| `process.exit` | Terminates the process on `ConfigNotFoundError` |