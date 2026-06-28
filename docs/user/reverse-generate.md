---
title: "Reverse Generation Pipeline"
sidebar_label: "Reverse Generation Pipeline"
description: "The Reverse Generation Pipeline reads your existing source code and automatically produces or updates Living Spec Markdown files, making it the go-to tool for bringing brownfield codebases into SpecGuard without writing specs from scratch."
category: "pipelines"
order: 20
generated: true
---

# Reverse Generation Pipeline

## What It Does

The Reverse Generation Pipeline is SpecGuard's answer to the classic brownfield problem: you have a working codebase, but no Living Specs to go with it. Instead of requiring you to write specs from scratch, this pipeline reads your existing source files — components, routes, API handlers, and tests — and uses an LLM to generate structured Living Spec Markdown files for you.

If a spec already exists for a feature, the pipeline can detect that and skip it, so you never accidentally overwrite work you've already done. When code changes and a spec becomes stale, you can force a regeneration to bring it back in sync.

---

## How Source Files Are Discovered

The pipeline is entirely config-driven. It reads your app definition from `.specguard/config.json`, which contains glob patterns for each category of source file:

| Category | What it covers |
|----------|---------------|
| `routes` | Route definition files |
| `pages` | Page-level components or views |
| `api` | API handler files |
| `tests` | Existing test files |

All globs are expanded relative to the app's configured `repo` directory — no file paths are hard-coded anywhere in the pipeline.

> **Context limit:** To keep LLM prompts manageable, each source file is capped at **20,000 characters**. Files longer than this are automatically truncated, and a `... (truncated)` marker is appended so the model knows the content was cut.

---

## Running the Pipeline

You must tell the pipeline which app (or apps) to process. Two flags control this:

```
# Process a single app by name
specguard reverse-generate --app <name>

# Process every app defined in your config
specguard reverse-generate --all
```

One of `--app` or `--all` is **required**. If you omit both, the CLI exits with code `1` and an error message.

### Forcing Regeneration

By default, if a spec file already exists for a discovered feature, the pipeline skips it and logs a `[skip]` line. To overwrite existing specs — for example, after significant code changes — add the `--force` flag:

```
specguard reverse-generate --app <name> --force
```

---

## What Gets Generated

For each logical feature the pipeline discovers (a distinct page, route, or functional area), it:

1. **Checks** whether a spec already exists at `<specDir>/<area>/<feature>.md`.
2. **Skips** the feature (with a `[skip]` log entry) if a spec exists and `--force` is not set.
3. **Calls the LLM** to generate a spec if no spec exists, or if `--force` is set.
4. **Writes** the generated spec to `<specDir>/<area>/<feature>.md`, creating any intermediate directories as needed.

At the end of a run, the pipeline reports a summary with counts of specs **created**, **skipped**, and **failed**.

---

## How the LLM Generates Specs

The pipeline sends the LLM a carefully structured prompt that includes:

- A **system prompt** defining the exact Living Spec format (HTML comment block, H2 sections).
- All **relevant source files** for the feature as context.
- The **target spec key** so the model knows what it is writing.

The system prompt instructs the model to follow these rules:

- Write **one spec per distinct page, route, or feature area** — no bundling unrelated features together.
- **Only document behaviour that is visible in the provided source code** — no invented or assumed functionality.
- Keep the `## Overview` section to **3–6 sentences**.
- Make every scenario step **observable by a test tool** — concrete and specific, not abstract.
- Output **only the Markdown content** — no preamble, explanation, or commentary.

This means the specs you get back are immediately usable as Living Specs and are grounded entirely in your actual code.

---

## Pipeline Result

After each run, the pipeline returns a structured result containing:

| Field | Description |
|-------|-------------|
| `created` | Number of new spec files written |
| `skipped` | Number of features skipped because a spec already existed |
| `failed` | Number of features where generation or writing failed |

---

## Related Concepts

- **Spec Parser** — used internally to check whether an existing spec is present for a given feature.
- **LLM Adapter** — the abstraction layer the pipeline uses to call the language model.
- **App Config (`AppConfig`)** — defines glob patterns and the `repo` root; drives all source discovery.
- **Writer** — handles file output and directory creation for generated specs.
