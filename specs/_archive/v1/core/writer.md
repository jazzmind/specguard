# File Writer

<!--
  module: src/core/writer.ts
  type: core
  status: draft
-->

## Overview

Thin abstraction over filesystem writes used by every pipeline. Pipelines never call `node:fs` directly — they write through this module so behavior (intermediate directory creation, encoding) stays consistent. Writes are UTF-8 and create any missing parent directories automatically.

## Acceptance Criteria

- [ ] `writeFile(path, content)` writes UTF-8 content to `path`
- [ ] `writeFile` creates intermediate directories recursively before writing
- [ ] `ensureDir(dir)` creates a directory recursively, succeeding if it already exists

## Scenarios

### Scenario 1: Write to a nested path

**Steps:**
1. Call `writeFile(dir/a/b/c.txt, content)` where `dir/a/b` does not exist
2. Read the file back

**Expected Results:**
- The intermediate directories `a/b` are created
- The file contains exactly `content` (UTF-8)

---

### Scenario 2: ensureDir is idempotent

**Steps:**
1. Call `ensureDir(dir)` twice on the same path

**Expected Results:**
- No error is thrown on the second call
- The directory exists afterward

## Dependencies

- `node:fs/promises`, `node:path`
