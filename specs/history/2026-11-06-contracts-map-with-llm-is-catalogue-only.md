---
id: 2026-11-06-contracts-map-with-llm-is-catalogue-only
date: 2026-11-06
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "contracts-map --with-llm is catalogue-only and announces what it sends"
affects:
  - integration-surfaces
---
# contracts-map --with-llm is catalogue-only and announces what it sends

## Decision

The model sees only the redacted text of specs the text pass could not settle plus a numbered catalogue of provider titles, and any answer outside the catalogue is rejected and logged. The provider, model and every spec are named before sending and a cap bounds the spend, matching how contracts --with-llm already behaves.
