---
id: 2026-10-23-workspace-panel-route-clicks-by-data-act
date: 2026-10-23
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Workspace panel: route clicks by data-act, not inline handlers"
affects:
  - workspaces
---
# Workspace panel: route clicks by data-act, not inline handlers

## Decision

The workspace panel's CSP is script-src 'nonce-…' only, which blocks inline onclick attributes, so every button in the panel (Ignore, Refresh all, Sync, Run drift, repo switch) did nothing. Buttons now carry data-act attributes and one delegated click listener in the nonce'd script handles them; a test fails if an inline handler comes back or the script does not parse.
