---
title: "Spec Parser"
sidebar_label: "Spec Parser"
description: "The Spec Parser reads Living Specification Markdown files and turns them into structured data objects that every SpecGuard pipeline can work with, with zero external dependencies."
category: "core"
order: 10
generated: true
---

# Spec Parser

The Spec Parser is the foundational module of SpecGuard. Every pipeline starts here — it reads your Living Specification Markdown files and converts them into structured `ParsedSpec` objects that the rest of the system can reliably work with.

---

## What It Does

When you point SpecGuard at a spec file, the parser handles all of the following automatically:

- **Extracts the document title** from the top-level H1 heading.
- **Reads metadata** from the `<!-- key: value -->` HTML comment block at the top of the file, turning it into a typed `SpecMeta` object.
- **Captures all H2 sections** by name as individual string fields, so any section of your spec (e.g. `## Overview`, `## Dependencies`) is directly accessible.
- **Parses scenarios** — the `## Scenarios` section is parsed into a structured array of `SpecScenario` objects, each containing the scenario name, its steps, and expected results.
- **Derives a stable `specKey`** for every file based on its path relative to your specs root directory. For example, a file at `core/spec-parser.md` gets the key `core/spec-parser`. This key is used consistently across all pipelines to identify and cross-reference specs.

---

## Spec File Format

Your spec files are standard Markdown with a few conventions:

```markdown
<!-- key: specguard-core/spec-parser -->
<!-- status: active -->

# Spec Parser

## Overview

A short description of the feature...

## Scenarios

### My Scenario Name

Steps and expected results go here.
```

- **Metadata block**: An HTML comment block at the top of the file using `key: value` pairs per line.
- **H1 title**: The document's primary heading, parsed as the spec title.
- **H2 sections**: Any number of named sections (e.g. `## Overview`, `## Acceptance Criteria`). Sections that are absent from a file are returned as empty strings — the parser never throws an error for a missing section.
- **H2 Scenarios section**: The special `## Scenarios` section is parsed deeply into structured `SpecScenario` objects. If this section is absent, an empty array is returned.

> **Compatibility note:** The Spec Parser is fully compatible with the format used in `practera-test-suite/packages/spec-tools/src/spec-parser.ts`. Any spec written for that project can be read by SpecGuard without modification.

---

## Loading Multiple Specs

Use `loadAllSpecs(dir)` to recursively discover and parse every spec in a directory tree. It finds all `.md` files under the given directory, automatically skipping any `README.md` files, and returns a parsed object for each one.

This is the typical entry point when running a full pipeline across your entire spec suite.

---

## Reliability and Purity

The Spec Parser is designed to be predictable and safe to use anywhere:

- **Graceful handling of missing content**: If a section or metadata field is absent, the parser returns an empty string or empty array rather than throwing. Your pipelines will never crash due to an incomplete spec file.
- **Pure functions**: Parsing functions accept file content as a plain string and have no side effects. There are no hidden filesystem reads or global state mutations, making the parser easy to test and compose.
- **Zero external dependencies**: The Spec Parser relies only on Node.js built-ins. There is nothing extra to install and no version conflicts to manage.
