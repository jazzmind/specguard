---
id: 2026-10-26-phase-3-contracts-and-seams
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Phase 3 contracts and seams"
affects:
  - proof-store
  - spec-first-changes
---
# Phase 3 contracts and seams

## Decision

Phase 3 starts with frozen contracts: the proof note, change record, proof packet, unrequested-code, hook decision, CI approval-trust and migration-plan modules export their types, constants and schemas and throw until each slice fills them in, so the slices build in parallel against one shape. The new config blocks (proofStore, change, enforce, hooks, approvals.ci, unrequested, ci.capabilityCoverage, apps[].test.coverage, mutation.command) are optional and default as designed, with one deviation: note authentication is opt-in (proofStore.verify defaults to off), and hooks fail open unless hooks.onError is deny. Command and MCP tool registration goes through one seam file per group so slices add files and never edit the shared entry points. Claim-scoped coverage evidence counts as claimable, history entries gain a policy list, and the statement input accepts a ledger store, a replacement approval list, extra approvals and a red-green sensitivity map.
