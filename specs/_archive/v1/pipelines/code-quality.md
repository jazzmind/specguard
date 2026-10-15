# Code Quality Pipeline

<!-- module: specguard-pipelines/code-quality / type: pipeline / status: draft -->

## Overview

The Code Quality pipeline runs ESLint (lint errors and style) and Knip (dead code, unused exports, unused dependencies) against one or more configured app repositories and aggregates all findings into a single structured report. It is invoked via the CLI command `specguard quality [--app <name>] [--fix]`. Both tools execute concurrently per app using `Promise.all`. The aggregated output is written to `.specguard/code-quality.json` relative to the configured root directory, where it is consumed by the VS Code dashboard's FindingsView and by CI fail-gates. The pipeline exits with a `ValidationFailed` exit code when any ESLint errors are present; warnings alone do not cause a failure.

## Acceptance Criteria

- AC-1: When invoked without `--app`, the pipeline runs ESLint and Knip against every app defined in `config.apps`.
- AC-2: When invoked with `--app <name>`, only the named app is processed; all other apps are skipped.
- AC-3: When `--app` specifies an unknown app name, the pipeline throws a `SpecGuardError` listing all known app names and does not write a report.
- AC-4: ESLint and Knip are executed concurrently (via `Promise.all`) for each app.
- AC-5: ESLint findings are normalised with `category: "lint"` and `source: "eslint"`.
- AC-6: Knip findings with kind `unused-export` or `unused-file` are normalised with `category: "dead-code"`; kind `unlisted-dep` maps to `category: "unlisted-dep"`; all other Knip kinds map to `category: "unused-dep"`. All Knip findings receive `severity: "warning"` and `source: "knip"`.
- AC-7: The report file `.specguard/code-quality.json` is created (including any missing parent directories) and contains `generatedAt`, `apps`, `findings`, `totalErrors`, and `totalWarnings` fields.
- AC-8: `totalErrors` reflects only ESLint error counts; Knip findings contribute only to `totalWarnings`.
- AC-9: `result.created` equals the total number of findings across all apps.
- AC-10: When `totalErrors > 0`, the returned `PipelineResult` has `exitCode` set to `ExitCode.ValidationFailed`.
- AC-11: When `totalErrors === 0`, the returned `PipelineResult` does not have `exitCode` set to `ExitCode.ValidationFailed`.
- AC-12: If ESLint or Knip is unavailable or fails for an app (`ok === false`), a warning message is logged and that tool contributes zero errors/warnings to the totals; the pipeline continues processing remaining apps.

## Scenarios

### Scenario 1: All apps processed when no `--app` filter is given

**Steps:**
1. Configure `SpecGuardConfig` with two apps, `app-a` and `app-b`, each pointing to a valid repo directory.
2. Call `runCodeQuality(config, {})`.
3. Inspect the written `.specguard/code-quality.json`.

**Expected Results:**
- The `apps` array in the JSON report contains exactly two entries, one with `name: "app-a"` and one with `name: "app-b"`.
- `result.messages` contains a `[quality]` log line referencing each app name.

---

### Scenario 2: Single app scoped via `--app`

**Steps:**
1. Configure `SpecGuardConfig` with two apps, `app-a` and `app-b`.
2. Call `runCodeQuality(config, { app: 'app-a' })`.
3. Inspect the written `.specguard/code-quality.json`.

**Expected Results:**
- The `apps` array contains exactly one entry with `name: "app-a"`.
- No entry for `app-b` appears anywhere in the report.

---

### Scenario 3: Unknown app name throws `SpecGuardError`

**Steps:**
1. Configure `SpecGuardConfig` with one app named `app-a`.
2. Call `runCodeQuality(config, { app: 'nonexistent' })` inside a try/catch.

**Expected Results:**
- A `SpecGuardError` is thrown.
- The error message contains the string `nonexistent`.
- The error message contains the string `app-a` (the list of known apps).
- No `.specguard/code-quality.json` file is written.

---

### Scenario 4: ESLint errors trigger `ValidationFailed` exit code

**Steps:**
1. Configure one app whose repo causes `runEslint` to return `{ ok: true, errorCount: 3, warningCount: 1, findings: [...] }`.
2. Configure `runKnip` to return `{ ok: true, findings: [] }`.
3. Call `runCodeQuality(config, {})`.
4. Inspect the returned `PipelineResult`.

