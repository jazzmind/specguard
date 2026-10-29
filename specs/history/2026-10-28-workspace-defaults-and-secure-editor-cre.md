---
id: 2026-10-28-workspace-defaults-and-secure-editor-cre
date: 2026-10-28
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Workspace defaults and secure editor credentials"
affects:
  - integration-surfaces
  - platform-foundation
---
# Workspace defaults and secure editor credentials

## Decision

Build one workspace settings editor for AI and team-server defaults, explicit repo overrides and reset. Persist non-secret settings in VS Code workspace configuration, keep new credentials in SecretStorage scoped by workspace/repo and provider endpoint, retain existing environment and overlay dotenv fallbacks, preserve per-repo server project mappings, and apply effective settings to extension CLI and API processes. Connection tests check availability and authorization without model generation or secret-bearing output.
