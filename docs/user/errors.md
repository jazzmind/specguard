---
title: "SpecGuard Core Error Classes"
sidebar_label: "SpecGuard Core Error Classes"
description: "SpecGuard's core error classes give every thrown error a structured identity, a numeric exit code, and a clear human-readable message so the CLI can always exit cleanly with the right status."
category: "core"
order: 50
generated: true
---

# SpecGuard Core Error Classes

SpecGuard uses a small, structured hierarchy of error classes to make sure that every failure — whether it's a missing config file or a schema violation — carries enough information for the CLI to exit with the correct status code and for you to understand exactly what went wrong.

---

## The Base Class: `SpecGuardError`

All errors thrown by SpecGuard core extend `SpecGuardError`, which itself extends the native JavaScript `Error` class. This means you can catch any SpecGuard error with a single `catch (err)` block and reliably test `err instanceof SpecGuardError`.

Every `SpecGuardError` instance exposes two additional read-only properties on top of the standard `Error` interface:

| Property | Description |
|---|---|
| `exitCode` | A numeric value (sourced from the `ExitCode` enum) that the CLI uses to set the process exit status. Defaults to `ExitCode.InternalError` when no code is explicitly provided. |
| `cause` | An optional reference to the underlying error or value that triggered this error, useful for debugging and error chaining. |

The `name` property of every `SpecGuardError` instance is set to `"SpecGuardError"`, making it easy to identify in logs and stack traces.

---

## `ConfigNotFoundError`

This error is raised when SpecGuard searches for a `.specguard/config.json` file and cannot locate one anywhere in the directory tree.

**When you see this error**, it means SpecGuard walked up the directory hierarchy starting from the path shown in the message and found no configuration file. The error message will always include:

- The **path it started searching from** (`searchedFrom`), so you know exactly where the search began.
- A **hint to run `specguard init`**, which will create a fresh configuration file in the correct location.

`ConfigNotFoundError` is a full `SpecGuardError` (and therefore also a standard `Error`), so all three `instanceof` checks hold:

```js
err instanceof Error              // true
err instanceof SpecGuardError     // true
err instanceof ConfigNotFoundError // true
```

The `name` property is set to `"ConfigNotFoundError"`.

---

## `ConfigInvalidError`

This error is raised when SpecGuard finds a `.specguard/config.json` file but the file's contents fail schema validation.

The error message is always prefixed with **`"Invalid config:"`** followed by a description of the specific validation problem, so you can quickly identify which part of your configuration needs to be corrected.

Like `ConfigNotFoundError`, this class is a full member of the error hierarchy:

```js
err instanceof Error              // true
err instanceof SpecGuardError     // true
err instanceof ConfigInvalidError // true
```

If the validation failure was itself caused by an underlying error (for example, a JSON parse error), that original error is forwarded to the `cause` property on the base class, giving you the full picture when debugging.

The `name` property is set to `"ConfigInvalidError"`.

---

## Exit Codes

All error classes in this module rely on the `ExitCode` enum (from `./exit-codes.js`) to populate the `exitCode` property. When no specific exit code is supplied at construction time, the default is `ExitCode.InternalError`. This ensures the CLI layer never exits with an ambiguous or zero status when an error is thrown.

---

## Quick Reference

| Class | `name` | Default `exitCode` | Key message content |
|---|---|---|---|
| `SpecGuardError` | `"SpecGuardError"` | `ExitCode.InternalError` | Custom message passed at construction |
| `ConfigNotFoundError` | `"ConfigNotFoundError"` | `ExitCode.InternalError` | Includes `searchedFrom` path + hint to run `specguard init` |
| `ConfigInvalidError` | `"ConfigInvalidError"` | `ExitCode.InternalError` | Prefixed with `"Invalid config:"` + validation detail |
