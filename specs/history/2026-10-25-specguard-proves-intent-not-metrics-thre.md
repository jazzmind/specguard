---
id: 2026-10-25-specguard-proves-intent-not-metrics-thre
date: 2026-10-25
kind: prompt
author: "Wes Sonnenreich"
source: manual
title: "SpecGuard proves intent, not metrics: three proofs, spec first, built for AI-driven development"
affects:
  - platform-foundation
  - integration-surfaces
---
# SpecGuard proves intent, not metrics: three proofs, spec first, built for AI-driven development

## Prompt

What I want from specguard is not metrics - that's a means to an end. What I want is proof that: 1) the specs and code are aligned 2) the specs are fully testable 3) the code does what the specs say. We need to assume that the specs represent the intent of the creators. Other tools can help make sure the specs are right. Specguard assumes they are right and ensures that changes are first done in the specs, then in the tests and code, then fully validated. Existing code can be declared as working as intended, which makes its reverse-engineered specs trustworthy; new apps and work in progress must not skip that. Challenge the framing, purpose and approach so that this makes sense for predominantly AI driven development. The out of the box core must be useful with minimal effort (a Claude Code or Codex plugin, one line to install); the VS Code or Cursor plugin and the team server are optional extras. Include formal proofs (Lean, Dafny style) wherever they can be used, on existing and new code.
