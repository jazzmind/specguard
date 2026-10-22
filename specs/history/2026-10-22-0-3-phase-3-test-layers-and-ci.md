---
id: 2026-10-22-0-3-phase-3-test-layers-and-ci
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "0.3 phase 3: test layers and CI"
affects:
  - conformance-testing
  - agentic-verification
  - integration-surfaces
  - security-and-remediation
  - traceability-and-drift
---
# 0.3 phase 3: test layers and CI

## Prompt

Build SpecGuard 0.3 phase 3 (Wes, 2026-10-22): test layers (unit, integration, UX/Playwright, security, functional) integrated into CI with spec-driven development as the goal. Proofs record the layer they came from, capabilities can require layers, verify can become a Playwright test, init --ci github scaffolds a workflow, and the Action comments on PRs and uploads SARIF.

## Decision

The ledger stays at version 1 and every change adds fields, so older CLIs and pinned Actions keep reading it; required layers live in capability frontmatter, never in the claim comment, because the claim comment is part of the claim hash. A claim is proven by the layer that decides it: a failure in any layer wins, and classified evidence replaces unclassified evidence of the same tests. A generated Playwright test tags only claims it asserts. PR comment deltas are against the previous run on the same PR, not the base branch.
