---
id: 2026-10-22-security-no-rate-limit-or-budget-cap-on-2
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No rate-limit or budget cap on LLM calls or browser actions per run"
affects:
  - agentic-verification
---
# Security: No rate-limit or budget cap on LLM calls or browser actions per run

## Decision

Resolved spec-level security finding "No rate-limit or budget cap on LLM calls or browser actions per run": Add a requirement specifying maximum LLM calls per run and per spec, a wall-clock timeout per spec and per run, and a hard upper bound on `validate.maxRounds`, with the run failing with exit code 1 when any budget is exceeded.

Note: At most five steps a round, maxRounds <= 10, a per-spec time budget (verify-run-bounds), plus llm.budget.maxCalls.
