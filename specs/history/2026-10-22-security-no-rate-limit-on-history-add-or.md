---
id: 2026-10-22-security-no-rate-limit-on-history-add-or
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No rate limit on `history add` or MCP `history_add` calls from automat"
affects:
  - requirement-history
---
# Security: No rate limit on `history add` or MCP `history_add` calls from automat

## Decision

Resolved spec-level security finding "No rate limit on `history add` or MCP `history_add` calls from automated agents": Add a requirement capping the number of history entries that can be created per minute per caller identity (e.g., 10/min for the MCP tool, unlimited for interactive CLI use) and that the MCP tool returns a structured error when the limit is exceeded rather than silently dropping the entry.

Note: The MCP history_add tool is limited to 20 a minute (SPECGUARD_MCP_HISTORY_PER_MIN) and returns an error result, not a drop (mcp-limits).
