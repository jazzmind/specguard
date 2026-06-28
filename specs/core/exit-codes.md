# Exit Codes

<!-- module: specguard-core/exit-codes / type: utility / status: draft -->

## Overview

This module defines the canonical, typed process exit codes used throughout SpecGuard. Each pipeline returns one of these values in `PipelineResult.exitCode`, and the CLI passes it directly to `process.exit`. The values are considered stable contracts relied upon by CI pipelines and the MCP server. A companion `exitCodeLabel` function maps any numeric code to a human-readable string for logging purposes. Unknown codes produce a fallback label of the form `unknown (<code>)`.

## Acceptance Criteria

- AC1: The `ExitCode` object exposes exactly seven named constants: `Success` (0), `InternalError` (1), `ValidationFailed` (2), `DriftDetected` (3), `MissingSpecs` (4), `SecurityIssues` (5), and `HealFailed` (7).
- AC2: No exit code value is duplicated across the seven named constants.
- AC3: `exitCodeLabel` returns the correct human-readable string for each of the seven defined codes.
- AC4: `exitCodeLabel` returns a string matching the pattern `unknown (<n>)` for any numeric input that is not one of the seven defined codes.
- AC5: The numeric values of all named constants must not change between releases (stability guarantee for CI and MCP consumers).
- AC6: The `ExitCode` type is a union of the literal numeric values, preventing assignment of arbitrary numbers where the type is required.

## Scenarios

### Scenario 1: Retrieving a known exit code value

**Steps:**
1. Import `ExitCode` from `src/core/exit-codes.ts`.
2. Read `ExitCode.Success`, `ExitCode.InternalError`, `ExitCode.ValidationFailed`, `ExitCode.DriftDetected`, `ExitCode.MissingSpecs`, `ExitCode.SecurityIssues`, and `ExitCode.HealFailed`.

**Expected Results:**
- `ExitCode.Success` equals `0`.
- `ExitCode.InternalError` equals `1`.
- `ExitCode.ValidationFailed` equals `2`.
- `ExitCode.DriftDetected` equals `3`.
- `ExitCode.MissingSpecs` equals `4`.
- `ExitCode.SecurityIssues` equals `5`.
- `ExitCode.HealFailed` equals `7`.

### Scenario 2: Obtaining a label for each defined exit code

**Steps:**
1. Import `exitCodeLabel` from `src/core/exit-codes.ts`.
2. Call `exitCodeLabel` once for each of the seven defined numeric values: `0`, `1`, `2`, `3`, `4`, `5`, `7`.

**Expected Results:**
- `exitCodeLabel(0)` returns `"success"`.
- `exitCodeLabel(1)` returns `"internal error"`.
- `exitCodeLabel(2)` returns `"validation failed"`.
- `exitCodeLabel(3)` returns `"drift detected"`.
- `exitCodeLabel(4)` returns `"missing specs"`.
- `exitCodeLabel(5)` returns `"security issues"`.
- `exitCodeLabel(7)` returns `"heal failed"`.

### Scenario 3: Obtaining a label for an unknown exit code

**Steps:**
1. Import `exitCodeLabel` from `src/core/exit-codes.ts`.
2. Call `exitCodeLabel(6)` (a value not assigned to any named constant).
3. Call `exitCodeLabel(99)` (an arbitrary out-of-range value).
4. Call `exitCodeLabel(-1)` (a negative value).

**Expected Results:**
- `exitCodeLabel(6)` returns `"unknown (6)"`.
- `exitCodeLabel(99)` returns `"unknown (99)"`.
- `exitCodeLabel(-1)` returns `"unknown (-1)"`.

### Scenario 4: Verifying no duplicate numeric values exist

**Steps:**
1. Import `ExitCode` from `src/core/exit-codes.ts`.
2. Collect all values of the `ExitCode` object into an array.
3. Compare the length of the array to the length of a `Set` constructed from the same array.

**Expected Results:**
- The array contains exactly 7 elements.
- The `Set` contains exactly 7 elements (no duplicates).

### Scenario 5: Type safety prevents arbitrary number assignment

**Steps:**
1. In a TypeScript compilation context, attempt to assign the literal `6` (not a defined code) to a variable typed as `ExitCode`.
2. Attempt to assign `ExitCode.Success` (value `0`) to a variable typed as `ExitCode`.

**Expected Results:**
- The assignment of `6` produces a TypeScript compile-time type error.
- The assignment of `ExitCode.Success` compiles without error.

## Security Notes

- This module contains no credentials, tokens, or secret values.
- Exit codes are surfaced to CI environments and the MCP server; consumers must not infer sensitive internal state solely from exit code values beyond the documented semantics.

## Dependencies

- No runtime dependencies; this module is pure TypeScript with no imports.
- Consumed by: CLI entry point (passes value to `process.exit`), pipeline result types (`PipelineResult.exitCode`), and the MCP server integration.