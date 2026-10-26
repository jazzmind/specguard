---
id: 2026-10-26-coverage-and-mutation-evidence-is-attrib
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Coverage and mutation evidence is attributed by ownership and states what it cannot prove"
affects:
  - coverage-and-mutation
---
# Coverage and mutation evidence is attributed by ownership and states what it cannot prove

## Decision

Coverage and mutation reports are ingested from files, mapped to repository files and credited to the owning capability. A whole-suite report is never presented as proof that a claim's tests reach the code; only a report scoped to a capability's tagged tests can, and mutation is what attributes sensitivity to a claim. Evidence stores content hashes so changed files go stale instead of being trusted.
