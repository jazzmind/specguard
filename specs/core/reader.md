# SpecGuard Core – File Reader Abstraction

<!-- module: specguard-core/reader / type: utility / status: draft -->

## Overview

The reader module provides a centralised file-read abstraction for all SpecGuard pipelines, ensuring that encoding choices and glob expansion behaviour remain consistent across the codebase. It exposes three async functions: `readFile`, `fileExists`, and `expandGlobs`. No pipeline code calls `node:fs` directly for read operations; all reads are routed through this module. `expandGlobs` resolves patterns relative to a caller-supplied base directory and always returns absolute, sorted, deduplicated paths. Hidden files (dot-files) are excluded from glob results by default.

## Acceptance Criteria

1. `readFile(filePath)` returns the full UTF-8 text content of the file at `filePath`.
2. `readFile(filePath)` rejects with an error when the file does not exist or is not readable.
3. `fileExists(filePath)` returns `true` when the path exists and is accessible to the process.
4. `fileExists(filePath)` returns `false` (and does not throw) when the path does not exist or is inaccessible.
5. `expandGlobs(patterns, baseDir)` returns an empty array when `patterns` is empty, without performing any filesystem access.
6. `expandGlobs(patterns, baseDir)` resolves all patterns relative to `baseDir` and returns only absolute paths.
7. Results from `expandGlobs` are sorted lexicographically and contain no duplicate paths.
8. `expandGlobs` returns only files (not directories) and excludes dot-files.

## Scenarios

### Scenario 1: Reading an existing UTF-8 file

**Steps:**
1. Create a temporary file containing the UTF-8 text `"hello world"`.
2. Call `readFile` with the absolute path to that file.
3. Await the returned promise.

**Expected Results:**
- The resolved value is the string `"hello world"`.
- No error is thrown.

---

### Scenario 2: Reading a non-existent file

**Steps:**
1. Construct a path that does not exist on the filesystem.
2. Call `readFile` with that path.
3. Await the returned promise inside a try/catch block.

**Expected Results:**
- The promise rejects with an error (e.g., `ENOENT`).
- The catch block receives the error; no value is resolved.

---

### Scenario 3: Checking existence of an accessible path

**Steps:**
1. Create a temporary file on the filesystem.
2. Call `fileExists` with the absolute path to that file.
3. Await the returned promise.

**Expected Results:**
- The resolved value is `true`.
- No error is thrown.

---

### Scenario 4: Checking existence of a missing or inaccessible path

**Steps:**
1. Construct a path that does not exist on the filesystem.
2. Call `fileExists` with that path.
3. Await the returned promise.

**Expected Results:**
- The resolved value is `false`.
- No error is thrown (the function handles the internal exception silently).

---

### Scenario 5: Expanding an empty patterns array

**Steps:**
1. Call `expandGlobs` with an empty array `[]` and any string as `baseDir`.
2. Await the returned promise.

**Expected Results:**
- The resolved value is an empty array `[]`.
- No filesystem or glob library calls are made.

---

### Scenario 6: Expanding glob patterns relative to a base directory

**Steps:**
1. Create a temporary directory containing files `a.ts`, `b.ts`, and a subdirectory `sub/c.ts`.
2. Call `expandGlobs` with patterns `["**/*.ts"]` and the absolute path of the temporary directory as `baseDir`.
3. Await the returned promise.

**Expected Results:**
- The resolved array contains the absolute paths of `a.ts`, `b.ts`, and `sub/c.ts`.
- All returned paths are absolute (begin with the filesystem root).
- The array is sorted lexicographically.
- No path appears more than once.

---

### Scenario 7: Deduplication when multiple patterns match the same file

**Steps:**
1. Create a temporary directory containing a single file `index.ts`.
2. Call `expandGlobs` with patterns `["*.ts", "index.ts"]` and the temporary directory as `baseDir`.
3. Await the returned promise.

**Expected Results:**
- The resolved array contains exactly one entry for `index.ts`.
- No duplicates are present.

---

### Scenario 8: Dot-files are excluded from glob results

**Steps:**
1. Create a temporary directory containing `.hidden.ts` and `visible.ts`.
2. Call `expandGlobs` with patterns `["**/*.ts"]` and the temporary directory as `baseDir`.
3. Await the returned promise.

**Expected Results:**
- The resolved array contains the absolute path of `visible.ts`.
- The absolute path of `.hidden.ts` is **not** present in the result.

---

### Scenario 9: Directories are excluded from glob results

**Steps:**
1. Create a temporary directory containing a subdirectory named `mydir` and a file `myfile.ts`.
2. Call `expandGlobs` with patterns `["**/*"]` and the temporary directory as `baseDir`.
3. Await the returned promise.

**Expected Results:**
- The resolved array contains the absolute path of `myfile.ts`.
- The path of `mydir` (a directory) is **not** present in the result.

## Security Notes

- This module performs no authentication or authorisation checks; callers are responsible for validating that requested paths are within permitted boundaries before invoking these functions.
- `readFile` and `fileExists` accept arbitrary path strings; upstream code must sanitise inputs to prevent path-traversal attacks.
- No secret values, credentials, or API keys are handled by this module.

## Dependencies

| Dependency | Purpose |
|---|---|
| `node:fs/promises` (`readFile`, `access`) | Low-level async file reading and accessibility checks |
| `node:path` | Path normalisation and resolution to absolute paths |
| `fast-glob` (`fg`) | Glob pattern expansion with `cwd`, `absolute`, `dot`, and `onlyFiles` options |