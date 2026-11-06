---
title: "Proof Store (developer reference)"
audience: dev
source: "specs/capabilities/proof-store.md"
generated: true
---
<a id="proof-store"></a>
# Proof Store

<a id="purpose"></a>
## Purpose

The proof store keeps one small proof note per proven commit inside git, under its own notes ref. Only CI writes these notes. A clone or a pull request can then read what was proven for a commit without rerunning tests, trusting a local file, or merging a shared ledger.

The problem it solves: the proof ledger used to be a local file. Proof earned on CI was lost when the job ended, a developer's machine could claim any proof, and a committed ledger was a large file every branch edited. A reader could not tell CI-earned proof from typed-in proof.

A reader finds the nearest noted ancestor of the commit it is on and reads the evidence that is still fresh there. The note is plain text in git, so it needs no server, travels with a clone, and can be checked against the CI run that wrote it.

Journeys it supports:

- **CI job:** runs tests on a commit and stores one proof note for it under the notes ref.
- **Developer on a branch:** reads the nearest noted ancestor's note and sees which claims are still proven for files they have not touched.
- **Parallel branches:** two branches that each prove their own commit never conflict. Each commit has its own note and no shared ledger file is edited.
- **Security-minded team:** turns on note verification so a hand-pushed note is rejected unless the CI check run for its digest exists.
- **Maintainer:** inspects a note and sees one verdict per claim and layer, with file hashes listed once for the whole note.

<a id="responsibilities"></a>
## Responsibilities

- **Note format:** define, parse, serialize and digest the proof note. Parsing is defensive, serialization is canonical, and unknown fields are preserved.
- **Compact and expand:** convert between the local ledger and the note, keeping each file hash once per note, and preserve effective verdicts through a round trip.
- **Size limits:** trim notes over 1 MiB and refuse notes over 8 MiB.
- **Merge:** deterministically merge two notes for the same commit.
- **Verification:** optionally check a note's digest against a CI check run.
- **Git storage:** fetch, write, push, prune and walk the notes ref, with safe argument handling and a retry protocol for concurrent writers.
- **Reading:** find the nearest noted ancestor, import notes across squash or rebase merges, and build the effective ledger that combines the local cache with the note.
- **Surfaces:** `check` evidence reporting, `proof fetch`, `proof publish`, and the `specguard_proof_fetch` MCP tool.

<a id="interfaces"></a>
## Interfaces

<a id="configuration-proofstore"></a>
### Configuration (`proofStore`)

| Key | Behaviour stated in the spec |
|---|---|
| (default refs) | Notes live under `refs/notes/specguard` on the `origin` remote unless `proofStore` names others. |
| `verify` | `off` (default) or `check-run`. A network check against a CI check run happens only for `check-run`. |
| `autoFetch` | When `off`, any background fetch is skipped. |
| `maxWalk` | Bounds the ancestor walk. |

<a id="cli"></a>
### CLI

- **`check`:** reads the effective ledger when a note is found. It names the evidence source on statement lines and under `--explain`. `--no-notes` ignores notes.
- **`proof fetch`:** fetches the notes ref and can add the notes refspec to the remote's fetch settings once. The background form is quiet and never fails. `--if-older` skips a fetch younger than the given age.
- **`proof publish`:** writes the note for the checked-out commit, CI only (or `--allow-non-github` in another CI). `--force-local` writes a provisional local note.
- **Prune:** removes old notes on unreachable commits. It lists them without `--yes`.

<a id="mcp"></a>
### MCP

- **`specguard_proof_fetch`:** fetches the notes ref. It is a write tool, so a read-only server does not offer it. No MCP tool can publish a proof note.

<a id="note-and-check-run-contract"></a>
### Note and check-run contract

- **Note fields:** a note names its schema and version and carries commit, tree, rows, approvals and statement summary.
- **Parse failures:** `not-json`, `wrong-schema`, `invalid` and `newer-version`.
- **Fetch outcomes:** `no-remote`, `no-ref-on-remote`, `offline`, `auth`.
- **Verification results:** `unverified`, `mismatch`, `not-checked`.
- **Check run:** named `specguard/proof-note`. Its summary leads with `note-sha256: <digest>`, followed by schema version, row count and certification level.
- **Evidence source labels:** for example `ci note @abc1234 (2 commits back, unverified)`, `local (provisional)`, `mixed: 30 ci, 4 local`.

<a id="requirements"></a>
## Requirements

<a id="note-format"></a>
### Note format

- **note-contract**: A proof note names its schema and version and carries the commit, tree, rows, approvals and statement summary. The contract accepts a complete note, rejects one with a wrong schema, a missing field or a malformed approval hash, and keeps fields it does not know.
- **note-defaults**: Notes live under `refs/notes/specguard` on the `origin` remote unless `proofStore` names others. A note over 1 MiB is trimmed and one over 8 MiB is refused. A note is checked against a CI check run only when `proofStore.verify` is `check-run`.
- **note-parse-defensive**: A proof note is read defensively. Text that is not JSON, JSON that is not a proof note, and a note whose shape is wrong each return a named failure (`not-json`, `wrong-schema`, `invalid`) with a short detail, never a throw. Unknown fields are kept and written back.
- **note-newer-version**: A note written by a newer SpecGuard is reported as `newer-version` before its shape is checked, so a layout this reader cannot validate is never misread as invalid or thrown on. A wrong schema name still wins over the version.
- **note-serialize-canonical**: A note serializes canonically: keys sorted at every depth, rows ordered by claim then layer, absent fields left out, one line with a trailing newline. Equal notes give equal bytes whatever order their keys and rows were built in.
- **note-digest-stable**: The note digest is the sha256 of the canonical bytes. The same note always has the same digest, a changed note a different one, and a note that is parsed and serialized again keeps its digest.

