---
id: 2026-10-26-intent-approvals-are-history-entries-bou
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Intent approvals are history entries bound to the claim hash"
affects:
  - intent-approval
---
# Intent approvals are history entries bound to the claim hash

## Decision

Approving a requirement is a committed history entry of kind approval, one file per event so branches never conflict. Each approved claim is recorded with the first 16 hex characters of its claim hash, so an edit to the wording lapses the approval without any extra bookkeeping. Approval is CLI only and never an MCP tool, and the refusal for an agent with no terminal is a speed bump: the real control is a CI check that approvals added in a pull request are backed by someone other than the author, planned for a later phase.
