---
id: 2026-10-22-security-evidence-path-traversal-not-con
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Evidence path traversal not constrained by a normalisation requirement"
affects:
  - conformance-testing
---
# Security: Evidence path traversal not constrained by a normalisation requirement

## Decision

Resolved spec-level security finding "Evidence path traversal not constrained by a normalisation requirement": Add a requirement that evidence paths are canonicalised (symlinks resolved, `..` collapsed) and then verified to lie within the repository root before being stored or read, and that ingest rejects any verdict whose evidence path fails this check.

Note: Evidence paths are recorded only inside the repository, normalised; others are dropped with a message (evidence-path-inside-repo). Nothing in SpecGuard reads a file by an evidence path.
