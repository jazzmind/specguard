---
id: 2026-11-06-contracts-map-proposes-mappings-from-spe
date: 2026-11-06
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "contracts-map proposes mappings from spec text and merges without losing hand work"
affects:
  - integration-surfaces
---
# contracts-map proposes mappings from spec text and merges without losing hand work

## Decision

Writing mappings by hand does not scale, so a deterministic spec-text pass proposes them with scores that say how the spec referred to the provider. Entries carry generated and suggestions fields so a rerun can refresh its own output, while anything a person wrote or edited is never overwritten. A dry run and a per-repo summary keep the write reviewable.
