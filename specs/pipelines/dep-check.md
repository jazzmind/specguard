# Dep-Check Pipeline

<!-- module: specguard-pipelines/dep-check / type: pipeline / status: draft -->

## Overview

The dep-check pipeline audits one or more application repositories for npm security vulnerabilities (via `npm-audit`) and dependency hygiene issues (via `depcheck`). Both tools run concurrently per app, and their findings are normalised into a unified `DepFinding` structure. Results are aggregated across all in-scope apps and written to `.specguard/dep-check.json`, which is consumed by the VS Code dashboard's FindingsView and by CI fail-gates. The pipeline exits with a non-zero code (`ExitCode.SecurityIssues`) when any critical or high severity vulnerability is found. It is invoked via the CLI command `specguard deps [--app <name>]`.

## Acceptance Criteria

- AC-1: When no `--app` flag is supplied, the pipeline runs against every app defined in `config.apps`.
- AC-2: When `--app <name>` is supplied and the name matches a configured app, only that app is processed.
- AC-3: When `--app <name>` is supplied and the name does not match any configured app, a `SpecGuardError` is thrown listing all known app names, and the pipeline does not run.
- AC-4: For each app, `runNpmAudit` and `runDepcheck` are invoked concurrently (via `Promise.all`) against the resolved absolute path of the app's repo.
- AC-5: npm-audit findings are normalised to `category: 'vulnerability'` and `source: 'npm-audit'`; severity values `moderate` and `medium` are both mapped to `'medium'`; any unrecognised severity maps to `'info'`.
- AC-6: depcheck findings are normalised to `source: 'depcheck'` with `category` set to `'missing-dep'`, `'unused-dev-dep'`, or `'unused-dep'` according to the finding's `kind` field; severity is always `'info'`.
- AC-7: When `runNpmAudit` returns `ok: false`, a warning message is logged for that app and processing continues.
- AC-8: When `runDepcheck` returns `ok: false`, a warning message is logged for that app and processing continues.
- AC-9: The report file `.specguard/dep-check.json` is created (including any missing parent directories) and contains `generatedAt`, `apps`, `findings`, `totalVulnerabilities`, `totalUnused`, and `totalMissing` fields.
- AC-10: `totalVulnerabilities` equals the sum of all vulnerability findings across all apps; `totalUnused` equals the sum of all non-`missing-dep` depcheck findings; `totalMissing` equals the sum of all `missing-dep` depcheck findings.
- AC-11: `result.created` equals the total number of findings across all apps and both tools.
- AC-12: If one or more findings have severity `'critical'` or `'high'`, `result.exitCode` is set to `ExitCode.SecurityIssues`.
- AC-13: If no findings have severity `'critical'` or `'high'`, `result.exitCode` retains the default value from `emptyResult`.

## Scenarios

### Scenario 1: Full run across all apps with no critical findings

**Steps:**
1. Provide a `SpecGuardConfig` with two apps (`app-a`, `app-b`), no `--app` option, and a `rootDir` pointing to a temp directory containing both repos.
2. Mock `runNpmAudit` to return `{ ok: true, findings: [{ ruleId: 'GHSA-001', severity: 'low', message: 'Low vuln' }] }` for both apps.
3. Mock `runDepcheck` to return `{ ok: true, findings: [{ name: 'lodash', kind: 'unused-dep', message: 'Unused' }] }` for both apps.
4. Call `runDepCheck(config, {})` and await the result.
5. Read and parse `.specguard/dep-check.json` from the resolved report path.

**Expected Results:**
- `result.exitCode` equals the default exit code (not `ExitCode.SecurityIssues`).
- `result.created` equals `4` (2 findings × 2 apps).
- The JSON report's `totalVulnerabilities` equals `2`, `totalUnused` equals `2`, `totalMissing` equals `0`.
- The JSON report's `apps` array contains exactly two entries, one for `app-a` and one for `app-b`, each with `vulnerabilityCount: 1` and `unusedCount: 1`.
- The JSON report's `findings` array contains `4` entries.
- `result.messages` contains a line matching `[deps] wrote` followed by the report path.

### Scenario 2: Single-app filter via `--app` flag

**Steps:**
1. Provide a `SpecGuardConfig` with two apps (`app-a`, `app-b`).
2. Mock both adapters to return empty findings with `ok: true`.
3. Call `runDepCheck(config, { app: 'app-a' })` and await the result.
4. Inspect which adapter calls were made and read the written report.

**Expected Results:**
- `runNpmAudit` and `runDepcheck` are each called exactly once, with the resolved path of `app-a`'s repo.
- The JSON report's `apps` array contains exactly one entry with `name: 'app-a'`.
- `result.messages` contains a log line referencing `app-a` and not `app-b`.

### Scenario 3: Unknown app name supplied via `--app`

**Steps:**
1. Provide a `SpecGuardConfig` with one app named `app-a`.
2. Call `runDepCheck(config, { app: 'nonexistent' })` inside a try/catch.

**Expected Results:**
- A `SpecGuardError` is thrown.
- The error message contains the string `nonexistent`.
- The error message contains the string `app-a` (the list of known apps).
- Neither `runNpmAudit` nor `runDepcheck` is called.
- No report file is written to disk.

