# Gap Analysis Pipeline

<!-- module: specguard-pipelines/gap-analysis / type: pipeline / status: draft -->

## Overview

The Gap Analysis pipeline scans every Living Specification found in each configured app's `specDir` and determines whether a corresponding source module exists in the app's repository. Specs with no matching source files are classified as `unimplemented`; specs whose acceptance criteria contain one or more unchecked `- [ ]` items are classified as `partial`; all others are `implemented`. For each `unimplemented` spec, the pipeline optionally invokes an LLM to generate a structured implementation plan written to `.specguard/plans/<feature>.md`. A machine-readable summary of all gaps is persisted to `.specguard/gaps.json` after every run. When at least one gap exists, the pipeline also writes an agent-readable summary plan to `.specguard/plans/gap-analysis-<timestamp>.md` via `writePlan`, which lists all unimplemented and partial specs with fix steps for the coding agent. The pipeline exits with a non-success code whenever at least one gap (unimplemented or partial) is found.

## Acceptance Criteria

- [ ] Each spec in every app's `specDir` is evaluated for gap status (`unimplemented`, `partial`, or `implemented`).
- [ ] A spec is `unimplemented` when no source file path resolves to a matching feature key.
- [ ] A spec is `partial` when a matching source file exists but one or more `- [ ]` items remain in its acceptance criteria.
- [ ] A spec is `implemented` when a matching source file exists and no unchecked criteria remain; it is excluded from the gaps list.
- [ ] Implementation plans are generated via LLM only for `unimplemented` specs (not `partial`).
- [ ] Each generated plan is written to `.specguard/plans/<feature>.md` using the kebab-cased spec key.
- [ ] The plan Markdown contains: title, summary, suggested files (≤12), implementation steps (≤10), and testing approach.
- [ ] `.specguard/gaps.json` is written after every run containing `generatedAt` and the `gaps` array.
- [ ] When at least one gap exists (unimplemented or partial), a summary plan file is written to `.specguard/plans/gap-analysis-<timestamp>.md` via `writePlan`, listing all gaps and ordered fix steps for the coding agent.
- [ ] When `--spec <key>` is provided, only the matching spec is evaluated.
- [ ] When `plan: false` is set, no LLM calls are made and no plan files are written.
- [ ] The pipeline exit code is non-success (`ExitCode.MissingSpecs`) when `result.failed > 0`.
- [ ] The pipeline exit code is success (`ExitCode.Success`) when no gaps are found.
- [ ] Source files under the `tests` group are excluded from the implemented-features set.

## Scenarios

### Scenario 1: Spec with no matching source is flagged as unimplemented

**Steps:**
1. Configure an app with a `specDir` containing one spec file whose spec key does not match any file path resolved from the app's non-test source globs.
2. Run `runGapAnalysis(config, { plan: false })`.
3. Inspect the returned `GapAnalysisResult`.

**Expected Results:**
- `result.gaps` contains exactly one entry with `status: 'unimplemented'`.
- The gap entry includes the correct `specKey`, `title`, `appName`, `uncheckedCriteria`, and `totalCriteria`.
- `result.failed` equals `1`.
- `result.exitCode` equals `ExitCode.MissingSpecs`.
- `result.items` contains one entry with `status: 'failed'`.

---

### Scenario 2: Spec with matching source but unchecked criteria is flagged as partial

**Steps:**
1. Configure an app whose source globs resolve to a file whose feature key matches a spec key.
2. Ensure the spec's acceptance criteria section contains at least one `- [ ]` line.
3. Run `runGapAnalysis(config, { plan: false })`.
4. Inspect the returned `GapAnalysisResult`.

**Expected Results:**
- `result.gaps` contains exactly one entry with `status: 'partial'`.
- `gap.uncheckedCriteria` equals the number of `- [ ]` lines present in the spec.
- `result.items` contains one entry with `status: 'skipped'` and a message referencing the unchecked count.
- No plan file is written to `.specguard/plans/`.
- `result.exitCode` equals `ExitCode.MissingSpecs`.

---

### Scenario 3: Fully implemented spec is excluded from gaps

**Steps:**
1. Configure an app whose source globs resolve to a file matching a spec key.
2. Ensure the spec's acceptance criteria contain only `- [x]` items (none unchecked).
3. Run `runGapAnalysis(config, { plan: false })`.
4. Inspect the returned `GapAnalysisResult`.

**Expected Results:**
- `result.gaps` is an empty array.
- `result.failed` equals `0`.
- `result.exitCode` equals `ExitCode.Success`.
- A log message matching `[gap] <appName>/<specKey>: implemented` is present in `result.messages`.

