---
id: proof-store
kind: capability
title: Proof Store
parent: system
value: Every proven commit carries its own small proof record inside git, written only by CI, so a clone or a pull request can read what was proven without rerunning tests, trusting a local file or merging a shared ledger.
status: active
sources:
  - "src/core/proof-note.ts"
  - "src/cli/commands/proof-store.ts"
  - "src/ci/note-verify.ts"
docs: []
history:
  - 2026-10-26-phase-3-contracts-and-seams
  - 2026-10-26-proof-note-is-a-pure-json-module-with-ca
  - 2026-10-26-ci-trust-approvals-are-records-ci-plumbi
tests:
  - "tests/core/contracts-phase3.test.ts"
  - "tests/core/config-phase3.test.ts"
  - "tests/core/proof-note.test.ts"
  - "tests/ci/note-verify.test.ts"
---

# Proof Store

## Problem & Value
The proof ledger is a local file. Proof that CI earned sits on the CI machine and is gone when the job ends, a developer's machine can claim any proof it likes, and a committed ledger is a large file that every branch edits. A reader cannot tell proof a trusted run earned from proof someone typed in.

The proof store keeps one small note per proven commit in git itself, written by CI only, under its own notes ref. A reader finds the nearest noted ancestor of the commit it is on and reads the evidence that is still fresh there. Because the note is plain text in git, it needs no server, travels with a clone and can be checked against the CI run that wrote it.

## Users & Journeys
- A CI job runs the tests on a commit and stores one proof note for that commit under the notes ref, so the proof travels with the repository.
- A developer on a branch reads the nearest noted ancestor's note and sees which claims are still proven for the files they have not touched.
- Two branches that each prove their own commit never conflict, because every commit has its own note and no shared ledger file is edited.
- A security-minded team turns on note verification so a hand-pushed note is rejected unless the CI check run for its digest exists.
- A maintainer inspects a note and sees one verdict per claim and layer, with file hashes listed once for the whole note.

## Requirements
- [ ] A proof note names its schema and version and carries the commit, tree, rows, approvals and statement summary, so the note contract accepts a complete note, rejects one with a wrong schema, a missing field or a malformed approval hash, and keeps fields it does not know <!-- claim: note-contract -->
- [ ] Notes live under `refs/notes/specguard` on the `origin` remote unless `proofStore` names others, a note over 1 MiB is trimmed and one over 8 MiB is refused, and a note is checked against a CI check run only when `proofStore.verify` is `check-run` <!-- claim: note-defaults -->
- [ ] A proof note is read defensively: text that is not JSON, JSON that is not a proof note, and a note whose shape is wrong each come back as a named failure (`not-json`, `wrong-schema`, `invalid`) with a short detail and never as a throw, while fields the reader does not know are kept and written back <!-- claim: note-parse-defensive -->
- [ ] A note written by a newer SpecGuard is reported as `newer-version` before its shape is checked, so a layout this reader cannot validate is never misread as invalid or thrown on, and a wrong schema name still wins over the version <!-- claim: note-newer-version -->
- [ ] A note serializes canonically: keys sorted at every depth, rows ordered by claim then layer, absent fields left out, one line with a trailing newline, so equal notes give equal bytes whatever order their keys and rows were built in <!-- claim: note-serialize-canonical -->
- [ ] The note digest is the sha256 of the canonical bytes: the same note always has the same digest, a changed note a different one, and a note that is parsed and serialized again keeps its digest <!-- claim: note-digest-stable -->
- [ ] Compacting a ledger stores each file hash once in a note-wide table, rows list only sorted paths, rows come out in claim and layer order, and the dependency fingerprint is carried once for the whole note <!-- claim: note-compact-files-once -->
- [ ] Expanding a note gives a ledger whose rows keep their origin as `ci`, take their repo sha from where the evidence was earned, get their file hashes back from the table, and keep one entry per layer so a failing layer still decides its claim <!-- claim: note-expand-origin-ci -->
- [ ] A ledger that goes into a note and comes back out gives the same effective verdict for every claim, both when the files are unchanged and when one has changed <!-- claim: note-roundtrip-verdicts -->
- [ ] A note within 1 MiB is kept as it is; over that, fields this version does not define are dropped first and the exercised and counterexample counts are zeroed next (stopping as soon as it fits, with a warning each time and without changing the input); a note still over 8 MiB after trimming is refused with its size <!-- claim: note-size-limits -->
- [ ] Merging two notes of the same commit is deterministic: per claim and layer the newer evidence wins, a failure from the same run beats a later pass, a same-instant tie is settled by failure, then run id, then content, approvals union by claim, hash and review, and the result is the same in either argument order <!-- claim: note-merge-deterministic -->
- [ ] Note authenticity checking is opt-in: with `proofStore.verify` `off` (the default), or `check-run` but no GitHub client or repository, a note reads `unverified` and no call is made <!-- claim: note-verify-opt-in -->
- [ ] With `proofStore.verify` `check-run`, a note is verified only when a `specguard/proof-note` check run on its commit, created by the workflow app, carries a `note-sha256:` summary line equal to the note's digest (compared case-insensitively); check runs from any other app never count <!-- claim: note-verify-check-run-digest -->
- [ ] Check runs that exist but carry another digest, or none that ran on a required branch, give `mismatch`, no check run gives `unverified`, and a failing API call gives `not-checked`, never a pass <!-- claim: note-verify-mismatch-and-branch -->
- [ ] The check run summary leads with `note-sha256: <digest>` followed by schema version, row count and certification level, and the reader recovers exactly that digest from it <!-- claim: note-verify-summary -->
