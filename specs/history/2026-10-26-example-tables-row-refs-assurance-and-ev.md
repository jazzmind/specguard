---
id: 2026-10-26-example-tables-row-refs-assurance-and-ev
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Example tables, row refs, assurance and evidence frontmatter, testability lint"
affects:
  - spec-authoring
---
# Example tables, row refs, assurance and evidence frontmatter, testability lint

## Decision

Behaviour that varies is declared in a markdown table under the claim bullet; table lines are never claim text, so claim hashes do not change. A row is addressable as specKey#claimId/rowId and has its own hash built on the claim hash. assurance and evidence frontmatter sit outside the claim hash. A deterministic testability lint (no model) flags claims no test or named verifier could judge, configured by a top-level testability block.
