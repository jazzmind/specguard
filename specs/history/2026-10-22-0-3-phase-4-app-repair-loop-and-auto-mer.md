---
id: 2026-10-22-0-3-phase-4-app-repair-loop-and-auto-mer
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "0.3 phase 4: app repair loop and auto-merge policy"
affects:
  - security-and-remediation
  - conformance-testing
---
# 0.3 phase 4: app repair loop and auto-merge policy

## Prompt

Build SpecGuard 0.3 phase 4 (Wes, 2026-10-22): self-healing with auto-merge for low-risk fixes. A failing test or verify result should lead to a fix, a re-verify and a PR; dependency patches that keep every proof may auto-merge.

## Decision

App repairs (remediate --from failing) may change only the capability's own source files and are always a PR for a person, never auto-merged; dependency fixes auto-merge only when config and --auto-merge are both set, the bump is a patch or a 1.x minor touching only manifests and lockfiles, the verdict is PRESERVED, every claim proven in any layer before is proven in that layer after, risk is low, and the base branch has required status checks (otherwise GitHub auto-merge would merge before any check ran). The spec claim pr-modes-no-merge is amended: nothing merges unless that policy allows it.