<a id="compact-expand-limits-merge"></a>
### Compact, expand, limits, merge

- **note-compact-files-once**: Compacting a ledger stores each file hash once in a note-wide table. Rows list only sorted paths and come out in claim and layer order. The dependency fingerprint is carried once for the whole note.
- **note-expand-origin-ci**: Expanding a note gives a ledger whose rows keep their origin as `ci`, take their repo sha from where the evidence was earned, get their file hashes back from the table, and keep one entry per layer so a failing layer still decides its claim.
- **note-roundtrip-verdicts**: A ledger that goes into a note and comes back out gives the same effective verdict for every claim, both when the files are unchanged and when one has changed.
- **note-size-limits**: A note within 1 MiB is kept as it is. Over that, fields this version does not define are dropped first, then the exercised and counterexample counts are zeroed. Trimming stops as soon as the note fits, warns each time, and does not change the input. A note still over 8 MiB after trimming is refused, with its size.
- **note-merge-deterministic**: Merging two notes of the same commit is deterministic. Per claim and layer the newer evidence wins. A failure from the same run beats a later pass. A same-instant tie is settled by failure, then run id, then content. Approvals union by claim, hash and review. The result is the same in either argument order.

<a id="verification"></a>
### Verification

- **note-verify-opt-in**: Authenticity checking is opt-in. With `proofStore.verify` `off` (the default), or `check-run` but no GitHub client or repository, a note reads `unverified` and no call is made.
- **note-verify-check-run-digest**: With `proofStore.verify` `check-run`, a note is verified only when a `specguard/proof-note` check run on its commit, created by the workflow app, carries a `note-sha256:` summary line equal to the note's digest (compared case-insensitively). Check runs from any other app never count.
- **note-verify-mismatch-and-branch**: Check runs that exist but carry another digest, or none that ran on a required branch, give `mismatch`. No check run gives `unverified`. A failing API call gives `not-checked`, never a pass.
- **note-verify-summary**: The check run summary leads with `note-sha256: <digest>` followed by schema version, row count and certification level. The reader recovers exactly that digest from it.

<a id="git-storage"></a>
### Git storage

- **store-git-safe-args**: Every ref, remote and commit name that reaches git is checked first. A notes ref must sit under `refs/notes/`, a remote is a plain name, and a commit is a hex name or a safe ref. Anything that could be read as an option is refused without running git. Git runs only through argument arrays. Credentials in a URL or header never appear in a message.
- **store-fetch-and-configure**: Fetching the notes ref reports `no-remote`, `no-ref-on-remote`, `offline` or `auth` as outcomes and never throws. A missing notes ref reads as no notes. A successful fetch is forced and recorded. `proof fetch` can add the notes refspec to the remote's fetch settings once, is quiet and never fails in the background form, and skips a fetch younger than `--if-older` or any background fetch when `proofStore.autoFetch` is `off`.
- **store-write-and-limits**: Writing a note stores exactly the bytes the canonical serialization produced, so the note's digest is the sha256 of the stored blob. It creates the ref and pushes without force. A note over 1 MiB is written trimmed with a warning, and one over 8 MiB is not written at all.
- **store-concurrent-writers**: Writers never merge notes with git. A push that loses a race is fetched, re-applied on the new tip and pushed again (at most five rounds with jittered backoff), so writers on different commits all land. A second note for the same commit is merged with the first, then has its statement summary refreshed.
- **store-nearest-ancestor**: The nearest noted ancestor is found by a topological walk bounded by `proofStore.maxWalk` that reports its distance and whether it was cut short. A note on a commit that is not an ancestor is never read. A note of a newer version, a corrupt note or one filed under another commit is skipped with a warning while the walk goes on to an older note.
- **store-shallow-clone**: In a shallow clone a walk that finds no note reports itself as truncated, and deepening the clone in steps finds the noted ancestor.
- **store-squash-import**: A squash or rebase merge commit finds the note of the pull request head that has the same tree, newest first and optionally only notes newer than a date, without needing the head's commit object.
- **store-prune-reachable**: Pruning removes only notes older than the given days on commits no branch, remote branch or tag reaches. It lists them without `--yes`, never touches a note on a reachable commit, and does nothing in a shallow clone.

<a id="reading-and-publishing"></a>
### Reading and publishing

