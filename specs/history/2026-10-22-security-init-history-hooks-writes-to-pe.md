---
id: 2026-10-22-security-init-history-hooks-writes-to-pe
date: 2026-10-22
kind: decision
author: "Wes Sonnenreich"
source: security-plan
title: "Security: init --history-hooks writes to personal, uncommitted settings with no "
affects:
  - integration-surfaces
---
# Security: init --history-hooks writes to personal, uncommitted settings with no 

## Decision

Resolved spec-level security finding "init --history-hooks writes to personal, uncommitted settings with no integrity check": Add a requirement: on each `init` or `scaffold` run, SpecGuard MUST verify that any previously written hook command matches the currently resolved runner; if it differs, it MUST print a diff and require `--update-hooks` to overwrite, identical to the behaviour specified in `agent-wiring-and-runner`. Additionally, the installed hook script MUST be restricted to the resolved absolute binary path, not a shell alias or PATH lookup.

Note: Already specified and tested: a differing existing hook is left alone and its diff printed; --update-hooks is required to change it (agent-wiring-and-runner; history safe-merge and runner tests).
