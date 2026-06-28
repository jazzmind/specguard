# Spec Parser

<!--
  module: src/core/spec-parser.ts
  type: core
  status: draft
-->

## Overview

Parses Living Specification Markdown files into structured `ParsedSpec` objects. This is the foundational module — every pipeline reads specs through this parser. The format is structured Markdown with an HTML comment metadata block and conventional H2/H3 sections.

Compatible with the format used in `practera-test-suite/packages/spec-tools/src/spec-parser.ts` — any spec from that project can be read by this parser without modification.

## Acceptance Criteria

- [ ] Parses the H1 title from a spec file
- [ ] Parses the `<!-- key: value -->` metadata block into a typed `SpecMeta` object
- [ ] Extracts all H2 sections by name into string fields
- [ ] Parses `## Scenarios` into an array of `SpecScenario` objects with name, steps, and expected results
- [ ] Returns a stable `specKey` derived from the file path relative to the specs root (e.g. `core/spec-parser`)
- [ ] Handles missing sections gracefully (returns empty string / empty array, not an error)
- [ ] `loadAllSpecs(dir)` recursively finds all `.md` files excluding `README.md`
- [ ] All functions are pure (no side effects, no filesystem calls — accept file content as string where possible)

## Scenarios

### Scenario 1: Parse a minimal spec file

**Steps:**
1. Call `parseSpecContent(content, filePath, specsRoot)` with a valid spec string
2. Inspect the returned `ParsedSpec`

**Expected Results:**
- `title` matches the H1 heading
- `specKey` is the relative path without `.md` extension
- `meta.module` and `meta.type` are populated from the comment block
- `overview` contains the text under `## Overview`
- `scenarios` is an empty array if no `## Scenarios` section exists

---

### Scenario 2: Parse a spec with multiple scenarios

**Steps:**
1. Pass a spec string containing `## Scenarios` with two `### Scenario N:` subsections
2. Each scenario has `**Steps:**` and `**Expected Results:**` blocks

**Expected Results:**
- `scenarios` array has length 2
- Each scenario's `steps` array matches the numbered list items
- Each scenario's `expectedResults` array matches the bullet list items
- Scenario names strip the `Scenario N:` prefix cleanly

---

### Scenario 3: Parse a spec with unknown metadata keys

**Steps:**
1. Pass a spec with an HTML comment containing an unrecognised key: `custom-key: value`

**Expected Results:**
- No error thrown
- Known keys (`module`, `type`, `status`, `auth`, `url`, `framework`) are populated
- Unknown keys are preserved in `meta.extra` as a `Record<string, string>`

---

### Scenario 4: loadAllSpecs finds nested files

**Steps:**
1. Point `loadAllSpecs` at a directory with `.md` files in subdirectories
2. Include a `README.md` that should be excluded

**Expected Results:**
- Returns `ParsedSpec[]` for all `.md` files found recursively
- `README.md` at any level is excluded
- `specKey` for `specs/core/spec-parser.md` is `core/spec-parser`

## Security Notes

None — this is a pure parsing module with no network or auth surface.

## Dependencies

None. This module must have zero runtime dependencies beyond Node.js built-ins.
