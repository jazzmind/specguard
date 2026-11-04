---
id: 2026-11-04-workspace-report-and-vs-code-report-pane
date: 2026-11-04
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "workspace report and VS Code report panel"
affects:
  - traceability-and-drift
  - integration-surfaces
---
# workspace report and VS Code report panel

## Decision

Wes wants test evidence visible in the VS Code extension: a workspace-level rollup with drilldown into each repo's report (screenshots, video, traces). Generic: report --workspace builds per-repo reports plus a landing page from the workspace manifest; the extension renders those static pages in a webview with a strict CSP and message-based navigation. Overlay-specific extras are linked through .specguard/report-links.json.
