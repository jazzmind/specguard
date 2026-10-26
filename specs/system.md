---
id: system
kind: system
title: "SpecGuard"
value: "Teams keep the intent behind their code as the source of truth, and can prove at any moment that the code still delivers it."
status: active
history:
  - 2026-10-15-functional-specs-and-four-pillars
---

# SpecGuard

## Problem

Code is now written quickly, often by AI agents, and it changes constantly. Intent does not survive that.
Requirements live in chat transcripts and people's heads, tests drift away from what the system is meant to do,
documentation goes stale, and security reviews look only at code, so flaws that are really missing or wrong
requirements get through.

**Principle: code is fluid. Specs, and the tests that prove the code conforms to them, are the source of truth.**

## Users

- **Developers and coding agents** who need to know what a system is supposed to do before changing it.
- **Reviewers and auditors** who need evidence that the code delivers what was promised.
- **Security and risk teams** who need findings tied to requirements, and fixes that other systems can automate.
- **End users and operators** who need accurate documentation of the system as it is now.

## Value

- Specs describe functionality in terms of the user or business value it delivers, not individual files.
- Every requirement can be traced to code, tests, docs and the history of why it exists.
- Conformance is proven, not assumed: unit, integration and end-to-end tests, plus agentic browser tests that judge
  the running system against its stated problem and value.
- Docs are always current because they are generated from the specs when requested.
- Security review covers spec-level flaws as well as code-level ones, and produces remediation plans in a stable
  format that other systems can act on.

## Pillars

1. **Specs and requirement history.** A master system spec, about 10-15 functional capability specs that each link
   to many code files, tests and docs, and a committed history of the prompts, plans and decisions that shaped them.
   See spec-authoring and requirement-history.
2. **Conformance.** Generate, run and heal tests; keep one proof ledger; verify the running system with agentic
   browser tests judged against requirements and against problem and value. See conformance-testing,
   traceability-and-drift and agentic-verification.
3. **Documentation.** User, developer and agent docs generated on demand from the specs by a fast model and served
   over an API, together with audit views such as the traceability matrix. See documentation-api.
4. **Security.** Code and spec-level scans that produce remediation plans in one published schema. See
   security-and-remediation.

Multi-repo and monorepo workspaces (workspaces) run across all four pillars. integration-surfaces covers how people,
agents and CI drive SpecGuard; platform-foundation is the shared engine underneath.

## Capability Map

<!-- specguard:capability-map:start -->
| Capability | Value | Status | Claims |
|---|---|---|---|
| [Agentic Verification](capabilities/agentic-verification.md) | The running system is judged against what its specs say it is for, by a browser agent that can see and use it safely, so requirements are verified end to end and not only line by line. | active | 26 |
| [Conformance Testing](capabilities/conformance-testing.md) | Teams can prove, claim by claim, that the current code delivers what the specs say, and see immediately when a proof is no longer trustworthy. | active | 45 |
| [Coverage and Mutation Evidence](capabilities/coverage-and-mutation.md) | A reviewer can see which owned code the tests execute and whether a claim's tests would notice the code changing, with every number carrying what it cannot prove and a mark when the code has moved on since it was measured. | active | 12 |
| [Documentation and API](capabilities/documentation-api.md) | Anyone, human or AI, can read accurate documentation of the system as it is now, pitched at their level, generated from the specs on request and delivered over an API. | active | 23 |
| [Integration Surfaces - CLI, Agents, CI, IDE and Plugins](capabilities/integration-surfaces.md) | People, coding agents and other systems can drive SpecGuard from wherever they work (terminal, agent harness, CI or IDE) and extend it without forking it. | active | 46 |
| [Intent Approval](capabilities/intent-approval.md) | A person, not a tool, signs off that each requirement states what the system should do, and the sign-off is a committed record that lapses the moment the requirement's wording changes. | active | 24 |
| [Platform Foundation](capabilities/platform-foundation.md) | Every SpecGuard capability runs on one predictable engine for configuration, model access, cost control, redaction, file access and exit codes, so behaviour is consistent, safe and testable. | active | 34 |
| [Proof Store](capabilities/proof-store.md) | Every proven commit carries its own small proof record inside git, written only by CI, so a clone or a pull request can read what was proven without rerunning tests, trusting a local file or merging a shared ledger. | active | 15 |
| [Requirement History](capabilities/requirement-history.md) | Anyone can see which prompts, approved plans and decisions shaped each capability, so the reason behind a requirement survives the chat session that produced it. | active | 16 |
| [Security Scanning and Remediation](capabilities/security-and-remediation.md) | Security and risk teams find flaws in code, dependencies, secrets and the specs themselves, and get fixes proposed with proof that behaviour was preserved, in a form other systems can automate. | active | 32 |
| [Spec Authoring](capabilities/spec-authoring.md) | Teams get an accurate, machine-checked set of functional specs for their system, created from existing code or documents and kept consistent as it grows. | active | 34 |
| [Spec-First Changes](capabilities/spec-first-changes.md) | A change goes spec, tests, red, code, green, validated in that order, with enforcement set per capability, so a requirement is approved before it is built, its tests are seen failing before the code exists, and review sees a packet of what changed and what was proven instead of reading code. | active | 45 |
| [Local-first operation with an optional team server](capabilities/team-server.md) | SpecGuard works fully on one machine, and when a team server exists it also gives everyone shared proof from CI, shared documents and shared plans, without anyone depending on it. | active | 16 |
| [Test Strength](capabilities/test-strength.md) | A claim counts as tested only when a real test that can fail is tagged to it, so skipped, gated or empty tests and weakened assertions are caught before they pass for proof. | active | 12 |
| [Traceability and Drift](capabilities/traceability-and-drift.md) | At any moment a team can see how every spec relates to its code, tests, docs and proof, and be told as soon as code and specs stop agreeing. | active | 42 |
| [Workspaces - Multi-Repo and Monorepo](capabilities/workspaces.md) | Teams that split one system across several repos or packages can treat it as one system, so a change in one place shows what else must be re-checked. | active | 31 |
<!-- specguard:capability-map:end -->

