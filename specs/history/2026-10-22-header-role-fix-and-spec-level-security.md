---
id: 2026-10-22-header-role-fix-and-spec-level-security
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "header role fix and spec-level security triage"
affects:
  - platform-foundation
  - agentic-verification
  - conformance-testing
  - security-and-remediation
  - workspaces
  - integration-surfaces
  - documentation-api
  - team-server
  - requirement-history
  - spec-authoring
---
# header role fix and spec-level security triage

## Prompt

Fix the header bug, then work through the 37 open spec-level security items (Wes, 2026-10-22).

## Decision

The team server's sign-in header makes a maintainer only when the request comes from SPECGUARD_TRUSTED_PROXIES; without it the header is a read-only viewer, so a forged maintainer email gains nothing. The spec-level findings were triaged one by one: what is a real gap was implemented and specified (credential masking at the single LLM call path, fencing of untrusted page/document/spec text, fail-closed redaction hooks inside the project, per-spec time and action bounds, an agent allowlist for browser targets, evidence permissions and retention, test commands without SpecGuard's credentials, MCP rate limits and a read-only mode, serve --allow-remote, team-server rate limits and audit trail, contracts --with-llm cap, evidence paths inside the repo, vuln-ignore expiry warnings, .env permission warning); what asks for authentication on a local CLI, stdio MCP server or repository file was not added and is explained in a Trust model section of the system spec, because there is no second party to authenticate and a key beside the file protects nothing; generated tests are not statically filtered because an import allowlist breaks real tests without stopping a determined output.
