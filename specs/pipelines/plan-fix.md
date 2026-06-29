# Plan Fix Pipeline

<!-- module: specguard-pipelines/plan-fix / type: pipeline / status: draft -->

## Overview

The Plan Fix pipeline accepts structured findings from other SpecGuard pipelines (validate, security, quality, deps) and uses a configured LLM to produce a structured, human-approvable fix plan. The plan consists of up to ten discrete, ordered steps, each classified as a pipeline invocation, file edit, or shell command. The generated plan is persisted to `.specguard/fix-plan.json` for consumption by the dashboard's approval flow and is also returned in the `PipelineResult`. This pipeline is intentionally read-only: it produces a plan but does not execute any changes. Execution occurs only after explicit human approval via the dashboard's "Approve & Execute" action or the `specguard analyze --auto-fix` flag.

## Acceptance Criteria

1. Given a valid `PlanFixOpts` and LLM configuration, the pipeline returns a `PipelineResult` with a non-null `plan` field containing `title`, `summary`, and at least one step.
2. Each step in the plan must have a unique `id`, a `description`, and an `action` value of exactly one of `run-pipeline`, `edit-file`, or `run-command`.
3. The plan must contain no more than ten steps.
4. The pipeline writes the plan to `.specguard/fix-plan.json` relative to `config.rootDir` (or `process.cwd()` if unset), including `generatedAt`, `sourcePipeline`, `title`, `summary`, and `steps`.
5. The `PipelineResult` messages array must include a line reporting the plan title and a line reporting the step count.
6. Each step is reflected as an item in `result.items` with `status: 'created'` and the step's description as the message.
7. `result.created` equals the number of steps in the generated plan.
8. If the LLM call fails, the pipeline returns a result with `result.failed === 1`, `result.exitCode` set to `InternalError`, and the error message appended to `result.messages`. No file is written.
9. If `logLines` are provided, only the last 20 lines are included in the LLM prompt.
10. The pipeline never executes any file edits, shell commands, or pipeline invocations described in the plan.

## Scenarios

### Scenario 1: Successful plan generation with log lines

**Steps:**
1. Invoke `runPlanFix` with a valid `SpecGuardConfig` (LLM provider, model, and API key env configured) and `PlanFixOpts` containing `sourcePipeline: "validate"`, a non-empty `issuesSummary`, and an array of 25 `logLines`.
2. Mock `llmGenerateObject` to resolve with a valid plan object: `title: "Fix validate failures"`, `summary: "Two specs are missing acceptance criteria."`, and three steps each with distinct `id`, `description`, and `action` values.
3. Assert that the returned `result.plan` is not null and equals the mocked plan object.
4. Assert that `result.messages` contains a string matching `"[plan-fix] created: Fix validate failures"`.
5. Assert that `result.messages` contains a string matching `"[plan-fix] 3 step(s)"`.
6. Assert that `result.items` has exactly three entries, each with `status: 'created'`.
7. Assert that `result.created === 3`.
8. Assert that `.specguard/fix-plan.json` exists and its parsed JSON contains `sourcePipeline: "validate"`, `title: "Fix validate failures"`, and a `steps` array of length 3.
9. Assert that the `generatedAt` field in the written JSON is a valid ISO 8601 timestamp.
10. Assert that the LLM prompt passed to `llmGenerateObject` includes only the last 20 of the 25 provided log lines.

**Expected Results:**
- `result.plan` matches the mocked plan exactly.
- `result.messages` includes both the title and step-count lines.
- `result.items` contains one entry per step with `status: 'created'`.
- `result.created` equals 3.
- `.specguard/fix-plan.json` is written with correct content and a valid `generatedAt` timestamp.
- The LLM prompt contains exactly 20 log lines (the last 20).

---

### Scenario 2: Successful plan generation without log lines

**Steps:**
1. Invoke `runPlanFix` with a valid `SpecGuardConfig` and `PlanFixOpts` containing `sourcePipeline: "security"`, a non-empty `issuesSummary`, and no `logLines` field.
2. Mock `llmGenerateObject` to resolve with a valid plan containing two steps.
3. Assert that the LLM prompt passed to `llmGenerateObject` does not contain the string `"Relevant log output:"`.
4. Assert that `result.plan` is not null.
5. Assert that `result.created === 2`.
6. Assert that `.specguard/fix-plan.json` is written successfully.

