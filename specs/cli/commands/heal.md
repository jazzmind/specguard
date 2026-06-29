# specguard heal Command

<!-- module: specguard-cli/commands/heal / type: cli-command / status: draft -->

## Overview

The `specguard heal` command invokes the Phase 4 heal pipeline to automatically repair failing generated tests. It accepts an optional `--spec` flag to target a single specification, an `--all` flag to process every available specification, and an optional `--maxRetries` flag to cap the number of repair attempts. Configuration is loaded from the standard CLI config mechanism before the pipeline runs. Upon completion, all pipeline messages are written to stdout and the process exits with the pipeline-supplied exit code.

## Acceptance Criteria

- AC1: Running `specguard heal` without flags loads CLI config and invokes `runHeal` with no `spec`, no `all`, and no `maxRetries` override.
- AC2: `--spec <value>` passes the provided spec identifier to `runHeal` as `spec`.
- AC3: `--all` passes `all: true` to `runHeal`.
- AC4: `--maxRetries <integer>` parses the value as a base-10 integer and passes it to `runHeal` as `maxRetries`.
- AC5: A non-numeric `--maxRetries` value (resulting in `NaN`) is treated as `undefined` and not forwarded to `runHeal`.
- AC6: Every message in `result.messages` is written to stdout, each followed by a newline.
- AC7: The process exits with exactly `result.exitCode` as returned by `runHeal`.

## Scenarios

### Scenario 1: Heal a single spec by name

**Steps:**
1. Invoke `healCommand({ spec: 'my-feature' })`.
2. Observe the arguments passed to `runHeal`.
3. Observe stdout output after the call resolves.
4. Observe the process exit code.

**Expected Results:**
- `runHeal` is called with `{ spec: 'my-feature', all: undefined, maxRetries: undefined }`.
- Each entry in `result.messages` appears on its own line in stdout.
- `process.exit` is called with `result.exitCode`.

### Scenario 2: Heal all specs

**Steps:**
1. Invoke `healCommand({ all: true })`.
2. Observe the arguments passed to `runHeal`.

**Expected Results:**
- `runHeal` is called with `{ spec: undefined, all: true, maxRetries: undefined }`.
- The command does not exit with a non-zero code when `runHeal` returns `exitCode: 0`.

### Scenario 3: Heal with a valid maxRetries value

**Steps:**
1. Invoke `healCommand({ maxRetries: '3' })`.
2. Observe the `maxRetries` argument forwarded to `runHeal`.

**Expected Results:**
- `runHeal` receives `maxRetries: 3` (numeric integer, not the string `'3'`).

### Scenario 4: Heal with a non-numeric maxRetries value

**Steps:**
1. Invoke `healCommand({ maxRetries: 'abc' })`.
2. Observe the `maxRetries` argument forwarded to `runHeal`.

**Expected Results:**
- `Number.parseInt('abc', 10)` produces `NaN`.
- `runHeal` receives `maxRetries: undefined` (the NaN value is suppressed).

### Scenario 5: Pipeline messages are written to stdout

**Steps:**
1. Configure `runHeal` to return `{ messages: ['Healing spec A', 'Fixed 2 tests'], exitCode: 0 }`.
2. Invoke `healCommand({})`.
3. Capture all data written to `process.stdout`.

**Expected Results:**
- stdout contains the line `Healing spec A\n`.
- stdout contains the line `Fixed 2 tests\n`.
- Lines appear in the same order as `result.messages`.

### Scenario 6: Non-zero exit code propagates

**Steps:**
1. Configure `runHeal` to return `{ messages: ['Error: could not heal'], exitCode: 1 }`.
2. Invoke `healCommand({})`.
3. Observe the value passed to `process.exit`.

**Expected Results:**
- `process.exit` is called with `1`.
- The error message `Error: could not heal\n` is written to stdout before exit.

## Security Notes

- No credentials, API keys, or tokens are accepted or processed by this command.
- CLI configuration loaded via `loadCliConfig` must not log or expose secret values present in the config file.
- The `--maxRetries` input is parsed with `Number.parseInt` and validated against `NaN` before use, preventing injection of unexpected numeric values.

## Dependencies

- `../../pipelines/heal.js` — provides `runHeal`, the core Phase 4 heal pipeline.
- `./helpers.js` — provides `loadCliConfig` for resolving global CLI configuration and the `GlobalOpts` type.
- Node.js `process.stdout` and `process.exit` — used for output and termination.