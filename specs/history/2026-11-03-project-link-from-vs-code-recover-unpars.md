---
id: 2026-11-03-project-link-from-vs-code-recover-unpars
date: 2026-11-03
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Project link from VS Code; recover unparseable structured replies"
affects:
  - team-server
  - platform-foundation
---
# Project link from VS Code; recover unparseable structured replies

## Decision

Open the repo's team-server project page from VS Code (per-repo action, palette command), reading the address from settings on every call instead of a status cache that only refreshed with the workspace; structured model replies that are fenced or cut off are recovered or explained instead of failing with 'could not parse the response' (business journeys draft).
