---
id: 2026-10-22-security-credentials-embedded-in-importe
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Credentials embedded in imported documents may be forwarded to the LLM"
affects:
  - spec-authoring
---
# Security: Credentials embedded in imported documents may be forwarded to the LLM

## Decision

Resolved spec-level security finding "Credentials embedded in imported documents may be forwarded to the LLM": Add a requirement for `import` analogous to `reverse-safety`: define the secret-detection patterns applied to fetched/local document content, specify that matching content is redacted (not merely warned about) before the model call, and require that the model is instructed not to reproduce any value that was redacted.

Note: Credentials in an imported document are masked before the model call, and the document is fenced as untrusted (prompt-redaction, untrusted-content-fenced); documents are truncated to 48,000 characters.
