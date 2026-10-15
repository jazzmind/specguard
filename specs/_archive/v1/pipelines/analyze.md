# Analyze Pipeline

<!-- module: specguard-pipelines/analyze / type: pipeline / status: draft -->

## Overview

The Analyze pipeline is the "smart start" entry point for SpecGuard. It orchestrates five internal sub-pipelines — Status, Drift, Code Quality, Dep-Check, and Gap Analysis — and aggregates their findings into a prioritised list of recommended next pipelines. Results are returned as a `PipelineResult` whose `items` carry each recommendation's pipeline ID as `key` and a human-readable reason as `message`. A structured JSON report is also written to `.specguard/analysis.json` for consumption by the dashboard and MCP tooling. Exit code `0` signals a healthy workspace; exit code `4` signals that recommendations exist; exit code `1` signals an internal error.

## Acceptance Criteria

- AC1: When all sub-pipelines report no issues, `runAnalyze` returns exit code `0` and zero recommendation items.
- AC2: When the Status sub-pipeline returns `MissingSpecs`, a `high`-priority recommendation for the `reverse` pipeline is included, with the count of uncovered source files in the reason string.
- AC3: When the Drift sub-pipeline returns `DriftDetected`, a `high`-priority recommendation for `drift` and a `medium`-priority recommendation for `heal` are included; the drift recommendation message contains the count of stale specs.
- AC4: When at least one app is configured and no specs are missing, `medium`-priority recommendations for `generate` and `security`, and `low`-priority recommendations for `docs` and `matrix`, are included.
- AC5: When Gap Analysis finds unimplemented specs, a `high`-priority recommendation for `gap-analysis` is included with the unimplemented count; when only partial specs exist, a `medium`-priority recommendation for `gap-analysis` is included.
- AC6: When Code Quality reports failures, a `medium`-priority recommendation for `quality` is included with the failure count.
- AC7: When Dep-Check reports fewer than 3 failures, a `medium`-priority recommendation for `deps` is included; when 3 or more failures are found, the priority is `high`.
- AC8: Duplicate pipeline recommendations are deduplicated, retaining the entry with the highest priority.
- AC9: Recommendations are sorted in ascending priority order: `high` before `medium` before `low`.
- AC10: A valid `analysis.json` file is written to `<rootDir>/.specguard/analysis.json` containing `generatedAt`, `recommendations`, and `summary` fields.
- AC11: If any individual sub-pipeline throws, the error is logged to `result.messages` and analysis continues with the remaining sub-pipelines.
- AC12: When recommendations exist, `result.exitCode` equals `4` (`ExitCode.MissingSpecs`).

## Scenarios

### Scenario 1: Healthy workspace — no recommendations

**Steps:**
1. Configure a `SpecGuardConfig` with one app entry and a writable `rootDir`.
2. Mock `runStatus`, `runDrift`, `runCodeQuality`, `runDepCheck`, and `runGapAnalysis` to all return success exit codes with zero failing/missing items.
3. Call `runAnalyze(config, {})`.

**Expected Results:**
- `result.exitCode` equals `0`.
- `result.items` is an empty array.
- `result.analysisReport.recommendations` is an empty array.
- `result.messages` contains a line matching `[analyze] workspace looks healthy — no recommendations`.
- `.specguard/analysis.json` exists and parses to an object with `recommendations: []`.

---

### Scenario 2: Missing specs trigger reverse recommendation

**Steps:**
1. Configure a `SpecGuardConfig` with one app entry.
2. Mock `runStatus` to return `exitCode: 4` (`MissingSpecs`) with 3 items that do not include the text `spec exists`.
3. Mock all other sub-pipelines to return success with zero findings.
4. Call `runAnalyze(config, {})`.

**Expected Results:**
- `result.exitCode` equals `4`.
- `result.items` contains exactly one entry with `key === 'reverse'`.
- `result.analysisReport.recommendations[0].pipeline` equals `'reverse'`.
- `result.analysisReport.recommendations[0].priority` equals `'high'`.
- `result.analysisReport.recommendations[0].reason` contains the string `'3'`.
- `result.analysisReport.summary.missingSpecs` equals `3`.

---

### Scenario 3: Drift detected triggers drift and heal recommendations

**Steps:**
1. Configure a `SpecGuardConfig` with one app entry and `missingSpecs` already zero.
2. Mock `runStatus` to return success.
3. Mock `runDrift` to return `exitCode: DriftDetected` with 2 items having `status === 'failed'`.
4. Mock all other sub-pipelines to return success with zero findings.
5. Call `runAnalyze(config, {})`.

