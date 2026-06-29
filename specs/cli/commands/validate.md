# specguard validate Command

<!-- module: specguard-cli/commands/validate / type: cli-command / status: draft -->

## Overview

The `specguard validate` command executes a PERCEIVE-PLAN-ACT-VERIFY browser validation pipeline against one or more Living Specifications. It accepts options to target a single spec by key, validate all specs at once, override the base URL, or specify an application context. After the pipeline completes, the command prints per-message output followed by a summary line and exits with a code reflecting the overall pass/fail result.

## Acceptance Criteria

- AC1: When invoked, the command loads CLI configuration via `loadCliConfig` before running the validation pipeline.
- AC2: The `--spec` flag restricts validation to a single named spec; `--all` runs validation across every available spec.
- AC3: The `--url` flag overrides the base URL used by the validation pipeline.
- AC4: The `--app` flag passes an application context identifier to the validation pipeline.
- AC5: Each message returned by the pipeline is written to `stdout` on its own line.
- AC6: A summary line in the format `validate: <N> passed, <N> skipped, <N> failed` is written to `stdout` after all messages.
- AC7: The process exits with the exit code returned by the pipeline (`result.exitCode`).

## Scenarios

### Scenario 1: Validate a single spec by key

**Steps:**
1. Run `specguard validate --spec specguard-cli/commands/validate` from the CLI.
2. Observe all lines written to `stdout`.
3. Observe the final summary line written to `stdout`.
4. Observe the process exit code.

**Expected Results:**
- Each element of `result.messages` appears as a separate line on `stdout`.
- The final `stdout` line matches the pattern `validate: <N> passed, <N> skipped, <N> failed`.
- The process exits with the numeric exit code provided by `result.exitCode`.

---

### Scenario 2: Validate all specs with the `--all` flag

**Steps:**
1. Run `specguard validate --all` from the CLI.
2. Observe all lines written to `stdout`.
3. Observe the final summary line written to `stdout`.
4. Observe the process exit code.

**Expected Results:**
- The pipeline is invoked with `all: true`.
- All pipeline messages appear on `stdout`, one per line.
- The summary line reflects the aggregate counts across all specs.
- The process exits with the exit code returned by the pipeline.

---

### Scenario 3: Override base URL with `--url`

**Steps:**
1. Run `specguard validate --all --url http://localhost:4000` from the CLI.
2. Capture the arguments passed to `runValidate`.

**Expected Results:**
- `runValidate` is called with `baseUrl` set to `http://localhost:4000`.
- Output and exit code behaviour is identical to Scenario 2.

---

### Scenario 4: Specify application context with `--app`

**Steps:**
1. Run `specguard validate --all --app my-app` from the CLI.
2. Capture the arguments passed to `runValidate`.

**Expected Results:**
- `runValidate` is called with `app` set to `"my-app"`.
- Output and exit code behaviour is identical to Scenario 2.

---

### Scenario 5: Pipeline reports failures

**Steps:**
1. Run `specguard validate --all` in an environment where at least one spec fails validation.
2. Observe the summary line on `stdout`.
3. Observe the process exit code.

**Expected Results:**
- The summary line shows a non-zero value for the `failed` count (e.g., `validate: 2 passed, 0 skipped, 1 failed`).
- The process exits with a non-zero exit code as returned by `result.exitCode`.

---

### Scenario 6: Pipeline reports all specs passing

**Steps:**
1. Run `specguard validate --all` in an environment where all specs pass validation.
2. Observe the summary line on `stdout`.
3. Observe the process exit code.

**Expected Results:**
- The summary line shows `0` for both `skipped` and `failed` counts (e.g., `validate: 5 passed, 0 skipped, 0 failed`).
- The process exits with exit code `0`.

## Security Notes

- No credentials, API keys, or secret values are accepted or processed by this command directly; any sensitive configuration must be handled within `loadCliConfig` and must not be echoed to `stdout`.
- The `--url` flag accepts an arbitrary URL; callers should ensure only trusted URLs are supplied to prevent the validation pipeline from targeting unintended hosts.

## Dependencies

- `../../pipelines/validate` — provides `runValidate`, which executes the PERCEIVE-PLAN-ACT-VERIFY pipeline and returns `messages`, `created`, `skipped`, `failed`, and `exitCode`.
- `./helpers` — provides `loadCliConfig` for resolving and merging CLI configuration with global options.
- Node.js `process.stdout` and `process.exit` — used for output and termination.