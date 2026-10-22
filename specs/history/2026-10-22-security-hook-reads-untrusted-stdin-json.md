---
id: 2026-10-22-security-hook-reads-untrusted-stdin-json
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Hook reads untrusted stdin JSON but no input-size limit is specified, "
affects:
  - requirement-history
---
# Security: Hook reads untrusted stdin JSON but no input-size limit is specified, 

## Decision

Resolved spec-level security finding "Hook reads untrusted stdin JSON but no input-size limit is specified, enabling resource exhaustion": Add a requirement that the hook enforces a maximum stdin read size (e.g., 8 MB) and discards the payload with a silent no-op if the limit is exceeded, logging the event to a debug log file rather than stderr/stdout.

Note: hook stdin is capped at 4 MB (larger input dropped), a prompt is cut to 50,000 characters, the inbox is 0600.