**Expected Results:**
- `result.exitCode` equals `ExitCode.ValidationFailed`.
- `result.messages` contains a line matching `[eslint] <app-name>: 3 errors, 1 warnings`.

---

### Scenario 5: Warnings only do not trigger `ValidationFailed`

**Steps:**
1. Configure one app whose repo causes `runEslint` to return `{ ok: true, errorCount: 0, warningCount: 2, findings: [...] }`.
2. Configure `runKnip` to return `{ ok: true, findings: [{ kind: 'unused-dep', ... }] }`.
3. Call `runCodeQuality(config, {})`.
4. Inspect the returned `PipelineResult`.

**Expected Results:**
- `result.exitCode` is not `ExitCode.ValidationFailed`.
- The JSON report's `totalErrors` is `0`.
- The JSON report's `totalWarnings` is `3` (2 ESLint warnings + 1 Knip finding).

---

### Scenario 6: Knip finding categories are mapped correctly

**Steps:**
1. Configure one app where `runKnip` returns findings with kinds `unused-export`, `unused-file`, `unlisted-dep`, and `unused-dep`.
2. Call `runCodeQuality(config, {})`.
3. Read `.specguard/code-quality.json` and inspect the `findings` array.

**Expected Results:**
- The finding with kind `unused-export` has `category: "dead-code"` and `source: "knip"`.
- The finding with kind `unused-file` has `category: "dead-code"` and `source: "knip"`.
- The finding with kind `unlisted-dep` has `category: "unlisted-dep"` and `source: "knip"`.
- The finding with kind `unused-dep` has `category: "unused-dep"` and `source: "knip"`.
- All four findings have `severity: "warning"`.

---

### Scenario 7: ESLint unavailable — pipeline continues and logs warning

**Steps:**
1. Configure one app where `runEslint` returns `{ ok: false, findings: [], errorCount: 0, warningCount: 0 }`.
2. Configure `runKnip` to return `{ ok: true, findings: [] }`.
3. Call `runCodeQuality(config, {})`.
4. Inspect `result.messages` and the written JSON report.

**Expected Results:**
- `result.messages` contains a line matching `[warn] <app-name>: ESLint not available or failed`.
- The JSON report is written successfully.
- `totalErrors` is `0`.
- `result.exitCode` is not `ExitCode.ValidationFailed`.

---

### Scenario 8: Report file and directory are created

**Steps:**
1. Configure `SpecGuardConfig` with `rootDir` pointing to a temporary directory that does not yet contain a `.specguard` subdirectory.
2. Call `runCodeQuality(config, {})`.
3. Check the filesystem at `<rootDir>/.specguard/code-quality.json`.

**Expected Results:**
- The directory `<rootDir>/.specguard/` exists after the call.
- The file `<rootDir>/.specguard/code-quality.json` exists and is valid JSON.
- The JSON object contains the keys `generatedAt`, `apps`, `findings`, `totalErrors`, and `totalWarnings`.
- `generatedAt` is a valid ISO 8601 timestamp string.

---

### Scenario 9: `result.created` equals total finding count

**Steps:**
1. Configure two apps; the first produces 2 ESLint findings and 1 Knip finding; the second produces 0 ESLint findings and 3 Knip findings.
2. Call `runCodeQuality(config, {})`.
3. Inspect the returned `PipelineResult`.

**Expected Results:**
- `result.created` equals `6`.
- The `findings` array in the JSON report has length `6`.

---

## Security Notes

- No credentials, API keys, or tokens are present in this pipeline.
- The pipeline reads from and writes to the local filesystem only; no network calls are made directly by this module.
- Report output is written to `.specguard/code-quality.json`; ensure this path is excluded from version control if findings may contain sensitive file paths or internal dependency names.

## Dependencies

| Dependency | Role |
|---|---|
| `../adapters/eslint` (`runEslint`) | Executes ESLint against a repo directory and returns structured findings |
| `../adapters/knip` (`runKnip`) | Executes Knip against a repo directory and returns structured findings |
| `../core/types` (`SpecGuardConfig`, `AppConfig`, `PipelineResult`, `emptyResult`) | Shared configuration and result types |
| `../core/errors` (`SpecGuardError`) | Structured error type used for unknown app names |
| `../core/exit-codes` (`ExitCode`) | Enumeration of pipeline exit codes |
| `node:fs` | Filesystem access for creating directories and writing the report |
| `node:path` | Path resolution for repo directories and report output path |