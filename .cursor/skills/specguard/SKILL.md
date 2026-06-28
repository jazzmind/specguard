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

# SpecGuard Parallel Agent (Bootstrap v0.3 — Phase 3)

The `specguard` CLI now exists for **reverse**, **status**, and **drift**. Prefer the CLI for those operations; the remaining steps (test generation, security) are still manual until their pipelines land. Run the CLI with `npx tsx src/cli/index.ts <command>` (source) or `specguard <command>` once built and linked.

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
- ✅ `specguard reverse` / `status` / `drift` built (Phase 3) → CLI invocation in use above
- `specguard generate` built → replace "Manual Test Generation" with CLI invocation
- `specguard security` built → replace "Security Check" with CLI invocation

Track the current bootstrap state at the top of this file by updating the version comment.
