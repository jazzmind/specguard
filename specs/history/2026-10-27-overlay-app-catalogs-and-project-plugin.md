---
id: 2026-10-27-overlay-app-catalogs-and-project-plugin
date: 2026-10-27
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Overlay app catalogs and project plugin refresh"
affects:
  - integration-surfaces
---
# Overlay app catalogs and project plugin refresh

## Decision

Resolve featureState.catalog relative to the app config directory when an ancestor workspace manifest exists. Refresh plugin and pipeline state when switching projects and discard obsolete plugin-list responses; preserve config/spec separation in overlay workspaces.
