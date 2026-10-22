---
id: 2026-10-22-0-3-phase-1f-workspaces-on-the-team-serv
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "0.3 phase 1f: workspaces on the team server"
affects:
  - workspaces
  - team-server
---
# 0.3 phase 1f: workspaces on the team server

## Prompt

Build SpecGuard 0.3 phase 1f (Wes, 2026-10-22): the combined workspace picture on the team server, after the local one.

## Decision

The server keeps named workspaces (sets of projects) in file and Postgres storage and rolls each project's newest snapshot up with the same pure function the local check --workspace uses; a token scoped to one project may not define a workspace and sees only one made of that project alone; the rollup has no ledger freshness on the server because snapshots carry no per-proof timestamps it reads.
