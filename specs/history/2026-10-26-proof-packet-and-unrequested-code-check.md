---
id: 2026-10-26-proof-packet-and-unrequested-code-check
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Proof packet and unrequested-code check for pull requests"
affects:
  - spec-first-changes
---
# Proof packet and unrequested-code check for pull requests

## Decision

Phase 3 slice C adds the proof packet and the unrequested-code check to the change protocol. Reviewers of a pull request see what the requirements now say and what proves them, instead of reading code. Two modules were filled in: `proof-packet.ts` builds the packet from the proof statement, changed claims, approvals, change verdicts, weakening findings and the unrequested report, then renders one markdown comment under a size limit, and `unrequested.ts` finds changed owned lines that no test of the change's claims reaches. Decisions: the verdict rules follow the design with a few additions (a passing capability that is not observed warns when it has warning-level findings, a spike counts as failed, a pipeline change at error severity makes a ready packet advisory, an error-level weakening naming no claim applies to every touched capability); without capability-scoped coverage a missed line is reported as unrequested, the stricter reading; the headline names at most two causes; truncation steps through fixed row limits so the output is deterministic; all untrusted text is masked for credentials and escaped before it reaches the comment.
