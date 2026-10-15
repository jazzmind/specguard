# Self-Healing Test Pipeline

<!--
  module: src/pipelines/heal.ts
  type: pipeline
  status: draft
-->

## Overview

Runs the project's test suite, and for each failing test asks the LLM to attribute the failure: is the **test** wrong (stale assertion, drifted selector, bad setup) or is the **application** wrong (a real bug the test correctly caught)? When the test is at fault, the pipeline rewrites the test code, re-runs the suite, and repeats up to `maxRetries`. When the application is at fault, it reports the bug and **never touches application source code**. The result is a heal report counting fixed, still-broken, and app-bug tests, with exit code 7 (`HealFailed`) when any test remains broken after retries.

Heal runs every distinct test job: one per app `test` block (`command`, `cwd`, `reporter`, `resultsFile`, `timeoutMs`), and for apps without one the shared `config.heal.testCommand` (default: the language profile's command) at the config root, once. Each job runs through a test-runner adapter (`src/adapters/test-runners.ts`) that reads the reporter's OUTPUT FILE. Output that cannot be parsed is a failure, never a pass. The retry budget comes from `config.heal.maxRetries`, overridable per invocation. The raw invocation is isolated behind an exported `healRunner` seam so it can be mocked in hermetic unit tests.

## Acceptance Criteria

- [ ] Resolves `maxRetries` from `opts.maxRetries ?? config.heal.maxRetries ?? 2`
- [ ] Runs one job per app with a `test` block and one shared job for the apps without one, using `config.heal.testCommand` or the language profile's command; identical (command, cwd) jobs run once <!-- claim: per-app-jobs -->
- [ ] The reporter flags come from the app's test-runner adapter, not from a blanket ` -- --reporter=json` suffix; a configured `resultsFile` means the command runs verbatim <!-- claim: adapter-flags -->
- [ ] Failing tests (file, name, message) are read from the reporter output file through the adapter, without throwing on a non-zero exit <!-- claim: failures-from-file -->
- [ ] A missing or unparseable results file is a FAILURE (exit 7) even when the runner exited zero; `--lenient` restores the old fail-open behaviour <!-- claim: unparseable-is-failure -->
- [ ] `--spec <key>` runs only the app that owns the spec, and only that spec's tests <!-- claim: spec-flag -->
- [ ] `--all` runs every app (the default), `--app <name>` runs one <!-- claim: all-flag -->
- [ ] `--classify-only` classifies every failure and reports it but never writes a test file and never re-runs <!-- claim: classify-only -->
- [ ] A failing test is matched to its spec through the language profile's `featureExtRegex`, not a TypeScript-only pattern <!-- claim: profile-feature-regex -->
- [ ] When there are no failing tests, returns a clean result (`exitCode 0`, message "all tests passing") and makes no LLM calls
- [ ] For each failing test file, reads the test source and (best-effort) the corresponding spec, then asks the LLM to classify the failure as `test-bug` or `app-bug` with a reason
- [ ] `test-bug`: writes the LLM's `fixedTestCode` via the writer abstraction, then re-runs the suite; the run -> classify -> rewrite loop repeats up to `maxRetries` total re-runs
- [ ] `app-bug`: recorded as a `failed` `PipelineItem` whose message is the LLM's reason; no application source is modified
- [ ] Produces a heal report with counts of fixed / still-broken / app-bugs pushed as readable lines into `result.messages`
- [ ] Sets `result.exitCode = ExitCode.HealFailed` (7) if any tests remain broken after retries, including app-bugs (the suite is still red)
- [ ] All LLM access routes through `src/core/llm.ts`; all file I/O routes through `src/core/reader.ts` / `writer.ts`; the only direct process spawn is inside the `healRunner` seam

## Test-runner results (legacy note)

The sections below describe the Vitest/Jest JSON document. It is now read from a reporter output file by the adapter; the shape is unchanged.

## Test-runner JSON parsing

The adapter invokes the test command with vitest's JSON reporter and an output
file (`--reporter=json --outputFile=<file>`). Vitest writes a Jest-compatible JSON
document to that file:

```jsonc
{
  "numFailedTests": 1,
  "success": false,
  "testResults": [
    {
      "name": "/abs/path/to/foo.test.ts",
      "assertionResults": [
        { "status": "passed", "title": "does a thing", "failureMessages": [] },
        { "status": "failed", "title": "does another", "failureMessages": ["expected 1 to be 2"] }
      ]
    }
  ]
}
```

Parsing rules:
- The document is read from the results file. The legacy stdout parser (`parseVitestJson`) remains exported and tolerates noise around the object.
- A failing test = an `assertionResults` entry with `status === 'failed'`.
  Its file is `testResults[].name`, name is `title` (or `fullName`), message
  is the joined `failureMessages`.
- If no JSON object can be located/parsed, parsing yields `null` and the
  pipeline records a "could not parse test output" message rather than throwing.

## Scenarios

### Scenario 1: All tests pass on the first run

**Steps:**
1. `healRunner.runTests` returns JSON with `numFailedTests: 0` and exit code 0
2. Call `runHeal(config, {})`

**Expected Results:**
- The LLM is never called
- `result.exitCode` is 0
- `result.messages` includes "all tests passing"
- `fixed`, `still-broken`, and `app-bugs` counts are all 0

---

### Scenario 2: A failing test is a test bug and the rewrite fixes it

**Steps:**
1. First `runTests` returns one failing test in `foo.test.ts`
2. LLM classifies it `test-bug` and returns `fixedTestCode`
3. Second `runTests` returns no failures

**Expected Results:**
- `fixedTestCode` is written to the test file via the writer
- The suite is re-run after the rewrite
- The test is counted under `fixed` (1)
- `result.exitCode` is 0

---

### Scenario 3: A failing test is an application bug

**Steps:**
1. `runTests` returns one failing test
2. LLM classifies it `app-bug` with a reason

**Expected Results:**
- No test file is rewritten
- No application source is modified
- The test is recorded as a `failed` PipelineItem with the reason as its message
- The test is counted under `app-bugs`
- `result.exitCode` is 7 (suite still red)

---

### Scenario 4: A test stays broken after maxRetries

**Steps:**
1. Every `runTests` keeps returning the same failing test
2. LLM keeps classifying `test-bug` and returning a rewrite
3. `maxRetries` is reached

**Expected Results:**
- The rewrite loop stops after `maxRetries` re-runs
- The test is counted under `still-broken`
- `result.exitCode` is 7

---

### Scenario 5: Malformed JSON from the runner

**Steps:**
1. `runTests` returns non-JSON garbage on stdout with a non-zero exit code
2. Call `runHeal(config, {})`

**Expected Results:**
- The pipeline does not throw
- `result.messages` includes a "could not parse test output" line
- `result.exitCode` is 7, and stays 7 when the runner exited zero (unparseable output is never a pass)

## Security Notes

- Test source files and failure messages are sent to the LLM provider for
  classification. These may contain fixtures with secret-like values; the
  classification prompt instructs the model not to echo raw secrets into its
  reason.
- The pipeline must never modify application (non-test) source files. Only the
  failing test file identified in the JSON output may be overwritten, and only
  with the LLM's `fixedTestCode`.

## Dependencies

- `specs/core/spec-parser.md` — mapping a test file to its spec for context
- `specs/core/llm.md` — `llmGenerateObject` for structured classification
- `specs/core/reader.md` / `specs/core/writer.md` — test file I/O
- `specs/core/exit-codes.md` — `HealFailed` (7)
