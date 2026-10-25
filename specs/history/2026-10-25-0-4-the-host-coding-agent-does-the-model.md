---
id: 2026-10-25-0-4-the-host-coding-agent-does-the-model
date: 2026-10-25
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "0.4: the host coding agent does the model work; init is minimal; Claude Code and Codex plugins"
affects:
  - platform-foundation
  - integration-surfaces
---
# 0.4: the host coding agent does the model work; init is minimal; Claude Code and Codex plugins

## Decision

Inside a coding agent SpecGuard needs no API key: a model call with no recorded answer writes a request file and the run exits 12 (waiting for the agent), the agent answers into the replay store, and the next run validates the answer with the pipeline's own schema. Requests are batched per round (file summaries in groups of 25, every capability spec at once). Guessed results are never recorded while waiting, and calls a hook makes opt out so hooks leave no requests. init writes only a config and a specs README (no key file, no llm block, no agent files unless --harness), matches root-level code when there is no src/, and Claude Code's MCP server goes in .mcp.json where it is read. specguard start sets up, drafts, tags, runs and reports, resumably. The repo is a Claude Code and Codex marketplace with one plugin (skills, start/check commands, a specguard executable on PATH, the MCP server, a session-start status hook). Why: the missing-key 401 and the 13-file init were the first things a new user hit, and an agent is already a model. The wider program (intent approval by people, proofs as git notes, change protocol, formal evidence) is built in later phases. Private project names and internal hosts were removed from the public repository and a hashed deny-list test keeps them out.
