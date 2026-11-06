---
id: 2026-11-06-contracts-map-precision-from-a-real-over
date: 2026-11-06
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "contracts-map precision from a real overlay trial"
affects:
  - integration-surfaces
---
# contracts-map precision from a real overlay trial

## Decision

A trial on a real six-repo overlay showed the spec-text pass proposing sibling consumer apps (identical titles), the consumer's own heading, capability-map table rows and the system spec, and the code pass reading the overlay's spec folder instead of the app's code. Candidates are now provider repos when roles exist, self-descriptions are skipped, ambiguous titles drop below the default bar, overlay code is read from the app's repo, and an endpoint defined by two providers (a forked backend) is capped and flagged unless contractMappings.baseRepos names the repo behind the client's base URL.
