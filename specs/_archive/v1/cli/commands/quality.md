# specguard quality Command

<!-- module: specguard-cli/commands/quality / type: cli-command / status: draft -->

## Overview

The `specguard quality` command runs automated code quality checks against a project by invoking the ESLint and Knip pipelines via `runCodeQuality`. It accepts an optional `--app` flag to scope checks to a specific application and an optional `--fix` flag to apply auto-fixes where supported. After execution, all diagnostic messages are printed to stdout followed by a summary line reporting the total number of findings and errors. The process exits with the exit code returned by the quality pipeline, allowing CI systems to detect failures.

## Acceptance Criteria

- AC1: Running `specguard quality` without flags loads the CLI config from default sources and executes quality checks across the full project.
- AC2: When `--app <name>` is provided, the `app` value is forwarded to `runCodeQuality` to scope the checks.
- AC3: When `--fix` is provided, the `fix: true` option is forwarded to `runCodeQuality`.
- AC4: Each message in `result.messages` is printed to stdout on its own line, in order.
- AC5: A summary line in the format `quality: <N> finding(s) — <M> error(s)` is printed to stdout after all messages.
- AC6: The process exits with `result.exitCode`; a non-zero exit code indicates failure.

## Scenarios

### Scenario 1: Successful quality run with no findings

**Steps:**
1. Invoke `qualityCommand({})` with no additional options.
2. Mock `loadCliConfig` to return a valid config object.
3. Mock `runCodeQuality` to return `{ messages: [], created: 0, failed: 0, exitCode: 0 }`.
4. Capture all writes to `process.stdout`.
5. Observe the exit code passed to `process.exit`.

**Expected Results:**
- `process.stdout` receives exactly one line: `quality: 0 finding(s) — 0 error(s)`.
- `process.exit` is called with `0`.

---

### Scenario 2: Quality run with findings and errors

**Steps:**
1. Invoke `qualityCommand({})` with no additional options.
2. Mock `runCodeQuality` to return `{ messages: ['src/foo.ts: error no-unused-vars', 'src/bar.ts: warning'], created: 2, failed: 1, exitCode: 1 }`.
3. Capture all writes to `process.stdout`.
4. Observe the exit code passed to `process.exit`.

**Expected Results:**
- `process.stdout` receives `src/foo.ts: error no-unused-vars\n` as the first line.
- `process.stdout` receives `src/bar.ts: warning\n` as the second line.
- `process.stdout` receives `quality: 2 finding(s) — 1 error(s)\n` as the final line.
- `process.exit` is called with `1`.

---

### Scenario 3: Scoped run with --app flag

**Steps:**
1. Invoke `qualityCommand({ app: 'my-service' })`.
2. Mock `loadCliConfig` to return a valid config object.
3. Capture the arguments passed to `runCodeQuality`.

**Expected Results:**
- `runCodeQuality` is called with the loaded config as the first argument.
- The second argument to `runCodeQuality` contains `{ app: 'my-service', fix: undefined }`.

---

### Scenario 4: Auto-fix run with --fix flag

**Steps:**
1. Invoke `qualityCommand({ fix: true })`.
2. Mock `loadCliConfig` to return a valid config object.
3. Capture the arguments passed to `runCodeQuality`.

**Expected Results:**
- `runCodeQuality` is called with the second argument containing `{ fix: true, app: undefined }`.

---

### Scenario 5: Config loading failure

**Steps:**
1. Invoke `qualityCommand({})`.
2. Mock `loadCliConfig` to throw an `Error` with message `Config file not found`.
3. Observe whether the error propagates.

**Expected Results:**
- The returned promise rejects with an error whose message is `Config file not found`.
- `process.exit` is not called.

## Security Notes

- No credentials, API keys, or tokens are present in this command's source.
- The `--app` option value is passed directly to the pipeline; callers should ensure it is validated upstream to prevent path traversal or injection if it influences file system operations inside `runCodeQuality`.

## Dependencies

- `../../pipelines/code-quality.js` — provides `runCodeQuality`; must be available at runtime.
- `./helpers.js` — provides `loadCliConfig` and the `GlobalOpts` type; CLI config resolution depends on this module.
- Node.js built-ins: `process.stdout.write`, `process.exit`.