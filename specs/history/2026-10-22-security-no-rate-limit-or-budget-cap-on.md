---
id: 2026-10-22-security-no-rate-limit-or-budget-cap-on
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No rate limit or budget cap on LLM calls from `import` when fetching r"
affects:
  - spec-authoring
---
# Security: No rate limit or budget cap on LLM calls from `import` when fetching r

## Decision

Resolved spec-level security finding "No rate limit or budget cap on LLM calls from `import` when fetching remote URLs": Add a requirement that `import` truncates or rejects any fetched document exceeding a defined character/byte limit (matching or derived from the 20,000-character cap used by `reverse`) before passing content to the LLM, and that the shared LLM layer enforces a per-invocation token budget with a hard exit when exceeded.

Note: Already bounded: each model call carries at most 48,000 characters of the document, a fetched document is capped at 5 MB, and llm.budget applies; now also credential-masked and fenced.
