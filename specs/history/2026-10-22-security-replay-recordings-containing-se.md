---
id: 2026-10-22-security-replay-recordings-containing-se
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Replay recordings containing sensitive data have no access-control or "
affects:
  - platform-foundation
---
# Security: Replay recordings containing sensitive data have no access-control or 

## Decision

Resolved spec-level security finding "Replay recordings containing sensitive data have no access-control or encryption requirement": Add a requirement that replay responses are written only after redaction has been applied to the prompt and response text, that the managed ignore block (filesystem-access) does NOT add the replay directory to .gitignore by default (so accidental commit is flagged rather than silently excluded), and that a warning is emitted when recording while the provider is anything other than `none`.

Note: Prompts are credential-masked before they are hashed or sent, so a recording cannot hold one; the preview is masked too; recording is opt-in and the folder is deliberately not ignored (prompt-redaction).
