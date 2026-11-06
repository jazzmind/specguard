---
id: concepts
kind: journey
title: "Core concepts"
audience: user
order: 3
related:
  - spec-authoring
  - requirement-history
  - traceability-and-drift
  - proof-store
  - workspaces
  - integration-surfaces
---

# Core concepts

## Goal
Learn the handful of terms every other page uses: specs, capabilities, claims, proofs, history, drift, workspaces and units, overlays, contracts and plugins.

## Prerequisites
Read [What is SpecGuard](what-is-specguard.md) first if you have not.

## Steps
### Specs
A spec is a Markdown file with YAML frontmatter, kept in git under `specs/`. `specs/system.md` is the master spec: the problem, the users, the value and a map of the capabilities. `specs/README.md` documents the format. Specs are the source of truth, and every command reads them.

### Capabilities
A capability spec (`specs/capabilities/<id>.md`) describes one piece of functionality in terms of the value it delivers. Its frontmatter lists `sources` (globs of the code it owns), `tests` and `docs`. Its body has Problem & Value, Users & Journeys, Requirements, Scenarios, Interfaces and Out of Scope. A system has about ten to fifteen of them; a capability links to many files rather than to one. `specguard spec graph` prints the tree and the files each spec owns.

### Claims
A claim is a requirement with a stable id, written as a checklist bullet:

```
- [ ] Orders over fifty dollars ship free. <!-- claim: free-shipping -->
```

A claim ref is `<specKey>#<claimId>`, for example `capabilities/shop#free-shipping`. Tag the tests that prove it with `// [claims: capabilities/shop#free-shipping]` or put `@claim:capabilities/shop#free-shipping` in the test title.

### Proofs
A proof is the recorded result of running the tests that carry a claim's tag. No model is involved. Per claim the verdict is `proven` (a pass and no failure), `failed` (with the failing titles), `unexercised` (no test ran) or `stale` (the spec, an owned source file or a lockfile changed after the proof). Proofs are kept per layer (unit, integration, e2e, security, functional), and a capability can require layers. Local runs write `.specguard/proofs.json`; CI evidence is a git note under `refs/notes/specguard`. A capability is `certified` only on CI evidence at a clean commit; the same evidence from a local run is `provisional`.

### History
`specs/history/` records why requirements changed: prompts, approved plans and decisions, one file each, written with `specguard history add`. A capability's frontmatter `history:` lists the entries behind it. `check` reports an intent gap when code changed after the last recorded intent.

### Drift
Drift is code that changed faster than its spec. `specguard check --drift` gives one verdict per capability; `specguard drift` keeps working for older repos. A proof going stale is the test-side version of the same signal.

### Workspaces and units
A workspace is a list of repositories (or monorepo packages, called units) that SpecGuard treats as one system. It lives in `.specguard/workspace.json`. A repository you choose to leave out is *ignored*, and every workspace command respects that. `check --workspace` prints one row per repository.

### Overlays
An overlay is a separate repository that holds the specs, config and test results for one or more application repositories, so nothing is written into the applications. Register it once per machine with `specguard overlay add`.

### Contracts
A contract is a dependency between specs across repositories: a consumer's spec depends on a provider's endpoint or file. The set of them is the contract graph (`.specguard/contracts.json`). `specguard contracts` builds it, and `specguard impact <target>` answers what else a change reaches.

### Plugins
A plugin adds commands, contract importers or catalog providers. Built-in plugins are `quality`, `git`, `feature-catalog` and `contract-mappings`; npm packages can add more. `specguard plugin list` shows what is on.

### The change protocol
For agent-driven work, `specguard change start` opens a record of intent, a person approves the new wording (`specguard spec approve`), tests are written and seen failing (`change red`), the code is written, and `change green` records the passing run. Each capability has an enforce level (`observe`, `warn`, `enforce`) that decides whether the edit guard blocks code edits without a valid change.

## Outcome
You can read any other page, and `specguard check`'s output, without stopping to look up a term.

## Related
- [Quickstart: one repository](single-repo.md)
- [Quickstart: adding new features](new-features.md)
- [Quickstart: detecting drift](drift.md)
