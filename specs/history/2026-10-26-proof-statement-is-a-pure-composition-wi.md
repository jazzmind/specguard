---
id: 2026-10-26-proof-statement-is-a-pure-composition-wi
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Proof statement is a pure composition with policy deciding only blocking"
affects:
  - traceability-and-drift
---
# Proof statement is a pure composition with policy deciding only blocking

## Decision

The proof statement (src/core/proof-statement.ts) composes four pillars per capability (approved, testable, aligned, conforms) from plain evidence data. Pillar status never depends on proof config; the require* gates only mark reasons blocking. Approval stays its own pillar and the raw ledger verdict is used with no drift-assessment opinion. Certified needs all four pillars ok, CI-only evidence, a known commit and clean inputs. A blocking reason exits with the new code 13 (NotCertified), because 6 is invalid and 9 to 11 are remediate-scoped.
