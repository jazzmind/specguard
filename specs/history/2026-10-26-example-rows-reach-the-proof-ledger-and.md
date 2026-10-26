---
id: 2026-10-26-example-rows-reach-the-proof-ledger-and
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Example rows reach the proof ledger and approvals, and non-test evidence cannot satisfy an automated layer"
affects:
  - conformance-testing
  - intent-approval
---
# Example rows reach the proof ledger and approvals, and non-test evidence cannot satisfy an automated layer

## Decision

A row of a claim's examples table is proven and approved under its own ref (spec#claim/row) with its row hash, a row-tagged result also counts for the parent claim once, and a title naming two rows warns instead of attributing. Agentic and manual evidence can only prove the functional layer, so ingest refuses them elsewhere and a required automated layer they sit in stays missing. A deterministic walk ignores LLM drift assessments so any changed owned file stales a proof. Approvals keep the row and gain a latest lookup.
