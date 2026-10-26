---
id: proof-store
kind: capability
title: Proof Store
parent: system
value: Proof earned in CI travels with the commit it proved, inside git itself, so every clone and every later run can read what was proven without rerunning the tests or trusting a local file.
status: active
sources:
  - "src/core/proof-note.ts"
  - "src/cli/commands/proof-store.ts"
docs: []
history:
  - 2026-10-26-phase-3-contracts-and-seams
tests:
  - "tests/core/contracts-phase3.test.ts"
  - "tests/core/config-phase3.test.ts"
---

# Proof Store

## Problem & Value
The proof ledger is a local file. Proof that CI earned sits on the CI machine and is gone when the job ends, a developer's machine can claim any proof it likes, and a committed ledger is a large file that every branch edits. A reader cannot tell proof a trusted run earned from proof someone typed in.

The proof store keeps one small note per proven commit in git itself, written by CI only, under its own notes ref. A reader finds the nearest noted ancestor of the commit it is on and reads the evidence that is still fresh there. Because the note is plain text in git, it needs no server, travels with a clone and can be checked against the CI run that wrote it.

## Requirements
- [ ] A proof note names its schema and version and carries the commit, tree, rows, approvals and statement summary, so the note contract accepts a complete note, rejects one with a wrong schema, a missing field or a malformed approval hash, and keeps fields it does not know <!-- claim: note-contract -->
- [ ] Notes live under `refs/notes/specguard` on the `origin` remote unless `proofStore` names others, a note over 1 MiB is trimmed and one over 8 MiB is refused, and a note is checked against a CI check run only when `proofStore.verify` is `check-run` <!-- claim: note-defaults -->
