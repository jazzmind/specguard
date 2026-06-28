---
title: "Status Pipeline"
sidebar_label: "Status Pipeline"
generated: true
---

# Status Pipeline

## What It Does

The Status Pipeline is SpecGuard's read-only coverage health check. Point it at your repository and it will tell you, for every app in your SpecGuard configuration, exactly which source files have a corresponding spec and generated test — and which ones don't.

It never calls an LLM and never writes or modifies any files. Its sole job is to answer the question: **"Which source files still lack a spec?"**

This makes it ideal for running in CI as a coverage gate.

---

## How It Works

When you run the Status Pipeline, it works through the following steps for each app defined in your SpecGuard configuration:

1. **Expands your source globs** — It resolves all source file patterns configured for the app, relative to the app's repository directory.

2. **Skips test files** — Files belonging to the `tests` source group are excluded from coverage checks. Test files are not features and don't require their own spec.

3. **Derives the expected spec key** — For each source file, it calculates the feature/spec key using the same source-file-to-feature mapping used by the Reverse Generate pipeline. This ensures consistency across pipelines.

4. **Checks for a spec** — It looks for a spec file at `<specDir>/<feature>.md`. If that file exists, the source file is considered covered.

5. **Checks for a generated test** — It also checks whether a generated test exists under your configured `testOutput` directory for that feature.

6. **Builds a coverage report** — For each app, it tallies:
   - Total number of source files
   - How many have a spec (and the percentage)
   - How many have a generated test (and the percentage)
   - A list of source files that are missing a spec

---

## Reading the Output

The pipeline prints a human-readable report for each app, followed by a totals summary across all apps. Each source file is reported as either:

- **OK** — a spec exists for this file (the report will also note if a generated test is missing)
- **Failed** — no spec exists for this file

---

## Exit Codes

The Status Pipeline signals coverage gaps through its exit code, making it straightforward to integrate into CI pipelines:

| Exit Code | Meaning |
|-----------|---------|
| `0` | All source files have a corresponding spec |
| `4` (`MissingSpecs`) | One or more source files are missing a spec |

The number of files missing a spec is also reported as the failure count in the pipeline result.

---

## Using It in CI

Because the Status Pipeline exits with code `4` when any source file lacks a spec, you can use it directly as a CI gate. If the pipeline exits cleanly with `0`, your spec coverage is complete. Any non-zero exit signals exactly what needs attention before the build can pass.

---

## Relationship to Other Pipelines

The Status Pipeline shares its source-file-to-feature mapping with the **Reverse Generate** pipeline. This means the spec keys it checks for are always consistent with the specs that Reverse Generate would produce — there's no ambiguity about where a spec "should" live.