**Expected Results:**
- The LLM prompt omits the log output section entirely.
- `result.plan` is populated with the mocked plan.
- `result.created` equals 2.
- The fix plan file is written to disk.

---

### Scenario 3: LLM call failure

**Steps:**
1. Invoke `runPlanFix` with a valid `SpecGuardConfig` and `PlanFixOpts` containing `sourcePipeline: "quality"` and a non-empty `issuesSummary`.
2. Mock `llmGenerateObject` to reject with `new Error("LLM timeout")`.
3. Assert that the returned `result.plan` is `null`.
4. Assert that `result.failed === 1`.
5. Assert that `result.exitCode` equals `ExitCode.InternalError`.
6. Assert that `result.messages` contains a string matching `"[plan-fix] failed: LLM timeout"`.
7. Assert that `result.items` contains one entry with `key: 'plan-fix'`, `status: 'failed'`, and `message: 'LLM timeout'`.
8. Assert that `.specguard/fix-plan.json` does not exist (or was not written during this invocation).

**Expected Results:**
- `result.plan` is `null`.
- `result.failed` is 1 and `result.exitCode` is `InternalError`.
- The error message appears in both `result.messages` and `result.items`.
- No fix plan file is written to disk.

---

### Scenario 4: File system write failure is non-fatal

**Steps:**
1. Invoke `runPlanFix` with a valid `SpecGuardConfig` and `PlanFixOpts`.
2. Mock `llmGenerateObject` to resolve with a valid two-step plan.
3. Mock `fs.writeFileSync` to throw `new Error("EACCES: permission denied")`.
4. Assert that the returned `result.plan` is not null and equals the mocked plan.
5. Assert that `result.failed` is `0` (or undefined/falsy).
6. Assert that `result.exitCode` is not `ExitCode.InternalError`.
7. Assert that `result.created === 2`.

**Expected Results:**
- A file system write error does not propagate to the pipeline result.
- `result.plan` is still populated with the generated plan.
- `result.created` reflects the number of steps.
- The pipeline exits without an error exit code.

---

### Scenario 5: Plan step action types are correctly reflected in result items

**Steps:**
1. Invoke `runPlanFix` with a valid `SpecGuardConfig` and `PlanFixOpts`.
2. Mock `llmGenerateObject` to resolve with a plan containing three steps: one with `action: "run-pipeline"` and `pipeline: "heal"`, one with `action: "edit-file"` and `file: "src/foo.ts"`, and one with `action: "run-command"` and `command: "npm install"`.
3. Assert that `result.items[0]` has `key` matching the first step's `id` and `status: 'created'`.
4. Assert that `result.items[1]` has `key` matching the second step's `id` and `status: 'created'`.
5. Assert that `result.items[2]` has `key` matching the third step's `id` and `status: 'created'`.
6. Assert that `result.messages` contains three lines beginning with two spaces followed by each step's `id` and `description`.

**Expected Results:**
- All three steps appear in `result.items` with `status: 'created'` regardless of action type.
- Each step's `id` and `description` are reflected in `result.messages`.

## Security Notes

- The LLM API key is never read directly in this pipeline; it is referenced only by the environment variable name (`config.llm.apiKeyEnv`) and resolved by `llmGenerateObject`. Raw API key values must never appear in logs, messages, or the written fix plan file.
- The fix plan written to `.specguard/fix-plan.json` may contain file paths and command strings derived from LLM output. Consumers of this file must treat its contents as untrusted and validate before execution.
- This pipeline is read-only by design. Any code path that would execute steps in the plan (file edits, shell commands, pipeline invocations) must not be introduced here.
- Log lines passed via `logLines` may contain sensitive runtime information; only the last 20 are forwarded to the LLM to limit exposure.

## Dependencies

- `src/core/types.ts` — `SpecGuardConfig`, `PipelineResult`, `emptyResult`
- `src/core/exit-codes.ts` — `ExitCode.InternalError`
- `src/core/llm.ts` — `llmGenerateObject`
- `zod` — schema definition and validation for `FixStepSchema` and `FixPlanSchema`
- Node.js built-ins: `node:fs` (file persistence), `node:path` (path construction)
- `.specguard/fix-plan.json` — output artefact consumed by the SpecGuard dashboard approval flow