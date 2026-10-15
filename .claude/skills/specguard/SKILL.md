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
| `specguard check` | Spec health for the whole system: ownership, tests, proofs, gaps, drift. Start here |
| `specguard spec graph` | The spec tree, the files each spec owns, and rule violations |
| `specguard spec draft` | Write the system spec and functional capability specs from existing code |
| `specguard history add` | Record why a requirement changed: a prompt, plan or decision |
| `specguard test run` | Run the tests and record the results as proof |
| `specguard verify --all --url <base>` | Judge the running app against each capability's problem and value |
| `specguard security scan` | Code, dependency, secret and spec-level findings as one remediation plan |
| `specguard serve` | Docs and audit API, with a web UI |
| (tests run via) | `npm test` |

Without a global install, run any command as `npx -p specguard-ai specguard <command>`.

## Build-from-specs Loop

1. `specguard check --gaps` → what is unowned, untested, stale or failing.
2. Implement one capability's requirements against its spec.
3. Write tests and tag each with the requirement it proves (`// [claims: capabilities/<id>#<claim-id>]`).
4. `specguard test run` → results become proof; `specguard check` shows what is proven.
5. Repeat until every requirement is proven.

Tests for this project run with `npm test`.
