---
title: "File Writer"
sidebar_label: "File Writer"
generated: true
---

# File Writer

The File Writer is the single, consistent way SpecGuard writes files to disk. Every pipeline routes its output through this module, which means you always get the same predictable behavior: files are written in UTF-8, and any folders that need to exist along the way are created for you automatically.

## What It Does

### Writing a File

When you call `writeFile(path, content)`, the module writes your content to the specified path as a UTF-8 encoded file. You don't need to worry about whether the destination folder exists — if any part of the directory path is missing, it is created automatically before the file is written. This means you can write to a deeply nested path like `output/docs/api/reference.md` without manually creating each intermediate folder first.

### Ensuring a Directory Exists

The `ensureDir(dir)` function creates a directory at the given path, including any missing parent directories. If the directory already exists, the call succeeds quietly — nothing is overwritten or disrupted. This is useful when you need to guarantee a folder is in place before performing a series of related writes.

## Consistent Behavior Across Pipelines

Because all pipelines use the File Writer rather than calling the filesystem directly, encoding and directory-creation behavior is uniform throughout SpecGuard. You won't encounter situations where one pipeline creates missing directories and another doesn't — the rules are the same everywhere.
