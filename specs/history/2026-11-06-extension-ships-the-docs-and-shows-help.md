---
id: 2026-11-06-extension-ships-the-docs-and-shows-help
date: 2026-11-06
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Extension ships the docs and shows help in place"
affects:
  - integration-surfaces
---
# Extension ships the docs and shows help in place

## Decision

The extension copies the generated docs into media/docs at build time and renders them host-side with markdown-it (html disabled; anchor lines become heading ids) in a CSP-locked panel, so help works offline. Help popovers read help-topics.json; Read more opens the matching page and anchor. Generate Contract Mappings and Build Contract Graph offer a QuickPick of modes mapped to CLI flags by pure functions, and the mapping command is shown only when a workspace repo enables the contract-mappings plugin.
