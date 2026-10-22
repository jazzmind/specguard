---
id: 2026-10-22-0-3-phase-2-plugin-management
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "0.3 phase 2: plugin management"
affects:
  - integration-surfaces
---
# 0.3 phase 2: plugin management

## Prompt

Build SpecGuard 0.3 phase 2 (Wes, 2026-10-22): plugin management. Plugins have no metadata and there is no easy way to browse, add or remove them from the VS Code extension: add a catalog, a plugin list/enable/disable/add/remove CLI, an API route, and a Plugins view; stop hard-coding the quality and commit actions.

## Decision

disabledPlugins config key lets a repo turn off a plugin an extended config enables, because extends replaces arrays wholesale; a disabled npm plugin keeps its entry so it can be re-enabled by id; adding an npm plugin needs explicit confirmation (it runs the package's code) and installs with scripts disabled; the MCP tool list stays at 16 so plugin_list is in the extra set.
