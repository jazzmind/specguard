# specguard docs Command

<!-- module: specguard-cli/commands/docs / type: cli-command / status: draft -->

## Overview

The `specguard docs` command generates user-facing documentation from Living Specification files as part of Phase 5 of the SpecGuard pipeline. It delegates to the `runDocGenerate` pipeline function, passing CLI options including an optional target spec key, an all-specs flag, an output path, and an app identifier. After the pipeline completes, the command prints each message from the result to stdout, followed by a summary line reporting the count of created, skipped, and failed documents. The process exits with the exit code returned by the pipeline.

## Acceptance Criteria

- AC1: When invoked, the command loads CLI configuration via `loadCliConfig` before executing the pipeline.
- AC2: The `--spec`, `--all`, `--out`, and `--app` options are forwarded to `runDocGenerate` unchanged.
- AC3: Every message in `result.messages` is written to stdout, each on its own line.
- AC4: A summary line in the format `docs: <N> created, <N> skipped, <N> failed` is written to stdout after all messages.
- AC5: The process exits with the numeric exit code provided by `result.exitCode`.

## Scenarios

### Scenario 1: Generate documentation for a single spec

**Steps:**
1. Run `specguard docs --spec some/spec-key` from the CLI.
2. Observe stdout output.
3. Observe the process exit code.

**Expected Results:**
- `loadCliConfig` is called with the provided options before the pipeline runs.
- `runDocGenerate` is called with `{ spec: "some/spec-key", all: undefined, out: undefined, app: undefined }`.
- Each string in `result.messages` appears on its own line in stdout.
- The final stdout line matches the pattern `docs: \d+ created, \d+ skipped, \d+ failed`.
- The process exits with the exit code returned by `runDocGenerate`.

### Scenario 2: Generate documentation for all specs

**Steps:**
1. Run `specguard docs --all` from the CLI.
2. Observe stdout output.
3. Observe the process exit code.

**Expected Results:**
- `runDocGenerate` is called with `{ all: true, spec: undefined, out: undefined, app: undefined }`.
- All pipeline messages are printed to stdout, one per line.
- The summary line is printed after all messages.
- The process exits with the exit code returned by `runDocGenerate`.

### Scenario 3: Generate documentation with a custom output path and app identifier

**Steps:**
1. Run `specguard docs --all --out ./dist/docs --app my-app` from the CLI.
2. Observe the arguments passed to `runDocGenerate`.
3. Observe stdout output and process exit code.

**Expected Results:**
- `runDocGenerate` is called with `{ all: true, out: "./dist/docs", app: "my-app", spec: undefined }`.
- All messages from the result are written to stdout.
- The summary line appears last in stdout.
- The process exits with the exit code returned by `runDocGenerate`.

### Scenario 4: Pipeline reports failures

**Steps:**
1. Run `specguard docs --all` where the pipeline returns `{ created: 2, skipped: 1, failed: 3, exitCode: 1, messages: ["error: spec-a failed", "error: spec-b failed", "error: spec-c failed"] }`.
2. Observe stdout output.
3. Observe the process exit code.

**Expected Results:**
- The three error message lines appear in stdout in order.
- The summary line reads exactly `docs: 2 created, 1 skipped, 3 failed`.
- The process exits with code `1`.

### Scenario 5: Pipeline reports full success with no messages

**Steps:**
1. Run `specguard docs --all` where the pipeline returns `{ created: 5, skipped: 0, failed: 0, exitCode: 0, messages: [] }`.
2. Observe stdout output.
3. Observe the process exit code.

**Expected Results:**
- No message lines are written before the summary line.
- The summary line reads exactly `docs: 5 created, 0 skipped, 0 failed`.
- The process exits with code `0`.

## Security Notes

- No secret values, API keys, or credentials are present in this command's source.
- CLI options (`--spec`, `--out`, `--app`) are passed directly to the pipeline; the pipeline layer is responsible for validating and sanitising these values before use in file system operations.

## Dependencies

- `runDocGenerate` from `../../pipelines/doc-generate.js` — the core pipeline that performs documentation generation.
- `loadCliConfig` from `./helpers.js` — resolves and merges CLI configuration before pipeline execution.
- `GlobalOpts` type from `./helpers.js` — base type extended by `DocsCliOpts`.
- Node.js `process.stdout` and `process.exit` — used for output and termination.