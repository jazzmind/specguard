---
name: specguard
description: >-
  SpecGuard parallel QA agent. Maintains Living Specs as the single source of
  truth alongside coding work. Triggered automatically after each plan phase,
  when security-sensitive files change, or manually. Runs spec coverage checks,
  creates/updates spec files, generates tests, and flags security concerns.
  Use when the user completes a plan phase, asks to check spec coverage, wants
  tests generated from a spec, or asks to validate the live app against a spec.
---

# SpecGuard Parallel Agent (v1.0)

The `specguard` CLI and MCP server are fully built. Every operation delegates to the CLI (`npx tsx src/cli/index.ts <command>`, or `specguard <command>` once built and linked) or to the MCP tools (`specguard_*`). No manual steps remain.

Available commands: `init`, `reverse`, `generate`, `heal`, `validate` (stub), `security`, `docs`, `drift`, `matrix` (stub), `status`. The MCP server (`specguard-mcp`, stdio) exposes each pipeline as a `specguard_*` tool plus `specguard_read_spec` / `specguard_write_spec`.

## When to Run

Run automatically after any of these events:
- A plan phase completes (new module written, existing module changed)
- Security-sensitive files are changed (`**/auth/**`, `**/middleware/**`, `**/api/**`)
- The user asks for spec coverage, test generation, or validation

## After Each Plan Phase — CLI Reverse + Coverage

Run these after every plan phase and report the results to the user:

```bash
# Generate/update specs for source that lacks them (skips existing specs)
npx tsx src/cli/index.ts reverse --app specguard-core

# Report spec + test coverage (exit 4 if any source file lacks a spec)
npx tsx src/cli/index.ts status

# Detect specs that have drifted from changed source (exit 3 if drift found)
npx tsx src/cli/index.ts drift
```

- `reverse` skips files that already have a spec; pass `--force` to regenerate.
- `status` prints per-app coverage and a totals line; a non-zero exit means uncovered features remain.
- `drift` diffs `HEAD~1..HEAD` by default (`--since <ref>` to widen) and flags specs older than their source.

Report to the user: which specs were created/updated by `reverse`, the coverage % from `status`, and any drift flagged.

## Spec Format (Quick Reference)

```markdown
# Module Title

<!--
  module: src/path/to/module.ts
  type: core | pipeline | adapter | cli
  status: draft | stable
-->

## Overview
What this module does and why it exists.

## Scenarios

### Scenario 1: <name>
**Steps:**
1. ...
**Expected Results:**
- ...

## Security Notes
- Any security constraints this module must enforce

## Acceptance Criteria
- Testable bullets that define "done" for this module
```

## Spec Location Mapping

| Source file | Spec file |
|---|---|
| `src/core/*.ts` | `specs/core/<name>.md` |
| `src/pipelines/*.ts` | `specs/pipelines/<name>.md` |
| `src/adapters/*.ts` | `specs/adapters/<name>.md` |
| `src/cli/*.ts` | `specs/core/cli.md` |

## Test Generation + Self-Healing (CLI)

Generate tests from specs, then heal any that fail:

```bash
# Generate a test file per spec (one it() per scenario); skips existing files
npx tsx src/cli/index.ts generate --all        # or --spec <key>, --force to overwrite

# Run tests and auto-fix test-bugs (vs. reporting real app-bugs); exit 7 if still broken
npx tsx src/cli/index.ts heal --all            # or --spec <key>, --max-retries <n>
```

- `generate` writes `<testOutput>/<feature>.test.ts`, one `it()` per scenario, importing the module from the spec's `meta.module`. Requires `ANTHROPIC_API_KEY` (or the configured `llm.apiKeyEnv`).
- `heal` runs `config.heal.testCommand`, parses failures, and asks the LLM to classify each as a **test bug** (rewritten + re-run, up to `maxRetries`) or an **app bug** (reported, source never touched).

## Security Check + Docs (CLI)

```bash
# Generate OWASP-annotated security test stubs (add --with-sast for Semgrep)
npx tsx src/cli/index.ts security --all          # or --spec <key>

# Generate user-facing docs from specs
npx tsx src/cli/index.ts docs --all              # or --spec <key>, --out <dir>
```

- `security` reads each spec's `## Security Notes` + source module and writes stubs to `tests/security/<feature>.test.ts`; `--with-sast` runs Semgrep in Docker (gracefully degrades if unavailable) and exits 5 on real findings.
- `docs` strips internal sections (Scenarios, Security Notes, metadata) and emits frontmattered Markdown to `docs/user/` by default.

## Upgrading This Skill

All bootstrap phases are complete (v1.0):
- ✅ `specguard reverse` / `status` / `drift` (Phase 3)
- ✅ `specguard generate` / `heal` (Phase 4)
- ✅ `specguard security` / `docs` + MCP server (Phase 5)

`validate` and `matrix` remain CLI/MCP stubs (no pipeline yet); implement those pipelines to light them up.
