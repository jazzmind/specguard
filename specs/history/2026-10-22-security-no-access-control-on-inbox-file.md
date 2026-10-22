---
id: 2026-10-22-security-no-access-control-on-inbox-file
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No access control on inbox file containing redacted but sensitive prom"
affects:
  - requirement-history
---
# Security: No access control on inbox file containing redacted but sensitive prom

## Decision

Resolved spec-level security finding "No access control on inbox file containing redacted but sensitive prompt data": Add a requirement that `history inbox` creates `.specguard/history/inbox.jsonl` with owner-read/write-only permissions (mode 0600 on POSIX systems) and that `history add` / `history capture` create committed entry files with at most 0644. Document the expected umask or explicit chmod call.

Note: The inbox is created 0600, prompts are cut to 50,000 characters and redacted first (hook-input-bounded).
