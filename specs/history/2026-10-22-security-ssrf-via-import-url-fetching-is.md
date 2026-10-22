---
id: 2026-10-22-security-ssrf-via-import-url-fetching-is
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: SSRF via `import` URL fetching is not mitigated by any requirement"
affects:
  - spec-authoring
---
# Security: SSRF via `import` URL fetching is not mitigated by any requirement

## Decision

Resolved spec-level security finding "SSRF via `import` URL fetching is not mitigated by any requirement": Add a requirement that `import` resolves the target hostname before connecting and refuses to connect to loopback, link-local, or private IP ranges (RFC 1918/4193/3927); also require that any redirect target is subject to the same check before following it.

Note: import <url> now resolves and checks the host itself, refuses non-public addresses (also per redirect), caps redirects and size; MCP import is limited to project files and public URLs (0.3 hardening 2026-10-22).
