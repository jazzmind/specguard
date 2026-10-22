---
id: 2026-10-22-security-no-rate-limit-or-resource-limit
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No rate-limit or resource-limit requirement for LLM extraction over sp"
affects:
  - workspaces
---
# Security: No rate-limit or resource-limit requirement for LLM extraction over sp

## Decision

Resolved spec-level security finding "No rate-limit or resource-limit requirement for LLM extraction over spec text": Add requirements that (1) `--with-llm` prints a clear warning listing which specs will be sent before proceeding (with a confirmation prompt in interactive mode), (2) there is a configurable per-run request cap, (3) specs matching a configurable exclusion pattern are never sent, and (4) the LLM provider endpoint and data-retention policy must be declared in workspace configuration.

Note: contracts --with-llm sends only each spec's Dependencies section, says so and to which model, lists each spec and stops at --max-llm-specs (default 50) (contracts-llm-cap).
