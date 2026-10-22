---
id: 2026-10-22-security-prompt-injection-via-page-conte
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Prompt-injection via page content reaching the LLM is not addressed"
affects:
  - agentic-verification
---
# Security: Prompt-injection via page content reaching the LLM is not addressed

## Decision

Resolved spec-level security finding "Prompt-injection via page content reaching the LLM is not addressed": Add a requirement that page-derived content is presented to the LLM in a structurally separated context that cannot override system instructions, and that the action-classification step is performed deterministically (not LLM-driven) for any action whose target is resolvable in the accessibility tree, with the LLM's output treated as untrusted input subject to a second deterministic safety check before execution.

Note: Page title, tree, HTML and console text are fenced as untrusted data in every step with a standing instruction, and actions are classified deterministically and guarded regardless of what the model asks (untrusted-content-fenced).
