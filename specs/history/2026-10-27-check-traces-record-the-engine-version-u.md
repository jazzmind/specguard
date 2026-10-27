---
id: 2026-10-27-check-traces-record-the-engine-version-u
date: 2026-10-27
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Check traces record the engine version used for workspace alignment"
affects:
  - traceability-and-drift
---
# Check traces record the engine version used for workspace alignment

## Decision

The extension must distinguish the current code revision, the checked revision, the version that performed the check, and the version that generated harness files. Persist versionInfo in trace.json as an additive tool field; older traces have an unknown check engine and prompt a refresh instead of claiming current alignment.
