# ESLint Adapter

<!-- module: specguard-adapters/eslint / type: adapter / status: draft -->

## Overview

The ESLint adapter executes `npx eslint --format json --no-error-on-unmatched-pattern .` inside a target project directory using `spawnSync` and normalises the JSON output into a typed `EslintResult` containing zero or more `EslintFinding` records. It follows a thin-wrapper pattern: the function `runEslint` never throws and always returns a structured result, using `ok: false` to signal any failure condition (tool unavailable, spawn error, unparseable output). Each finding carries the relative file path, line, column, severity (`error`, `warning`, or `info`), human-readable message, rule identifier, and a fixed `source` field of `"eslint"`. Aggregate `errorCount` and `warningCount` totals are derived from ESLint's per-file counts in the JSON output. A replaceable `eslintRunner` seam allows the spawn call to be stubbed in tests without modifying production logic.

## Acceptance Criteria

- AC1: `runEslint(projectDir)` returns a `Promise<EslintResult>` and never rejects or throws under any input condition.
- AC2: When ESLint runs successfully and produces findings, `ok` is `true`, `findings` is non-empty, and `errorCount`/`warningCount` reflect the totals from ESLint's JSON output.
- AC3: When ESLint runs successfully and produces no findings, `ok` is `true`, `findings` is an empty array, and both counts are `0`.
- AC4: When the spawn call returns an `error` object or `stdout` is `null`, the result is `{ ok: false, findings: [], errorCount: 0, warningCount: 0 }`.
- AC5: When `stdout` is empty or whitespace-only after trimming, the result is `{ ok: true, findings: [], errorCount: 0, warningCount: 0 }`.
- AC6: When `stdout` is non-empty but not valid JSON, or the parsed value is not an array, the result is `{ ok: false, findings: [], errorCount: 0, warningCount: 0 }`.
- AC7: Each `EslintFinding` has `source` set to `"eslint"` and a relative `file` path (the `cwd` prefix and leading separator stripped from `filePath`).
- AC8: ESLint severity `2` maps to `"error"`, severity `1` maps to `"warning"`, and any other value maps to `"info"`.
- AC9: A missing or null `ruleId` in ESLint output is normalised to the string `"(no rule)"`.
- AC10: A missing `filePath` in an ESLint file result is normalised to `"(unknown)"`.
- AC11: The spawn is invoked with a 60-second timeout and a 32 MB `maxBuffer`; a process exit with a non-zero status code alone does not cause `ok: false`.

## Scenarios

### Scenario 1: Successful lint run with errors and warnings

**Steps:**
1. Stub `eslintRunner.run` to return `{ stdout: <valid ESLint JSON with two file results — one with errorCount 1 and one message of severity 2, one with warningCount 1 and one message of severity 1>, status: 1, error: undefined }`.
2. Call `runEslint('/project')`.
3. Await the returned promise.

**Expected Results:**
- The resolved value has `ok === true`.
- `errorCount === 1` and `warningCount === 1`.
- `findings` has length `2`.
- The finding from the error file has `severity === 'error'` and `source === 'eslint'`.
- The finding from the warning file has `severity === 'warning'` and `source === 'eslint'`.
- Each finding's `file` property does not contain the `/project` prefix.

### Scenario 2: Successful lint run with no findings

**Steps:**
1. Stub `eslintRunner.run` to return `{ stdout: '[]', status: 0, error: undefined }`.
2. Call `runEslint('/project')`.
3. Await the returned promise.

**Expected Results:**
- The resolved value has `ok === true`.
- `findings` is an empty array (`length === 0`).
- `errorCount === 0` and `warningCount === 0`.

### Scenario 3: Spawn error (tool unavailable)

**Steps:**
1. Stub `eslintRunner.run` to return `{ stdout: null, status: null, error: new Error('spawn ENOENT') }`.
2. Call `runEslint('/project')`.
3. Await the returned promise.

**Expected Results:**
- The resolved value has `ok === false`.
- `findings` is an empty array.
- `errorCount === 0` and `warningCount === 0`.

### Scenario 4: stdout is null without an error object

