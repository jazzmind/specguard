---
title: "Test Strength"
audience: user
source: "specs/capabilities/test-strength.md"
generated: true
---
<a id="test-strength"></a>
# Test Strength

Test Strength checks whether the tests behind a claim could actually catch a mistake. A claim counts as tested only when a real test that can fail is tagged to it. It reads test source without running anything and without calling a model.

<a id="why-it-exists"></a>
## Why it exists

A passing test is evidence only if it could have failed. When something has to be shown as "proven", there are cheap ways to get a green result without proving anything:

- skipping the failing test
- gating it behind an environment variable nobody sets
- deleting its assertions
- swapping an exact comparison for a check that something exists
- regenerating a snapshot

Each of these keeps the test run green. Test Strength catches them before they pass for proof.

<a id="what-you-can-do"></a>
## What you can do

**See how strong each test is.** Every test is labelled strong, weak, skipped, conditional or unknown, with the reason. For a weak test you also see the assertion that proves too little.

- **Skipped:** the test is marked as skipped in its source. Examples are `it.skip`, `xit`, `it.todo`, a `.only` elsewhere in the file, Python `skip`/`xfail`, Go `t.Skip`, Rust `#[ignore]`, and Java/Kotlin `@Disabled` or `@Ignore`.
- **Conditional:** the test runs only under some condition, such as `skipIf`/`runIf`, `testing.Short()`, a Go build tag, Rust `#[cfg(...)]`, or JUnit `@EnabledIf*` and `assume*`. You can also list your own gates (see below).
- **Weak:** the test has no assertion, or only trivial ones such as `expect(true).toBe(true)`. Commented-out or quoted assertions don't count. Weak tests that do assert are given a reason:
  - `existence-only`: only checks that something exists
  - `no-throw-only`: only checks that nothing throws
  - `error-check-only`: only checks that an error occurred
  - `snapshot-only`: only checks a snapshot
- **Strong:** the test has at least one comparison, structural or exact assertion.
- **Unknown:** the test is in an unsupported language or can't be parsed. The tool says so instead of guessing.

**See whether a claim is meaningfully tested.** A claim counts when at least one tagged test is strong at each required layer, except `functional`. If no layer is required, one strong tagged test is enough. If a claim isn't meaningfully tested, you get the reasons: no tagged tests, all skipped, conditional only, weak only, a named layer not meaningful, or strength unknown. For example, a strong unit test doesn't help if the spec also requires `e2e` and the only e2e test checks that a page loads.

**Compare two versions of a project.** The comparison reports changes that make proof weaker.

*Errors in test files:*
- a tagged test removed or untagged while its claim is live
- a test newly skipped or gated
- a focused test added
- a strong test turned weak
- fewer or looser assertions

*Warnings in test files:*
- added wildcard matchers
- a removed test whose tags moved to an added test

*Errors in specs and config:*
- a claim loses a required layer
- a claim's assurance is lowered
- a claim's evidence moves to a manual or agentic verifier, or changes verifier
- an example row is deleted while the claim text is unchanged
- a `proof.require*` flag is turned off
- a threshold such as `mutation.minScore` is lowered
- testability allow or waive lists, test-strength helpers or gates are loosened

*Warnings in a diff:*
- added lines in non-test source that branch on the test environment
- added mutation-testing exclusions
- rewritten snapshot files

**Configure it.** Use a top-level `testStrength` block:
- `conditional`: regular expressions for gates that stop tests from counting, such as an environment variable your CI never sets. An invalid expression is rejected with an error.
- `assertHelpers`: names of your own assertion helpers, which count as full-strength. A trailing wildcard on a prefix is allowed.
- `snapshotIsWeak`: defaults to true. Set it to false to let snapshot-only tests count as strong.

An app can also add gate expressions for its own files with `test.conditional`.

**How helpers are counted.** A call to a helper in the same file counts with that helper's strength, up to three levels deep. A convention-named helper such as `expectValidUser` counts as moderate strength. A name in `assertHelpers` counts as full strength. Any other imported call counts for nothing.

<a id="what-to-expect"></a>
## What to expect

- **Local and repeatable.** Analysis only reads source text. It never runs tests, never executes your code, and never calls a model. The same input gives the same result.
- **Honest about limits.** It is a heuristic over well-known assertion styles. When it can't read a test, the test is `unknown` and the claim's result is `unknown`, not weak and not meaningful.
- **Short quotes.** Findings quote at most 120 characters of an assertion.
- **Diff scans cover only what you give them.** The scans for test-environment branches, mutation exclusions and snapshot rewrites look only at the added lines of the diff you supply.
- **Examples.**
  - If a test is changed from `it(` to `it.skip(`, the new test is classed `skipped`, the comparison reports `skip-added` as an error naming the test and its claim, and the claim is no longer meaningfully tested because all its tests are skipped.
  - If a claim has a strong unit test and a weak e2e test, and both layers are required, the claim is not meaningfully tested, and the e2e layer is the one flagged.

**What it does not do**
- It doesn't run tests, mutation testing or coverage. Those are separate evidence.
- It doesn't follow imports to judge helpers defined in other files. Helpers are trusted by naming convention or configuration.
- It doesn't decide what to do with findings, such as exit codes or the change process. It only reports them.
