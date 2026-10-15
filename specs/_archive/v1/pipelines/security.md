# Security Pipeline

<!--
  module: src/pipelines/security.ts
  type: pipeline
  status: draft
-->

## Overview

Generates OWASP-annotated security test stubs from a spec's `## Security Notes` section and its source module, and optionally runs a Semgrep SAST scan over the source tree. For each spec, the pipeline reads the security constraints the module must enforce, reads the referenced source file, and asks the LLM to emit vitest security test stubs — each test commented with the relevant OWASP Top 10 category. This is the security half of requirement-to-test traceability: documented security constraints drive executable security tests.

Config-driven: the spec's owning app (matched by `specDir`) supplies the test framework and the source repo. Security tests are always written under `tests/security/<feature>.test.ts` resolved against `config.rootDir`. The optional `--with-sast` step shells out to Semgrep via Docker behind a mockable seam, and feeds any real findings back into the LLM prompt so the generated stubs target concrete issues.

## Acceptance Criteria

- [ ] Reads app config from `SpecGuardConfig` (caller loads it; no config discovery here)
- [ ] `--spec <key|path>` processes exactly one spec; `--all` processes every spec under each app's `specDir`
- [ ] A spec key like `core/spec-parser` is resolved under the matching app's `specDir`; a direct `.md` path is used verbatim
- [ ] Each spec is parsed and its `## Security Notes` section is extracted via `extractSection`
- [ ] The source module named in the spec's `meta.module` is read best-effort; if missing or unreadable it is noted in the prompt rather than failing
- [ ] The LLM is asked to emit OWASP-annotated vitest security test stubs — each test prefixed with a `// OWASP A0X: <category>` comment
- [ ] The prompt instructs the model to output ONLY valid test code (vitest) with no Markdown fences; accidental fences are stripped from the output
- [ ] Output path is `tests/security/<feature>.test.ts` (resolved against `config.rootDir`); `feature` is the spec path relative to the owning app's `specDir`, `.md` dropped
- [ ] An existing security test file is NOT overwritten — the spec is recorded as `skipped` with a `[skip]` log line
- [ ] `--with-sast` runs Semgrep via the exported `sast.run` seam over the owning app's repo; the seam never throws if Docker/Semgrep is unavailable — it logs a `[warn]` and returns no findings
- [ ] When SAST returns real findings, a compact summary is fed into the LLM prompt and the findings are included in the result messages
- [ ] `result.exitCode` is `ExitCode.SecurityIssues` (5) only when `--with-sast` produced real findings; generating stubs alone is exit 0
- [ ] An LLM error for one spec records `failed` and continues with the remaining specs
- [ ] Returns a `PipelineResult` with counts, per-item detail, and progress messages (the CLI renders the summary)
- [ ] Routes all LLM access through `core/llm.ts` and all file I/O through `core/reader.ts` / `core/writer.ts`

## Security Test Prompt Requirements

The LLM system prompt must instruct the model to:
- Emit a single complete vitest test file of security test stubs
- Annotate each test with the relevant OWASP Top 10 category as a leading comment (e.g. `// OWASP A01: Broken Access Control`)
- Derive tests from the spec's Security Notes and the source module's surface area
- Target any provided SAST findings with concrete regression tests
- Output ONLY valid test code — no Markdown fences, no prose, no explanation

## Scenarios

### Scenario 1: Generate security stubs from a single spec via --spec

**Steps:**
1. A spec with a `## Security Notes` section exists for an app
2. No security test file exists yet at the output path
3. Call `runSecurity(config, { spec: 'core/llm' })`

**Expected Results:**
- The spec is parsed, Security Notes extracted, and the LLM called once
- A test file is written to `tests/security/llm.test.ts`
- The file retains the OWASP annotation comments from the model output
- Result includes `created: 1` and `exitCode: 0`
- Log shows `[gen] <app>/llm`

---

### Scenario 2: Generate security stubs for all specs via --all

**Steps:**
1. Multiple specs exist across apps' `specDir`s
2. Call `runSecurity(config, { all: true })`

**Expected Results:**
- `loadAllSpecs` discovers every spec under each app's `specDir`
- One security test file is generated per spec
- Result `created` equals the number of specs processed

---

### Scenario 3: Skip an existing security test file

**Steps:**
1. A spec exists and the corresponding security test file already exists
2. Call `runSecurity(config, { spec: '<key>' })`

**Expected Results:**
- The LLM is NOT called
- The existing file is not overwritten
- Result includes `skipped: 1` and a `[skip]` log line

---

### Scenario 4: Strip accidental Markdown fences from LLM output

**Steps:**
1. The LLM returns its test code wrapped in a ```ts fenced block

**Expected Results:**
- The leading and trailing fence lines are removed before writing
- The written file starts with the actual test code, not a backtick fence

---

### Scenario 5: --with-sast surfaces real findings

**Steps:**
1. The `sast.run` seam returns findings (`ok: true`, non-empty `findings`)
2. Call `runSecurity(config, { spec: '<key>', withSast: true })`

**Expected Results:**
- A compact summary of the findings is included in the LLM prompt
- The findings appear in the result messages
- `result.exitCode` is `ExitCode.SecurityIssues` (5)

---

### Scenario 6: --with-sast when Semgrep/Docker is unavailable

**Steps:**
1. The `sast.run` seam returns `ok: false` with no findings (tool unavailable)
2. Call `runSecurity(config, { spec: '<key>', withSast: true })`

**Expected Results:**
- No exception is thrown
- Stubs are still generated (`created: 1`)
- `result.exitCode` is `0` (no real findings)

---

### Scenario 7: LLM call fails for one spec

**Steps:**
1. The LLM adapter throws for one spec while others succeed

**Expected Results:**
- That spec is recorded as `failed` with the error message
- The pipeline continues with the remaining specs

## Security Notes

- The SAST seam shells out to `docker run` via `node:child_process` spawnSync; it must never throw on a missing Docker/Semgrep binary — failures are caught, logged as `[warn]`, and treated as zero findings so the pipeline degrades gracefully.
- Generated artifacts are test stubs only; this pipeline never executes the target application's code.
- LLM access is routed through `core/llm.ts`, which guarantees the API key value is never logged.

## Dependencies

- `specs/core/spec-parser.md` — `parseSpecContent`, `loadAllSpecs`, `extractSection`
- `specs/core/llm.md` — LLM adapter (`llmGenerateText`)
- `specs/core/config.md` — `AppConfig` (`specDir`, `repo`, `framework`)
- `specs/core/reader.md` / `specs/core/writer.md` — file I/O
- `specs/adapters/semgrep.md` — Semgrep SAST adapter (Docker invocation)
- `specs/pipelines/forward-generate.md` — shares the spec→app→feature-naming convention
