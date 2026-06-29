# `specguard analyze` Command

<!-- module: specguard-cli/commands/analyze / type: cli-command / status: draft -->

## Overview

The `specguard analyze` command runs all diagnostic pipelines against the current workspace and surfaces actionable recommendations to the user via standard output. It loads CLI configuration through shared global options before delegating to the `runAnalyze` pipeline. Each recommendation is printed with a priority label, the relevant pipeline name, and a human-readable reason. When no recommendations are found, the command confirms the workspace is healthy. The process exits with the exit code returned by the pipeline, enabling integration with CI systems and shell scripts.

## Acceptance Criteria

- AC-1: The command loads CLI configuration using the provided global options before executing any analysis.
- AC-2: All messages returned by `runAnalyze` are written to `stdout` in the order they are received.
- AC-3: When the analysis report contains zero recommendations, the string `analyze: workspace is healthy — nothing to do` is written to `stdout`.
- AC-4: When one or more recommendations exist, a summary line `analyze: <N> recommendation(s) (next steps):` is written to `stdout`, where `<N>` matches the exact count of recommendations.
- AC-5: Each recommendation is printed in the format `  [<priority>] specguard <pipeline> — <reason>` with two leading spaces.
- AC-6: The process exits with the numeric exit code provided by `result.exitCode`.
- AC-7: When `--auto-fix` is passed, the `autoFix: true` option is forwarded to `runAnalyze`.

## Scenarios

### Scenario 1: Healthy workspace with no recommendations

**Steps:**
1. Invoke `analyzeCommand({ autoFix: false })` in an environment where `runAnalyze` returns `{ messages: ['Scan complete.'], analysisReport: { recommendations: [] }, exitCode: 0 }`.
2. Capture all data written to `process.stdout`.
3. Observe the process exit code.

**Expected Results:**
- `stdout` contains the line `Scan complete.`.
- `stdout` contains the line `analyze: workspace is healthy — nothing to do`.
- The process exits with code `0`.

---

### Scenario 2: Workspace with multiple recommendations

**Steps:**
1. Invoke `analyzeCommand({ autoFix: false })` where `runAnalyze` returns `{ messages: [], analysisReport: { recommendations: [{ priority: 'HIGH', pipeline: 'lint', reason: 'Unused specs detected' }, { priority: 'LOW', pipeline: 'format', reason: 'Style drift found' }] }, exitCode: 1 }`.
2. Capture all data written to `process.stdout`.
3. Observe the process exit code.

**Expected Results:**
- `stdout` contains the line `analyze: 2 recommendation(s) (next steps):`.
- `stdout` contains the line `  [HIGH] specguard lint — Unused specs detected`.
- `stdout` contains the line `  [LOW] specguard format — Style drift found`.
- The string `workspace is healthy` does **not** appear in `stdout`.
- The process exits with code `1`.

---

### Scenario 3: Auto-fix flag is forwarded to the pipeline

**Steps:**
1. Invoke `analyzeCommand({ autoFix: true })`.
2. Intercept the arguments passed to `runAnalyze`.

**Expected Results:**
- `runAnalyze` is called with a second argument object where `autoFix` is strictly `true`.

---

### Scenario 4: Pipeline messages are printed before recommendations

**Steps:**
1. Invoke `analyzeCommand({})` where `runAnalyze` returns `{ messages: ['msg-1', 'msg-2'], analysisReport: { recommendations: [{ priority: 'MEDIUM', pipeline: 'check', reason: 'Missing coverage' }] }, exitCode: 2 }`.
2. Capture the full ordered output written to `process.stdout`.

**Expected Results:**
- `msg-1` appears in `stdout` before the recommendations summary line.
- `msg-2` appears in `stdout` before the recommendations summary line.
- The recommendations summary line `analyze: 1 recommendation(s) (next steps):` is present.
- The process exits with code `2`.

---

### Scenario 5: Non-zero exit code on pipeline failure

**Steps:**
1. Invoke `analyzeCommand({})` where `runAnalyze` returns `{ messages: ['Error encountered.'], analysisReport: { recommendations: [] }, exitCode: 3 }`.
2. Observe the process exit code.

**Expected Results:**
- The process exits with code `3`.
- `stdout` contains `analyze: workspace is healthy — nothing to do` (recommendations list is empty regardless of exit code).

## Security Notes

- No secret values, API keys, or credentials are present in this command's source. No redaction was required.
- CLI options passed via `GlobalOpts` must be validated by `loadCliConfig` before use; the `analyze` command itself performs no direct input sanitisation.
- The command writes exclusively to `stdout` and does not log configuration internals, preventing accidental exposure of sensitive config values.

## Dependencies

| Dependency | Role |
|---|---|
| `../../pipelines/analyze.js` (`runAnalyze`) | Executes all diagnostic pipelines and returns messages, the analysis report, and an exit code. |
| `./helpers.js` (`loadCliConfig`, `GlobalOpts`) | Resolves and validates CLI configuration from global options before pipeline execution. |
| `process.stdout` | Output sink for all messages and recommendations. |
| `process.exit` | Terminates the process with the pipeline-supplied exit code. |