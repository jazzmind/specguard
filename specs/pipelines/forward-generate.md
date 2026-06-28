# Forward Generation Pipeline

<!--
  module: src/pipelines/forward-generate.ts
  type: pipeline
  status: draft
-->

## Overview

Reads existing Living Spec Markdown files and generates executable test files from them — the inverse of the reverse pipeline. For each spec, every `### Scenario` becomes one `it()` / test block in the target framework, titled with the scenario name, importing the module under test declared in the spec's `module` metadata. This is the forward half of requirement-to-test traceability: specs drive tests, tests validate code.

Config-driven: the spec's owning app (matched by `specDir`) supplies the default `framework` and the `testOutput` directory. No paths are hard-coded — the caller loads `SpecGuardConfig` and passes it in.

## Acceptance Criteria

- [ ] Reads app config from `SpecGuardConfig` (caller loads it; no config discovery here)
- [ ] `--spec <key|path>` processes exactly one spec; `--all` processes every spec under each app's `specDir`
- [ ] A spec key like `core/spec-parser` is resolved under the matching app's `specDir`; a direct `.md` path is used verbatim
- [ ] Each spec is parsed with `parseSpecContent` and every scenario becomes one `it()` / test block
- [ ] Target framework defaults to the owning app's `framework`, overridable via `--framework` (vitest | playwright | jest)
- [ ] The module under test is taken from the spec's `meta.module` and surfaced to the LLM for the import statement
- [ ] Output path is `<app.testOutput>/<feature>.test.ts` where `feature` is the spec path relative to the app's `specDir` (the area is already encoded in `testOutput`)
- [ ] The spec is mapped back to its owning app by matching the spec file location against each app's resolved `specDir`
- [ ] If the test file exists and `--force` is not set, the spec is skipped with a `[skip]` log line and recorded as `skipped`
- [ ] Otherwise the LLM is called, accidental Markdown code fences are stripped, and the file is written via the writer abstraction (recorded as `created`, `[gen]` log line)
- [ ] An LLM error for one spec records `failed` and continues with the remaining specs
- [ ] Returns a `PipelineResult` with counts, per-item detail, and progress messages (the CLI renders the summary)

## Test Generation Prompt Requirements

The LLM system prompt must instruct the model to:
- Emit a single complete test file in the requested framework
- Create exactly one `it()` / test block per scenario, titled with the scenario name
- Import the module under test from the spec's `module` metadata path
- Translate each scenario's steps and expected results into arrange/act/assert code
- Output ONLY valid test code — no Markdown fences, no prose, no explanation

## Scenarios

### Scenario 1: Generate tests from a single spec via --spec

**Steps:**
1. A spec exists at `<specDir>/spec-parser.md` for app `specguard-core`
2. Call `runForwardGenerate(config, { spec: 'core/spec-parser' })`
3. No test file exists yet at the output path

**Expected Results:**
- The spec is parsed and the LLM is called once
- A test file is written to `tests/core/spec-parser.test.ts`
- Result includes `created: 1`
- Log shows `[gen] specguard-core/spec-parser`

---

### Scenario 2: Generate tests for all specs via --all

**Steps:**
1. Multiple specs exist across apps' `specDir`s
2. Call `runForwardGenerate(config, { all: true })`

**Expected Results:**
- `loadAllSpecs` is used to discover every spec under each app's `specDir`
- One test file is generated per spec
- Result `created` equals the number of specs processed

---

### Scenario 3: Skip an existing test file without --force

**Steps:**
1. A spec exists and the corresponding test file already exists
2. Call `runForwardGenerate(config, { spec: '<key>' })` with `force` unset

**Expected Results:**
- The LLM is NOT called
- No file is written
- Result includes `skipped: 1`
- Log shows `[skip] <app>/<feature> — test already exists`

---

### Scenario 4: Overwrite an existing test file with --force

**Steps:**
1. A spec and its test file already exist
2. Call `runForwardGenerate(config, { spec: '<key>', force: true })`

**Expected Results:**
- The LLM is called
- The existing test file is overwritten
- Result includes `created: 1`

---

### Scenario 5: Framework override

**Steps:**
1. The owning app's `framework` is `vitest`
2. Call `runForwardGenerate(config, { spec: '<key>', framework: 'playwright' })`

**Expected Results:**
- The LLM prompt requests `playwright` test code rather than the app default
- The test file is still written to `<testOutput>/<feature>.test.ts`

---

### Scenario 6: Strip accidental Markdown fences from LLM output

**Steps:**
1. The LLM returns its test code wrapped in a ```ts fenced block

**Expected Results:**
- The leading and trailing fence lines are removed before writing
- The written file starts with the actual test code (e.g. `import`), not a backtick fence

---

### Scenario 7: LLM call fails for one spec

**Steps:**
1. The LLM adapter throws for one spec while others succeed

**Expected Results:**
- That spec is recorded as `failed: 1` with the error message
- The pipeline continues with the remaining specs
- Exit is non-zero only if every attempted spec failed

## Dependencies

- `specs/core/spec-parser.md` — `parseSpecContent`, `loadAllSpecs`
- `specs/core/llm.md` — LLM adapter (`llmGenerateText`)
- `specs/core/config.md` — `AppConfig` (`framework`, `specDir`, `testOutput`)
- `specs/core/writer.md` — file output
- `specs/pipelines/reverse-generate.md` — inverse pipeline; shares the feature-naming convention
