# `specguard security` Command

<!-- module: specguard-cli/commands/security / type: cli-command / status: draft -->

## Overview

The `specguard security` command is a CLI entry point for Phase 5 of the SpecGuard pipeline, responsible for generating security tests and optionally running Static Application Security Testing (SAST). It accepts a set of options to target a specific spec, all specs, a specific app, or to force re-generation. After delegating to the `runSecurity` pipeline function, it prints per-item messages followed by a summary line and exits with the pipeline-determined exit code.

## Acceptance Criteria

- AC1: When invoked, the command loads CLI configuration via `loadCliConfig` before executing the security pipeline.
- AC2: The command passes `spec`, `all`, `withSast`, `app`, and `force` options directly to `runSecurity` without modification.
- AC3: Every message returned in `result.messages` is written to `stdout`, each on its own line.
- AC4: A summary line in the format `security: <N> created, <N> skipped, <N> failed` is written to `stdout` after all messages.
- AC5: The process exits with the exit code returned by `runSecurity` (`result.exitCode`).
- AC6: No secret values, credentials, or API keys are logged or written to stdout at any point.

## Scenarios

### Scenario 1: Successful security generation for a single spec

**Steps:**
1. Invoke `securityCommand` with `{ spec: "auth.spec.md" }`.
2. Observe all calls to `process.stdout.write`.
3. Observe the call to `process.exit`.

**Expected Results:**
- Each string in `result.messages` is written to stdout as a separate line terminated with `\n`.
- The final stdout write matches the pattern `security: \d+ created, \d+ skipped, \d+ failed\n`.
- `process.exit` is called exactly once with `result.exitCode`.

---

### Scenario 2: Security generation with SAST enabled for all specs

**Steps:**
1. Invoke `securityCommand` with `{ all: true, withSast: true }`.
2. Capture the options object passed to `runSecurity`.

**Expected Results:**
- `runSecurity` is called with `all: true` and `withSast: true`.
- `spec` and `app` are `undefined` in the options passed to `runSecurity`.
- stdout receives messages and a summary line as described in AC3 and AC4.

---

### Scenario 3: Forced re-generation targeting a specific app

**Steps:**
1. Invoke `securityCommand` with `{ app: "payments-service", force: true }`.
2. Capture the options object passed to `runSecurity`.

**Expected Results:**
- `runSecurity` is called with `app: "payments-service"` and `force: true`.
- `all` and `spec` are `undefined` in the options passed to `runSecurity`.
- `process.exit` is called with the exit code returned by `runSecurity`.

---

### Scenario 4: Pipeline reports failures

**Steps:**
1. Configure `runSecurity` to return `{ messages: ["ERROR: spec X failed"], created: 0, skipped: 1, failed: 1, exitCode: 1 }`.
2. Invoke `securityCommand` with any valid options.
3. Observe stdout output and the exit code.

**Expected Results:**
- `"ERROR: spec X failed\n"` is written to stdout.
- The summary line written to stdout is `"security: 0 created, 1 skipped, 1 failed\n"`.
- `process.exit` is called with `1`.

---

### Scenario 5: Empty messages array

**Steps:**
1. Configure `runSecurity` to return `{ messages: [], created: 2, skipped: 0, failed: 0, exitCode: 0 }`.
2. Invoke `securityCommand` with any valid options.
3. Observe stdout output.

**Expected Results:**
- No per-message lines are written to stdout before the summary line.
- The summary line written to stdout is `"security: 2 created, 0 skipped, 0 failed\n"`.
- `process.exit` is called with `0`.

## Security Notes

- The command must not log, print, or expose any secret values, API keys, tokens, or credentials to stdout, stderr, or any log output at any stage of execution.
- CLI options passed by the user (e.g., `spec`, `app`) should be treated as untrusted input and must not be interpolated into shell commands without sanitisation within the pipeline layer.
- The `force` flag bypasses skip logic; its use should be auditable via pipeline-level logging.

## Dependencies

- `../../pipelines/security.js` — `runSecurity` pipeline function that performs the actual security test generation and SAST execution.
- `./helpers.js` — `loadCliConfig` utility and `GlobalOpts` type for shared CLI configuration loading.
- Node.js built-ins: `process.stdout.write`, `process.exit`.