# SpecGuard Specifications

This directory is the **source of truth** for SpecGuard itself. Code is fluid; these specs, and the tests that prove the code conforms to them, are what stay put.

Specs describe *functionality that delivers user or business value*, not source files. One spec links to many code files, tests and docs.

## Layout

```
specs/
  system.md              # the master spec: problem, users, value, pillars, capability map
  capabilities/          # one spec per functional capability (~10)
    spec-authoring.md
    requirement-history.md
    traceability-and-drift.md
    conformance-testing.md
    agentic-verification.md
    documentation-api.md
    security-and-remediation.md
    workspaces.md
    integration-surfaces.md
    platform-foundation.md
  history/               # committed requirement history: prompts, approved plans, decisions
  README.md              # this file
```

Specs from the earlier per-file layout (`core/`, `pipelines/`, `cli/`, `adapters/`, `mcp/`, `extension/`, `plugins/`, `ci/`) still exist during the migration. They are archived under `_archive/v1/` when `specguard check` replaces the file-name-based `status` and `drift`. SpecGuard reads both formats.

## The v2 format

A spec starts with YAML frontmatter. Lists are block lists and every glob is quoted: a flow list such as `[a/{b,c}/**]` or an unquoted glob starting with `*` is invalid YAML, and the parser says so.

```markdown
---
id: spec-authoring            # must equal the file name
kind: capability              # system | capability | component | journey
title: Spec Authoring
parent: system                # a component's parent is a capability
value: One sentence: the user or business value this delivers.
status: active
sources:                      # code this spec owns; may overlap with other specs
  - "src/core/spec-parser.ts"
tests:
  - "tests/core/spec-parser.test.ts"
docs:
  - "README.md"
history:                      # ids of specs/history entries behind this spec
  - 2026-10-15-functional-specs-and-four-pillars
---

# Spec Authoring

## Problem & Value
## Users & Journeys
## Requirements
- [ ] A testable statement about behaviour <!-- claim: stable-claim-id -->
## Scenarios
### Scenario 1: name
**Steps:**
1. ...

**Expected Results:**
- ...
## Security & Data Considerations
## Interfaces
## Out of Scope
```

- `## Problem & Value` is required on capabilities and components. Agentic verification judges the running system against it.
- `## Requirements` replaces `## Acceptance Criteria`; bullets carry claim ids, `<!-- claim: id -->`, that tests cite with `@claim:<specKey>#<id>`.
- A claim's proof goes stale only when that claim's text or the spec's Problem & Value changes, or when the code it covers drifts. Editing another claim, a scenario, `sources` or `history` does not stale it.
- `system.md` is the one master spec (`kind: system`). Capabilities hang off it; a component refines a capability, for example its frontend and backend halves.
- A file may be owned by several specs. A source file owned by none is reported as unowned.

`specguard spec graph` prints the tree with owned-file counts and fails on rule violations: no or several system specs, an id that differs from the file name, an unknown parent, a capability without Problem & Value, a repeated claim id.

## Rules

- Write or update the spec **before** changing behaviour; the spec is the contract.
- Keep granularity at the capability level. If a spec only describes one file, merge it into the capability that file serves.
- Record why requirements changed in `specs/history/` (`specguard history add` once it exists; by hand until then).
