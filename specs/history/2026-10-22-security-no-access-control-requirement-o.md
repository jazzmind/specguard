---
id: 2026-10-22-security-no-access-control-requirement-o
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No access control requirement on LLM key environment variables"
affects:
  - traceability-and-drift
---
# Security: No access control requirement on LLM key environment variables

## Decision

Resolved spec-level security finding "No access control requirement on LLM key environment variables": Add a requirement that LLM API key environment variables must be sourced from a secrets store with least-privilege access, must not be printed to stdout/stderr or logs by any specguard command, and must not be forwarded to sub-processes that do not need them.

Note: Keys are withheld from test commands unless test.passEnv names them (test-env-withheld), masked in prompts and logs, and never printed.
