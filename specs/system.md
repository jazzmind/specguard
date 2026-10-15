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
| [Agentic Verification](capabilities/agentic-verification.md) | The running system is judged against what its specs say it is for, by a browser agent that can see and use it safely, so requirements are verified end to end and not only line by line. | active | 18 |
| [Conformance Testing](capabilities/conformance-testing.md) | Teams can prove, claim by claim, that the current code delivers what the specs say, and see immediately when a proof is no longer trustworthy. | active | 20 |
| [Documentation and API](capabilities/documentation-api.md) | Anyone, human or AI, can read accurate documentation of the system as it is now, pitched at their level, generated from the specs on request and delivered over an API. | active | 18 |
| [Integration Surfaces - CLI, Agents, CI, IDE and Plugins](capabilities/integration-surfaces.md) | People, coding agents and other systems can drive SpecGuard from wherever they work (terminal, agent harness, CI or IDE) and extend it without forking it. | active | 19 |
| [Platform Foundation](capabilities/platform-foundation.md) | Every SpecGuard capability runs on one predictable engine for configuration, model access, cost control, redaction, file access and exit codes, so behaviour is consistent, safe and testable. | active | 19 |
| [Requirement History](capabilities/requirement-history.md) | Anyone can see which prompts, approved plans and decisions shaped each capability, so the reason behind a requirement survives the chat session that produced it. | planned | 15 |
| [Security Scanning and Remediation](capabilities/security-and-remediation.md) | Security and risk teams find flaws in code, dependencies, secrets and (planned) the specs themselves, and get fixes proposed with proof that behaviour was preserved, in a form other systems can automate. | active | 19 |
| [Spec Authoring](capabilities/spec-authoring.md) | Teams get an accurate, machine-checked set of functional specs for their system, created from existing code or documents and kept consistent as it grows. | active | 19 |
| [Traceability and Drift](capabilities/traceability-and-drift.md) | At any moment a team can see how every spec relates to its code, tests, docs and proof, and be told as soon as code and specs stop agreeing. | active | 20 |
| [Workspaces - Multi-Repo and Monorepo](capabilities/workspaces.md) | Teams that split one system across several repos or packages can treat it as one system, so a change in one place shows what else must be re-checked. | active | 19 |
<!-- specguard:capability-map:end -->

## Non-goals

- Replacing the test runner, the issue tracker or the CI system. SpecGuard integrates with them.
- Generating one spec per source file. Specs follow functionality, not file layout.
- Hosting a general documentation site. The docs API is for viewers to render from.
