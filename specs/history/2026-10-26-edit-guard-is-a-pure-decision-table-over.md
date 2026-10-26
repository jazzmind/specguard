---
id: 2026-10-26-edit-guard-is-a-pure-decision-table-over
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Edit guard is a pure decision table over an ownership index"
affects:
  - spec-first-changes
---
# Edit guard is a pure decision table over an ownership index

## Decision

The edit guard that enforces spec-first order for coding agents is a pure decision table. It classifies each path an agent is about to write from a precomputed ownership index (owned source, test, spec, history, change record, config or workflow), then decides by the strictest enforcement level among the owning capabilities and the stage of the open change: observe logs, warn allows with the next command, enforce denies code edits that have no approved change with valid red. Specs and tests stay editable; a test or spec edit that would break a valid red is allowed with a message that the change is back at red. Agents cannot approve requirements, lower enforcement, publish proof notes or write history through the shell, and approval-like history writes and closed change records are refused at every level. The guard fails open on any malformed input or error because CI is the gate, and it reads both Claude Code and Codex payloads, including the paths inside a Codex apply_patch. A Bash command is read the way a shell splits it (quotes, operators, here-documents, bash -c, eval, substitutions) and is a speed bump, not a gate: variable expansion and scripts are not followed.
