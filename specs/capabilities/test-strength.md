---
id: test-strength
kind: capability
title: Test Strength
parent: system
value: A claim counts as tested only when a real test that can fail is tagged to it, so skipped, gated or empty tests and weakened assertions are caught before they pass for proof.
status: active
sources:
  - "src/core/test-strength.ts"
  - "src/core/test-assertions.ts"
  - "src/core/source-scan.ts"
  - "src/core/weakening.ts"
  - "src/core/diff-lines.ts"
docs: []
history:
  - 2026-10-26-test-strength-is-a-static-reading-of-tes
tests:
  - "tests/core/test-strength.test.ts"
  - "tests/core/weakening.test.ts"
  - "tests/core/diff-lines.test.ts"
  - "tests/core/test-declarations.test.ts"
---

# Test Strength

## Problem & Value
A passing test is only evidence if it could have failed. A coding agent that must get a claim to "proven" has cheap ways to get there without proving anything: skip the failing test, gate it behind an environment variable nobody sets, delete its assertions, replace an exact comparison with a check that something exists, or regenerate a snapshot. Every one of these keeps the test run green and the ledger happy.

Test strength reads test source, with no run and no model, and says for each test whether it is strong, weak, skipped or conditional, and why. It rolls that up per claim and per required layer, so "tested" means a strong test at each layer the spec demands. It also compares two versions of a project and reports the changes that make proof weaker: removed or untagged tests, newly skipped or gated tests, fewer or looser assertions, relaxed spec policy, lowered config thresholds, and test-environment branches in source. The reader is a static heuristic over well-known assertion APIs, and it says "unknown" instead of guessing when it cannot read a test.

## Users & Journeys
- A developer runs the checks and sees that the claim "the fee is waived over 50" has one tagged test and it is `weak: existence-only`, with the line of the assertion that proves too little.
- A reviewer of an agent's pull request sees `skip-added` and `assertions-removed` findings next to a change that made a red test green.
- A team whose CI never sets `RUN_REGRESSION` lists that gate in `testStrength.conditional`, and tests behind it stop counting as proof.
- A tech lead requires `e2e` for the checkout capability, and a claim with a strong unit test and a weak e2e test is reported as not meaningfully tested at `e2e`.
- A reviewer sees that an agent lowered `mutation.minScore` or dropped a required layer from a spec's frontmatter, neither of which changes any approved claim text.

## Requirements
- [ ] A test is classed `skipped` when its source marks it so: JavaScript `it.skip`, `xit`, `it.todo`, `test.fixme`, an enclosing `describe.skip`, a first-statement `test.skip()`, or a `.only` elsewhere in the file; Python `skip`/`xfail` decorators or `pytestmark`; Go `t.Skip` as the first statement; Rust `#[ignore]`; Java and Kotlin `@Disabled`, `@Ignore` or `@Test(enabled = false)` on the method or class <!-- claim: skip-detected -->
- [ ] A test is classed `conditional` when it runs only under a condition: `skipIf`/`runIf`, a skip call inside the test, `skipif` decorators, `testing.Short()`, a Go build tag, Rust `#[cfg(...)]`, JUnit `@EnabledIf*`/`@DisabledIf*` or an `assume*` call, or a match of a regex in `testStrength.conditional` or the app's `test.conditional`; an invalid regex is rejected with an error <!-- claim: conditional-gates -->
- [ ] A test with no assertion, or only trivial assertions such as `expect(true).toBe(true)` or `assert x == x`, is `weak`, and commented-out or quoted assertions are not counted <!-- claim: no-assertion-weak -->
- [ ] A test whose assertions only check that something exists, that nothing throws, or that an error occurred is `weak` with the reason `existence-only`, `no-throw-only` or `error-check-only`, and a test with at least one comparison, structural or exact assertion is `strong` <!-- claim: weak-assertions -->
- [ ] A test whose only assertions are snapshots is `weak` with the reason `snapshot-only` unless `testStrength.snapshotIsWeak` is false <!-- claim: snapshot-weak -->
- [ ] A call to a same-file helper that asserts counts with the helper's strength to a depth of three, a call to a convention-named helper such as `expectValidUser` counts as strength 2, a name in `testStrength.assertHelpers` counts as strength 3, and any other imported call counts for nothing <!-- claim: helper-assertions -->
- [ ] A claim is meaningfully tested when, for each required layer except `functional`, at least one tagged test at that layer is strong, or when no layer is required and at least one tagged test is strong, and otherwise the result lists why: no tagged tests, all skipped, conditional only, weak only, a named layer not meaningful, or strength unknown <!-- claim: claim-layer-rule -->
- [ ] Comparing two versions of a test file reports an error for a tagged test removed or untagged while its claim is live, a test newly skipped or gated, a focused test added, a strong test turned weak, and fewer or looser assertions, and reports a warning for added wildcard matchers or a removed test whose tags moved to an added test <!-- claim: weakening-tests -->
- [ ] Comparing two versions of a spec or config reports an error when a claim loses a required layer, its assurance is lowered, its evidence moves to a manual or agentic verifier or changes verifier, an example row is deleted while the claim text is unchanged, a `proof.require*` flag is turned off, a threshold is lowered, or testability allow or waive lists, test-strength helpers or gates are loosened <!-- claim: weakening-policy -->
- [ ] A diff is scanned for added lines in non-test source that branch on the test environment, added mutation-testing exclusions anywhere, and rewritten snapshot files, each reported as a warning <!-- claim: weakening-source -->
- [ ] A unified diff is parsed into changed files with their status, added and removed line numbers and added text, handling renames, binary files, `/dev/null` paths, quoted paths, omitted hunk counts, CRLF and no-newline markers <!-- claim: diff-parser -->
- [ ] Test declarations include `xit`, `xtest`, `fit`, `ftest` and `it.skipIf(...)` tests, jqwik `@Property` and `@Example`, Rust tests with attributes between `#[test]` and `fn`, and expose JVM annotation names, annotation arguments and the method name <!-- claim: declarations-markers -->

