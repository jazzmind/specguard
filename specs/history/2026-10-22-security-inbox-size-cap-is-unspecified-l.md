---
id: 2026-10-22-security-inbox-size-cap-is-unspecified-l
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: Inbox size cap is unspecified, leaving denial-of-service and data-rete"
affects:
  - requirement-history
---
# Security: Inbox size cap is unspecified, leaving denial-of-service and data-rete

## Decision

Resolved spec-level security finding "Inbox size cap is unspecified, leaving denial-of-service and data-retention risks undefined": Specify the inbox cap as a concrete maximum (e.g., 10 MB or 1 000 entries), define the eviction policy (drop oldest entries by session_id+timestamp), and require that a dropped entry is silently discarded rather than causing the hook to fail, consistent with `history-hooks-silent`.

Note: already implemented; specified and tested in 0.3 hardening
