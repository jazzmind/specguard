---
id: 2026-10-22-security-no-rate-limit-on-api-endpoints
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No rate limit on API endpoints to prevent LLM budget exhaustion or den"
affects:
  - documentation-api
---
# Security: No rate limit on API endpoints to prevent LLM budget exhaustion or den

## Decision

Resolved spec-level security finding "No rate limit on API endpoints to prevent LLM budget exhaustion or denial-of-service": Add a requirement that the server enforces a per-source or global rate limit on /docs endpoint calls (e.g., requests per second) and returns HTTP 429 when the limit is exceeded, independent of the per-request LLM budget.

Note: Per-caller limits on the team server, tighter for /docs/, 429 with Retry-After (server-rate-limits).
