---
title: "Config Loader"
sidebar_label: "Config Loader"
generated: true
---

# Config Loader

## Overview

The Config Loader is responsible for finding and reading the `.specguard/config.json` file that powers every SpecGuard command. Whenever you run a SpecGuard command, the loader automatically locates your configuration, validates it, and makes it available to the rest of the pipeline — you never need to point SpecGuard at your config file manually.

---

## How SpecGuard Finds Your Config

When a SpecGuard command runs, the loader starts in the current working directory and walks up through parent directories until it finds a `.specguard/config.json` file. This means you can run SpecGuard commands from anywhere inside your project and it will correctly locate your configuration at the project root.

The directory that contains the `.specguard/` folder is automatically recorded as `rootDir`. All other paths in your configuration are resolved relative to this directory, so you can use project-relative paths throughout your config without worrying about where you invoke SpecGuard from.

---

## What Happens When Config Is Loaded

Once the config file is found, SpecGuard:

1. **Reads and parses** the JSON file.
2. **Validates** the parsed content against the expected configuration schema.
3. **Returns** the validated configuration, with `rootDir` set to the directory containing `.specguard/`.

If your config file includes a `_comment` field (a common convention for leaving notes in JSON files), SpecGuard ignores it gracefully. Any additional unknown keys in the file are also tolerated and passed through without causing errors.

---

## Error Conditions

### Config Not Found

If SpecGuard cannot locate a `.specguard/config.json` file in the current directory or any of its ancestors, it will throw a `ConfigNotFoundError`. If you see this error, make sure:

- You are running the command from within your project directory.
- Your project has a `.specguard/config.json` file at the root level.

### Config Invalid

If a `.specguard/config.json` file is found but its contents do not match the expected structure, SpecGuard will throw a `ConfigInvalidError` with a descriptive message explaining what is wrong. Review the message to identify which field is missing or incorrectly formatted, then correct your config file accordingly.

---

## Notes for Config Authors

- Place your `.specguard/config.json` at the root of your repository so it is discoverable from any subdirectory.
- Use project-relative paths for any path values in your config — SpecGuard resolves them against `rootDir` automatically.
- You may include a `_comment` field anywhere in your config JSON to leave notes for your team; SpecGuard will ignore it.
