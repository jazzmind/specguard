---
id: 2026-10-24-key-set-status-and-a-per-user-env-file
date: 2026-10-24
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "key set/status and a per-user env file"
affects:
  - workspaces
---
# key set/status and a per-user env file

## Decision

SpecGuard could only get its model key from a repo or ancestor-workspace .env, and a workspace manifest kept beside a .code-workspace is not an ancestor of its repos, so there was no one place to put the key for all workspaces. Added ~/.config/specguard/.env as the lowest-precedence env file, 'specguard key set|status' (hidden prompt, stdin or --from-env, never argv; mode 600, atomic, one-line values; never printed) and the extension's 'SpecGuard: Set API Key'. config.json still only names the variable (llm.apiKeyEnv); the key is deliberately not stored in it because that file is committed.
