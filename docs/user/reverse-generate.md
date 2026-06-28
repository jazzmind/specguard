---
title: "Reverse Generation Pipeline"
sidebar_label: "Reverse Generation Pipeline"
generated: true
---

# Reverse Generation Pipeline

## What This Pipeline Does

The Reverse Generation Pipeline reads your existing codebase — components, routes, API handlers, and tests — and automatically produces Living Spec Markdown files for features that don't yet have a spec. If code has changed since a spec was last written, it can update stale specs to match. This makes it the go-to starting point for **brownfield projects**, where you want to bring an existing codebase under spec coverage without writing specs from scratch.

Source files are discovered using the glob patterns you define in your `.specguard/config.json` app definition, so no file paths are hard-coded and the pipeline adapts to your project's structure.

---

## Running the Pipeline

You must tell the pipeline which app (or apps) to process. Two flags control this:

| Flag | Effect |
|---|---|
| `--app <name>` | Processes a single named app from your config |
| `--all` | Processes every app defined in your config |

Exactly one of these flags is required. If you omit both, the command exits immediately with an error.

**Examples:**

```bash
# Generate specs for a single app
specguard reverse-generate --app my-web-app

# Generate specs for all configured apps
specguard reverse-generate --all
```

---

## How Source Files Are Discovered

For each app, the pipeline expands the glob patterns defined in your app config relative to that app's repository root. Discovered files are grouped into four categories:

- **Routes** — URL routing definitions
- **Pages** — page-level components or views
- **API** — API handler files
- **Tests** — existing test files

These groups are passed together as context when generating a spec, giving the language model a complete picture of each feature area.

> **Note:** To keep generation reliable and within context limits, each individual source file is capped at 20,000 characters. Files longer than this are truncated automatically, with a `... (truncated)` marker appended.

---

## What Gets Generated (and What Gets Skipped)

For each logical feature the pipeline discovers, it checks whether a spec file already exists in your configured `specDir`.

- **No existing spec** — the pipeline calls the LLM and writes a new spec to `<specDir>/<area>/<feature>.md`. Any intermediate directories are created automatically.
- **Spec already exists** — the pipeline skips that feature and logs a `[skip]` line, leaving your existing spec untouched.
- **Spec already exists, but you want to regenerate it** — pass the `--force` flag to overwrite existing specs.

At the end of a run, the pipeline reports a summary of how many specs were **created**, **skipped**, and **failed**.

---

## What the Generated Specs Look Like

The pipeline instructs the language model to produce specs that follow SpecGuard's standard format. Specifically, each generated spec:

- Covers **one distinct page, route, or feature area** — the pipeline does not bundle unrelated features into a single file.
- Documents **only behaviour that is visible in the provided source code** — the model does not invent or assume functionality.
- Uses the **standard spec format**, including the required HTML comment block and H2 section headings.
- Keeps the `## Overview` section to **3–6 sentences**.
- Writes scenario steps that are **observable by a test tool** — concrete and specific, not abstract descriptions.
- Outputs **only the Markdown content**, with no preamble or explanation added by the model.

---

## Configuration Reference

The pipeline reads all app definitions from your `SpecGuardConfig` (loaded via `.specguard/config.json`). Each app entry should include:

- Glob patterns for `routes`, `pages`, `api`, and `tests` source files
- A `repo` directory that globs are expanded relative to
- A `specDir` pointing to where generated spec files should be written

Refer to the [Config documentation](../core/config.md) for the full `AppConfig` schema.
