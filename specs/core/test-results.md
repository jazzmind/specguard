# Test results

<!--
  module: src/core/test-results.ts
  type: core
  status: draft
-->

## Overview

Normalizes test-runner reporter output into one shape, `TestCaseResult`, that covers every test (pass, fail, and skip), not only failures. Parsers read Vitest and Jest JSON, Playwright JSON, JUnit XML (which also covers pytest `--junitxml`, `go-junit-report`, and Maven Surefire), pytest-json-report, `go test -json`, and `cargo test` JSON events. `aggregateClaims` folds results into one verdict per claim using the claim tags from `src/core/claim-tags.ts`.

## Acceptance Criteria

- [ ] `detectResultFormat` recognises each supported format from its content and returns null for anything else <!-- claim: detect-format -->
- [ ] The Vitest/Jest parser returns passed, failed, and skipped tests with file, title, full title, and duration <!-- claim: parse-vitest -->
- [ ] The Playwright parser walks nested suites, reads spec tags, annotations, and project names, and maps `unexpected` to fail and `skipped` to skip <!-- claim: parse-playwright -->
- [ ] The JUnit parser reads `testsuite`/`testcase` elements, failure/error/skipped children, and `property` elements named `claim`, `tag`, or `externalId` <!-- claim: parse-junit -->
- [ ] The pytest-json-report parser maps `failed` and `error` outcomes to fail and `skipped`/`xfailed` to skip <!-- claim: parse-pytest -->
- [ ] The Go and Cargo JSON-line parsers produce one result per test <!-- claim: parse-go-cargo -->
- [ ] A result carries `claims` from tags in its title, tags, and annotations, and `externalIds` from `@ext:`/`@id:` tags and annotations <!-- claim: result-tags -->
- [ ] `aggregateClaims` marks a claim failed when any tagged test fails, proven when at least one passes and none fail, and unexercised otherwise <!-- claim: aggregate-rule -->
- [ ] `exercised` counts passing tests and `counterexamples` counts failing tests, and failing test titles are returned as counterexamples <!-- claim: aggregate-counts -->
- [ ] Unparseable input throws a `ResultParseError` naming the format and never returns an empty list silently <!-- claim: parse-error -->

## Scenarios

### Scenario 1: One failing test fails the claim

**Steps:**
1. Aggregate three tests tagged with the same claim, two passing and one failing

**Expected Results:**
- The verdict is `failed`
- `exercised` is 2 and `counterexamples` is 1
