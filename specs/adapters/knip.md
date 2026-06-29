# Knip Adapter

<!-- module: specguard-adapters/knip / type: adapter / status: draft -->

## Overview

The Knip adapter executes `npx knip --reporter json` as a subprocess inside a target project directory and normalises the raw JSON output into typed `KnipFinding[]` records. It detects five categories of issue: unused exports, unused files, unused dependencies (including devDependencies), unlisted dependencies, and duplicate exports. The adapter follows a thin-wrapper pattern: it never throws, and returns `{ ok: false, findings: [] }` on any execution or parse error. A replaceable `knipRunner` seam allows the subprocess call to be substituted in tests without spawning a real process. The public entry point is the async `runKnip(projectDir)` function.

## Acceptance Criteria

1. `runKnip` returns `{ ok: true, findings: [] }` when knip exits successfully with empty output.
2. `runKnip` returns `{ ok: true }` with one `unused-file` finding per entry in the `files` array of the knip JSON output.
3. `runKnip` returns `{ ok: true }` with one `unused-dep` finding per entry in `dependencies` or `devDependencies` arrays within each issue object.
4. `runKnip` returns `{ ok: true }` with one `unlisted-dep` finding per entry in the `unlisted` array within each issue object.
5. `runKnip` returns `{ ok: true }` with one `unused-export` finding per entry in the `exports` array within each issue object.
6. `runKnip` returns `{ ok: true }` with one `duplicate-export` finding per group in the `duplicates` array, with `name` set to a comma-separated list of names in that group.
7. Every `KnipFinding` has `source` set to the literal string `'knip'`.
8. `runKnip` returns `{ ok: false, findings: [] }` when the subprocess produces a `res.error`.
9. `runKnip` returns `{ ok: false, findings: [] }` when `stdout` is `null`.
10. `runKnip` returns `{ ok: false, findings: [] }` when `stdout` is not valid JSON.
11. `runKnip` never throws under any condition.
12. The subprocess is invoked with a 120-second timeout and a 32 MB stdout buffer.

## Scenarios

### Scenario 1: Successful run with no findings

**Steps:**
1. Stub `knipRunner.run` to return `{ stdout: '{}', status: 0, error: undefined }`.
2. Call `runKnip('/some/project')`.

**Expected Results:**
- The resolved value has `ok === true`.
- The resolved value has `findings` as an empty array.

---

### Scenario 2: Unused file detected

**Steps:**
1. Stub `knipRunner.run` to return `{ stdout: '{"files":["src/orphan.ts"]}', status: 1, error: undefined }`.
2. Call `runKnip('/some/project')`.

**Expected Results:**
- The resolved value has `ok === true`.
- `findings` contains exactly one entry.
- That entry has `file === 'src/orphan.ts'`, `kind === 'unused-file'`, `source === 'knip'`.
- `message` equals `'File is unused (no imports)'`.

---

### Scenario 3: Unused dependency detected

**Steps:**
1. Stub `knipRunner.run` to return stdout containing `{ "issues": [{ "file": "package.json", "dependencies": [{ "name": "lodash" }] }] }`.
2. Call `runKnip('/some/project')`.

**Expected Results:**
- `findings` contains exactly one entry.
- That entry has `file === 'package.json'`, `name === 'lodash'`, `kind === 'unused-dep'`, `source === 'knip'`.
- `message` equals `'Unused dependency: lodash'`.

---

### Scenario 4: Unused devDependency detected

**Steps:**
1. Stub `knipRunner.run` to return stdout containing `{ "issues": [{ "file": "package.json", "devDependencies": [{ "name": "jest" }] }] }`.
2. Call `runKnip('/some/project')`.

**Expected Results:**
- `findings` contains exactly one entry.
- That entry has `name === 'jest'`, `kind === 'unused-dep'`, `source === 'knip'`.
- `message` equals `'Unused devDependency: jest'`.

---

### Scenario 5: Unlisted dependency detected

**Steps:**
1. Stub `knipRunner.run` to return stdout containing `{ "issues": [{ "file": "src/index.ts", "unlisted": [{ "name": "chalk" }] }] }`.
2. Call `runKnip('/some/project')`.

