---
id: 2026-10-22-security-mcp-commit-tool-has-no-requirem
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: MCP commit tool has no requirement preventing staging of secrets or en"
affects:
  - integration-surfaces
---
# Security: MCP commit tool has no requirement preventing staging of secrets or en

## Decision

Resolved spec-level security finding "MCP commit tool has no requirement preventing staging of secrets or env files": Add an explicit requirement: the commit tool (both CLI and MCP) MUST never stage `.specguard/.env`, `.specguard/.env.*`, or any file matched by the managed git-ignore block, even if those paths fall inside a configured commit directory. A violation MUST be reported as an error and exit 1.

Note: isSafeToStage now refuses env files, keys, credentials, saved logins and browser evidence even inside .specguard/.
