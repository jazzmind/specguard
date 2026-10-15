# Reverse Command — Generate Specs from Source

<!-- module: specguard-cli/commands/reverse / type: cli-command / status: draft -->

## Overview

The `specguard reverse` command generates Living Specification documents from existing source code by invoking the reverse pipeline. It accepts either a single named application (`--app <name>`) or a flag to process every configured application (`--all`). An optional `--file` argument narrows processing to a specific source file, and `--force` allows overwriting existing specs. After processing all targeted applications, the command prints a summary of created, updated, skipped, and failed specs, then exits with the appropriate exit code.

## Acceptance Criteria

- AC-1: Running `specguard reverse` without `--app` or `--all` writes an error message to stderr and exits with a non-zero exit code (`ExitCode.InternalError`).
- AC-2: Running with `--app <name>` processes exactly one application whose name matches `<name>`.
- AC-3: Running with `--all` processes every application defined in the loaded CLI configuration.
- AC-4: For each application processed, a progress line `reverse: analyzing app "<appName>"...` is written to stdout before pipeline execution.
- AC-5: All messages returned by the reverse pipeline for each application are written to stdout, one per line.
- AC-6: After all applications are processed, a single summary line is written to stdout in the format: `reverse: <N> created, <N> updated, <N> skipped, <N> failed`.
- AC-7: The process exits with the last non-zero exit code produced by any application's pipeline run; if all runs succeed, it exits with `0`.
- AC-8: When `--file` is supplied, the value is forwarded to the reverse pipeline to restrict processing to that file.
- AC-9: When `--force` is supplied, the value is forwarded to the reverse pipeline to permit overwriting existing specs.

## Scenarios

### Scenario 1: Missing scope flag produces error

**Steps:**
1. Invoke `specguard reverse` with no `--app` and no `--all` flags.

**Expected Results:**
- stderr contains the string `reverse: pass --app <name> to target one app, or --all to process every app.`
- Process exits with a non-zero exit code equal to `ExitCode.InternalError`.
- No pipeline execution occurs.

---

### Scenario 2: Single app targeted with --app

**Steps:**
1. Invoke `specguard reverse --app my-service` with a valid configuration containing an app named `my-service`.
2. Observe stdout output.

**Expected Results:**
- stdout contains `reverse: analyzing app "my-service"...` before any pipeline messages.
- All messages from the pipeline result for `my-service` appear in stdout, each on its own line.
- stdout contains a summary line matching `reverse: <N> created, <N> updated, <N> skipped, <N> failed`.
- Process exits with the exit code returned by the pipeline for `my-service`.

---

### Scenario 3: All apps processed with --all

**Steps:**
1. Provide a configuration with three apps: `app-a`, `app-b`, `app-c`.
2. Invoke `specguard reverse --all`.
3. Observe stdout output.

**Expected Results:**
- stdout contains `reverse: analyzing app "app-a"...`, `reverse: analyzing app "app-b"...`, and `reverse: analyzing app "app-c"...` in configuration order.
- Pipeline messages for each app appear in stdout after their respective progress line.
- The final summary line aggregates counts across all three apps (created, updated, skipped, failed are summed).
- Process exits with `0` if all pipelines return exit code `0`.

---

### Scenario 4: One app fails in an --all run

**Steps:**
1. Provide a configuration with two apps: `app-ok` (pipeline returns exit code `0`) and `app-fail` (pipeline returns exit code `1`).
2. Invoke `specguard reverse --all`.
3. Observe the process exit code.

**Expected Results:**
- Both apps are still processed (processing is not halted on failure).
- The summary line reflects combined counts from both apps.
- Process exits with `1` (the last non-zero exit code encountered).

---

### Scenario 5: --file flag forwarded to pipeline

**Steps:**
1. Invoke `specguard reverse --app my-service --file src/auth/login.ts`.
2. Capture the arguments passed to `runReverseGenerate`.

**Expected Results:**
- `runReverseGenerate` is called with `file` set to `"src/auth/login.ts"`.
- Processing is scoped to the single specified file as determined by the pipeline.

---

### Scenario 6: --force flag forwarded to pipeline

**Steps:**
1. Invoke `specguard reverse --app my-service --force`.
2. Capture the arguments passed to `runReverseGenerate`.

**Expected Results:**
- `runReverseGenerate` is called with `force` set to `true`.
- Existing spec files are eligible for overwrite as determined by the pipeline.

---

### Scenario 7: Summary counts are correctly aggregated

**Steps:**
1. Configure two apps where app-1 pipeline returns `{ created: 2, updated: 1, skipped: 0, failed: 0, exitCode: 0 }` and app-2 returns `{ created: 1, updated: 0, skipped: 3, failed: 1, exitCode: 1 }`.
2. Invoke `specguard reverse --all`.
3. Observe the summary line in stdout.

**Expected Results:**
- stdout contains exactly `reverse: 3 created, 1 updated, 3 skipped, 1 failed`.

## Security Notes

- No credentials, API keys, or secret values are accepted or processed by this command.
- The `--file` argument is passed directly to the pipeline; callers should ensure path values are validated within the pipeline layer to prevent path traversal.
- Configuration is loaded via `loadCliConfig`, which is responsible for safe handling of any sensitive configuration fields.

## Dependencies

- `runReverseGenerate` (`../../pipelines/reverse-generate`) — executes the reverse spec-generation pipeline for a given app and optional file target.
- `loadCliConfig` (`./helpers`) — resolves and loads the CLI configuration, including the list of configured apps.
- `ExitCode` (`../../core/exit-codes`) — provides canonical exit code constants; `ExitCode.InternalError` is used when required flags are absent.