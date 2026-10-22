---
id: 2026-10-22-security-activity-log-may-capture-prompt
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Activity log may capture prompt text containing secrets"
affects:
  - integration-surfaces
---
# Security: Activity log may capture prompt text containing secrets

## Decision

Resolved spec-level security finding "Activity log may capture prompt text containing secrets": Add a requirement: the activity-log schema MUST be defined (tool name, timestamp, duration, pass/fail/error, and a bounded summary of at most N characters of sanitised arguments); no raw argument values, file contents, or environment variable values MAY be written; the sanitiser MUST redact any token matching the pattern of known secret formats (e.g., matching `sk-`, `gh_`, `Bearer `).

Note: the activity log holds no prompt text; its messages are now passed through the secret redactor.
