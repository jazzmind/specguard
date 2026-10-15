# Gap Analysis Command

<!-- module: specguard-cli/commands/gap-analysis / type: cli-command / status: draft -->

## Overview

The `specguard gap-analysis` command detects specifications that are unimplemented or only partially implemented within a repository. It delegates analysis to the `runGapAnalysis` pipeline, passing configuration loaded from CLI options. Results are printed to standard output, categorising gaps as either `unimplemented` or `partial`, with optional implementation plan paths shown alongside unimplemented specs. The command exits with a code determined by the pipeline result, allowing integration into CI pipelines.

## Acceptance Criteria

- AC1: When no gaps are detected, stdout contains the message `gap-analysis: all specs appear to be implemented ✓`.
- AC2: When unimplemented specs exist, stdout contains a header `N UNIMPLEMENTED spec(s):` followed by one line per spec prefixed with `✗`, showing the spec key and title.
- AC3: When a plan path is available for an unimplemented spec, the line includes `(plan: <planPath>)`.
- AC4: When partial specs exist, stdout contains a header `N PARTIAL spec(s):` followed by one line per spec prefixed with `~`, showing the spec key, title, and pending criteria count in the form `(X/Y criteria pending)`.
- AC5: All pipeline messages are printed to stdout before the gap summary.
- AC6: The process exits with the exit code returned by `runGapAnalysis`.
- AC7: When `--no-plan` is passed, the pipeline is invoked with `plan: false`.
- AC8: When `--spec <key>` is passed, the pipeline is invoked with `spec: <key>`.
- AC9: When neither `--spec` nor `--all` is provided, the pipeline is invoked with `spec: undefined`.

## Scenarios

### Scenario 1: All specs implemented

**Steps:**
1. Invoke `gapAnalysisCommand({})` with a configuration where `runGapAnalysis` returns `{ messages: [], gaps: [], exitCode: 0 }`.
2. Capture all writes to `process.stdout`.
3. Observe the exit code passed to `process.exit`.

**Expected Results:**
- stdout contains the string `gap-analysis: all specs appear to be implemented ✓`.
- `process.exit` is called with `0`.
- No `UNIMPLEMENTED` or `PARTIAL` section headers appear in stdout.

---

### Scenario 2: Unimplemented specs without plan paths

**Steps:**
1. Invoke `gapAnalysisCommand({})` with `runGapAnalysis` returning `{ messages: [], gaps: [{ status: 'unimplemented', specKey: 'auth/login', title: 'Login Page', planPath: undefined }], exitCode: 1 }`.
2. Capture all writes to `process.stdout`.
3. Observe the exit code passed to `process.exit`.

**Expected Results:**
- stdout contains `1 UNIMPLEMENTED spec(s):`.
- stdout contains a line matching `  ✗ auth/login — "Login Page"`.
- The line does not contain `(plan:`.
- `process.exit` is called with `1`.

---

### Scenario 3: Unimplemented spec with a plan path

**Steps:**
1. Invoke `gapAnalysisCommand({})` with `runGapAnalysis` returning a gap entry `{ status: 'unimplemented', specKey: 'auth/login', title: 'Login Page', planPath: 'plans/auth-login.md' }` and `exitCode: 1`.
2. Capture all writes to `process.stdout`.

**Expected Results:**
- stdout contains a line matching `  ✗ auth/login — "Login Page" (plan: plans/auth-login.md)`.

---

### Scenario 4: Partial specs

**Steps:**
1. Invoke `gapAnalysisCommand({})` with `runGapAnalysis` returning `{ messages: [], gaps: [{ status: 'partial', specKey: 'search/filters', title: 'Search Filters', uncheckedCriteria: 3, totalCriteria: 7 }], exitCode: 1 }`.
2. Capture all writes to `process.stdout`.

**Expected Results:**
- stdout contains `1 PARTIAL spec(s):`.
- stdout contains a line matching `  ~ search/filters — "Search Filters" (3/7 criteria pending)`.
- No `UNIMPLEMENTED` section header appears in stdout.

---

### Scenario 5: Mixed unimplemented and partial specs

**Steps:**
1. Invoke `gapAnalysisCommand({})` with `runGapAnalysis` returning two gaps: one with `status: 'unimplemented'` and one with `status: 'partial'`, and `exitCode: 1`.
2. Capture all writes to `process.stdout`.

**Expected Results:**
- stdout contains both `1 UNIMPLEMENTED spec(s):` and `1 PARTIAL spec(s):` sections.
- The `UNIMPLEMENTED` section appears before the `PARTIAL` section in stdout.

---

### Scenario 6: Pipeline messages are printed before the summary

**Steps:**
1. Invoke `gapAnalysisCommand({})` with `runGapAnalysis` returning `{ messages: ['Scanning specs…', 'Done.'], gaps: [], exitCode: 0 }`.
2. Capture all writes to `process.stdout` in order.

**Expected Results:**
- `Scanning specs…` appears in stdout before the `gap-analysis: all specs appear to be implemented ✓` line.
- `Done.` appears in stdout before the summary line.

---

### Scenario 7: `--no-plan` flag disables plan generation

**Steps:**
1. Invoke `gapAnalysisCommand({ noPlan: true })`.
2. Inspect the arguments passed to `runGapAnalysis`.

**Expected Results:**
- `runGapAnalysis` is called with a second argument containing `{ plan: false }`.

---

### Scenario 8: `--spec` flag scopes analysis to a single spec

**Steps:**
1. Invoke `gapAnalysisCommand({ spec: 'auth/login' })`.
2. Inspect the arguments passed to `runGapAnalysis`.

**Expected Results:**
- `runGapAnalysis` is called with a second argument containing `{ spec: 'auth/login', plan: true }`.

## Security Notes

- No credentials, tokens, or secret values are handled by this command.
- CLI configuration is loaded via `loadCliConfig`; any secrets within that configuration must not be echoed to stdout.
- Plan paths written to stdout are derived from pipeline output and should be validated upstream to prevent path traversal information leakage.

## Dependencies

- `../../pipelines/gap-analysis` — `runGapAnalysis` pipeline function that performs the actual analysis.
- `./helpers` — `loadCliConfig` for resolving merged CLI and file-based configuration; `GlobalOpts` type.
- Node.js `process.stdout` and `process.exit` — used directly for output and exit code signalling.