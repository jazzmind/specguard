# CLI Entrypoint

<!--
  module: src/cli/index.ts
  type: cli
  status: draft
-->

## Overview

The `specguard` CLI binary. Parses arguments, loads config from `.specguard/config.json`, and dispatches to the appropriate pipeline. Each subcommand maps 1:1 to a pipeline. The CLI itself contains no business logic — it is pure wiring between arguments and pipeline functions.

## Acceptance Criteria

- [ ] `specguard --help` prints usage and lists all subcommands
- [ ] `specguard --version` prints the current package version
- [ ] Unknown subcommand exits with code 1 and a clear error message
- [ ] Config is loaded from `.specguard/config.json` relative to cwd, or from `--config <path>`
- [ ] Missing config file exits with code 1 and actionable message ("Run `specguard init` to create a config")
- [ ] All subcommands accept `--help` for subcommand-specific usage
- [ ] Exit codes match the typed constants in `src/core/exit-codes.ts`
- [ ] `specguard init` scaffolds `.specguard/config.json` and `specs/README.md` if they don't exist

## Subcommands

| Command | Pipeline | Key flags |
|---|---|---|
| `init` | (scaffolding, no pipeline) | `--with-playwright` |
| `import <file>` | import | `--app`, `--format` |
| `reverse` | reverse-generate | `--app`, `--file`, `--force` |
| `generate` | forward-generate | `--spec`, `--all`, `--framework` |
| `heal` | heal | `--spec`, `--all`, `--max-retries` |
| `validate` | validate | `--spec`, `--all`, `--url`, `--auth`, `--out` |
| `security` | security | `--spec`, `--all`, `--with-sast` |
| `docs` | doc-generate | `--spec`, `--all`, `--out` |
| `drift` | drift | `--since`, `--spec` |
| `matrix` | matrix | `--out`, `--format` |
| `status` | status | (none) |

## Exit Codes

```
0  All checks passed / command succeeded
1  Internal error (unexpected, config missing, bad args)
2  Validation failed (critical/major issues found)
3  Drift detected (specs are stale)
4  Missing specs (uncovered features found by status)
5  Security issues found
7  Heal failed (tests still broken after max retries)
```

## Scenarios

### Scenario 1: Happy path — specguard reverse runs to completion

**Steps:**
1. Run `specguard reverse --app my-app` from a directory with valid `.specguard/config.json`
2. Config has a matching app `"my-app"` with source globs that resolve to existing files

**Expected Results:**
- Pipeline runs, spec files are created/updated in the configured `specDir`
- Exit code 0
- Progress messages printed to stdout

---

### Scenario 2: Config file not found

**Steps:**
1. Run `specguard reverse` from a directory with no `.specguard/config.json`

**Expected Results:**
- Error printed: "No config found. Run `specguard init` to create one."
- Exit code 1
- No files written

---

### Scenario 3: init scaffolds correctly

**Steps:**
1. Run `specguard init` in an empty directory

**Expected Results:**
- `.specguard/config.json` created with sensible defaults (auto-detected framework if `package.json` present)
- `specs/README.md` created
- `.cursor/skills/specguard/SKILL.md` copied into place
- `.cursor/mcp.json` updated with `specguard-mcp` entry
- User shown next steps

---

### Scenario 4: Subcommand --help

**Steps:**
1. Run `specguard validate --help`

**Expected Results:**
- Usage printed showing all flags for `validate`
- Exit code 0

## Security Notes

- Config may reference env var names for credentials (e.g. `"apiKeyEnv": "ANTHROPIC_API_KEY"`). The CLI resolves these at runtime from `process.env`. Never log the resolved values.
- The `validate` and `heal` subcommands accept `--auth <profile>` which loads credentials from config. These are passed to the auth state machine, never to LLM calls.

## Dependencies

- `specs/core/spec-parser.md` — loaded before any pipeline runs
- `specs/core/config.md` — config loading
- `specs/core/exit-codes.md` — exit code constants
