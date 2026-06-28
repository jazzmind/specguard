---
title: "Drift Detection Pipeline"
sidebar_label: "Drift Detection Pipeline"
description: "The Drift Detection Pipeline identifies when source code has changed but its corresponding Living Spec has not been updated, letting you gate CI with a dedicated exit code when specs fall out of sync."
category: "pipelines"
order: 50
generated: true
---

# Drift Detection Pipeline

## What It Does

The Drift Detection Pipeline keeps your Living Specs honest. Whenever source code changes but its corresponding spec document is not updated to match, the spec has **drifted** — it no longer accurately describes the code it covers. This pipeline catches that situation automatically so you can enforce spec hygiene in CI before drift accumulates.

At a high level, the pipeline:

1. Inspects your git history to find recently changed source files.
2. Maps each changed file to the spec it should be keeping in sync.
3. Compares file modification times (or checks for a missing spec entirely).
4. Reports every drifted spec and exits with a dedicated exit code so your CI pipeline can act on the result.

---

## How Drift Is Detected

### Determining Which Files Changed

By default the pipeline looks at the single most recent commit (`HEAD~1..HEAD`). You can widen the window by supplying a `since` option, which shifts the range to `<since>..HEAD` — for example, passing a branch name or commit SHA to check everything since that point.

Changed files are discovered by running `git diff --name-only` over the resolved range, rooted at your project's `rootDir` (falling back to the current working directory if `rootDir` is not configured).

> **Shallow clones & edge cases** — If git cannot produce a diff (e.g. a shallow clone, the very first commit, or a directory that is not a git repository), the pipeline logs a warning and falls back to scanning *all* configured source files rather than failing outright. You will never see an unhandled crash from a git error.

### Mapping Source Files to Specs

The pipeline uses the same source → spec-key mapping as the [Reverse Generate Pipeline](./reverse-generate.md). In practice this means:

- Only files that match one of your app's configured **source globs** are considered; everything else is silently ignored.
- For each matching file the expected spec path is derived by dropping leading `src/` or `tests/` segments, dropping the area segment, stripping `.test`/`.spec` suffixes and the file extension, and writing the result under `<specDir>/<feature>.md`.

This ensures the drift check is always consistent with how specs are generated in the first place.

### What Counts as Drift

A spec is considered **drifted** when either of the following is true:

| Condition | Result |
|---|---|
| The source file's modification time is **newer** than the spec's modification time | Drift — spec is stale |
| The expected spec file **does not exist** on disk | Drift — spec is missing |

Every drifted spec is recorded as a failed pipeline item with a human-readable message explaining what was found.

---

## Results & Exit Codes

| Outcome | `exitCode` | Meaning |
|---|---|---|
| No drift found | `0` | All specs are up to date |
| One or more specs drifted | `3` (`DriftDetected`) | Specs have fallen behind their source files |

The `result.failed` count equals the number of drifted specs. Each drifted spec also contributes a readable line to `result.messages`, making it straightforward to surface the details in CI logs.

---

## Filtering to a Single Spec

If you only want to check one spec rather than the full set, pass the `spec` option with the target spec key. The pipeline will scope its report to that spec alone, which is useful for targeted checks or debugging a specific area.

---

## CI Integration

Because the pipeline exits with code `3` when drift is detected, you can gate your CI workflow directly on this exit code. A non-zero exit will fail the step, preventing merges when specs have not been kept up to date with the code they describe.

A typical CI step might look like:

```bash
specguard run drift
```

If any spec is found to be stale or missing, the step fails with exit code `3` and the drifted spec paths are printed to the log.

---

## Related

- [Reverse Generate Pipeline](./reverse-generate.md) — defines the source → spec-key mapping that drift detection relies on.
- [App Configuration](../core/config.md) — how to configure `AppConfig` and source globs.
- [Exit Codes](../core/exit-codes.md) — full reference for all SpecGuard exit codes, including `DriftDetected = 3`.
