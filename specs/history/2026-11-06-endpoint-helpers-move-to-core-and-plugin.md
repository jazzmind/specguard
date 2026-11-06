---
id: 2026-11-06-endpoint-helpers-move-to-core-and-plugin
date: 2026-11-06
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Endpoint helpers move to core and plugin commands load from a workspace root"
affects:
  - integration-surfaces
  - workspaces
---
# Endpoint helpers move to core and plugin commands load from a workspace root

## Decision

Client-call and endpoint-definition helpers now live in core so the feature catalog and contracts-map share them without one plugin importing another. Plugin commands are found from a workspace root with no config of its own by taking the union of the repos' plugins, the rule contracts already used, so an overlay root can run contracts-map. Contract nodes are named by repo-relative path in every pass, because a spec key in one pass and a path in another split one spec into two nodes; graphs built earlier need contracts --force.
