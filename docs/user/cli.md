---
title: "CLI Entrypoint"
sidebar_label: "CLI Entrypoint"
description: "Complete reference for the specguard CLI binary: how to invoke it, all available subcommands, their key flags, and the exit codes returned by each operation."
category: "reference"
order: 0
generated: true
---

# CLI Entrypoint

The `specguard` command is your single entry point into every SpecGuard workflow. It reads your project configuration, then hands off to the right pipeline — keeping your terminal experience consistent no matter which operation you're running.

---

## Getting help

Every part of the CLI is self-documenting.

```bash
# Print top-level usage and a list of all subcommands
specguard --help

# Print the installed package version
specguard --version

# Get help for a specific subcommand
specguard <subcommand> --help
```

---

## Configuration

By default, `specguard` looks for a configuration file at `.specguard/config.json` relative to your current working directory. You can point it at a different file with the `--config` flag:

```bash
specguard --config path/to/my-config.json <subcommand>
```

If the config file is missing, the CLI exits with an error and tells you exactly what to do:

```
Config file not found. Run `specguard init` to create one.
```

---

## Subcommands

Each subcommand maps directly to a SpecGuard pipeline. The table below shows every available command alongside its most commonly used flags.

| Command | What it does | Key flags |
|---|---|---|
| `init` | Scaffolds `.specguard/config.json` and `specs/README.md` in your project (only creates files that don't already exist) | `--with-playwright` |
| `import <file>` | Imports an existing spec or API definition file into SpecGuard | `--app`, `--format` |
| `reverse` | Reverse-generates a spec from your existing codebase or tests | `--app`, `--file`, `--force` |
| `generate` | Forward-generates test or code artefacts from a spec | `--spec`, `--all`, `--framework` |
| `heal` | Attempts to automatically fix broken tests against a spec | `--spec`, `--all`, `--max-retries` |
| `validate` | Validates a live application against its spec | `--spec`, `--all`, `--url`, `--auth`, `--out` |
| `security` | Runs security checks against a spec | `--spec`, `--all`, `--with-sast` |
| `docs` | Generates documentation from a spec | `--spec`, `--all`, `--out` |
| `drift` | Detects drift between specs and the current state of your code or API | `--since`, `--spec` |
| `matrix` | Produces a coverage matrix across all specs | `--out`, `--format` |
| `status` | Shows an at-a-glance summary of spec coverage across your project | _(none)_ |

> **Tip:** Run `specguard <subcommand> --help` to see the full flag reference for any individual command.

---

## Exit codes

`specguard` uses a consistent set of exit codes so you can integrate it reliably into CI pipelines, shell scripts, and other tooling.

| Code | Meaning |
|------|---------|
| `0` | All checks passed / command succeeded |
| `1` | Internal error — unexpected failure, missing config, or bad arguments |
| `2` | Validation failed — critical or major issues were found |
| `3` | Drift detected — one or more specs are stale |
| `4` | Missing specs — uncovered features were found by `status` |
| `5` | Security issues found |
| `7` | Heal failed — tests are still broken after the maximum number of retries |

### Example: failing a CI job on drift

```bash
specguard drift --since main
if [ $? -eq 3 ]; then
  echo "Specs are out of date — please update them before merging."
  exit 1
fi
```

---

## Unknown subcommands

If you type a subcommand that SpecGuard doesn't recognise, the CLI prints a clear error message and exits with code `1`. No silent failures.

```bash
$ specguard frobnicate
Error: Unknown subcommand "frobnicate". Run `specguard --help` to see available commands.
```
