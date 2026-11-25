---
id: 2026-11-25-a-fix-is-linked-by-the-same-key-the-reme
date: 2026-11-25
kind: decision
author: "Cursor Agent"
source: manual
title: "A fix is linked by the same key the remediate item is built from"
affects:
  - security-and-remediation
---
# A fix is linked by the same key the remediate item is built from

## Decision

A shipped fix was still able to name another plan item's finding, because the map key was the advisory id, or rule and file, and two plan items can share that. The key is now computed by one function on both sides, from the fields a remediate item is built from: repository, ecosystem, package and advisory id, or rule, file and line. A package bump that clears several advisories for that same package in that same repository names each of them. A key shared by more than one plan item, or by more than one fix, is left off the commit and the pull request, and one log line says so. How security fix chooses an item's status still matches on the advisory id, and that ambiguity is left for a separate change.
