# specguard generate — Generate Tests from Specs

<!-- module: specguard-cli/commands/generate / type: cli-command / status: draft -->

## Overview

The `specguard generate` command implements the Phase 4 forward pipeline, producing test files from Living Specification documents. It accepts options to target a single spec (`--spec`) or all specs (`--all`), and allows callers to control the output framework, application target, test type, and whether existing files should be overwritten (`--force`). After the pipeline runs, the command prints each message returned by the pipeline followed by a summary line reporting counts of created, skipped, and failed files. The process exits with the exit code returned by the pipeline.

## Acceptance Criteria

- AC1: When `--spec <path>` is provided, only the specified spec is processed.
- AC2: When `--all` is provided, all discoverable specs are processed.
- AC3: When `--framework <name>` is provided, the value is forwarded to the pipeline unchanged.
- AC4: When `--app <name>` is provided, the value is forwarded to the pipeline unchanged.
- AC5: When `--type <testType>` is provided, the value is forwarded to the pipeline unchanged.
- AC6: When `--force` is provided, the pipeline receives `force: true`; when omitted, `force` is `undefined`/falsy.
- AC7: Every message in `result.messages` is written to stdout, each terminated by a newline.
- AC8: A summary line of the form `generate: <N> created, <N> skipped, <N> failed` is written to stdout after all messages.
- AC9: The process exits with the exact exit code returned by `result.exitCode`.
- AC10: CLI configuration is loaded via `loadCliConfig` before the pipeline is invoked, and global options are respected.

## Scenarios

### Scenario 1: Generate tests for a single spec without force

**Steps:**
1. Invoke `generateCommand` with `{ spec: 'specs/login.md' }` and no `--force` flag.
2. Observe the arguments passed to `runForwardGenerate`.
3. Observe all data written to `process.stdout`.
4. Observe the value passed to `process.exit`.

**Expected Results:**
- `runForwardGenerate` is called with `spec: 'specs/login.md'` and `force` falsy.
- Each entry in `result.messages` appears on stdout as a separate line.
- The final stdout line matches `generate: <created> created, <skipped> skipped, <failed> failed` with the values from the pipeline result.
- `process.exit` is called with `result.exitCode`.

### Scenario 2: Generate tests for all specs with force overwrite

**Steps:**
1. Invoke `generateCommand` with `{ all: true, force: true }`.
2. Observe the arguments passed to `runForwardGenerate`.
3. Observe the summary line written to stdout.
4. Observe the value passed to `process.exit`.

**Expected Results:**
- `runForwardGenerate` is called with `all: true` and `force: true`.
- The summary line is present and correctly reflects the pipeline's `created`, `skipped`, and `failed` counts.
- `process.exit` is called with `result.exitCode`.

### Scenario 3: Generate tests with framework, app, and type options

**Steps:**
1. Invoke `generateCommand` with `{ all: true, framework: 'playwright', app: 'web', type: 'e2e' }`.
2. Observe the arguments passed to `runForwardGenerate`.

**Expected Results:**
- `runForwardGenerate` receives `framework: 'playwright'`, `app: 'web'`, and `type: 'e2e'` exactly as supplied.

### Scenario 4: Pipeline returns multiple messages

**Steps:**
1. Configure `runForwardGenerate` to return `messages: ['Generating foo.test.ts', 'Generating bar.test.ts']`, `created: 2`, `skipped: 0`, `failed: 0`, `exitCode: 0`.
2. Invoke `generateCommand` with `{ all: true }`.
3. Capture all stdout output.

**Expected Results:**
- Stdout contains `Generating foo.test.ts\n` followed by `Generating bar.test.ts\n`.
- Stdout then contains `generate: 2 created, 0 skipped, 0 failed\n`.
- `process.exit` is called with `0`.

### Scenario 5: Pipeline reports failures and non-zero exit code

**Steps:**
1. Configure `runForwardGenerate` to return `messages: ['Error: spec not found']`, `created: 0`, `skipped: 0`, `failed: 1`, `exitCode: 1`.
2. Invoke `generateCommand` with `{ spec: 'specs/missing.md' }`.
3. Capture stdout output and the exit code.

**Expected Results:**
- Stdout contains `Error: spec not found\n`.
- Stdout contains `generate: 0 created, 0 skipped, 1 failed\n`.
- `process.exit` is called with `1`.

### Scenario 6: Global options are forwarded to config loader

**Steps:**
1. Invoke `generateCommand` with global options such as `{ config: 'custom.config.json' }`.
2. Observe the argument passed to `loadCliConfig`.

**Expected Results:**
- `loadCliConfig` is called with the full opts object including the global option values.
- The config returned by `loadCliConfig` is passed as the first argument to `runForwardGenerate`.

## Security Notes

- No secret values, API keys, or credentials are present in this command's source.
- CLI options are passed directly to the pipeline without sanitisation at this layer; the pipeline is responsible for validating path inputs such as `spec` to prevent path traversal.

## Dependencies

- `runForwardGenerate` (`../../pipelines/forward-generate.js`) — executes the forward generation pipeline and returns messages, counts, and an exit code.
- `loadCliConfig` (`./helpers.js`) — resolves and loads CLI configuration from global options.
- `TestType` (type import from `../../pipelines/forward-generate.js`) — constrains the `--type` option value.
- Node.js built-ins: `process.stdout.write`, `process.exit`.