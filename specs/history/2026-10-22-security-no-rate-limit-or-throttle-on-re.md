---
id: 2026-10-22-security-no-rate-limit-or-throttle-on-re
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: No rate-limit or throttle on redaction hook execution"
affects:
  - platform-foundation
---
# Security: No rate-limit or throttle on redaction hook execution

## Decision

Resolved spec-level security finding "No rate-limit or throttle on redaction hook execution": Add a requirement that the redaction hook is called with a per-invocation timeout (configurable, defaulting to a short value), that a hook timeout or exception causes the call to fail with an internal error rather than proceeding with unredacted text, and that the hook result is validated to confirm it is a string no longer than the input.

Note: A hook must be synchronous, return a string of at most 2,000,000 characters, and a throw or bad result fails closed (redaction-hook-fails-closed).
