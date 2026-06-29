# Coverage Parse Utility

<!-- module: specguard-extension/src/dashboard/coverage-parse / type: utility / status: draft -->

## Overview

The `parseCoverageText` function parses plain-text coverage reports produced by the SpecGuard CLI into structured data objects. Each parsed object represents a single application (app) with its name, overall coverage percentage, and a list of individual source-file coverage items. Items are classified as either having a spec (`[ok]`) or missing one (`[missing-spec]`). This utility is consumed by the dashboard to render coverage summaries and per-file status indicators.

## Acceptance Criteria

- `parseCoverageText` accepts a multi-line string in the SpecGuard coverage text format and returns an array of app coverage objects.
- Each app object exposes `name` (string), `percentage` (number, integer), and `items` (array).
- Each item in `items` exposes `key` (string, the source path) and `hasSpec` (boolean).
- Lines prefixed with `[ok]` produce items where `hasSpec` is `true`.
- Lines prefixed with `[missing-spec]` produce items where `hasSpec` is `false`.
- The summary line (e.g., `specguard-core: 2 source files, 1 specs (50%), 1 tests`) is parsed to extract the integer percentage value.
- The function returns one app object per app section found in the input text.

## Scenarios

### Scenario 1: Parse a single-app coverage report

**Steps:**

1. Call `parseCoverageText` with a string containing one app section headed by `# specguard-core (specs/core)`, two item lines (`[ok] core/parser` and `[missing-spec] core/llm`), and a summary line reporting `50%`.
2. Inspect the length of the returned array.
3. Inspect `apps[0].name`.
4. Inspect `apps[0].percentage`.
5. Find the item with `key === 'core/parser'` and inspect its `hasSpec` value.
6. Find the item with `key === 'core/llm'` and inspect its `hasSpec` value.

**Expected Results:**

- The returned array has exactly 1 element.
- `apps[0].name` equals `"specguard-core"`.
- `apps[0].percentage` equals `50` (numeric).
- The item with `key === 'core/parser'` has `hasSpec` equal to `true`.
- The item with `key === 'core/llm'` has `hasSpec` equal to `false`.

### Scenario 2: Empty input string

**Steps:**

1. Call `parseCoverageText` with an empty string `""`.
2. Inspect the length of the returned array.

**Expected Results:**

- The returned array has 0 elements (no app objects are produced).

### Scenario 3: Input with no item lines (only a header and summary)

**Steps:**

1. Call `parseCoverageText` with a string containing one app header and one summary line but no `[ok]` or `[missing-spec]` lines.
2. Inspect `apps[0].items`.

**Expected Results:**

- The returned array has 1 element.
- `apps[0].items` is an empty array.

## Security Notes

- The function performs text parsing only; no network calls, file I/O, or execution of external code occurs.
- Input strings should be treated as untrusted; the parser must not evaluate or execute any portion of the input.
- No secret values (API keys, tokens, credentials) are present in or expected from coverage text; any such content appearing in input should be treated as plain text and not acted upon.

## Dependencies

- `coverage-parse.ts` (implementation module, same directory) — exports `parseCoverageText`.
- `vitest` — test runner and assertion library used to verify behaviour.
- No runtime external dependencies beyond the host JavaScript environment are required by the utility itself.