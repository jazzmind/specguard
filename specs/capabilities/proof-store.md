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
  - "src/core/proof-store.ts"
  - "src/pipelines/proof-sources.ts"
  - "src/pipelines/proof-store-cmd.ts"
  - "src/mcp/tools/proof-store.ts"
docs: []
history:
  - 2026-10-26-phase-3-contracts-and-seams
  - 2026-10-26-proof-note-is-a-pure-json-module-with-ca
  - 2026-10-26-ci-trust-approvals-are-records-ci-plumbi
  - 2026-10-26-proof-store-reads-and-writes-notes-throu
  - 2026-10-27-portable-ci-fixtures-and-grouped-local-d
tests:
  - "tests/core/contracts-phase3.test.ts"
  - "tests/core/config-phase3.test.ts"
  - "tests/core/proof-note.test.ts"
  - "tests/ci/note-verify.test.ts"
  - "tests/core/proof-store.test.ts"
  - "tests/pipelines/proof-sources.test.ts"
  - "tests/pipelines/proof-store-cmd.test.ts"
  - "tests/mcp/proof-fetch-tool.test.ts"
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
- [ ] Every ref, remote and commit name that reaches git is checked first (a notes ref must sit under `refs/notes/`, a remote is a plain name, a commit is a hex name or a safe ref), anything that could be read as an option is refused without running git, git runs only through argument arrays, and credentials in a URL or header never appear in a message <!-- claim: store-git-safe-args -->
- [ ] Fetching the notes ref reports `no-remote`, `no-ref-on-remote`, `offline` or `auth` as outcomes and never throws, a missing notes ref reads as no notes, a successful fetch is forced and recorded, `proof fetch` can add the notes refspec to the remote's fetch settings once, is quiet and never fails in the background form, and skips a fetch younger than `--if-older` or any background fetch when `proofStore.autoFetch` is `off` <!-- claim: store-fetch-and-configure -->
- [ ] Writing a note stores exactly the bytes the canonical serialization produced, so the note's digest is the sha256 of the stored blob, creates the ref and pushes without force; a note over 1 MiB is written trimmed with a warning and one over 8 MiB is not written at all <!-- claim: store-write-and-limits -->
- [ ] Writers never merge notes with git: a push that loses a race is fetched, re-applied on the new tip and pushed again (at most five rounds with jittered backoff), so writers on different commits all land, and a second note for the same commit is merged with the first, then has its statement summary refreshed <!-- claim: store-concurrent-writers -->
- [ ] The nearest noted ancestor is found by a topological walk bounded by `proofStore.maxWalk` that reports its distance and whether it was cut short, a note on a commit that is not an ancestor is never read, and a note of a newer version, a corrupt note or one filed under another commit is skipped with a warning while the walk goes on to an older note <!-- claim: store-nearest-ancestor -->
- [ ] In a shallow clone a walk that finds no note reports itself as truncated, and deepening the clone in steps finds the noted ancestor <!-- claim: store-shallow-clone -->
- [ ] A squash or rebase merge commit finds the note of the pull request head that has the same tree, newest first and optionally only notes newer than a date, without needing the head's commit object <!-- claim: store-squash-import -->
- [ ] Pruning removes only notes older than the given days on commits no branch, remote branch or tag reaches, lists them without `--yes`, never touches a note on a reachable commit and does nothing in a shallow clone <!-- claim: store-prune-reachable -->
- [ ] The effective ledger is the local cache together with the nearest ancestor's note: per claim and layer a fresh failure beats a fresh CI proof, which beats a fresh local proof, which beats a stale row, a changed owned file stales the note's row so a fresh local row decides, local rows are always local evidence whatever origin they say (unless the CI job that wrote them asks to keep it), a note that fails its check run is ignored with a warning, no network call is made unless `proofStore.verify` is `check-run`, and the merged view cannot be written back <!-- claim: store-effective-ledger -->
- [ ] `check` reads the effective ledger when a note is found, names where each capability's evidence came from (`ci note @abc1234 (2 commits back, unverified)`, `local (provisional)` or `mixed: 30 ci, 4 local`) on its statement lines and under `--explain`, can reach certified at HEAD from an ancestor note with no local ledger, ignores notes under `--no-notes`, and for a repo with no notes reads the local file exactly as before <!-- claim: store-evidence-source -->
- [ ] `proof publish` writes the note for the checked-out commit only in CI (or with `--allow-non-github` in another CI), from the fresh CI-origin rows only, refuses a commit that is not checked out, proof files that differ from the commit and a run with nothing fresh, and `--force-local` writes a provisional local note that is not pushed by default and that readers treat as local evidence <!-- claim: store-publish-ci-only -->
- [ ] `specguard_proof_fetch` fetches the notes ref over MCP, writes git refs only and never the working tree, is a write tool a read-only server does not offer, and no MCP tool can publish a proof note <!-- claim: store-fetch-tool -->
