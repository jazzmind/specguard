---
id: 2026-11-03-diagnosable-team-server-sign-in-and-open
date: 2026-11-03
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Diagnosable team-server sign-in and open-in-browser link"
affects:
  - team-server
---
# Diagnosable team-server sign-in and open-in-browser link

## Decision

Team server 401s now say why (no sign-in header, untrusted proxy address, wrong domain) and the web UI shows it; the VS Code Team server row and a command open the configured server in the browser. Released as 0.6.1.
