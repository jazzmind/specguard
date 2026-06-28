---
title: "File Writer"
sidebar_label: "File Writer"
description: "The File Writer is a core module that handles all filesystem writes across SpecGuard pipelines, automatically creating missing directories and ensuring consistent UTF-8 encoding."
category: "core"
order: 20
generated: true
---

# File Writer

The File Writer is the single, consistent interface that every SpecGuard pipeline uses to write files to disk. Rather than calling the filesystem directly, pipelines delegate all write operations to this module — keeping encoding, error handling, and directory management uniform across the entire tool.

## What It Does

Whenever SpecGuard needs to write output to disk, the File Writer takes care of two things automatically:

1. **Creates any missing parent directories.** You never need to manually create a folder structure before writing a file. If the destination path contains directories that don't yet exist, they are created recursively before the file is written.
2. **Writes content as UTF-8.** All file output is encoded as UTF-8, ensuring consistent, predictable text files regardless of the pipeline producing them.

## Key Operations

### Writing a File

The `writeFile(path, content)` operation writes the given text content to the specified path. If any intermediate directories in the path are missing, they are created automatically before the write takes place. You do not need to call any directory-creation step yourself — a single call is all that's needed.

**Example flow:**

- You specify an output path such as `dist/reports/summary.md`.
- If `dist/` or `dist/reports/` do not exist, the File Writer creates them.
- The content is then written to `dist/reports/summary.md` as a UTF-8 text file.

### Ensuring a Directory Exists

The `ensureDir(dir)` operation guarantees that a given directory path exists. It creates the directory (and any missing parents) recursively. If the directory already exists, the operation completes successfully without error — making it safe to call at any point without needing to check first.

## Why This Matters

By routing all filesystem writes through the File Writer, SpecGuard pipelines stay focused on generating content rather than managing filesystem concerns. Encoding is always consistent, nested output paths just work, and there is no risk of a pipeline failing simply because an output folder hasn't been created yet.
