---
title: "Test Strength (developer reference)"
audience: dev
source: "specs/capabilities/test-strength.md"
generated: true
---
<a id="test-strength"></a>
# Test Strength

<a id="purpose"></a>
## Purpose

A passing test is evidence only if it could have failed. Test strength reads test source statically, with no test run and no model, and classifies each test as strong, weak, skipped, conditional or unknown, with reasons. A claim counts as tested only when a real test that can fail is tagged to it.

It rolls results up per claim and per required layer, so "tested" means a strong test at each layer the spec demands. It also compares two versions of a project and reports changes that weaken proof. Examples are removed or untagged tests, newly skipped or gated tests, fewer or looser assertions, relaxed spec policy, lowered config thresholds, and test-environment branches in source.

The reader is a static heuristic over well-known assertion APIs. When it cannot read a test, it says `unknown` rather than guessing.

<a id="responsibilities"></a>
## Responsibilities

- Classify each test (`strong`, `weak`, `skipped`, `conditional`, `unknown`) with reasons, assertion sites, claim tags and body lines.
- Roll tests up to a claim and its required layers, and list why a claim is not meaningfully tested.
- Compare two versions of a test file, spec, or config and report weakening findings.
- Scan a supplied diff for test-environment branches in non-test source, added mutation-testing exclusions, and rewritten snapshot files.
- Parse unified diffs into changed-file records.

Out of scope:

- Running tests, mutation testing and coverage. These are separate evidence.
- Following imports to judge helpers defined in other files. Helpers are trusted by convention or configuration.
- Deciding what to do with findings (exit codes, the proof statement, the change protocol).

<a id="interfaces"></a>
## Interfaces

**Analysis**
- `analyzeTestFile(source, file, config)` returns one `TestStrength` per test: class, reasons, assertion sites, claim tags and body lines.
- `applyResultStatus` marks a test skipped when a run reported it skipped.
- `claimStrength(ref, tests, requiredLayers)` rolls tests up to a claim.

**Weakening comparison**
- `diffTestFile`, `diffSpecPolicy`, `diffConfigPolicy`, `scanAddedSource` and `snapshotRewrites` return `WeakeningFinding` lists. Each finding has `kind`, `severity`, the affected claim refs and a message.

**Diff parsing**
- `parseUnifiedDiff(text)` returns `ChangedFile` entries.

**Configuration**
- A top-level `testStrength` block:
  - `conditional`: regex sources that mark gated tests.
  - `assertHelpers`: helper names; a prefix wildcard is allowed.
  - `snapshotIsWeak`: defaults to `true`.
- An app's `test.conditional` adds gate regexes for that app's files.

**Result vocabulary mentioned in the spec**
- Test reasons: `skip-static`, `existence-only`, `no-throw-only`, `error-check-only`, `snapshot-only`, `unsupported-language`, `unparsable-body`.
- Claim reasons: `ALL_SKIPPED`, `LAYER_NOT_MEANINGFUL`. Other outcomes are no tagged tests, conditional only, weak only, and strength unknown.
- Finding kinds: `skip-added`, `assertions-removed`.

<a id="requirements"></a>
## Requirements

- **skip-detected**: A test is classed `skipped` when its source marks it so.
  - JavaScript: `it.skip`, `xit`, `it.todo`, `test.fixme`, an enclosing `describe.skip`, a first-statement `test.skip()`, or a `.only` elsewhere in the file.
  - Python: `skip`/`xfail` decorators or `pytestmark`.
  - Go: `t.Skip` as the first statement.
  - Rust: `#[ignore]`.
  - Java and Kotlin: `@Disabled`, `@Ignore` or `@Test(enabled = false)` on the method or class.
- **conditional-gates**: A test is classed `conditional` when it runs only under a condition.
  - Conditions: `skipIf`/`runIf`, a skip call inside the test, `skipif` decorators, `testing.Short()`, a Go build tag, Rust `#[cfg(...)]`, JUnit `@EnabledIf*`/`@DisabledIf*` or an `assume*` call.
  - A match of a regex in `testStrength.conditional` or the app's `test.conditional` also counts.
  - An invalid regex is rejected with an error.
- **no-assertion-weak**: A test with no assertion, or only trivial assertions such as `expect(true).toBe(true)` or `assert x == x`, is `weak`. Commented-out or quoted assertions are not counted.
- **weak-assertions**: A test whose assertions only check that something exists, that nothing throws, or that an error occurred is `weak` with the reason `existence-only`, `no-throw-only` or `error-check-only`. A test with at least one comparison, structural or exact assertion is `strong`.
- **snapshot-weak**: A test whose only assertions are snapshots is `weak` with the reason `snapshot-only` unless `testStrength.snapshotIsWeak` is false.
- **helper-assertions**: Helper calls count toward assertion strength as follows.
  - A call to a same-file helper that asserts counts with the helper's strength, to a depth of three.
  - A call to a convention-named helper such as `expectValidUser` counts as strength 2.
  - A name in `testStrength.assertHelpers` counts as strength 3.
  - Any other imported call counts for nothing.
