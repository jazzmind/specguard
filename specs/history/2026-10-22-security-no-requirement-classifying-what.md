---
id: 2026-10-22-security-no-requirement-classifying-what
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No requirement classifying what constitutes a 'secret' or 'credential'"
affects:
  - documentation-api
---
# Security: No requirement classifying what constitutes a 'secret' or 'credential'

## Decision

Resolved spec-level security finding "No requirement classifying what constitutes a 'secret' or 'credential' subject to redaction": Add a requirement that defines the classification of secret/credential values (e.g., values from named config keys, values matching configurable patterns, or values tagged in spec metadata) and specifies that the redaction mechanism MUST be applied uniformly before any external transmission or file write.

Note: Defined as the built-in credential masks (JWTs, bearer and basic tokens, provider API keys, private keys, password=/secret= values) plus llm.redactPatterns, applied to every prompt, log message and history entry (prompt-redaction, log-redaction).
