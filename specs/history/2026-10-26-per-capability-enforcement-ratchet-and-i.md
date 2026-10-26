---
id: 2026-10-26-per-capability-enforcement-ratchet-and-i
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Per-capability enforcement ratchet and its weakening guard"
affects:
  - spec-first-changes
---
# Per-capability enforcement ratchet and its weakening guard

## Decision

The per-capability ratchet gained its commands and its guard. A capability's `enforce:` level is read from frontmatter and falls back to the config default; it is deliberately outside the claim hash, so ratcheting never stales an approval, and a lowered or removed level is instead reported as an error-level `policy-enforce-lowered` weakening finding. `enforce raise` may move a capability to `enforce` only while it is certified and refuses otherwise with the blocking reasons; `enforce lower` requires a reason and is recorded as a decision history entry with a policy line and the person's name. Both refuse an agent without a terminal, as approvals do, because the level is a person's call and CI is the real gate. The decision to let `observe` to `warn` through at any certification state follows the design (advisory only); only the step to `enforce` is gated.
