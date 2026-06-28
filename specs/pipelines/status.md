# Status Pipeline

<!--
  module: src/pipelines/status.ts
  type: pipeline
  status: draft
-->

## Overview

Reports spec and test coverage for every app in the SpecGuard config. For each app it expands the configured source globs, derives the expected spec path for each source file (using the SAME source-file → feature mapping as the reverse pipeline), and checks whether that spec exists under `specDir` and whether a generated test exists under `testOutput`. It prints a per-app coverage report plus a totals line and signals missing coverage through its exit code.

This is the read-only health check for a SpecGuard-managed repo: it never calls the LLM and never writes files. It answers "which source files still lack a spec?" so CI can gate on coverage.

## Acceptance Criteria

- [ ] Reads app config from `SpecGuardConfig` (caller loads it; no config discovery)
- [ ] Expands source globs relative to `rootDir` + the app's `repo` directory
- [ ] Excludes the `tests` source group from the "needs a spec" set (test files are not features that require their own spec)
- [ ] For each source file, derives the expected feature/spec key using the same mapping as `reverse-generate.ts` (`deriveFeature`)
- [ ] Checks spec existence at `<specDir>/<feature>.md` via `fileExists`
- [ ] Checks generated-test existence under `<testOutput>` for the feature via `fileExists`
- [ ] Builds counts per app: total source files, specs present (count + %), tests present (count + %), and a list of files missing specs
- [ ] Pushes human-readable per-app and totals report lines into `result.messages`
- [ ] Each source file becomes a `PipelineItem` (`ok` when a spec exists, `failed` when the spec is missing); the item message notes a missing test
- [ ] Sets `result.exitCode = ExitCode.MissingSpecs` (4) if ANY source file lacks a spec; otherwise `0`
- [ ] Sets `result.failed` to the count of source files missing a spec
- [ ] Does not call the LLM and does not write any files

## Scenarios

### Scenario 1: All source files have specs

**Steps:**
1. Config app has a source glob matching `src/core/a.ts` and `src/core/b.ts`
2. Specs exist at `specs/core/a.md` and `specs/core/b.md`
3. Call `runStatus(config)`

**Expected Results:**
- Result reports 2 total source files and 2 specs present (100%)
- Every `PipelineItem` has status `ok`
- `result.failed` is `0`
- `result.exitCode` is `0`

---

### Scenario 2: A source file is missing its spec

**Steps:**
1. Config app has source globs matching `src/core/a.ts` and `src/core/b.ts`
2. A spec exists at `specs/core/a.md` but NOT at `specs/core/b.md`
3. Call `runStatus(config)`

**Expected Results:**
- Result reports 2 total source files and 1 spec present (50%)
- The item for `b` has status `failed`
- `result.failed` is `1` and the missing-specs list contains `b`
- `result.exitCode` is `ExitCode.MissingSpecs` (4)

---

### Scenario 3: Test coverage is reported

**Steps:**
1. A source file `src/core/a.ts` has a matching spec `specs/core/a.md`
2. A generated test exists at `tests/core/a.test.ts` (the app's `testOutput`)
3. Call `runStatus(config)`

**Expected Results:**
- The report counts 1 test present for that app
- The `PipelineItem` for `a` is `ok` with no missing-test note

---

### Scenario 4: Tests group is excluded from the needs-a-spec set

**Steps:**
1. Config app `sources` has both an `api` group and a `tests` group
2. Test files matched by the `tests` group exist on disk
3. Call `runStatus(config)`

**Expected Results:**
- Test files are not counted as source files needing a spec
- Only non-test source files contribute to the totals

---

### Scenario 5: Empty repo / no source files

**Steps:**
1. Config app has source globs that match nothing on disk
2. Call `runStatus(config)`

**Expected Results:**
- Result reports 0 total source files
- `result.failed` is `0`
- `result.exitCode` is `0`
- No error is thrown

## Dependencies

- `specs/pipelines/reverse-generate.md` — shares the source-file → feature/spec-key mapping
- `specs/core/spec-parser.md` — spec layout this pipeline cross-references
- `specs/core/config.md` — `AppConfig` type, glob expansion
- `specs/core/exit-codes.md` — `ExitCode.MissingSpecs`
