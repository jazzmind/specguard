# Test runner adapters

<!--
  module: src/adapters/test-runners.ts
  type: adapter
  status: draft
-->

## Overview

A test-runner adapter runs a project's tests and returns every result, read from the runner's reporter OUTPUT FILE rather than scraped from stdout. Adapters are separate from the language profile: the profile says what a language usually uses, the adapter says how to run and read one runner. Built in: `vitest`, `jest`, `playwright`, `pytest` (JUnit XML), `junit` (any JUnit-producing runner, Maven Surefire included), `go` (`go test -json`), and `cargo`. Per-app config is `test: { command, cwd, reporter, resultsFile, timeoutMs, image }`.

## Acceptance Criteria

- [ ] `run({ cwd, selection?, timeoutMs, sandbox })` returns `{ tests[], exitCode, raw, parsed }` where `tests` are normalized `TestCaseResult` rows for every test <!-- claim: run-report -->
- [ ] The Vitest and Jest adapters add `--reporter=json --outputFile=<file>` (Vitest) and `--json --outputFile=<file>` (Jest); Playwright sets `PLAYWRIGHT_JSON_OUTPUT_NAME` and `--reporter=json`; pytest adds `--junitxml=<file>`; Go and Cargo redirect their JSON stream to the file <!-- claim: reporter-flags -->
- [ ] For an npm script command (`npm test`, `npm run <script>`) a single ` -- ` is inserted before the reporter flags, and none is inserted for other commands <!-- claim: npm-separator -->
- [ ] When `test.resultsFile` is set the command runs verbatim, with no flags injected, and the file (or glob) is read after the run <!-- claim: verbatim-with-results-file -->
- [ ] A missing or unparseable results file gives `parsed: false` and no tests; stdout is never parsed as a fallback <!-- claim: no-stdout-scrape -->
- [ ] `selection` is passed to the runner as file arguments for Vitest, Jest, Playwright and pytest, and as package directories for Go <!-- claim: selection-args -->
- [ ] A command that exceeds `timeoutMs` is killed and reported with `timedOut: true` and a non-zero exit code <!-- claim: timeout -->
- [ ] `sandbox: 'docker'` (from `runners.testRunner: "docker"`) runs the command in the configured image with the repo mounted, and fails with a clear message when Docker is unavailable or no image is set, never falling back to the host <!-- claim: docker-sandbox -->
- [ ] A results glob matching several files merges all of them <!-- claim: results-glob -->

## Scenarios

### Scenario 1: Vitest run

**Steps:**
1. App `test` is `{ "command": "npx vitest run" }`
2. Call `run`

**Expected Results:**
- The command executed is `npx vitest run --reporter=json --outputFile=<run dir>/results.json`
- Every test in the file is returned with its status
