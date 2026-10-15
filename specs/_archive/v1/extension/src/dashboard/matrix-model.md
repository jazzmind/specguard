# Matrix Model Transformer

<!-- module: specguard-extension/src/dashboard/matrix-model / type: utility / status: draft -->

## Overview

The `toMatrixModel` function transforms raw spec coverage data into a structured matrix model consumed by the dashboard. Each entry in the raw payload is mapped to a row containing derived boolean flags and counts for test and documentation coverage. The function accepts the raw object produced by the spec coverage generator and returns a normalised model with a `generatedAt` timestamp and a `rows` array. Malformed or missing input is handled gracefully by returning an empty model rather than throwing.

## Acceptance Criteria

- AC1: `toMatrixModel` accepts a raw coverage payload and returns an object with `generatedAt` (string) and `rows` (array).
- AC2: Each row exposes `specKey`, `hasTests` (boolean), `testCount` (number), and `hasDocs` (boolean) derived from the raw entry's `tests` and `docs` arrays.
- AC3: A row with an empty `tests` array has `hasTests: false` and `testCount: 0`.
- AC4: A row with one or more entries in `tests` has `hasTests: true` and `testCount` equal to the length of that array.
- AC5: Calling `toMatrixModel` with `null` returns `{ generatedAt: null, rows: [] }`.
- AC6: Calling `toMatrixModel` with an empty object `{}` returns `{ generatedAt: null, rows: [] }`.

## Scenarios

### Scenario 1: Valid payload with mixed coverage entries

**Steps:**
1. Call `toMatrixModel` with a payload containing `generatedAt: "2026-06-28T18:24:50.615Z"` and two entries: one with `specKey: "cli"` and empty `tests`/`docs` arrays, and one with `specKey: "config"` and one item in `tests` and an empty `docs` array.
2. Read the `generatedAt` property of the returned model.
3. Read the `rows` array length of the returned model.
4. Read `rows[0]` fields: `specKey`, `hasTests`, `testCount`, `hasDocs`.
5. Read `rows[1]` fields: `specKey`, `hasTests`, `testCount`.

**Expected Results:**
- `generatedAt` equals `"2026-06-28T18:24:50.615Z"`.
- `rows` has length `2`.
- `rows[0]` matches `{ specKey: "cli", hasTests: false, testCount: 0, hasDocs: false }`.
- `rows[1]` matches `{ specKey: "config", hasTests: true, testCount: 1 }`.

### Scenario 2: Null input returns empty model

**Steps:**
1. Call `toMatrixModel(null)`.
2. Inspect the returned value.

**Expected Results:**
- The returned value deep-equals `{ generatedAt: null, rows: [] }`.

### Scenario 3: Empty object input returns empty model

**Steps:**
1. Call `toMatrixModel({})`.
2. Inspect the returned value.

**Expected Results:**
- The returned value deep-equals `{ generatedAt: null, rows: [] }`.

## Security Notes

- The transformer operates entirely on in-memory data structures; no network calls or file I/O are performed.
- Raw entry values (e.g. `specKey`, `title`, `sourceModule`) are passed through without sanitisation at this layer; consumers rendering these values in HTML must apply appropriate output encoding.
- No secret-like values are present in the raw payload schema.

## Dependencies

- `vitest` — test runner used to verify transformer behaviour (`describe`, `it`, `expect`).
- Raw coverage payload schema — the shape produced upstream by the spec coverage generator (`generatedAt`, `entries[].specKey`, `entries[].tests`, `entries[].docs`).
- Dashboard view layer — consumes the `MatrixModel` returned by this function to render the coverage matrix UI.