---
title: "Forward Generation Pipeline"
sidebar_label: "Forward Generation Pipeline"
description: "The Forward Generation Pipeline reads your Living Spec Markdown files and automatically generates executable test files, turning each scenario into a ready-to-run test block in your chosen framework."
category: "pipelines"
order: 20
generated: true
---

# Forward Generation Pipeline

## What It Does

The Forward Generation Pipeline is the **spec-to-test** half of SpecGuard's requirement-to-test traceability story. It reads your Living Spec Markdown files and produces executable test files from them — the direct inverse of the [Reverse Generation Pipeline](reverse-generate.md).

For every spec it processes, each `### Scenario` section becomes exactly one `it()` / test block in the output file, titled with the scenario name and wired up to import the module under test declared in the spec's `module` metadata. The result is a test suite that is structurally driven by your specifications: if a scenario exists in the spec, a test exists in the code.

---

## How It Works

### Spec Resolution

You can target a single spec or your entire spec library:

- **`--spec <key|path>`** — processes exactly one spec.
  - A *spec key* such as `core/spec-parser` is resolved relative to the matching app's `specDir` as defined in your `SpecGuardConfig`.
  - A *direct path* ending in `.md` is used verbatim.
- **`--all`** — processes every spec found under each app's `specDir`.

### Mapping Specs to Apps

Each spec file is matched back to its owning app by comparing the spec's file location against the `specDir` configured for each app in `SpecGuardConfig`. This is how the pipeline knows which framework to use and where to write the output — no paths are hard-coded.

### Parsing and Test Generation

Once a spec is located, it is parsed with `parseSpecContent`. Every `### Scenario` in the file becomes one `it()` / test block. The pipeline sends the parsed spec to the configured LLM with a strict prompt that instructs it to:

- Emit a **single, complete** test file in the requested framework.
- Create **exactly one** `it()` / test block per scenario, using the scenario name as the test title.
- Import the module under test from the path declared in the spec's `module` metadata.
- Translate each scenario's steps and expected results into **arrange / act / assert** code.
- Output **only** valid test code — no Markdown fences, no prose, no explanation.

Any accidental Markdown code fences in the LLM response are stripped automatically before the file is written.

### Output Location

Generated test files are written to:

```
<app.testOutput>/<feature>.test.ts
```

where `feature` is the spec's path relative to the app's `specDir`. Because the area is already encoded in `testOutput`, the directory structure stays clean and predictable.

---

## Choosing a Framework

The target test framework defaults to the **owning app's `framework`** setting (`vitest`, `playwright`, or `jest`). You can override this for a single run with the `--framework` flag:

```
--framework vitest
--framework jest
--framework playwright
```

---

## Skipping and Overwriting Existing Tests

To protect hand-edited test files, the pipeline checks whether the output file already exists before writing:

- **File exists, no `--force`** — the spec is skipped. A `[skip]` line is logged and the item is recorded as `skipped` in the results.
- **File exists with `--force`**, or **file does not exist** — the LLM is called, the output is written, a `[gen]` line is logged, and the item is recorded as `created`.

Use `--force` only when you intentionally want to regenerate and overwrite an existing test file.

---

## Error Handling

If the LLM returns an error for a particular spec, that spec is recorded as `failed` and the pipeline continues processing the remaining specs. A single failure does not abort the entire run.

---

## Results

The pipeline returns a `PipelineResult` containing:

- **Counts** — how many specs were `created`, `skipped`, and `failed`.
- **Per-item detail** — the outcome for each individual spec processed.
- **Progress messages** — logged during the run; the CLI renders a human-readable summary at the end.

---

## Configuration Reference

The pipeline reads all of its settings from `SpecGuardConfig` — the caller is responsible for loading the config and passing it in. The relevant per-app fields are:

| Field | Description |
|---|---|
| `specDir` | Root directory where Living Spec Markdown files live. Used to resolve spec keys and match specs to their owning app. |
| `framework` | Default test framework (`vitest`, `jest`, or `playwright`). Overridable with `--framework`. |
| `testOutput` | Directory where generated test files are written. |

---

## Related Pipelines

- **[Reverse Generation Pipeline](reverse-generate.md)** — the inverse: reads existing test files and generates or updates Living Spec Markdown from them. The two pipelines share the same feature-naming convention so their outputs stay in sync.
