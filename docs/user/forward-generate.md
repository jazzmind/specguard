---
title: "Forward Generation Pipeline"
sidebar_label: "Forward Generation Pipeline"
generated: true
---

# Forward Generation Pipeline

## What This Does

The Forward Generation Pipeline reads your Living Spec Markdown files and produces ready-to-run test files from them. Think of it as the spec-to-test direction of traceability: you write a spec, and SpecGuard generates the corresponding test code so your requirements are immediately backed by executable validation.

Every `### Scenario` block in a spec becomes exactly one `it()` / test block in the generated file, titled with the scenario name. The module under test is pulled from the spec's own `module` metadata, so the generated import statement points at the right place automatically.

This is the forward half of SpecGuard's requirement-to-test traceability loop — the [Reverse Generation Pipeline](../reverse-generate) is its counterpart, going the other direction.

---

## How to Use It

### Processing a single spec

Pass `--spec` with either a spec key or a direct file path:

```
specguard forward-generate --spec core/spec-parser
specguard forward-generate --spec path/to/my-feature.md
```

A spec key like `core/spec-parser` is resolved relative to the matching app's configured `specDir`. A path ending in `.md` is used exactly as given.

### Processing all specs at once

```
specguard forward-generate --all
```

This processes every spec found under each app's `specDir` as defined in your `SpecGuardConfig`.

---

## Configuration

The pipeline is entirely config-driven — no paths are hard-coded. It reads your `SpecGuardConfig` to determine:

| Setting | What it controls |
|---|---|
| `specDir` | Where specs live for each app; used to resolve spec keys and match specs back to their owning app |
| `testOutput` | The directory where generated test files are written |
| `framework` | The default test framework for each app (`vitest`, `playwright`, or `jest`) |

### Overriding the test framework

If you want to generate tests for a different framework than the app default, pass `--framework`:

```
specguard forward-generate --spec core/spec-parser --framework jest
```

Supported values are `vitest`, `playwright`, and `jest`.

---

## Where Output Files Are Written

Generated test files land at:

```
<app.testOutput>/<feature>.test.ts
```

where `<feature>` is the spec's path relative to the app's `specDir`. Because the area is already encoded in your `testOutput` configuration, the path stays clean and predictable.

---

## Skipping Existing Files

If a test file already exists at the target path, the pipeline **skips it by default** and records it as `skipped` in the results. This protects any manual edits you may have made.

To overwrite existing files, pass `--force`:

```
specguard forward-generate --all --force
```

---

## What the Generated Tests Look Like

SpecGuard instructs the underlying LLM to produce a single, complete test file with:

- **One `it()` / test block per scenario**, titled exactly with the scenario name from your spec
- **An import statement** pointing at the module declared in the spec's `module` metadata
- **Arrange / act / assert code** translated from each scenario's steps and expected results
- **No extra prose, no Markdown fences** — only valid, runnable test code

---

## Results and Error Handling

After a run, the pipeline returns a summary with counts and per-item detail that the CLI renders for you. Each spec ends up in one of three states:

| Status | Meaning |
|---|---|
| `created` | Test file was successfully generated and written |
| `skipped` | Test file already existed and `--force` was not set |
| `failed` | The LLM returned an error for this spec |

A failure on one spec does **not** stop the pipeline — remaining specs continue to be processed, and the failure is recorded in the final summary.
