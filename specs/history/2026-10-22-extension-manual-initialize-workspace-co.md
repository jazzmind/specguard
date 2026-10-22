---
id: 2026-10-22-extension-manual-initialize-workspace-co
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Extension: manual Initialize Workspace command"
affects:
  - workspaces
---
# Extension: manual Initialize Workspace command

## Decision

The one-time 'create a workspace?' offer is easy to dismiss and never returns. Added 'SpecGuard: Initialize Workspace' (palette, Coverage view title button while no manifest exists, and the Coverage welcome view): with a .code-workspace open it runs 'workspace init --from <file> --link' (or syncs when a manifest exists); otherwise the user picks a folder and 'workspace init --recursive' scans it.
