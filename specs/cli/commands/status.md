# `specguard status` — Spec Coverage Report

<!-- module: specguard-cli/commands/status / type: cli-command / status: draft -->

## Overview

The `specguard status` command provides a spec coverage report as part of the Phase 3 pipeline. When invoked, it loads the CLI configuration from global options, delegates execution to the `runStatus` pipeline, and streams each output message line-by-line to standard output. The command terminates the process with the exit code returned by the pipeline, allowing callers and CI systems to detect coverage failures programmatically. It does not perform any analysis itself; all logic is encapsulated in the `runStatus` pipeline and `loadCliConfig` helper.

## Acceptance Criteria

- AC1: The command loads CLI configuration using the provided global options before executing.
- AC2: The command invokes the `runStatus` pipeline with the loaded configuration.
- AC3: Every message returned by `runStatus` is written to `process.stdout`, each terminated by a newline character (`\n`).
- AC4: The process exits with the exact exit code returned by `runStatus` result.
- AC5: No output is written to `process.stderr` by this command directly.
- AC6: The command is asynchronous and resolves only after all messages have been written and `process.exit` is called.

## Scenarios

### Scenario 1: Successful coverage report with passing exit code

**Steps:**
1. Invoke `statusCommand` with valid global options that resolve to a well-formed config file.
2. Mock `runStatus` to return `{ messages: ["Coverage: 100%", "All specs passing"], exitCode: 0 }`.
3. Capture all writes to `process.stdout`.
4. Capture the argument passed to `process.exit`.

**Expected Results:**
- `process.stdout` receives exactly `"Coverage: 100%\n"` followed by `"All specs passing\n"`.
- `process.exit` is called with `0`.
- No writes are made to `process.stderr`.

### Scenario 2: Coverage report with failing exit code

**Steps:**
1. Invoke `statusCommand` with valid global options.
2. Mock `runStatus` to return `{ messages: ["Coverage: 42%", "3 specs missing"], exitCode: 1 }`.
3. Capture all writes to `process.stdout`.
4. Capture the argument passed to `process.exit`.

**Expected Results:**
- `process.stdout` receives exactly `"Coverage: 42%\n"` followed by `"3 specs missing\n"`.
- `process.exit` is called with `1`.

### Scenario 3: Pipeline returns an empty messages array

**Steps:**
1. Invoke `statusCommand` with valid global options.
2. Mock `runStatus` to return `{ messages: [], exitCode: 0 }`.
3. Capture all writes to `process.stdout`.
4. Capture the argument passed to `process.exit`.

**Expected Results:**
- No data is written to `process.stdout`.
- `process.exit` is called with `0`.

### Scenario 4: Configuration loading failure

**Steps:**
1. Invoke `statusCommand` with global options that reference a non-existent or malformed config file.
2. Mock `loadCliConfig` to throw an error (e.g., `Error: Config file not found`).
3. Observe whether the error propagates.

**Expected Results:**
- The thrown error propagates out of `statusCommand` (the promise rejects).
- `runStatus` is never called.
- `process.exit` is never called by this command.

### Scenario 5: Each message is written as a separate stdout call

**Steps:**
1. Invoke `statusCommand` with valid global options.
2. Mock `runStatus` to return `{ messages: ["Line A", "Line B", "Line C"], exitCode: 0 }`.
3. Spy on `process.stdout.write` to record each individual call.

**Expected Results:**
- `process.stdout.write` is called exactly 3 times.
- Call 1 receives `"Line A\n"`, call 2 receives `"Line B\n"`, call 3 receives `"Line C\n"`.
- Calls occur in the same order as the `messages` array.

## Security Notes

- No credentials, tokens, or secret values are handled or logged by this command.
- Global options passed to `loadCliConfig` should be validated by the helper before use; this command performs no additional sanitisation.
- Output is written only to `process.stdout`; sensitive pipeline internals must not be surfaced in messages by the `runStatus` pipeline.

## Dependencies

- `../../pipelines/status.js` — `runStatus(config)`: executes the Phase 3 spec coverage pipeline and returns `{ messages: string[], exitCode: number }`.
- `./helpers.js` — `loadCliConfig(opts: GlobalOpts)`: resolves and loads the CLI configuration from global options.
- Node.js built-ins: `process.stdout.write`, `process.exit`.