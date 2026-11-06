---
id: existing-code
kind: journey
title: "Quickstart: working with existing code"
audience: user
order: 14
useCase: Bring a mature codebase with existing tests under SpecGuard without rewriting anything.
related:
  - spec-authoring
  - conformance-testing
  - traceability-and-drift
  - proof-store
---

# Quickstart: working with existing code

## Goal
Adopt SpecGuard on a codebase that already has code and tests: draft capability specs from what is there, link the tests you already have, and record proof from your own test runs.

## Prerequisites
- A git repository with a working test suite that can write a machine-readable report.
- A clean working tree, so you can review what SpecGuard writes with `git diff`.

## Steps
### Initialise
```bash
specguard init
```

`init` detects the language, monorepo layout and test framework and writes `.specguard/config.json`. Check each app's `sources` and its `test` block (command and reporter). Add `--with-playwright` for browser tests or `--ci github` to write the CI workflows at the same time.

### Draft specs from the code
```bash
specguard spec draft
specguard spec draft --yes
```

The first command shows a reviewable map of the capabilities it proposes. `--yes` writes `specs/system.md` and one functional capability spec per piece of value, each owning many files. Use `--guidance "<text>"` to steer the grouping. The older `specguard reverse` writes one spec per source file; `specguard spec consolidate` turns such specs into capability specs and re-keys tags, proofs and drift state.

### Link the tests you already have
```bash
specguard spec tag --list
specguard spec tag --yes
```

Tests are mapped to the requirements they prove. `specguard align --all` maps scenarios and claims to test assertions with a model, for suites that have no tags yet.

### Record proof from your own runs
Run your tests with a JSON or JUnit reporter and ingest the report:

```bash
npx vitest run --reporter=json --outputFile=reports/vitest.json
specguard results ingest reports/vitest.json
specguard proof status
```

A claim is `proven` when a test carrying its tag passed and none failed. Or let SpecGuard run the configured suites: `specguard test run`.

### Find the gaps
```bash
specguard check
specguard check --gaps
specguard gap-analysis --all
```

`check` lists source files no spec owns (`missing-spec`), orphan specs, untested and unproven claims. `gap-analysis` writes an implementation plan for the missing coverage to `.specguard/plans/`.

### Turn drafts into intent
Read each drafted capability. Delete requirements that only describe an implementation accident, sharpen the ones that matter, and approve them with `specguard spec approve` in your own terminal. From then on, changes follow [the change protocol](new-features.md) and the specs are the source of truth, not a description of the code.

### Migrate an older repository
If the repository already uses an older SpecGuard layout:

```bash
specguard migrate
specguard migrate --yes
```

The first command lists every step as a dry run; `--yes` does the ones the tool may do itself.

## Outcome
Existing code is owned by capability specs, existing tests are linked to claims, and `check` reports real gaps without you having rewritten anything.

## Related
- [Detecting drift](drift.md)
- [QA automation](qa-automation.md)
- [Adding a new feature](new-features.md)
