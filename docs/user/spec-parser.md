---
title: "Spec Parser"
sidebar_label: "Spec Parser"
generated: true
---

# Spec Parser

## Overview

The Spec Parser reads Living Specification Markdown files and turns them into structured data your pipelines and tooling can work with. It is the foundational piece of the SpecGuard system — every part of the pipeline that needs to read a spec goes through this parser.

Specs are written in a conventional Markdown format: an H1 title, an HTML comment block for metadata, and H2/H3 sections for content and scenarios. If you have existing specs from `practera-test-suite/packages/spec-tools`, they are fully compatible and can be read by this parser without any changes.

---

## The Spec File Format

A valid spec file looks like this:

```markdown
# My Feature Name

<!-- key: my-feature/feature-name -->
<!-- status: draft -->
<!-- owner: platform-team -->

## Overview

A short description of what this feature does.

## Scenarios

### User logs in successfully
- Given the user is on the login page
- When they enter valid credentials
- Then they are redirected to the dashboard
```

The parser understands the following conventions:

- **H1 heading** — the human-readable title of the spec.
- **HTML comment metadata block** — one or more `<!-- key: value -->` lines placed near the top of the file. These are parsed into a typed metadata object.
- **H2 sections** — named content sections (e.g. `## Overview`, `## Dependencies`). Each section's content is available as a string field.
- **`## Scenarios` section** — a specially handled section where each H3 heading becomes a named scenario, complete with its steps and expected results.

---

## What the Parser Produces

When a spec file is parsed, you get back a `ParsedSpec` object containing:

| Field | Description |
|---|---|
| `title` | The text of the H1 heading. |
| `specKey` | A stable identifier derived from the file's path relative to your specs root directory (e.g. `core/spec-parser`). |
| `meta` | A typed `SpecMeta` object built from the HTML comment metadata block. |
| `sections` | A map of H2 section names to their content as strings. |
| `scenarios` | An array of `SpecScenario` objects, each with a name, steps, and expected results. |

### Handling Missing Sections

The parser is designed to be forgiving. If a section is absent from a spec file — including `## Scenarios` — the parser returns an empty string or an empty array rather than throwing an error. Your tooling can safely read any spec file without needing to guard against missing sections.

---

## Loading Multiple Specs

The `loadAllSpecs(dir)` function lets you point the parser at a directory and load every spec it contains in one call. It recursively finds all `.md` files within that directory and its subdirectories, automatically skipping any `README.md` files.

Each discovered file is parsed and returned as a `ParsedSpec`, with its `specKey` derived from its path relative to the root directory you provided.

---

## Design Notes

**Zero dependencies.** The Spec Parser has no runtime dependencies beyond Node.js built-ins. You can add it to any project without pulling in additional packages.

**Pure functions.** Where possible, the parser's functions accept file content as a plain string rather than reading from the filesystem themselves. This makes them straightforward to test and compose — pass in a string, get back structured data.
