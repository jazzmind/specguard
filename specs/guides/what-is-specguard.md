---
id: what-is-specguard
kind: journey
title: "What is SpecGuard and why it exists"
audience: user
order: 1
related:
  - spec-authoring
  - conformance-testing
  - documentation-api
  - security-and-remediation
---

# What is SpecGuard and why it exists

## Goal
Understand what SpecGuard does, the problem behind it, and how its four pillars fit together, so you can decide where to start.

## Prerequisites
None. This page is background reading. When you are ready to try it, jump to [Quickstart: one repository](single-repo.md).

## Steps
### The problem
Code is now written quickly, often by AI agents, and it changes constantly. Intent does not survive that. Requirements end up in chat transcripts and people's heads, tests drift away from what the system is meant to do, documentation goes stale, and security reviews look only at code, so a flaw that is really a missing or wrong requirement slips through. The gap between what the code does and what it is supposed to do grows with every pull request.

### The idea
**Code is fluid. Specs, and the tests that prove the code conforms to them, are the source of truth.**

SpecGuard keeps that true by running beside your coding agent and your CI. It does not replace your tests, your editor or your agent. It holds the intent in Markdown specs, ties each requirement to the tests and code that deliver it, and tells you, requirement by requirement, whether the evidence still holds.

### The four pillars
1. **Specs and requirement history.** One master spec (`specs/system.md`) states the problem, the users and the value. About ten to fifteen capability specs each describe functionality that delivers user or business value and link to the many code files, tests and docs behind it. `specs/history/` records the prompts, approved plans and decisions that shaped them, so you can answer "why does this requirement exist".
2. **Conformance.** `specguard test run` runs your own tests and records the verdicts in one proof ledger. `specguard verify` drives the running app with a browser agent and judges it against each capability's stated problem and value. Proof is recorded per test layer: unit, integration, e2e, security and functional.
3. **Documentation.** User, developer and agent documentation is generated from the specs, so it reflects the system as it is now. This site is built that way: `specguard docs build` renders it from SpecGuard's own specs.
4. **Security.** `specguard security scan` reviews code, dependencies and secrets, and also reviews each capability spec for flaws that are missing or wrong requirements. Findings go into a remediation plan in a published schema that other systems can read and update.

Multi-repo and monorepo workspaces run across all four.

### What a day looks like
A change goes in one order: spec, approval by a person, tests, red, code, green, validated. The requirement is written and approved before it is built, its tests are seen failing before the code exists, and review reads a short proof packet instead of the diff. Every stage is detected from git, the specs, the test tags and the run records, so editing a file cannot move a change forward.

A capability is `certified` only when its proof comes from CI at a clean commit. The same evidence from a local run is `provisional`. That distinction is the point: a green run on one laptop is not the same as a green run recorded in CI.

### What SpecGuard is not
- It is not a test runner. It runs yours and reads their reports.
- It does not decide what your product should do. People approve intent; SpecGuard shows whether the code still delivers it.
- It does not need a server. Everything works on one machine from files in git; a team server is optional.

## Outcome
You know the vocabulary (spec, capability, claim, proof, drift) and the four pillars, and you know that SpecGuard works from your existing tests and agent rather than around them.

## Related
- [How SpecGuard fits with other tools](fits-with-tools.md)
- [Core concepts](concepts.md)
- [Quickstart: one repository](single-repo.md)