- **claim-layer-rule**: A claim is meaningfully tested in either of two cases.
  - For each required layer except `functional`, at least one tagged test at that layer is strong.
  - No layer is required and at least one tagged test is strong.

  Otherwise the result lists why: no tagged tests, all skipped, conditional only, weak only, a named layer not meaningful, or strength unknown.
- **weakening-tests**: Comparing two versions of a test file reports:
  - An **error** for:
    - a tagged test removed or untagged while its claim is live
    - a test newly skipped or gated
    - a focused test added
    - a strong test turned weak
    - fewer or looser assertions
  - A **warning** for added wildcard matchers, or a removed test whose tags moved to an added test.
- **weakening-policy**: Comparing two versions of a spec or config reports an **error** when:
  - a claim loses a required layer
  - its assurance is lowered
  - its evidence moves to a manual or agentic verifier, or changes verifier
  - an example row is deleted while the claim text is unchanged
  - a `proof.require*` flag is turned off
  - a threshold is lowered
  - testability allow or waive lists, test-strength helpers or gates are loosened
- **weakening-source**: A diff is scanned for added lines in non-test source that branch on the test environment, added mutation-testing exclusions anywhere, and rewritten snapshot files. Each is reported as a warning.
- **diff-parser**: A unified diff is parsed into changed files with status, added and removed line numbers, and added text. It handles renames, binary files, `/dev/null` paths, quoted paths, omitted hunk counts, CRLF and no-newline markers.
- **declarations-markers**: Test declarations include:
  - `xit`, `xtest`, `fit`, `ftest` and `it.skipIf(...)` tests
  - jqwik `@Property` and `@Example`
  - Rust tests with attributes between `#[test]` and `fn`

  They also expose JVM annotation names, annotation arguments and the method name.

<a id="scenarios-the-behaviour-must-satisfy"></a>
### Scenarios the behaviour must satisfy

- **Agent skips a failing test.** A strong tagged test is changed from `it(` to `it.skip(`.
  - The new test is `skipped` with reason `skip-static`.
  - The comparison reports `skip-added` as an error naming the test and its claim.
  - The claim's reason is `ALL_SKIPPED`.
- **Strong unit test hides a weak e2e test.** The spec requires `unit` and `e2e`; the e2e test only checks that a page loads.
  - The claim is not meaningfully tested.
  - The result lists `LAYER_NOT_MEANINGFUL` for `e2e` and none for `unit`.
- **Unreadable test.** The test is in an unsupported language or in a file with unbalanced braces.
  - The test is `unknown` with reason `unsupported-language` or `unparsable-body`.
  - The claim's result is `unknown`, neither meaningful nor weak.

<a id="code-map"></a>
## Code map

| Area | Files |
|---|---|
| Sources | `src/core/test-strength.ts`, `src/core/test-assertions.ts`, `src/core/source-scan.ts`, `src/core/weakening.ts`, `src/core/diff-lines.ts` |
| Tests | `tests/core/test-strength.test.ts`, `tests/core/weakening.test.ts`, `tests/core/diff-lines.test.ts`, `tests/core/test-declarations.test.ts` |

The capability owns 5 files. The spec does not say which interface lives in which source file, so check the files directly for that mapping.

<a id="tests"></a>
## Tests

The four test files above cover this capability:

- `test-strength.test.ts`
- `weakening.test.ts`
- `diff-lines.test.ts`
- `test-declarations.test.ts`

The spec does not map individual requirement ids to test files. Use the scenarios above as the behavioural cases to confirm when changing the reader or the comparisons.

<a id="security-and-data"></a>
## Security and data

- All analysis is local, static and deterministic. Source text is read, never executed, and no model is called.
- The test-environment and mutation-exclusion scans only report added lines of a diff the caller supplies.
- Findings quote at most 120 characters of an assertion.

<a id="extending-it"></a>
## Extending it

Only the extension points the spec defines are documented here.

- **Gate environment-dependent tests.** Add regex sources to `testStrength.conditional`, or to an app's `test.conditional` for that app's files. Tests matching them become `conditional` and stop counting as proof. Invalid regexes are rejected with an error.
- **Trust project assertion helpers.** List helper names in `testStrength.assertHelpers`; a prefix wildcard is allowed. Listed names count as strength 3. Helpers defined in other files are otherwise not followed, so this is the way to credit them. Convention-named helpers such as `expectValidUser` already count as strength 2.
- **Change snapshot treatment.** Set `testStrength.snapshotIsWeak` to `false` so snapshot-only tests are not marked weak. The default is `true`.
- **Add support for a new test construct.** Keep the heuristic principle: if a test cannot be read, classify it `unknown` (`unsupported-language` or `unparsable-body`) rather than guessing. Add or adjust tests in `test-declarations.test.ts` and `test-strength.test.ts`.
- **Add a new weakening check.** Return a `WeakeningFinding` with `kind`, `severity` (error or warning), affected claim refs and a message. Existing checks use errors for changes that weaken claim proof or policy, and warnings for the source-scan checks and the two softer test-diff cases.
