---
title: "Drift Detection Pipeline"
sidebar_label: "Drift Detection Pipeline"
generated: true
---

# Drift Detection Pipeline

## What It Does

The Drift Detection Pipeline watches for situations where your source code has moved on but its Living Spec hasn't kept up. Whenever code changes without a corresponding spec update, the spec has *drifted* — it no longer accurately describes what the code does.

When you run this pipeline, it inspects your git history, identifies which source files have changed, finds the spec each changed file is supposed to keep in sync with, and checks whether that spec has been updated more recently than the source. Any spec that is older than the source it documents — or that is missing entirely — is reported as drift.

Because the pipeline exits with code `3` (`DriftDetected`) whenever drift is found, you can use it as a gate in CI to prevent specs from falling silently out of date.

---

## How It Works

### Determining What Changed

By default the pipeline looks at the single most recent commit (`HEAD~1..HEAD`). You can widen the window by supplying a `since` value, in which case the pipeline examines everything from `<since>` up to `HEAD`.

Changed files are discovered by running `git diff --name-only` over that range. If git is unavailable or fails — for example in a shallow clone, on the very first commit, or outside a repository — the pipeline logs a warning and falls back to scanning all configured source files rather than stopping with an error.

### Mapping Source Files to Specs

Each changed file is matched against your apps' configured source globs. Files that don't match any app's globs are ignored. For files that do match, the pipeline derives the expected spec path using the same source-to-spec-key mapping as the Reverse Generate pipeline:

- The leading `src/` or `tests/` segment is dropped.
- The area segment is dropped.
- Any `.test` or `.spec` suffix, along with the file extension, is stripped.
- The result is written as `<specDir>/<feature>.md`.

This means the mapping is always consistent between the two pipelines — if the Reverse Generate pipeline knows where a spec lives, the Drift Detection pipeline will look in exactly the same place.

### Detecting Drift

Once the expected spec path is known, the pipeline checks two things:

1. **Missing spec** — if no file exists at the expected spec path, that counts as drift.
2. **Stale spec** — if the spec file does exist but its last-modified time is older than the source file's last-modified time, that also counts as drift.

Every drifted spec is recorded with a human-readable message explaining what was found.

---

## Reading the Results

After the pipeline runs you'll see:

- A message for each drifted spec describing the problem (missing or stale).
- A count of how many specs drifted (`result.failed`).
- An exit code of `3` if any drift was detected, or `0` if everything is in sync.

The `3` exit code is the `DriftDetected` code defined in the core exit-code registry, making it straightforward to distinguish drift failures from other pipeline errors in your CI configuration.

---

## Filtering to a Single Spec

If you only want to check drift for one particular spec, supply its spec key via the `spec` option. The report will be scoped to that spec alone, leaving all others out of the output.

---

## Using It in CI

Because the pipeline exits with a non-zero code (`3`) whenever drift is found, you can drop it into any CI step that treats a non-zero exit as a failure. A typical setup runs the drift check after your test suite so that a passing build still fails if specs have been left behind.

```
# Example CI step (adapt to your runner)
specguard run drift
```

If the step exits with code `3`, at least one spec needs to be updated to reflect recent code changes. Fix the drift by updating the relevant spec, then re-run.

---

## Dependencies

This pipeline relies on the following other parts of the SpecGuard system:

| Dependency | Purpose |
|---|---|
| Reverse Generate Pipeline | Provides the source→spec-key mapping used to locate expected spec files |
| Core Config (`AppConfig`) | Supplies the source globs used to match changed files to apps |
| Core Exit Codes | Defines `DriftDetected = 3` |
