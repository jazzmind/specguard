---
id: 2026-10-26-migration-planning-is-a-pure-idempotent
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Migration planning is a pure idempotent plan module"
affects:
  - platform-foundation
---
# Migration planning is a pure idempotent plan module

## Decision

Migration planning became a pure module, `src/core/migrate-plan.ts`: from a plain facts object it detects the repository's format and returns the ordered, idempotent list of steps that bring it to the current layout, so the dry run and the later apply share one decision. The design's v0.1 route (archive the per-file specs, redraft as built) is the default, with consolidate as the stated alternative, because redrafting needs no judgement about which hand-written intent to keep. Steps that need a person, such as the as-built approval and the commit and push, are printed with their commands and never run by the tool. No new state was added for blocked steps: the contract's five states are kept and a blocked step is a skip whose description begins "Blocked:". Whether a repository is a git work tree is an optional fact, absent meaning yes.
