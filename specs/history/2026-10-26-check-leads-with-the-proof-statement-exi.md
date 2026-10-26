---
id: 2026-10-26-check-leads-with-the-proof-statement-exi
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "check leads with the proof statement; exit 13 only under a gate"
affects:
  - traceability-and-drift
---
# check leads with the proof statement; exit 13 only under a gate

## Decision

The check summary now starts with one STATEMENT line per capability and a system line, then keeps every earlier line unchanged. The statement is assembled from the repository in a separate module (approvals, testability lint, test strength, a ledger judged by hashes alone, ingested coverage and mutation evidence, git head and dirty files, and with a base ref the change and the weakening) and anything missing is passed as absent so its pillar reads unknown. check --explain and --strict, and the same inputs on the MCP tool, expose it. Exit 13 comes last in precedence and only when a gate flag turns a reason blocking, so a repo with every gate off keeps today's exit codes.