**Expected Results:**
- `result.items` contains an entry with `key === 'drift'`.
- `result.items` contains an entry with `key === 'heal'`.
- The `drift` recommendation in `result.analysisReport.recommendations` has `priority === 'high'` and `reason` containing `'2'`.
- The `heal` recommendation has `priority === 'medium'`.
- `result.analysisReport.summary.driftedSpecs` equals `2`.

---

### Scenario 4: Deduplication keeps highest-priority entry

**Steps:**
1. Configure a `SpecGuardConfig` with one app entry.
2. Mock `runGapAnalysis` to return both 1 unimplemented gap (triggering a `high` `gap-analysis` recommendation) and 1 partial gap (triggering a `medium` `gap-analysis` recommendation).
3. Mock all other sub-pipelines to return success with zero findings.
4. Call `runAnalyze(config, {})`.

**Expected Results:**
- `result.analysisReport.recommendations` contains exactly one entry with `pipeline === 'gap-analysis'`.
- That entry has `priority === 'high'`.

---

### Scenario 5: Dependency findings — priority escalation at threshold

**Steps:**
1. Configure a `SpecGuardConfig` with one app entry and `missingSpecs` zero.
2. Mock `runDepCheck` to return `failed: 3`.
3. Mock all other sub-pipelines to return success with zero findings.
4. Call `runAnalyze(config, {})`.

**Expected Results:**
- `result.items` contains an entry with `key === 'deps'`.
- The `deps` recommendation in `result.analysisReport.recommendations` has `priority === 'high'`.
- `result.analysisReport.summary.depFindings` equals `3`.

---

### Scenario 6: Sub-pipeline failure is isolated and logged

**Steps:**
1. Configure a `SpecGuardConfig` with one app entry.
2. Mock `runDrift` to throw `new Error('drift exploded')`.
3. Mock all other sub-pipelines to return success with zero findings.
4. Call `runAnalyze(config, {})`.

**Expected Results:**
- `runAnalyze` resolves without throwing.
- `result.messages` contains a line matching `[analyze] drift check failed: drift exploded`.
- `result.analysisReport.summary.driftedSpecs` equals `0`.

---

### Scenario 7: Analysis report written to disk

**Steps:**
1. Configure a `SpecGuardConfig` with `rootDir` set to a temporary directory.
2. Mock all sub-pipelines to return success with zero findings.
3. Call `runAnalyze(config, {})`.
4. Read and parse `<rootDir>/.specguard/analysis.json`.

**Expected Results:**
- The file exists and is valid JSON.
- The parsed object contains a `generatedAt` field that is a valid ISO 8601 timestamp string.
- The parsed object contains a `summary` field with keys `missingSpecs`, `driftedSpecs`, `qualityFindings`, `depFindings`, and `unimplementedSpecs`.
- The parsed object contains a `recommendations` array.

---

### Scenario 8: Recommendations sorted by priority

**Steps:**
1. Configure a `SpecGuardConfig` with one app entry and `missingSpecs` zero.
2. Mock `runDepCheck` to return `failed: 1` (medium priority).
3. Mock `runCodeQuality` to return `failed: 1` (medium priority).
4. Mock `runDrift` to return `exitCode: DriftDetected` with 1 failed item (high priority).
5. Mock all other sub-pipelines to return success.
6. Call `runAnalyze(config, {})`.

**Expected Results:**
- `result.analysisReport.recommendations[0].priority` equals `'high'`.
- All `'medium'`-priority entries appear after all `'high'`-priority entries in the array.
- No `'low'`-priority entry appears before a `'medium'`-priority entry.

## Security Notes

- No credentials, tokens, or secret values are read or written by this pipeline.
- The `analysis.json` report is written to a local `.specguard/` directory; ensure this directory is excluded from version control if it may contain sensitive path or finding information.
- Sub-pipeline errors are caught and logged as plain messages; stack traces are not surfaced to prevent leaking internal path information.

## Dependencies

- `./status` — `runStatus` for spec coverage checking.
- `./drift` — `runDrift` for stale-spec detection.
- `./code-quality` — `runCodeQuality` for lint and dead-code findings.
- `./dep-check` — `runDepCheck` for vulnerable/unused dependency findings.
- `./gap-analysis` — `runGapAnalysis` for unimplemented/partial spec detection.
- `../core/types` — `SpecGuardConfig`, `PipelineResult`, `PipelineItem`, `emptyResult`.
- `../core/exit-codes` — `ExitCode` enum (`Success = 0`, `MissingSpecs = 4`).
- Node.js built-ins: `node:path`, `node:fs` (for writing `analysis.json`).