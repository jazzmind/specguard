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

# SpecGuard Parallel Agent (Bootstrap v0)

This is the bootstrap version of the SpecGuard skill. It operates **manually** — creating and updating spec files directly — because the `specguard` CLI does not yet exist. As each pipeline is built, this skill will be updated to delegate to the CLI.

## When to Run

Run automatically after any of these events:
- A plan phase completes (new module written, existing module changed)
- Security-sensitive files are changed (`**/auth/**`, `**/middleware/**`, `**/api/**`)
- The user asks for spec coverage, test generation, or validation

## After Each Plan Phase — Manual Reverse

1. **Identify what changed.** List the files created or modified in this plan phase.
2. **Check spec coverage.** For each changed `src/` file, look for a corresponding spec in `specs/`.
   - `src/core/spec-parser.ts` → check `specs/core/spec-parser.md`
   - `src/pipelines/reverse-generate.ts` → check `specs/pipelines/reverse-generate.md`
   - `src/adapters/playwright.ts` → check `specs/adapters/playwright.md`
3. **Create or update specs.** For each file without a spec, create one now using the format in `specs/README.md`.
4. **Report coverage.** Tell the user: which specs were created, which were updated, and which files still lack specs.

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

## Manual Test Generation (until `specguard generate` exists)

When a spec has stable scenarios and the corresponding source module is written:
1. Read the spec's `## Scenarios` section
2. Read the source module
3. Write a test file at `tests/<area>/<name>.test.ts` using Vitest
4. Each scenario → one `it()` block with the scenario name as the title
5. Use `src/core/spec-parser.ts` as a reference for the first test file structure

## Security Check (until `specguard security` exists)

When auth, middleware, or API files change:
1. Read the spec's `## Security Notes` section
2. Check the changed code against those notes
3. Flag any discrepancy as a comment in the plan or directly to the user

## Upgrading This Skill

As each CLI command is implemented, update this skill to call it:
- `specguard reverse` built → replace "Manual Reverse" section with CLI invocation
- `specguard generate` built → replace "Manual Test Generation" with CLI invocation
- `specguard security` built → replace "Security Check" with CLI invocation

Track the current bootstrap state at the top of this file by updating the version comment.
