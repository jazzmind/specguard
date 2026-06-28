---
title: "SpecGuard Core – File Reader Abstraction"
sidebar_label: "SpecGuard Core – File Reader Abstraction"
description: "The File Reader Abstraction is a centralised module that provides consistent, async file-reading and glob-expansion utilities for all SpecGuard pipelines, handling encoding, path resolution, and dot-file exclusion automatically."
category: "core"
order: 20
generated: true
---

# SpecGuard Core – File Reader Abstraction

## Overview

The **reader module** is the single, authoritative way that all SpecGuard pipelines read files from disk. Rather than letting individual pipeline code reach directly into the filesystem, every read operation is routed through this shared abstraction. This guarantees that character encoding, path handling, and glob expansion behave identically no matter which pipeline is running.

The module exposes three async functions:

| Function | Purpose |
|---|---|
| `readFile(filePath)` | Read the full text content of a file |
| `fileExists(filePath)` | Check whether a path is accessible |
| `expandGlobs(patterns, baseDir)` | Expand glob patterns into a list of matching file paths |

---

## `readFile(filePath)`

Reads the file at `filePath` and returns its complete contents as a **UTF-8 string**.

```js
const content = await readFile('/absolute/path/to/spec.md');
```

If the file does not exist or cannot be read by the current process, `readFile` rejects with an error describing the problem. Always ensure the target path is accessible before calling this function, or handle the rejection appropriately in your code.

---

## `fileExists(filePath)`

Checks whether a given path exists and is accessible to the running process. Returns `true` if the path is reachable, or `false` if it does not exist or is inaccessible — it **never throws** in either case.

```js
const exists = await fileExists('/absolute/path/to/spec.md');

if (exists) {
  // safe to read
}
```

This makes `fileExists` safe to use as a guard before performing a read, without needing a surrounding `try/catch`.

---

## `expandGlobs(patterns, baseDir)`

Expands one or more glob patterns into a concrete list of matching file paths, resolved relative to the supplied `baseDir`.

```js
const files = await expandGlobs(['**/*.md', 'specs/**/*.yaml'], '/project/root');
```

### Behaviour and guarantees

- **Base directory resolution** — all patterns are resolved relative to `baseDir`, and every path in the returned array is **absolute**.
- **Files only** — directories are never included in the results.
- **Dot-files excluded** — hidden files (those whose name begins with `.`) are excluded from results by default.
- **Sorted and deduplicated** — the returned array is sorted lexicographically and contains no duplicate paths, regardless of how patterns overlap.
- **Empty input, no I/O** — if `patterns` is an empty array, `expandGlobs` immediately returns an empty array without touching the filesystem.

### Example output

Given a project rooted at `/project/root`, a call like:

```js
await expandGlobs(['**/*.md'], '/project/root');
```

might return:

```
[
  '/project/root/docs/guide.md',
  '/project/root/README.md',
  '/project/root/specs/overview.md'
]
```

Note that the paths are absolute and sorted alphabetically.

---

## Why a centralised reader?

Routing all file reads through a single module provides several practical benefits:

- **Consistency** — encoding (UTF-8) and path semantics are enforced in one place, eliminating subtle per-pipeline differences.
- **Predictability** — glob results are always sorted and deduplicated, so pipeline behaviour does not vary based on filesystem ordering.
- **Testability** — pipelines that depend on this module can be tested by swapping out the reader, rather than mocking low-level Node.js APIs throughout the codebase.

---

## Underlying dependencies

The reader module is built on the following libraries:

| Dependency | Role |
|---|---|
| `node:fs/promises` | Low-level async file reading (`readFile`) and accessibility checks (`access`) |
| `node:path` | Path normalisation and resolution to absolute paths |
| `fast-glob` | Glob pattern expansion, configured with `cwd`, `absolute`, `dot`, and `onlyFiles` options |

These are implementation details — pipeline code interacts only with the three functions described above and does not call `node:fs` directly.
