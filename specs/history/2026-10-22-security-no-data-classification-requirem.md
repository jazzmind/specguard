---
id: 2026-10-22-security-no-data-classification-requirem
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No data-classification requirement for diffs and spec excerpts sent to"
affects:
  - traceability-and-drift
---
# Security: No data-classification requirement for diffs and spec excerpts sent to

## Decision

Resolved spec-level security finding "No data-classification requirement for diffs and spec excerpts sent to the LLM": Add a requirement that specguard must apply a mandatory redaction pass before any content is sent to the LLM, with a built-in default ruleset that suppresses credential patterns (API keys, passwords, tokens), and that unconfigured redaction must default to deny-send rather than allow-send.

Note: A mandatory credential-masking pass runs on every prompt, on by default (llm.redactPrompts: false is the only opt-out), with llm.redactPatterns for the project's own (prompt-redaction).
