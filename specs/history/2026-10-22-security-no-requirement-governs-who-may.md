---
id: 2026-10-22-security-no-requirement-governs-who-may
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No requirement governs who may invoke validation or the MCP tool again"
affects:
  - agentic-verification
---
# Security: No requirement governs who may invoke validation or the MCP tool again

## Decision

Resolved spec-level security finding "No requirement governs who may invoke validation or the MCP tool against arbitrary URLs": Add a requirement that (a) the MCP tool enforces caller authentication before accepting any validation request, and (b) a URL allowlist/denylist configuration controls which base URLs the agent is permitted to target, with production-like hostnames blocked by default unless explicitly whitelisted.

Note: Agent-started checks may target only loopback and validate.allowedHosts (agent-target-allowlist); per-spec time and action bounds (verify-run-bounds); MCP call limits (mcp-limits).
