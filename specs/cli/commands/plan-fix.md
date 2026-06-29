# `specguard plan-fix` Command

<!-- module: specguard-cli/commands/plan-fix / type: cli-command / status: draft -->

## Overview

The `specguard plan-fix` command generates a structured fix plan from pipeline findings and an issues summary. It accepts a source pipeline identifier and a textual issues summary as required inputs, delegates execution to the `runPlanFix` pipeline function, and streams the resulting messages and plan details to standard output. When a plan is produced, it is persisted to `.specguard/fix-plan.json`. The command exits with the exit code returned by the pipeline, allowing CI systems to detect failures.

## Acceptance Criteria

- AC1: The command requires both `--pipeline` and `--issues` options; global options from `loadCliConfig` are also applied.
- AC2: All messages in `result.messages` are written to `stdout`, each on its own line.
- AC3: When `result.plan` is present, the plan title is printed in the format `plan-fix: "<title>"`, followed by the plan summary on the next line.
- AC4: Each step in `result.plan.steps` is printed as `  <id>: <description>` (two-space indent).
- AC5: When `result.plan` is present, the final stdout line reads `Plan written to .specguard/fix-plan.json`.
- AC6: The process exits with `result.exitCode` in all cases (plan present or absent).
- AC7: No secret or credential values from the loaded config are echoed to stdout.

## Scenarios

### Scenario 1: Successful plan generation with steps

**Steps:**
1. Invoke `planFixCommand` with `--pipeline my-pipeline --issues "Spec drift detected in auth module"` and valid global options.
2. Mock `runPlanFix` to return `{ messages: ["Analysing findings…", "Plan ready."], plan: { title: "Fix Auth Drift", summary: "Realign auth spec with implementation.", steps: [{ id: "S1", description: "Update spec section 3" }, { id: "S2", description: "Re-run validation" }] }, exitCode: 0 }`.
3. Capture all data written to `process.stdout`.
4. Observe the process exit code.

**Expected Results:**
- `stdout` contains the line `Analysing findings…`.
- `stdout` contains the line `Plan ready.`.
- `stdout` contains the line `plan-fix: "Fix Auth Drift"`.
- `stdout` contains the line `Realign auth spec with implementation.`.
- `stdout` contains the line `  S1: Update spec section 3`.
- `stdout` contains the line `  S2: Re-run validation`.
- `stdout` contains the line `Plan written to .specguard/fix-plan.json`.
- Process exits with code `0`.

### Scenario 2: Pipeline returns no plan (findings only)

**Steps:**
1. Invoke `planFixCommand` with `--pipeline my-pipeline --issues "No issues found"` and valid global options.
2. Mock `runPlanFix` to return `{ messages: ["Nothing to fix."], plan: null, exitCode: 0 }`.
3. Capture all data written to `process.stdout`.
4. Observe the process exit code.

**Expected Results:**
- `stdout` contains the line `Nothing to fix.`.
- `stdout` does NOT contain the substring `plan-fix:`.
- `stdout` does NOT contain the substring `Plan written to .specguard/fix-plan.json`.
- Process exits with code `0`.

### Scenario 3: Pipeline signals a failure exit code

**Steps:**
1. Invoke `planFixCommand` with `--pipeline bad-pipeline --issues "Critical drift"` and valid global options.
2. Mock `runPlanFix` to return `{ messages: ["Error: pipeline not found."], plan: null, exitCode: 1 }`.
3. Capture all data written to `process.stdout`.
4. Observe the process exit code.

**Expected Results:**
- `stdout` contains the line `Error: pipeline not found.`.
- Process exits with code `1`.

### Scenario 4: Plan with no steps renders correctly

**Steps:**
1. Invoke `planFixCommand` with `--pipeline my-pipeline --issues "Minor drift"` and valid global options.
2. Mock `runPlanFix` to return `{ messages: [], plan: { title: "Empty Plan", summary: "No actionable steps.", steps: [] }, exitCode: 0 }`.
3. Capture all data written to `process.stdout`.

**Expected Results:**
- `stdout` contains the line `plan-fix: "Empty Plan"`.
- `stdout` contains the line `No actionable steps.`.
- `stdout` contains the line `Plan written to .specguard/fix-plan.json`.
- No lines matching the pattern `  S\d+:` appear in `stdout`.
- Process exits with code `0`.

### Scenario 5: Global config is loaded before pipeline execution

**Steps:**
1. Invoke `planFixCommand` with valid `--pipeline` and `--issues` values plus a `--config ./custom.json` global option.
2. Spy on `loadCliConfig` to capture the options object passed to it.
3. Spy on `runPlanFix` to capture the config object passed as its first argument.

**Expected Results:**
- `loadCliConfig` is called exactly once with an options object containing the provided global option values.
- `runPlanFix` is called with the config object returned by `loadCliConfig` as its first argument.
- `runPlanFix` receives `{ sourcePipeline: <provided pipeline value>, issuesSummary: <provided issues value> }` as its second argument.

## Security Notes

- The loaded CLI configuration may contain sensitive credentials (API keys, tokens). These values must never be written to `stdout` or any log output by this command.
- The `--issues` option accepts free-form text; downstream consumers must sanitise this input before use in any shell or file operation.
- The fix plan is written to `.specguard/fix-plan.json`; file permissions on that path should be restricted to the invoking user.

## Dependencies

- `../../pipelines/plan-fix` — provides `runPlanFix`; must be available at runtime.
- `./helpers` — provides `loadCliConfig` and the `GlobalOpts` type for shared CLI configuration loading.
- Node.js `process.stdout` and `process.exit` — used directly for output and termination; no abstraction layer is present in this command.