# Flow Events Utility

<!-- module: specguard-extension/src/dashboard/flow-events / type: utility / status: draft -->

## Overview

The `flow-events` module provides two utility functions used by the SpecGuard dashboard to classify file-path changes into typed artifact events and to construct CLI argument arrays for pipeline invocations. `artifactEventFor` inspects a file path and a change verb to produce a structured event object describing the artifact kind (`spec`, `test`, or `doc`) and the nature of the change. `cliArgsFor` assembles an ordered argument list from a pipeline name and an optional array of extra flags. Paths that do not match any recognised artifact category are explicitly ignored by returning `null`.

## Acceptance Criteria

- AC-1: `artifactEventFor` returns an object with `type: 'artifact'`, a `kind` field, and a `change` field when the path matches a recognised category.
- AC-2: Paths beginning with `specs/` are classified as `kind: 'spec'`.
- AC-3: Paths beginning with `tests/` are classified as `kind: 'test'`.
- AC-4: Paths beginning with `docs/` are classified as `kind: 'doc'`.
- AC-5: Paths that do not match any recognised prefix cause `artifactEventFor` to return `null`.
- AC-6: `cliArgsFor` returns an array whose first element is the pipeline name.
- AC-7: When extra arguments are supplied to `cliArgsFor`, they are appended after the pipeline name in the order provided.
- AC-8: When no extra arguments are supplied to `cliArgsFor`, the returned array contains only the pipeline name.

## Scenarios

### Scenario 1: Classifying a spec path on create

**Steps:**
1. Call `artifactEventFor('specs/core/parser.md', 'create')`.
2. Inspect the returned value.

**Expected Results:**
- The return value is a non-null object.
- The object contains `type` equal to `'artifact'`.
- The object contains `kind` equal to `'spec'`.
- The object contains `change` equal to `'create'`.

---

### Scenario 2: Classifying a test path on update

**Steps:**
1. Call `artifactEventFor('tests/core/parser.test.ts', 'update')`.
2. Inspect the returned value.

**Expected Results:**
- The return value is a non-null object.
- The object contains `kind` equal to `'test'`.

---

### Scenario 3: Classifying a doc path on create

**Steps:**
1. Call `artifactEventFor('docs/user/login.md', 'create')`.
2. Inspect the returned value.

**Expected Results:**
- The return value is a non-null object.
- The object contains `kind` equal to `'doc'`.

---

### Scenario 4: Ignoring an unrelated path

**Steps:**
1. Call `artifactEventFor('src/core/parser.ts', 'create')`.
2. Inspect the returned value.

**Expected Results:**
- The return value is strictly `null`.

---

### Scenario 5: Building CLI args with no extras

**Steps:**
1. Call `cliArgsFor('drift')` with no second argument.
2. Inspect the returned array.

**Expected Results:**
- The returned value is an array equal to `['drift']`.
- The array has length 1.

---

### Scenario 6: Building CLI args with extra flags

**Steps:**
1. Call `cliArgsFor('reverse', ['--app', 'specguard-core'])`.
2. Inspect the returned array.

**Expected Results:**
- The returned value is an array equal to `['reverse', '--app', 'specguard-core']`.
- The first element is `'reverse'`.
- The subsequent elements are `'--app'` and `'specguard-core'` in that order.

## Security Notes

- No credentials, tokens, or secret values are handled by this module.
- File paths processed by `artifactEventFor` should be validated upstream to prevent path-traversal strings from being forwarded to downstream pipeline commands.
- Extra arguments passed to `cliArgsFor` are appended directly to the CLI invocation; callers must sanitise these values before passing them to avoid command-injection risks.

## Dependencies

- `vitest` — test framework used to verify all scenarios above.
- `extension/src/dashboard/flow-events.ts` — the implementation module exporting `artifactEventFor` and `cliArgsFor`.