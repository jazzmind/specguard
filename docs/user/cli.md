---
title: "CLI Entrypoint"
sidebar_label: "CLI Entrypoint"
generated: true
---

# CLI Entrypoint

## Overview

The `specguard` command-line tool is your primary interface for working with Living Specifications. From a single binary you can scaffold a new project, import existing specs, generate and heal tests, validate behavior, check for drift, and more. Every subcommand loads your project configuration automatically and hands off to the appropriate pipeline — so you get consistent, predictable behavior across your entire workflow.

---

## Getting Started

### Viewing Help

Run `specguard --help` at any time to see a summary of all available subcommands and global options. Every subcommand also accepts its own `--help` flag for more detailed usage:

```bash
specguard --help
specguard generate --help
```

### Checking the Version

```bash
specguard --version
```

This prints the currently installed version of SpecGuard.

---

## Configuration

SpecGuard looks for a configuration file at `.specguard/config.json` relative to your current working directory. If your config lives somewhere else, point to it explicitly with the `--config` flag:

```bash
specguard validate --config path/to/config.json
```

If no config file is found, SpecGuard will exit with a clear message telling you exactly what to do:

```
Config file not found. Run `specguard init` to create one.
```

---

## Subcommands

### `init`

Scaffolds a new SpecGuard project in the current directory. Creates `.specguard/config.json` and `specs/README.md` if they do not already exist.

```bash
specguard init
specguard init --with-playwright
```

| Flag | Description |
|---|---|
| `--with-playwright` | Include Playwright-specific scaffolding |

---

### `import <file>`

Imports an existing specification file into your project.

```bash
specguard import path/to/spec.yaml --app my-app --format openapi
```

| Flag | Description |
|---|---|
| `--app` | The application this spec belongs to |
| `--format` | The format of the source file |

---

### `reverse`

Reverse-generates a Living Specification from an existing codebase or test suite.

```bash
specguard reverse --app my-app --file output-spec.md
specguard reverse --app my-app --file output-spec.md --force
```

| Flag | Description |
|---|---|
| `--app` | The application to reverse-generate from |
| `--file` | Output file path for the generated spec |
| `--force` | Overwrite an existing spec file |

---

### `generate`

Forward-generates tests or other artifacts from your Living Specifications.

```bash
specguard generate --spec specs/auth.md --framework playwright
specguard generate --all --framework jest
```

| Flag | Description |
|---|---|
| `--spec` | Path to a specific spec file |
| `--all` | Run against all specs in the project |
| `--framework` | The test framework to generate for |

---

### `heal`

Attempts to automatically fix broken tests by reconciling them with their Living Specification.

```bash
specguard heal --spec specs/auth.md
specguard heal --all --max-retries 5
```

| Flag | Description |
|---|---|
| `--spec` | Path to a specific spec file |
| `--all` | Heal tests for all specs |
| `--max-retries` | Maximum number of fix attempts before giving up |

---

### `validate`

Validates your application's live behavior against its Living Specifications.

```bash
specguard validate --spec specs/auth.md --url https://staging.example.com
specguard validate --all --url https://staging.example.com --out report.json
```

| Flag | Description |
|---|---|
| `--spec` | Path to a specific spec file |
| `--all` | Validate against all specs |
| `--url` | The base URL of the running application |
| `--auth` | Authentication credentials or token |
| `--out` | Output file path for the validation report |

---

### `security`

Runs security checks against your specifications and, optionally, your source code.

```bash
specguard security --all
specguard security --spec specs/payments.md --with-sast
```

| Flag | Description |
|---|---|
| `--spec` | Path to a specific spec file |
| `--all` | Run against all specs |
| `--with-sast` | Also run static application security testing (SAST) |

---

### `docs`

Generates user-facing documentation from your Living Specifications.

```bash
specguard docs --all --out docs/
specguard docs --spec specs/auth.md --out docs/auth.md
```

| Flag | Description |
|---|---|
| `--spec` | Path to a specific spec file |
| `--all` | Generate docs for all specs |
| `--out` | Output path for the generated documentation |

---

### `drift`

Detects whether your Living Specifications have become stale relative to recent changes.

```bash
specguard drift --since 2024-01-01
specguard drift --spec specs/auth.md --since main
```

| Flag | Description |
|---|---|
| `--since` | A date or Git ref to compare against |
| `--spec` | Limit drift detection to a specific spec |

---

### `matrix`

Generates a coverage matrix showing which features are covered by which specs.

```bash
specguard matrix --out matrix.html --format html
```

| Flag | Description |
|---|---|
| `--out` | Output file path for the matrix |
| `--format` | Output format for the matrix |

---

### `status`

Prints a summary of your project's overall spec coverage and health. Takes no additional flags.

```bash
specguard status
```

---

## Exit Codes

SpecGuard uses distinct exit codes so you can handle different outcomes precisely in CI pipelines and scripts.

| Code | Meaning |
|---|---|
| `0` | Command succeeded / all checks passed |
| `1` | Internal error — unexpected failure, missing config, or bad arguments |
| `2` | Validation failed — critical or major issues were found |
| `3` | Drift detected — one or more specs are stale |
| `4` | Missing specs — uncovered features were found by `status` |
| `5` | Security issues found |
| `7` | Heal failed — tests are still broken after the maximum number of retries |
