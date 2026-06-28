---
title: "Exit Codes"
sidebar_label: "Exit Codes"
description: "A reference for SpecGuard's seven canonical exit codes, their numeric values, and how they map to human-readable labels for use in CI pipelines and the MCP server."
category: "reference"
order: 10
generated: true
---

# Exit Codes

SpecGuard uses a fixed set of **seven named exit codes** as a stable contract between the CLI, your CI pipelines, and the MCP server. Every pipeline run produces a `PipelineResult.exitCode` drawn from this set, and the CLI forwards that value directly to `process.exit`. Because external systems depend on these values, the numeric assignments are guaranteed never to change between releases.

---

## Named Exit Codes

| Constant | Value | Meaning |
|---|---|---|
| `Success` | `0` | The pipeline completed without any issues. |
| `InternalError` | `1` | An unexpected internal error occurred inside SpecGuard itself. |
| `ValidationFailed` | `2` | One or more specs failed validation. |
| `DriftDetected` | `3` | Drift was detected between the living spec and the implementation. |
| `MissingSpecs` | `4` | Required specs could not be found. |
| `SecurityIssues` | `5` | Security issues were identified during the pipeline run. |
| `HealFailed` | `7` | An attempted auto-heal operation did not succeed. |

> **Note:** No two constants share the same numeric value. You can safely use these values in `switch` statements, shell conditionals, or CI step outcome checks without ambiguity.

---

## Stability Guarantee

The numeric value of every named constant is a **stable, versioned contract**. SpecGuard will never reassign or reuse these numbers across releases. This means you can safely hard-code them in:

- CI pipeline `if:` conditions (e.g. GitHub Actions, GitLab CI)
- Shell scripts that inspect `$?`
- MCP server response handlers that branch on `exitCode`

---

## Human-Readable Labels

SpecGuard exposes an `exitCodeLabel` function that converts any numeric exit code into a descriptive string, useful for logging and diagnostics.

- For any of the seven defined codes, `exitCodeLabel` returns the corresponding name (e.g. `"DriftDetected"` for `3`).
- For any **unrecognised** numeric value, it returns a fallback string in the form `unknown (<n>)` — for example, `unknown (42)`.

This makes log output self-explanatory without requiring consumers to maintain their own lookup tables.

---

## Type Safety

The `ExitCode` TypeScript type is a **union of the seven literal numeric values**. This means the TypeScript compiler will reject any attempt to assign an arbitrary number where an `ExitCode` is expected, catching mistakes at compile time rather than at runtime.

---

## Where Exit Codes Appear

| Consumer | How it uses exit codes |
|---|---|
| **CLI entry point** | Passes `PipelineResult.exitCode` directly to `process.exit`. |
| **Pipeline result types** | `PipelineResult.exitCode` is typed as `ExitCode`. |
| **MCP server integration** | Reads `exitCode` from pipeline results to determine response behaviour. |

This module has no runtime dependencies — it is pure TypeScript with no imports, making it safe to use anywhere in the SpecGuard stack without introducing additional overhead.
