---
id: 2026-10-27-host-agent-tests-isolate-the-inherited-c
date: 2026-10-27
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Host-agent tests isolate the inherited Codex environment"
affects:
  - platform-foundation
---
# Host-agent tests isolate the inherited Codex environment

## Decision

The full CI-equivalent run inside Codex exposed an unrelated fixture leak: the missing-key-without-an-agent test cleared CLAUDECODE but inherited CODEX_THREAD_ID, so it detected a host agent. Clear both recognized host markers in that fixture, retaining explicit agent detection and switch-off assertions.
