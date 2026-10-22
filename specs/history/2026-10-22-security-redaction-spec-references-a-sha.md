---
id: 2026-10-22-security-redaction-spec-references-a-sha
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Redaction spec references a 'shared redactor' with no defined scope or"
affects:
  - requirement-history
---
# Security: Redaction spec references a 'shared redactor' with no defined scope or

## Decision

Resolved spec-level security finding "Redaction spec references a 'shared redactor' with no defined scope or failure mode": Add a requirement that references or defines the redactor's pattern catalogue, specifies a fail-closed posture (if the redactor errors the entry is not written), and requires that `history add` and `history capture` surface a warning when redaction is skipped or degraded so operators know the risk.

Note: Defined: the built-in credential masks plus validate.redaction.patterns, applied to every prompt, plan and decision before anything is written, with no path that skips it; hooks fail closed (prompt-redaction, redaction-hook-fails-closed, log-redaction).
