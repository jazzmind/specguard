---
title: "Config Loader"
sidebar_label: "Config Loader"
description: "The Config Loader finds, reads, and validates your .specguard/config.json file, making it the single source of configuration for every SpecGuard command."
category: "core"
order: 10
generated: true
---

# Config Loader

The Config Loader is the heart of SpecGuard's configuration system. Every command you run — from linting pipelines to generating reports — draws its settings from a single `.specguard/config.json` file. The Config Loader is responsible for finding that file, reading it, and making sure it's valid before any pipeline ever sees it.

---

## How It Works

When SpecGuard starts, it calls `loadConfig()` internally. You don't need to invoke this yourself; it runs automatically as part of every SpecGuard command. Here's what happens under the hood:

1. **Directory search** — Starting from your current working directory (or a directory you specify), the loader walks up through parent directories until it finds a folder named `.specguard/` containing a `config.json` file.
2. **Parsing** — The file is read and parsed as JSON.
3. **Validation** — The parsed content is checked against SpecGuard's configuration schema to make sure all required fields are present and correctly typed.
4. **Root resolution** — The directory that contains the `.specguard/` folder is recorded as `rootDir`. Pipelines use this to resolve any paths in your config relative to your project root.

The loader is the **only** way configuration enters SpecGuard. Pipelines never read `config.json` directly — they always receive a validated, fully-resolved config object.

---

## Locating Your Config File

SpecGuard looks for `.specguard/config.json` by starting at the current working directory and climbing up through each parent directory in turn. This means you can run SpecGuard commands from any subdirectory of your project and it will still find the right config file at the project root.

```
my-project/          ← .specguard/config.json lives here (rootDir)
├── .specguard/
│   └── config.json
├── src/
│   └── feature/     ← you can run `specguard` from here and it still works
└── ...
```

---

## Error Handling

The Config Loader raises clear, descriptive errors so you always know exactly what went wrong.

### Config file not found

If no `.specguard/config.json` is found in the current directory or any of its ancestors, SpecGuard throws a **`ConfigNotFoundError`**. This typically means:

- You're running SpecGuard outside of a project that has been initialised.
- The `.specguard/` folder or `config.json` file is missing or misnamed.

**Fix:** Make sure a `.specguard/config.json` file exists somewhere in your project tree. See the [Getting Started guide](#) for how to initialise a new config.

### Config file is invalid

If the file is found but its contents don't match the expected shape — for example, a required field is missing or a value has the wrong type — SpecGuard throws a **`ConfigInvalidError`** with a human-readable message describing exactly which part of the config is invalid.

**Fix:** Review the error message and compare your `config.json` against the [Config Reference](#).

---

## Flexible Config Authoring

The loader is intentionally lenient in a few ways to make your config file easier to maintain:

- **Comments field** — You can include a `_comment` field anywhere in your config (a common convention for adding notes to JSON files). The loader ignores it completely.
- **Unknown keys** — Extra fields that SpecGuard doesn't recognise are silently passed through rather than causing an error. This means you can add your own metadata or future-proof your config without breaking anything.

---

## The `rootDir` Property

After loading, the resolved config object includes a `rootDir` property set to the absolute path of the directory that contains your `.specguard/` folder. You'll see this referenced in pipeline and adapter documentation — it's the base path against which all relative paths in your config are resolved.

You don't need to set `rootDir` yourself; it is always computed automatically by the loader.

---

## Summary

| Behaviour | Detail |
|---|---|
| **Entry point** | `loadConfig(cwd?)` — `cwd` defaults to `process.cwd()` |
| **Search strategy** | Walks up from `cwd` to find the nearest `.specguard/config.json` |
| **On missing file** | Throws `ConfigNotFoundError` |
| **On invalid content** | Throws `ConfigInvalidError` with a readable message |
| **Tolerates** | `_comment` fields and unknown keys |
| **Sets** | `rootDir` to the directory containing `.specguard/` |
| **Used by** | Every SpecGuard pipeline and command |
