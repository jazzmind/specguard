---
id: 2026-10-22-security-hardening-from-audit-sast-and-p
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "security hardening from audit, SAST and probing"
affects:
  - spec-authoring
  - integration-surfaces
  - security-and-remediation
  - requirement-history
  - team-server
  - documentation-api
  - platform-foundation
  - workspaces
---
# security hardening from audit, SAST and probing

## Prompt

Fix any open security issues in specguard: npm audit, SAST and DAST scans (Wes, 2026-10-22).

## Decision

npm audit fix in the root, extension and webview packages, and pnpm-lock.yaml (unused by CI but still pinning vulnerable versions) brought to patched versions with vite pinned to 7.3.7 by a pnpm override. The editor no longer starts the CLI through a shell (planSpawn: node for scripts, node --import tsx for .ts, cmd.exe with quoted arguments only for a Windows shim; terminal commands single-quote values), the test runner quotes what it appends per platform, import <url> is SSRF-hardened (public addresses only, per-redirect checks, size and redirect caps, --allow-private opt-in), MCP import and read_spec/write_spec are confined to the project (spec Markdown only), the commit tool refuses secrets, hook stdin and prompts are bounded and the inbox is 0600, contract spec paths stay in their repo, activity-log messages and replay previews are redacted, HTML pages get frame-ancestors/X-Frame-Options/Referrer-Policy, and SPECGUARD_TRUSTED_PROXIES makes the team server honour the sign-in header only from the proxy. Left open on purpose: spec-level findings that are design decisions (authentication for a local CLI, rate limits, prompt-injection handling, data classification).