- **store-effective-ledger**: The effective ledger is the local cache together with the nearest ancestor's note.
  - Per claim and layer, a fresh failure beats a fresh CI proof, which beats a fresh local proof, which beats a stale row.
  - A changed owned file stales the note's row, so a fresh local row decides.
  - Local rows are always local evidence whatever origin they say, unless the CI job that wrote them asks to keep it.
  - A note that fails its check run is ignored with a warning.
  - No network call is made unless `proofStore.verify` is `check-run`.
  - The merged view cannot be written back.
- **store-evidence-source**: `check` reads the effective ledger when a note is found. It names where each capability's evidence came from (`ci note @abc1234 (2 commits back, unverified)`, `local (provisional)` or `mixed: 30 ci, 4 local`) on its statement lines and under `--explain`. It can reach certified at HEAD from an ancestor note with no local ledger. It ignores notes under `--no-notes`. For a repo with no notes it reads the local file exactly as before.
- **store-publish-ci-only**: `proof publish` writes the note for the checked-out commit only in CI (or with `--allow-non-github` in another CI), from the fresh CI-origin rows only. It refuses a commit that is not checked out, proof files that differ from the commit, and a run with nothing fresh. `--force-local` writes a provisional local note that is not pushed by default and that readers treat as local evidence.
- **store-fetch-tool**: `specguard_proof_fetch` fetches the notes ref over MCP, writes git refs only and never the working tree, is a write tool a read-only server does not offer, and no MCP tool can publish a proof note.

<a id="code-map"></a>
## Code map

Seven owned files:

- `src/core/proof-note.ts`
- `src/cli/commands/proof-store.ts`
- `src/ci/note-verify.ts`
- `src/core/proof-store.ts`
- `src/pipelines/proof-sources.ts`
- `src/pipelines/proof-store-cmd.ts`
- `src/mcp/tools/proof-store.ts`

The spec does not assign requirements to individual files. The directory layout suggests the split: note format in `core`, CI verification in `ci`, command and pipeline wiring in `cli` and `pipelines`, and the MCP tool in `mcp/tools`.

<a id="tests"></a>
## Tests

- `tests/core/contracts-phase3.test.ts`
- `tests/core/config-phase3.test.ts`
- `tests/core/proof-note.test.ts`
- `tests/ci/note-verify.test.ts`
- `tests/core/proof-store.test.ts`
- `tests/pipelines/proof-sources.test.ts`
- `tests/pipelines/proof-store-cmd.test.ts`
- `tests/mcp/proof-fetch-tool.test.ts`

The spec does not map individual tests to requirement ids.

<a id="security-and-data"></a>
## Security and data

- **Provenance:** notes are written only by CI. `proof publish` refuses to run outside CI unless `--allow-non-github` is given, and it publishes only fresh CI-origin rows. `--force-local` notes are provisional, are not pushed by default, and readers treat them as local evidence.
- **Authenticity:** the check is opt-in via `proofStore.verify: check-run`. A note passes only if a `specguard/proof-note` check run created by the workflow app carries its sha256 digest. Check runs from other apps never count. A failing API call gives `not-checked`, never a pass. A note that fails verification is ignored with a warning. With `off`, notes read `unverified` and no network call is made.
- **Git safety:** names are validated before reaching git, option-like input is refused without running git, git is invoked only through argument arrays, and credentials in a URL or header never appear in messages.
- **Writes without force:** pushes are never forced. Lost races are retried by re-applying on the new tip, at most five rounds, rather than by git merges.
- **Size limits:** 1 MiB trims, 8 MiB refuses, on both the note-processing and the write path.
- **Local evidence:** local rows are always local evidence whatever origin they claim, unless the CI job that wrote them asks to keep it. The merged effective ledger cannot be written back.
- **MCP:** `specguard_proof_fetch` writes git refs only, never the working tree. A read-only server does not offer it. No MCP tool can publish a note.
- **Data held:** a note carries the commit, tree, rows, approvals and statement summary, with file hashes in one note-wide table. Notes are plain text, one canonical line per note.

<a id="extending-it"></a>
## Extending it

The spec does not define an extension procedure. These points follow from the requirements:

- **Adding note fields:** readers keep and write back fields they do not know (**note-contract**, **note-parse-defensive**). Fields a given version does not define are the first thing dropped when trimming (**note-size-limits**), so do not make verdicts depend on optional extras.
- **Changing the layout:** a layout an older reader cannot validate is reported as `newer-version` before shape checks (**note-newer-version**), and the walk skips such notes with a warning (**store-nearest-ancestor**).
- **Serialization changes:** the digest is the sha256 of the canonical bytes, and the stored blob must be exactly those bytes (**note-digest-stable**, **store-write-and-limits**). Any change must keep equal notes byte-equal and keep a parse and re-serialize round trip digest-stable.
- **Merge or precedence changes:** merging must stay deterministic and argument-order independent (**note-merge-deterministic**). Changes to evidence precedence must respect **store-effective-ledger**, and verdicts must survive a round trip (**note-roundtrip-verdicts**).
- **New git operations:** route names through the same validation and use argument arrays only (**store-git-safe-args**). Report failures as named outcomes instead of throwing (**store-fetch-and-configure**).
- **New MCP tools:** keep fetching a write tool that read-only servers do not offer, and do not add any MCP tool that publishes notes (**store-fetch-tool**).
