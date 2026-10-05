---
name: specguard
description: >-
  SpecGuard QA agent. Maintains Living Specs as the single source of truth
  alongside coding work. Use after a build step, when checking spec coverage,
  generating tests from a spec, or validating the app against a spec.
---

<!-- specguard-managed: true -->

# SpecGuard Skill (typescript)

The `specguard` CLI and MCP server run every QA pipeline. Prefer the MCP tools
(`specguard_*`) when available; otherwise use `npx -p specguard-ai specguard <command>`
(or just `specguard <command>` when the CLI is installed with `npm install -g specguard-ai`).

## When to Run

- After implementing or changing a module (check coverage + drift).
- When the user asks for spec coverage, test generation, or validation.
- Security-sensitive files changed (`**/auth/**`, `**/api/**`).

## Quick Reference

| Command | What it does |
|---------|-------------|
| `specguard analyze` | Smart diagnostics — start here when unsure |
| `specguard gap-analysis` | Find unimplemented specs and generate build plans |
| `specguard status` | Spec + test coverage report |
| `specguard reverse --all` | Generate Living Specs from source |
| `specguard generate --all` | Generate test files from specs |
| `specguard align --all` | Map existing tests to spec scenarios |
| `specguard heal --all` | Run tests and auto-fix test bugs |
| `specguard drift` | Detect specs out of sync with code |
| `specguard security --all` | OWASP security test stubs |
| (tests run via) | `npm test` |

Without a global install, run any command as `npx -p specguard-ai specguard <command>`.

## Build-from-specs Loop

1. `specguard gap-analysis` → plans for every unimplemented spec (`.specguard/plans/*`).
2. Implement one module against its spec + plan.
3. `specguard status` → confirm the spec flips to covered.
4. `specguard generate --spec <key>` then `specguard heal --all`.
5. If the repo has many existing tests, run `specguard align --all` to map them to spec scenarios.
6. Repeat until `status` reports full coverage.

Tests for this project run with `npm test`.