## Trust model

What SpecGuard assumes, and the controls it has instead of authentication where authentication does not fit. Security reviews of the capability specs repeatedly ask for authentication on the CLI, the local API and the MCP server; this is why those are not in the specs, and what stands in for them.

- **The CLI and the stdio MCP server run as the user who started them.** They hold that user's files and keys, the way any developer tool does, and a client that can start them can already do what they do. There is no one to authenticate. Controls: an agent's reach through MCP is limited (spec files inside the project only, public URLs and project files for import, hosts the project lists for verification, per-minute limits, a read-only mode); the credentials SpecGuard holds are masked from every prompt, from logs and from test commands.
- **The project's `.specguard/config.json` is code.** It can set the command a test run executes, so running SpecGuard in a repository you do not trust is running that repository's code; `extends` adds no power the config did not already have, which is why it may point outside the repository (shared configs across repos). Review a config change as you review a build script.
- **`specguard serve` is a read-only view for its own user, on loopback.** It checks the `Host` header (so a web page cannot read it through DNS rebinding), sets no CORS, and refuses a wider bind without `--allow-remote`. Other processes of the same user can read it, as they can read the files it serves. To share a project use the team server.
- **The team server has authentication.** Tokens, a sign-in header honoured only from a trusted proxy, roles, per-caller rate limits, audit entries for token and plan changes. See its capability.
- **Files in `.specguard/` are evidence, not authority.** The proof ledger and the drift registry are repository files: whoever can write the repository can write them, as they can write the tests. A ledger edited by hand is caught the way a test edited by hand is: by CI re-running the tests and the server's snapshots, and by review of the diff. They carry no signature because a key kept beside them would add nothing; the controls that matter are branch protection and a CI run that proves claims from a clean checkout. Files that hold secrets or personal data (`.env`, saved logins, evidence, the prompt inbox) are owner-only and are never staged by the commit command.
- **Generated tests and specs are code a person reviews.** Model output is written only to a path derived from the spec, never one the model chose, and reaches the branch through a pull request; it is not statically filtered, because an allowlist of imports would break real tests without stopping a determined output. Repairs and dependency updates are limited to named files and merged by a person (apart from the narrow auto-merge policy).
- **LLM spend is bounded per process.** `llm.budget` (dollars, tokens, calls) is checked in the process that makes the calls, so a fleet of parallel CI jobs has one budget each, not one between them. Use the provider's own spend limit for a shared cap; the budget is a guard against a runaway loop in one run.

## Non-goals

- Replacing the test runner, the issue tracker or the CI system. SpecGuard integrates with them.
- Generating one spec per source file. Specs follow functionality, not file layout.
- Hosting a general documentation site. The docs API is for viewers to render from.
