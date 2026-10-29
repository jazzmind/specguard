---
id: 2026-10-28-unified-workspace-and-evidence-dashboard
date: 2026-10-28
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Unified workspace and evidence dashboard navigation"
affects:
  - integration-surfaces
---
# Unified workspace and evidence dashboard navigation

## Prompt

Fix top padding, open repo dashboards from workspace cards, and use existing dashboard pages for Coverage output links with consistent navigation.

## Decision

Add spacing below workspace controls and explicit per-repo dashboard links. Route Specs, Tests and Docs output commands into one project dashboard with an Evidence group and persistent Workspace return. Queue initial tab navigation until the webview is ready, retain routes when reopening, include configured test/doc inventories, and strip frontmatter from spec previews.