## Scenarios
### Scenario 1: An agent skips a failing test
**Steps:**
1. A claim has one strong tagged test, and the test fails after a change.
2. The agent changes `it(` to `it.skip(` and the run goes green.
3. Someone compares the old and new test file.

**Expected Results:**
- The new test is classed `skipped` with the reason `skip-static`.
- The comparison reports `skip-added` as an error naming the test and its claim.
- The claim is no longer meaningfully tested: the reason is `ALL_SKIPPED`.

### Scenario 2: A strong unit test hides a weak e2e test
**Steps:**
1. The spec requires the `unit` and `e2e` layers for a claim.
2. The claim has a strong unit test and an e2e test that only checks a page loads.

**Expected Results:**
- The claim is not meaningfully tested.
- The result lists `LAYER_NOT_MEANINGFUL` for `e2e` and none for `unit`.

### Scenario 3: A test the reader cannot understand
**Steps:**
1. A claim is tagged by a test in a language the reader does not support, or in a file with unbalanced braces.

**Expected Results:**
- The test is classed `unknown` with the reason `unsupported-language` or `unparsable-body`.
- The claim's result is `unknown`, not meaningful and not weak.

## Security & Data Considerations
All analysis is local, static and deterministic: source text is read, never executed, and no model is called. The test-environment and mutation-exclusion scans only report added lines of a diff the caller supplies. Findings quote at most 120 characters of an assertion.

## Interfaces
- `analyzeTestFile(source, file, config)` returns one `TestStrength` per test with its class, reasons, assertion sites, claim tags and body lines; `applyResultStatus` marks a test skipped when a run reported it skipped; `claimStrength(ref, tests, requiredLayers)` rolls tests up to a claim.
- `diffTestFile`, `diffSpecPolicy`, `diffConfigPolicy`, `scanAddedSource` and `snapshotRewrites` return `WeakeningFinding` lists with `kind`, `severity`, the affected claim refs and a message.
- `parseUnifiedDiff(text)` returns `ChangedFile` entries.
- Config: a top-level `testStrength` block with `conditional` (regex sources), `assertHelpers` (names, prefix wildcard allowed) and `snapshotIsWeak` (default true); an app's `test.conditional` adds gate regexes for that app's files.

## Out of Scope
- Running tests, mutation testing and coverage; those are separate evidence.
- Following imports to judge helpers defined in other files; helpers are trusted by convention or configuration.
- Deciding what to do with findings (exit codes, the proof statement, the change protocol).