**Expected Results:**
- `findings` contains exactly one entry.
- That entry has `file === 'src/index.ts'`, `name === 'chalk'`, `kind === 'unlisted-dep'`, `source === 'knip'`.
- `message` equals `'Unlisted dependency (used but not declared): chalk'`.

---

### Scenario 6: Unused export detected

**Steps:**
1. Stub `knipRunner.run` to return stdout containing `{ "issues": [{ "file": "src/utils.ts", "exports": [{ "name": "helperFn", "line": 12 }] }] }`.
2. Call `runKnip('/some/project')`.

**Expected Results:**
- `findings` contains exactly one entry.
- That entry has `file === 'src/utils.ts'`, `name === 'helperFn'`, `kind === 'unused-export'`, `source === 'knip'`.
- `message` equals `'Unused export: helperFn'`.

---

### Scenario 7: Duplicate export detected

**Steps:**
1. Stub `knipRunner.run` to return stdout containing `{ "issues": [{ "file": "src/barrel.ts", "duplicates": [[{ "name": "foo" }, { "name": "bar" }]] }] }`.
2. Call `runKnip('/some/project')`.

**Expected Results:**
- `findings` contains exactly one entry.
- That entry has `file === 'src/barrel.ts'`, `kind === 'duplicate-export'`, `source === 'knip'`.
- `name` equals `'foo, bar'`.
- `message` equals `'Duplicate exports: foo, bar'`.

---

### Scenario 8: Subprocess spawn error

**Steps:**
1. Stub `knipRunner.run` to return `{ stdout: null, status: null, error: new Error('spawn ENOENT') }`.
2. Call `runKnip('/some/project')`.

**Expected Results:**
- The resolved value has `ok === false`.
- `findings` is an empty array.
- No exception is thrown from `runKnip`.

---

### Scenario 9: Null stdout

**Steps:**
1. Stub `knipRunner.run` to return `{ stdout: null, status: 0, error: undefined }`.
2. Call `runKnip('/some/project')`.

**Expected Results:**
- The resolved value has `ok === false`.
- `findings` is an empty array.

---

### Scenario 10: Invalid JSON in stdout

**Steps:**
1. Stub `knipRunner.run` to return `{ stdout: 'NOT_JSON', status: 0, error: undefined }`.
2. Call `runKnip('/some/project')`.

**Expected Results:**
- The resolved value has `ok === false`.
- `findings` is an empty array.

---

### Scenario 11: Mixed findings in a single run

**Steps:**
1. Stub `knipRunner.run` to return stdout containing both a `files` entry (`"src/dead.ts"`) and an issue with one `exports` entry (`"unusedFn"`) in `"src/lib.ts"`.
2. Call `runKnip('/some/project')`.

**Expected Results:**
- `findings` contains exactly two entries.
- One entry has `kind === 'unused-file'` and `file === 'src/dead.ts'`.
- One entry has `kind === 'unused-export'` and `file === 'src/lib.ts'` and `name === 'unusedFn'`.
- Both entries have `source === 'knip'`.

---

### Scenario 12: Empty stdout string

**Steps:**
1. Stub `knipRunner.run` to return `{ stdout: '   ', status: 0, error: undefined }`.
2. Call `runKnip('/some/project')`.

**Expected Results:**
- The resolved value has `ok === true`.
- `findings` is an empty array.

## Security Notes

- No credentials, API keys, or tokens are used by this adapter.
- The `projectDir` argument is passed directly as the `cwd` option to `spawnSync`. Callers must ensure this value is a validated, trusted path to prevent working-directory traversal if the adapter is ever exposed to external input.
- stdout is capped at 32 MB (`maxBuffer`) to prevent memory exhaustion from unexpectedly large knip output.
- The subprocess times out after 120 seconds to prevent indefinite blocking.

## Dependencies

- **Node.js built-in**: `node:child_process` (`spawnSync`) — used to invoke the knip CLI.
- **Runtime CLI**: `npx knip` — must be resolvable in the target project's environment; absence causes `ok: false` rather than a thrown error.
- **Internal seam**: `knipRunner` object — injectable for testing without spawning a real subprocess.