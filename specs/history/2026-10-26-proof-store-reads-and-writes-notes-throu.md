---
id: 2026-10-26-proof-store-reads-and-writes-notes-throu
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Proof store reads and writes notes through git only"
affects:
  - proof-store
---
# Proof store reads and writes notes through git only

## Decision

The proof store gained its git side. A notes module runs git only through argument arrays with every ref and remote name checked, reads the nearest noted ancestor within a bounded walk, fetches and pushes the notes ref, and writes a note by fetching the remote tip, re-applying the note and pushing without force, retrying when another writer won the race, because merging two JSON notes line by line would corrupt them. A sources module reads the local cache together with that ancestor note, choosing per claim and layer by freshness and origin, and treats every local row as local evidence so CI evidence comes from notes alone; note authenticity checking stays opt-in. `check` and `publish` read the effective ledger only when a note exists, so a repo with no notes behaves as before, and the statement says where each capability's evidence came from. New `proof fetch`, `proof publish`, `proof notes` and `proof prune` commands and the `specguard_proof_fetch` tool wrap this; new repos now ignore `.specguard/proofs.json` as a local cache.
