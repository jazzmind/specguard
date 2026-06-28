---
title: "Status Pipeline"
sidebar_label: "Status Pipeline"
description: "The Status Pipeline is a read-only health check that reports spec and test coverage for every app in your SpecGuard config, signalling missing coverage through its exit code so CI can gate on it."
category: "pipelines"
order: 50
generated: true
---

# Status Pipeline

## What It Does

The Status Pipeline is SpecGuard's read-only coverage health check. Point it at your SpecGuard configuration and it will scan every source file across all of your configured apps, then tell you:

- Which source files already have a corresponding spec document.
- Which source files already have a generated test.
- Which source files are still missing a spec — and therefore represent a coverage gap.

Because it never calls an LLM and never writes any files, it is safe to run at any time, including in CI pipelines where you want a fast, side-effect-free gate on coverage completeness.

---

## How It Works

When you run the Status Pipeline, it works through the following steps for each app defined in your `SpecGuardConfig`:

1. **Expands source globs.** It resolves all source file globs configured for the app, relative to `rootDir` combined with the app's `repo` directory. This gives it the full list of source files to evaluate.

2. **Excludes test files.** Files belonging to the `tests` source group are automatically excluded. Test files are not features that require their own spec, so they are never counted as coverage gaps.

3. **Derives the expected spec key.** For each remaining source file, the pipeline derives the expected feature/spec key using the same source-file → feature mapping used by the [Reverse Generate Pipeline](./reverse-generate.md). This ensures that the coverage check is always consistent with what the reverse pipeline would produce.

4. **Checks spec existence.** It looks for a spec document at `<specDir>/<feature>.md`. If that file exists, the source file is considered spec-covered.

5. **Checks generated-test existence.** It also checks whether a generated test for that feature exists under `testOutput`. A missing test is noted in the item's message even if the spec itself is present.

6. **Builds per-app coverage counts.** For each app, the pipeline tallies:
   - Total number of source files evaluated.
   - Number (and percentage) of source files with a spec present.
   - Number (and percentage) of source files with a generated test present.
   - A list of source files that are missing a spec.

---

## Output and Exit Code

### Coverage Report

The pipeline emits a human-readable coverage report as a series of messages — one summary block per app, followed by an overall totals line. A typical report looks like:

```
App: my-api
  Source files : 42
  Specs present: 38 (90%)
  Tests present: 35 (83%)
  Missing specs : src/auth/token.ts, src/billing/invoice.ts, src/billing/refund.ts, src/notifications/email.ts

────────────────────────────────────────
TOTALS  Source: 42  Specs: 38 (90%)  Tests: 35 (83%)  Missing: 4
```

### Pipeline Items

Each source file becomes a `PipelineItem` in the result:

| Condition | Item status | Notes |
|---|---|---|
| Spec exists | `ok` | Item message notes if a generated test is also missing |
| Spec missing | `failed` | Item message identifies the missing spec |

### Exit Code

| Condition | Exit code |
|---|---|
| All source files have a spec | `0` (success) |
| One or more source files lack a spec | `4` (`MissingSpecs`) |

The `result.failed` count is set to the number of source files missing a spec, making it straightforward to surface the gap count in CI logs.

---

## Using the Status Pipeline in CI

Because the pipeline exits with code `4` when any source file lacks a spec, you can use it as a hard gate in your CI workflow. For example, a non-zero exit code from the Status Pipeline means new source files have been added without corresponding specs, and the build should fail until coverage is restored.

```yaml
# Example CI step (pseudo-config)
- name: Check SpecGuard coverage
  run: specguard status
  # Fails the build if exit code is 4 (MissingSpecs)
```

> **Tip:** The Status Pipeline is entirely read-only. It will never modify your specs, tests, or any other files, so it is always safe to run as a pre-merge check.

---

## Related

- [Reverse Generate Pipeline](./reverse-generate.md) — shares the same source-file → feature key mapping used by the coverage check.
- [Core Config](../core/config.md) — describes `AppConfig`, glob expansion, and `specDir`/`testOutput` settings.
- [Exit Codes](../reference/exit-codes.md) — full reference for all SpecGuard exit codes, including `ExitCode.MissingSpecs` (`4`).
