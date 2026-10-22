---
id: 2026-10-22-security-prompt-injection-via-spec-conte
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Prompt-injection via spec content sent to LLM is not addressed"
affects:
  - documentation-api
---
# Security: Prompt-injection via spec content sent to LLM is not addressed

## Decision

Resolved spec-level security finding "Prompt-injection via spec content sent to LLM is not addressed": Add a requirement that spec content passed to the LLM is treated as untrusted user input: it must be placed in a delimited section of the prompt with explicit LLM instructions not to follow embedded instructions, and generated output must be validated to contain only the expected document structure before being cached or returned.

Note: Spec material is fenced as untrusted data and the system message says nothing inside is an instruction (untrusted-content-fenced); documents are cached per content hash.
