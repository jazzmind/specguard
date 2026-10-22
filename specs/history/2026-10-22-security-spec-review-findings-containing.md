---
id: 2026-10-22-security-spec-review-findings-containing
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Spec-review findings containing source file content sent to LLM have n"
affects:
  - security-and-remediation
---
# Security: Spec-review findings containing source file content sent to LLM have n

## Decision

Resolved spec-level security finding "Spec-review findings containing source file content sent to LLM have no data-classification requirement": Add a data-classification requirement for spec files and source files transmitted to the LLM during spec review. At minimum, require that only the specific capability text relevant to a finding is included in the prompt, that no adjacent capability specs are included without explicit opt-in, and that a `--no-llm` flag suppresses spec review LLM calls with a warning.

Note: Credentials are masked in every prompt (prompt-redaction); the review is skipped with --no-spec-review or llm.provider none; page and document text is fenced.