### Scenario 4: Critical vulnerability triggers fail-gate exit code

**Steps:**
1. Provide a `SpecGuardConfig` with one app.
2. Mock `runNpmAudit` to return `{ ok: true, findings: [{ ruleId: 'GHSA-CRIT', severity: 'critical', message: 'Critical vuln' }] }`.
3. Mock `runDepcheck` to return `{ ok: true, findings: [] }`.
4. Call `runDepCheck(config, {})` and await the result.

**Expected Results:**
- `result.exitCode` equals `ExitCode.SecurityIssues`.
- The JSON report's `totalVulnerabilities` equals `1`.
- The finding in the report has `severity: 'critical'` and `category: 'vulnerability'`.

### Scenario 5: High severity vulnerability triggers fail-gate exit code

**Steps:**
1. Provide a `SpecGuardConfig` with one app.
2. Mock `runNpmAudit` to return `{ ok: true, findings: [{ ruleId: 'GHSA-HIGH', severity: 'high', message: 'High vuln' }] }`.
3. Mock `runDepcheck` to return `{ ok: true, findings: [] }`.
4. Call `runDepCheck(config, {})` and await the result.

**Expected Results:**
- `result.exitCode` equals `ExitCode.SecurityIssues`.
- The finding in the report has `severity: 'high'`.

### Scenario 6: npm-audit unavailable, depcheck succeeds

**Steps:**
1. Provide a `SpecGuardConfig` with one app.
2. Mock `runNpmAudit` to return `{ ok: false, findings: [] }`.
3. Mock `runDepcheck` to return `{ ok: true, findings: [{ name: 'chalk', kind: 'unused-dev-dep', message: 'Unused dev dep' }] }`.
4. Call `runDepCheck(config, {})` and await the result.

**Expected Results:**
- `result.exitCode` is not `ExitCode.SecurityIssues`.
- `result.messages` contains a line matching `[warn]` and the app name and `npm audit not available`.
- The JSON report's `totalVulnerabilities` equals `0` and `totalUnused` equals `1`.
- The finding has `category: 'unused-dev-dep'` and `source: 'depcheck'`.

### Scenario 7: Severity normalisation for `moderate` input

**Steps:**
1. Provide a `SpecGuardConfig` with one app.
2. Mock `runNpmAudit` to return `{ ok: true, findings: [{ ruleId: 'GHSA-MOD', severity: 'moderate', message: 'Moderate vuln' }] }`.
3. Mock `runDepcheck` to return `{ ok: true, findings: [] }`.
4. Call `runDepCheck(config, {})` and await the result.
5. Read the written report and inspect the finding's `severity` field.

**Expected Results:**
- The finding's `severity` equals `'medium'`.
- `result.exitCode` is not `ExitCode.SecurityIssues`.

### Scenario 8: Report directory is created when absent

**Steps:**
1. Provide a `SpecGuardConfig` with `rootDir` pointing to a temp directory that does not contain a `.specguard` subdirectory.
2. Mock both adapters to return `{ ok: true, findings: [] }`.
3. Call `runDepCheck(config, {})` and await the result.
4. Check the filesystem for the `.specguard` directory and `dep-check.json` file.

**Expected Results:**
- The `.specguard` directory exists under `rootDir`.
- The file `.specguard/dep-check.json` exists and is valid JSON.
- The JSON contains a `generatedAt` field that is a valid ISO 8601 timestamp string.

### Scenario 9: Missing-dep findings are counted separately from unused

**Steps:**
1. Provide a `SpecGuardConfig` with one app.
2. Mock `runNpmAudit` to return `{ ok: true, findings: [] }`.
3. Mock `runDepcheck` to return `{ ok: true, findings: [{ name: 'react', kind: 'missing-dep', message: 'Missing', usedIn: ['src/App.tsx'] }, { name: 'lodash', kind: 'unused-dep', message: 'Unused' }] }`.
4. Call `runDepCheck(config, {})` and await the result.
5. Read and parse the report.

**Expected Results:**
- `totalMissing` equals `1`.
- `totalUnused` equals `1`.
- The `missing-dep` finding has `usedIn: ['src/App.tsx']`.
- The `missing-dep` finding has `category: 'missing-dep'` and `severity: 'info'`.

## Security Notes

- No credentials, API keys, or tokens are used or stored by this pipeline.
- The pipeline reads from and writes to the local filesystem only; no network calls are made directly (network I/O is delegated to the `npm-audit` and `depcheck` adapters).
- The report file `.specguard/dep-check.json` may contain package names and file paths from the target repositories; access to this file should be restricted to authorised users and CI processes.
- The fail-gate on `critical` and `high` severity findings is intended to block CI pipelines from proceeding when known exploitable vulnerabilities are present.

## Dependencies

- `../core/types` — `SpecGuardConfig`, `AppConfig`, `PipelineResult`, `emptyResult`
- `../core/errors` — `SpecGuardError`
- `../core/exit-codes` — `ExitCode`
- `../adapters/npm-audit` — `runNpmAudit`
- `../adapters/depcheck` — `runDepcheck`, `DepcheckFinding`
- `./security` — `SastFinding` (type import only)
- Node.js built-ins: `node:path`, `node:fs`