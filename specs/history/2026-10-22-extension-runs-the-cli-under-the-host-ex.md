---
id: 2026-10-22-extension-runs-the-cli-under-the-host-ex
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Extension runs the CLI under the host executable; plugin subcommands honour --json"
affects:
  - integration-surfaces
  - security-and-remediation
  - workspaces
---
# Extension runs the CLI under the host executable; plugin subcommands honour --json

## Decision

Installing 0.3.0 showed 'spawn node ENOENT': VS Code launched outside a shell has no nvm node on PATH. The extension now runs .js/.ts CLI entry points under process.execPath with ELECTRON_RUN_AS_NODE=1 (nodeRuntime in safe-spawn). The Plugins view also failed because the root program's --json swallowed the subcommand's, so 'plugin list --json' printed the table; plugin and workspace-publish actions now merge the root option. The Workspace section of the Coverage tree now also shows when this project's coverage errored or has no config.
