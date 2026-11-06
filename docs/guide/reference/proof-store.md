---
title: "Proof Store"
audience: user
source: "specs/capabilities/proof-store.md"
generated: true
---
<a id="proof-store"></a>
# Proof Store

The proof store keeps a small proof record, called a note, for each commit that has been proven. The note lives inside git, is written only by CI, and travels with the repository.

<a id="why-it-exists"></a>
## Why it exists

Proof used to sit in a local file. That caused three problems:

- Proof earned on a CI machine disappeared when the job ended.
- A developer's machine could claim any proof it liked.
- A ledger committed to the repository was a large file that every branch edited.

With the proof store, anyone with a clone or a pull request can see what was proven without rerunning tests, trusting a local file, or merging a shared ledger. Each commit has its own note, so two branches that prove their own commits never conflict. The notes are plain text in git, so they need no server.

<a id="what-you-can-do"></a>
## What you can do

**Publish proof from CI**
- `proof publish` writes the note for the checked-out commit. It works in CI, or in another CI system if you pass `--allow-non-github`.
- The note is built only from fresh CI-earned results.
- It refuses to publish if the commit is not the one checked out, if the proof files differ from the commit, or if nothing fresh was proven.
- `--force-local` writes a provisional local note. It is not pushed by default, and readers treat it as local evidence.
- If another writer pushes at the same moment, the publish retries on the new tip (up to five rounds). Writers on different commits all land. A second note for the same commit is merged with the first.

**Read proof on a branch**
- `check` looks back through history for the nearest commit that has a note and combines it with your local results. You see which claims are still proven for files you have not touched. A commit can reach certified from an ancestor's note, even with no local ledger.
- Statement lines and `--explain` show where each capability's evidence came from, for example `ci note @abc1234 (2 commits back, unverified)`, `local (provisional)`, or `mixed: 30 ci, 4 local`.
- `--no-notes` ignores notes. In a repository with no notes, `check` reads the local file as it always did.
- `proofStore.maxWalk` limits how far back the search goes.

**Fetch notes**
- `proof fetch` brings the notes down from the remote. It can add the notes setting to the remote's fetch configuration once, so ordinary fetches pick them up.
- In its background form it is quiet and never fails. `--if-older` skips a fetch that is too recent.
- Setting `proofStore.autoFetch` to `off` stops all background fetches.
- Through MCP, `specguard_proof_fetch` does the same. It changes only git refs, never your working files, and a read-only server does not offer it. No MCP tool can publish a note.

**Verify that a note came from CI**
- Verification is off by default. Set `proofStore.verify` to `check-run` to turn it on.
- A note then counts as verified only if the commit has a `specguard/proof-note` check run, created by the workflow app, whose summary carries the note's digest. Check runs from other apps never count.
- A hand-pushed note without a matching check run is not trusted, and a note that fails verification is ignored with a warning.

**Squash and rebase merges**
- A squash or rebase merge commit can find the note of the pull request head that has the same tree. You can optionally limit this to notes newer than a given date.

**Clean up**
- Pruning removes notes older than a number of days, only on commits that no branch, remote branch or tag reaches. Without `--yes` it only lists what it would remove. It never touches notes on reachable commits and does nothing in a shallow clone.

**Inspect a note**
- A note shows one verdict per claim and layer. File hashes are listed once for the whole note.

<a id="what-to-expect"></a>
## What to expect

**Where notes live.** By default they are under `refs/notes/specguard` on the `origin` remote. `proofStore` can name different ones.

**Which evidence wins.** For each claim and layer, the order is:
1. a fresh failure
2. a fresh CI proof
3. a fresh local proof
4. a stale row

If you change a file a claim depends on, the note's row for it goes stale and a fresh local result decides. Local results always count as local evidence. This combined view is for reading only and cannot be written back.

**Verification results.**
- With verification off, or with no GitHub client or repository available, notes read `unverified` and no network call is made.
- With `check-run` on, no check run gives `unverified`. A check run with a different digest gives `mismatch`. A failing API call gives `not-checked`. None of these ever counts as a pass.

**Size limits.** A note up to 1 MiB is kept as is. A larger note is trimmed, with a warning: fields this version doesn't define are dropped first, then the exercised and counterexample counts are zeroed. A note still over 8 MiB after trimming is refused and not written.

**Notes that can't be used.** Notes that are newer than your SpecGuard version, corrupt, or filed under the wrong commit are skipped with a warning, and the search continues to an older note. A note on a commit that is not an ancestor is never read.

**Shallow clones.** If a search finds no note in a shallow clone, it reports that the result may be incomplete. Deepening the clone step by step finds the noted ancestor.

**Fetch outcomes.** Fetching reports `no-remote`, `no-ref-on-remote`, `offline` or `auth` instead of failing. A missing notes ref simply means there are no notes.

**Safety.** Ref, remote and commit names are checked before git is run, and anything that could be read as an option is refused. Credentials in URLs or headers never appear in messages.

**Stable notes.** The same proof always produces the same note, whatever order it was built in. Fields written by a newer tool that this version doesn't recognize are kept when a note is rewritten.
