---
id: 2026-10-22-security-mcp-server-has-no-rate-limit-or
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: MCP server has no rate-limit or authentication requirement"
affects:
  - integration-surfaces
---
# Security: MCP server has no rate-limit or authentication requirement

## Decision

Resolved spec-level security finding "MCP server has no rate-limit or authentication requirement": Add a requirement: the MCP server MUST enforce a per-session rate limit on tool calls (e.g., no more than N calls per minute, configurable); calls exceeding the limit MUST return an error result (not throw) and MUST be logged. Additionally, specify that write-effect tools (`write_spec`, `commit`) MUST be disabled or return an error when invoked in a non-interactive context unless explicitly enabled by config.

Note: Rate limits (300 calls and 20 history entries a minute), a read-only mode, spec-only paths (mcp-limits, mcp-readonly, mcp-spec-paths). Authentication does not apply to a stdio server; see the Trust model.
