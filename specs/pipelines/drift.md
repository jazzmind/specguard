# Drift Detection Pipeline

<!--
  module: src/pipelines/drift.ts
  type: pipeline
  status: draft
-->

## Overview

Detects when source code has changed but its corresponding Living Spec has not been updated — i.e. the spec has drifted out of sync with the code it describes. It inspects the git history for files changed in a range (default `HEAD~1..HEAD`), maps each changed source file to the spec it should keep in sync using the same source→spec-key mapping as the reverse pipeline, and compares file modification times. A spec that is older than the source it documents (or missing entirely) is reported as drift. The pipeline exits with code `3` (`DriftDetected`) when any drift is found, so it can gate CI.

## Acceptance Criteria

- [ ] Determines the git range from `opts.since`: `<since>..HEAD` when provided, else `HEAD~1..HEAD`
- [ ] Lists changed files with `git diff --name-only <range>` run via `node:child_process` (no shell), cwd = `config.rootDir ?? process.cwd()`
- [ ] The git invocation is isolated in an exported helper (`getChangedFiles`) so it can be mocked/overridden in tests
- [ ] If git fails (shallow clone, first commit, not a repo), logs a `[warn]` line and falls back to scanning all configured source files — never throws an unhandled error
- [ ] Maps each changed file that matches an app's source globs to its expected spec path using the reverse pipeline's mapping (drop leading `src/`/`tests/`, drop the area segment, strip `.test`/`.spec` + extension, write under `<specDir>/<feature>.md`)
- [ ] Files that do not match any app's source globs are ignored
- [ ] Compares mtimes via `fs.stat`: source mtime newer than spec mtime → drift for that spec
- [ ] A changed source file whose spec does not exist on disk → drift (missing spec)
- [ ] Each drifted spec is recorded as a `PipelineItem` with `status: 'failed'` and a human-readable `message`; readable lines are pushed to `result.messages`
- [ ] `result.failed` equals the number of drifted specs; `result.exitCode` is `ExitCode.DriftDetected` (3) when drift exists, else `0`
- [ ] `opts.spec` filters the report to a single spec key when provided

## Scenarios

### Scenario 1: Source changed after its spec → drift

**Steps:**
1. A source file `src/core/foo.ts` is reported as changed by git in the range
2. Its spec `specs/core/foo.md` exists but has an older mtime than the source
3. Call `runDrift(config)`

**Expected Results:**
- The spec key `specguard-core/foo` is recorded with `status: 'failed'`
- `result.failed === 1`
- `result.exitCode === 3`
- A `[drift]` line is present in `result.messages`

---

### Scenario 2: Spec newer than source → no drift

**Steps:**
1. `src/core/foo.ts` is reported as changed
2. `specs/core/foo.md` exists with an mtime newer than the source
3. Call `runDrift(config)`

**Expected Results:**
- No drift items recorded
- `result.failed === 0`
- `result.exitCode === 0`

---

### Scenario 3: Changed source has no spec → drift (missing spec)

**Steps:**
1. `src/core/bar.ts` is reported as changed
2. No file exists at `specs/core/bar.md`
3. Call `runDrift(config)`

**Expected Results:**
- The spec key `specguard-core/bar` is recorded with `status: 'failed'` and a "missing spec" message
- `result.exitCode === 3`

---

### Scenario 4: Changed file does not match any source glob → ignored

**Steps:**
1. git reports `README.md` and `package.json` as changed
2. Neither matches any app's source globs
3. Call `runDrift(config)`

**Expected Results:**
- No items recorded
- `result.exitCode === 0`

---

### Scenario 5: git fails → graceful fallback

**Steps:**
1. The repo is a shallow clone / first commit, so `git diff` exits non-zero
2. Call `runDrift(config)`

**Expected Results:**
- A `[warn]` line notes the git failure and the fallback to scanning all source files
- No unhandled error is thrown
- Drift is evaluated against the full set of configured source files

---

### Scenario 6: Filter to a single spec key

**Steps:**
1. Multiple source files changed, mapping to several spec keys
2. Call `runDrift(config, { spec: 'specguard-core/foo' })`

**Expected Results:**
- Only the `specguard-core/foo` spec is evaluated for drift
- Other changed files are skipped

## Dependencies

- `specs/pipelines/reverse-generate.md` — source→spec-key mapping (must match)
- `specs/core/config.md` — `AppConfig`, source globs
- `specs/core/exit-codes.md` — `DriftDetected = 3`