---

### Scenario 4: LLM implementation plan is generated and written for an unimplemented spec

**Steps:**
1. Configure an app with one unimplemented spec (no matching source file).
2. Mock `llmGenerateObject` to return a valid `ImplementationPlanSchema` object with `title`, `summary`, `suggestedFiles` (≤12 items), `implementationSteps` (≤10 items), and `testingApproach`.
3. Run `runGapAnalysis(config, { plan: true })`.
4. Check the filesystem for the plan file at `.specguard/plans/<spec-key-kebab>.md`.
5. Inspect the returned `GapAnalysisResult`.

**Expected Results:**
- The plan file exists at the expected path.
- The plan file begins with `# Implementation Plan:` followed by the LLM-returned title.
- The plan file contains sections `## Summary`, `## Suggested Files`, `## Implementation Steps`, and `## Testing Approach`.
- `gap.planPath` equals the absolute path of the written plan file.
- `result.created` equals `1`.
- A log message containing `plan written to` is present in `result.messages`.

---

### Scenario 5: LLM failure during plan generation is handled gracefully

**Steps:**
1. Configure an app with one unimplemented spec.
2. Mock `llmGenerateObject` to throw an `Error` with a descriptive message.
3. Run `runGapAnalysis(config, { plan: true })`.
4. Inspect the returned `GapAnalysisResult`.

**Expected Results:**
- `result.gaps` still contains the gap entry for the unimplemented spec.
- `gap.planPath` is `undefined`.
- A log message matching `plan generation failed for` and including the error message is present in `result.messages`.
- `result.created` equals `0`.
- The pipeline does not throw; it returns a result normally.

---

### Scenario 6: Single-spec filter restricts evaluation to one spec

**Steps:**
1. Configure an app with two spec files in `specDir`, both unimplemented.
2. Run `runGapAnalysis(config, { plan: false, spec: '<appName>/<specKey1>' })`.
3. Inspect the returned `GapAnalysisResult`.

**Expected Results:**
- `result.gaps` contains exactly one entry matching `specKey1`.
- The second spec is not present in `result.gaps`.
- `result.failed` equals `1`.

---

### Scenario 7: gaps.json is written after every run

**Steps:**
1. Configure an app with one unimplemented spec.
2. Run `runGapAnalysis(config, { plan: false })`.
3. Read `.specguard/gaps.json` from the filesystem.
4. Parse the JSON content.

**Expected Results:**
- The file exists at `.specguard/gaps.json` relative to `config.rootDir`.
- The parsed object contains a `generatedAt` ISO timestamp string.
- The parsed object contains a `gaps` array with one entry matching the unimplemented spec.

---

### Scenario 8: Test source files are excluded from implemented-features resolution

**Steps:**
1. Configure an app where the only source file matching a spec key is listed under the `tests` source group.
2. Run `runGapAnalysis(config, { plan: false })`.
3. Inspect the returned `GapAnalysisResult`.

**Expected Results:**
- `result.gaps` contains one entry with `status: 'unimplemented'` for that spec.
- The test file path is not used to mark the spec as implemented.

---

### Scenario 9: App with no spec files is silently skipped

**Steps:**
1. Configure an app whose `specDir` does not exist or contains no spec files.
2. Run `runGapAnalysis(config, { plan: false })`.
3. Inspect the returned `GapAnalysisResult`.

**Expected Results:**
- `result.gaps` is an empty array.
- `result.failed` equals `0`.
- `result.exitCode` equals `ExitCode.Success`.
- No error is thrown.

## Security Notes

- The LLM API key is referenced only via the `apiKeyEnv` environment variable name from config; the raw key value is never logged, stored in plan files, or included in `gaps.json`.
- Plan files written to `.specguard/plans/` are derived solely from spec content; no runtime user input is interpolated into file paths beyond the spec key, which is sanitised by replacing `/` with `-`.
- `gaps.json` contains only spec metadata (keys, titles, status counts) and no credentials or secrets.

## Dependencies

- `src/core/types.ts` — `SpecGuardConfig`, `PipelineResult`, `emptyResult`
- `src/core/exit-codes.ts` — `ExitCode`
- `src/core/spec-parser.ts` — `loadAllSpecs`
- `src/core/reader.ts` — `expandGlobs`, `fileExists`
- `src/core/llm.ts` — `llmGenerateObject`
- `src/core/writer.ts` — `writeFile`
- Node.js built-ins: `node:path`, `node:fs`
- `zod` — runtime schema validation for LLM output (`ImplementationPlanSchema`)