# Depcheck Adapter

<!-- module: specguard-adapters/depcheck / type: adapter / status: draft -->

## Overview

The Depcheck adapter wraps `npx depcheck --json` to detect dependency hygiene issues in a target Node.js project directory. It normalises raw depcheck output into a typed `DepcheckFinding[]` array, classifying each finding as one of three kinds: `unused-dep`, `unused-dev-dep`, or `missing-dep`. The adapter follows a thin-wrapper pattern: it never throws, and returns `{ ok: false, findings: [] }` on any execution or parse error. A `depcheckRunner` seam is exposed to allow the underlying process spawn to be replaced in tests. The public entry point is the async function `runDepcheck(projectDir)`.

## Acceptance Criteria

1. `runDepcheck` returns `{ ok: true }` when `npx depcheck --json` exits successfully, regardless of whether findings are present.
2. Each entry in `doc.dependencies` produces a finding with `kind: 'unused-dep'` and a message prefixed `"Unused dependency: "`.
3. Each entry in `doc.devDependencies` produces a finding with `kind: 'unused-dev-dep'` and a message prefixed `"Unused devDependency: "`.
4. Each key in `doc.missing` produces a finding with `kind: 'missing-dep'`, a message prefixed `"Missing dependency (not in package.json): "`, and a `usedIn` array containing the associated file paths.
5. All findings carry `source: 'depcheck'`.
6. When the runner returns a process error or `null` stdout, `runDepcheck` returns `{ ok: false, findings: [] }` without throwing.
7. When stdout is empty or whitespace-only, `runDepcheck` returns `{ ok: true, findings: [] }`.
8. When stdout is non-empty but not valid JSON, `runDepcheck` returns `{ ok: false, findings: [] }`.
9. When `depcheckRunner.run` throws synchronously, `runDepcheck` returns `{ ok: false, findings: [] }` without propagating the exception.
10. The runner spawns `npx depcheck --json` with a 60-second timeout and a 16 MB stdout buffer.

## Scenarios

### Scenario 1: Clean project with no dependency issues

**Steps:**
1. Stub `depcheckRunner.run` to return `{ stdout: '{"dependencies":[],"devDependencies":[],"missing":{}}', status: 0, error: undefined }`.
2. Call `runDepcheck('/some/project')`.

**Expected Results:**
- Return value has `ok === true`.
- Return value has `findings` as an empty array.

---

### Scenario 2: Project with unused production dependency

**Steps:**
1. Stub `depcheckRunner.run` to return `{ stdout: '{"dependencies":["lodash"],"devDependencies":[],"missing":{}}', status: 0 }`.
2. Call `runDepcheck('/some/project')`.

**Expected Results:**
- Return value has `ok === true`.
- `findings` contains exactly one entry.
- That entry has `name === 'lodash'`, `kind === 'unused-dep'`, `message === 'Unused dependency: lodash'`, and `source === 'depcheck'`.

---

### Scenario 3: Project with unused devDependency

**Steps:**
1. Stub `depcheckRunner.run` to return `{ stdout: '{"dependencies":[],"devDependencies":["jest"],"missing":{}}', status: 0 }`.
2. Call `runDepcheck('/some/project')`.

**Expected Results:**
- Return value has `ok === true`.
- `findings` contains exactly one entry.
- That entry has `name === 'jest'`, `kind === 'unused-dev-dep'`, `message === 'Unused devDependency: jest'`, and `source === 'depcheck'`.

---

### Scenario 4: Project with missing dependency

**Steps:**
1. Stub `depcheckRunner.run` to return `{ stdout: '{"dependencies":[],"devDependencies":[],"missing":{"axios":["src/api.ts","src/client.ts"]}}', status: 0 }`.
2. Call `runDepcheck('/some/project')`.

**Expected Results:**
- Return value has `ok === true`.
- `findings` contains exactly one entry.
- That entry has `name === 'axios'`, `kind === 'missing-dep'`, `message === 'Missing dependency (not in package.json): axios'`, `source === 'depcheck'`, and `usedIn` equal to `['src/api.ts', 'src/client.ts']`.

---

### Scenario 5: Mixed findings across all three kinds

**Steps:**
1. Stub `depcheckRunner.run` to return stdout containing `dependencies: ["moment"]`, `devDependencies: ["ts-jest"]`, and `missing: { "chalk": ["src/log.ts"] }`.
2. Call `runDepcheck('/some/project')`.

**Expected Results:**
- Return value has `ok === true`.
- `findings` has exactly three entries.
- One entry has `kind === 'unused-dep'` and `name === 'moment'`.
- One entry has `kind === 'unused-dev-dep'` and `name === 'ts-jest'`.
- One entry has `kind === 'missing-dep'`, `name === 'chalk'`, and `usedIn` equal to `['src/log.ts']`.

---

### Scenario 6: Runner returns a process error

**Steps:**
1. Stub `depcheckRunner.run` to return `{ stdout: null, status: null, error: new Error('spawn ENOENT') }`.
2. Call `runDepcheck('/some/project')`.

**Expected Results:**
- Return value has `ok === false`.
- Return value has `findings` as an empty array.
- No exception is thrown by `runDepcheck`.

---

### Scenario 7: Runner returns empty stdout

**Steps:**
1. Stub `depcheckRunner.run` to return `{ stdout: '   ', status: 0, error: undefined }`.
2. Call `runDepcheck('/some/project')`.

**Expected Results:**
- Return value has `ok === true`.
- Return value has `findings` as an empty array.

---

### Scenario 8: Runner returns malformed JSON

**Steps:**
1. Stub `depcheckRunner.run` to return `{ stdout: 'not-valid-json', status: 0, error: undefined }`.
2. Call `runDepcheck('/some/project')`.

**Expected Results:**
- Return value has `ok === false`.
- Return value has `findings` as an empty array.
- No exception is thrown by `runDepcheck`.

---

### Scenario 9: Runner throws synchronously

**Steps:**
1. Stub `depcheckRunner.run` to throw `new Error('unexpected failure')`.
2. Call `runDepcheck('/some/project')`.

**Expected Results:**
- The promise returned by `runDepcheck` resolves (does not reject).
- Resolved value has `ok === false`.
- Resolved value has `findings` as an empty array.

---

### Scenario 10: Runner is invoked with correct spawn parameters

**Steps:**
1. Spy on `depcheckRunner.run` and stub it to return a valid empty-findings JSON response.
2. Call `runDepcheck('/target/dir')`.

**Expected Results:**
- `depcheckRunner.run` is called exactly once.
- The `cwd` argument passed to the runner equals `'/target/dir'`.

## Security Notes

- No credentials, API keys, or tokens are present in this adapter.
- The `projectDir` argument is passed directly as the `cwd` of a child process; callers must ensure this value is a validated, trusted path to prevent working-directory injection.
- stdout buffer is capped at 16 MB to limit memory exhaustion from unexpectedly large depcheck output.
- Process execution is bounded by a 60-second timeout to prevent indefinite hangs.

## Dependencies

- **Node.js built-in:** `node:child_process` (`spawnSync`) — used to execute `npx depcheck --json`.
- **Runtime dependency:** `npx` / `depcheck` must be available in the environment where the adapter runs; absence causes `{ ok: false }` to be returned gracefully.
- **Internal:** `DepcheckFinding`, `DepcheckResult`, `DepcheckFindingKind` types are exported and consumed by downstream aggregation or reporting modules.