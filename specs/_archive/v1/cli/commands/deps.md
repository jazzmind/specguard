# `specguard deps` — Dependency Health Check Command

<!-- module: specguard-cli/commands/deps / type: cli-command / status: draft -->

## Overview

The `specguard deps` command runs dependency health checks against a project by invoking the `runDepCheck` pipeline, which combines npm-audit and depcheck analysis. It accepts an optional `--app` flag to scope the check to a specific application within a monorepo or multi-app workspace. After the pipeline completes, all result messages are written line-by-line to standard output, followed by a summary line reporting the total number of findings. The process exits with the exit code returned by the pipeline, allowing CI systems to detect failures automatically.

## Acceptance Criteria

- AC-1: The command loads CLI configuration via `loadCliConfig` before executing any dependency checks.
- AC-2: When `--app <name>` is provided, the value is forwarded to `runDepCheck` as the `app` option.
- AC-3: When `--app` is omitted, `runDepCheck` is called with `app` set to `undefined`.
- AC-4: Every message in `result.messages` is written to `process.stdout`, each terminated by a newline character.
- AC-5: A summary line in the format `deps: <N> finding(s)` is written to `process.stdout` after all messages.
- AC-6: The process exits with `result.exitCode` as returned by the pipeline (non-zero indicates failure).
- AC-7: No output is written to `process.stderr` by this command layer itself.

## Scenarios

### Scenario 1: Successful run with no findings

**Steps:**
1. Invoke `depsCommand({})` with no `app` option and a valid config file present.
2. Mock `runDepCheck` to resolve with `{ messages: [], created: 0, exitCode: 0 }`.
3. Capture all writes to `process.stdout` and the value passed to `process.exit`.

**Expected Results:**
- `process.stdout` receives exactly one line: `deps: 0 finding(s)`.
- `process.exit` is called with `0`.

---

### Scenario 2: Run with findings reported

**Steps:**
1. Invoke `depsCommand({})` with no `app` option.
2. Mock `runDepCheck` to resolve with `{ messages: ['WARN lodash has known vulnerability', 'INFO unused: chalk'], created: 2, exitCode: 1 }`.
3. Capture all writes to `process.stdout` and the value passed to `process.exit`.

**Expected Results:**
- `process.stdout` receives `WARN lodash has known vulnerability\n` as the first write.
- `process.stdout` receives `INFO unused: chalk\n` as the second write.
- `process.stdout` receives `deps: 2 finding(s)\n` as the final write.
- `process.exit` is called with `1`.

---

### Scenario 3: Scoped run using `--app` flag

**Steps:**
1. Invoke `depsCommand({ app: 'api-service' })`.
2. Capture the arguments passed to `runDepCheck`.

**Expected Results:**
- `runDepCheck` is called with a config object as the first argument and `{ app: 'api-service' }` as the second argument.

---

### Scenario 4: Run without `--app` flag passes undefined app

**Steps:**
1. Invoke `depsCommand({})` (no `app` property set).
2. Capture the arguments passed to `runDepCheck`.

**Expected Results:**
- `runDepCheck` is called with a second argument where `app` is `undefined`.

---

### Scenario 5: Config loading failure

**Steps:**
1. Invoke `depsCommand({})` with no config file present or with `loadCliConfig` mocked to throw an error.
2. Observe whether `runDepCheck` is called and what the process does.

**Expected Results:**
- `runDepCheck` is NOT called.
- The command propagates the error (throws or causes an unhandled rejection); `process.exit` is not called by this command layer.

## Security Notes

- No credentials, API keys, or tokens are handled by this command. No redaction is required.
- The `--app` option value is passed directly to the pipeline; callers should ensure the value is validated or sanitised within `runDepCheck` to prevent path-traversal or injection if it is used to construct file paths.
- Configuration loaded via `loadCliConfig` may contain sensitive paths or tokens; those values must not be echoed to stdout by this command.

## Dependencies

| Dependency | Role |
|---|---|
| `../../pipelines/dep-check.js` → `runDepCheck` | Executes npm-audit and depcheck, returns messages, finding count, and exit code |
| `./helpers.js` → `loadCliConfig` | Resolves and loads the CLI configuration from disk or environment |
| `./helpers.js` → `GlobalOpts` | Base type providing shared CLI option fields (e.g., config path, verbosity) |
| `process.stdout` | Output sink for all result messages and the summary line |
| `process.exit` | Terminates the process with the pipeline-determined exit code |