**Steps:**
1. Stub `eslintRunner.run` to return `{ stdout: null, status: 0, error: undefined }`.
2. Call `runEslint('/project')`.
3. Await the returned promise.

**Expected Results:**
- The resolved value has `ok === false`.
- `findings` is an empty array.

### Scenario 5: stdout is empty or whitespace only

**Steps:**
1. Stub `eslintRunner.run` to return `{ stdout: '   ', status: 0, error: undefined }`.
2. Call `runEslint('/project')`.
3. Await the returned promise.

**Expected Results:**
- The resolved value has `ok === true`.
- `findings` is an empty array.
- `errorCount === 0` and `warningCount === 0`.

### Scenario 6: stdout is invalid JSON

**Steps:**
1. Stub `eslintRunner.run` to return `{ stdout: 'not json at all', status: 0, error: undefined }`.
2. Call `runEslint('/project')`.
3. Await the returned promise.

**Expected Results:**
- The resolved value has `ok === false`.
- `findings` is an empty array.
- `errorCount === 0` and `warningCount === 0`.

### Scenario 7: stdout is valid JSON but not an array

**Steps:**
1. Stub `eslintRunner.run` to return `{ stdout: '{"unexpected":"object"}', status: 0, error: undefined }`.
2. Call `runEslint('/project')`.
3. Await the returned promise.

**Expected Results:**
- The resolved value has `ok === false`.
- `findings` is an empty array.

### Scenario 8: Finding with missing ruleId and missing filePath

**Steps:**
1. Stub `eslintRunner.run` to return `{ stdout: JSON.stringify([{ messages: [{ severity: 2, message: 'Unexpected token', ruleId: null }], errorCount: 1, warningCount: 0 }]), status: 1, error: undefined }` (no `filePath` key on the file result).
2. Call `runEslint('/project')`.
3. Await the returned promise.

**Expected Results:**
- The resolved value has `ok === true`.
- `findings` has length `1`.
- The single finding has `ruleId === '(no rule)'`.
- The single finding has `file === '(unknown)'`.
- The single finding has `severity === 'error'`.

### Scenario 9: Severity value outside 1 and 2 maps to info

**Steps:**
1. Stub `eslintRunner.run` to return `{ stdout: JSON.stringify([{ filePath: '/project/src/a.ts', messages: [{ severity: 0, message: 'Some info', ruleId: 'some-rule', line: 5, column: 3 }], errorCount: 0, warningCount: 0 }]), status: 0, error: undefined }`.
2. Call `runEslint('/project')`.
3. Await the returned promise.

**Expected Results:**
- `findings` has length `1`.
- The finding has `severity === 'info'`.
- The finding has `line === 5` and `column === 3`.
- The finding has `file === 'src/a.ts'` (leading separator stripped).

### Scenario 10: runEslint does not throw when eslintRunner.run throws synchronously

**Steps:**
1. Stub `eslintRunner.run` to throw `new Error('unexpected internal error')`.
2. Call `runEslint('/project')`.
3. Await the returned promise.

**Expected Results:**
- The promise resolves (does not reject).
- The resolved value has `ok === false`.
- `findings` is an empty array.

## Security Notes

- No credentials, API keys, or tokens are present in this adapter.
- The `projectDir` argument is passed directly as the `cwd` option to `spawnSync`. Callers must ensure this path is validated and restricted to trusted directories before invoking `runEslint` to prevent working-directory traversal.
- `maxBuffer` is capped at 32 MB and `timeout` at 60 seconds to limit resource exhaustion from a runaway or malicious ESLint process.
- ESLint output is parsed with `JSON.parse`; no `eval` or unsafe deserialisation is used.

## Dependencies

- **Node.js built-in** `node:child_process` (`spawnSync`) — used to invoke the ESLint CLI process.
- **`npx` / ESLint CLI** — must be resolvable in the target project's environment; absence causes `ok: false` via the spawn error path.
- **TypeScript interfaces** `EslintFinding`, `EslintResult`, `EslintFileResult` — defined in this module; consumed by any caller of `runEslint`.
- **`eslintRunner` seam** — exported object wrapping `spawnSync`; must be replaced in test environments to avoid real process spawning.