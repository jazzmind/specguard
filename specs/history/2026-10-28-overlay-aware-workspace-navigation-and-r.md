---
id: 2026-10-28-overlay-aware-workspace-navigation-and-r
date: 2026-10-28
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Overlay-aware workspace navigation and repository details"
affects:
  - integration-surfaces
---
# Overlay-aware workspace navigation and repository details

## Prompt

Improve VS Code repository preview and activation, evidence overlay relationships, catalog cards, team-server visibility and overlay file links.

## Decision

Separate dashboard preview from activation; surface discovered contributions and overlay consumers without scaffolding container configs; resolve coverage spec paths against their owning config directory; place catalogs in repo cards and show bounded cached server health probes without claiming project authorization.
