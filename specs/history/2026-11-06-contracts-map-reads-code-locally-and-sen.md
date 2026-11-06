---
id: 2026-11-06-contracts-map-reads-code-locally-and-sen
date: 2026-11-06
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "contracts-map reads code locally and sends it only when asked twice"
affects:
  - integration-surfaces
---
# contracts-map reads code locally and sends it only when asked twice

## Decision

Client calls and endpoint definitions are read by text extractors, matched by normalised path, and attributed to specs through file ownership, so code evidence is stronger than prose without a model. An assess mode says whether code would add anything before anyone runs it. Code excerpts reach a model only with both --with-llm and --send-code, skipping files that look like they hold secrets.
