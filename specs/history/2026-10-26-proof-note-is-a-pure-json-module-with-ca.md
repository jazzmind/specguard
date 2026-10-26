---
id: 2026-10-26-proof-note-is-a-pure-json-module-with-ca
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Proof note is a pure JSON module with canonical bytes"
affects:
  - proof-store
---
# Proof note is a pure JSON module with canonical bytes

## Decision

Decision: the proof note is a single JSON document with a schema name and an integer version, read through a loose schema and canonically serialized, and it stays a pure module (parse, serialize, digest, compact, expand, fit, merge) with the git plumbing elsewhere. Version is checked before shape so a newer note is reported and skipped rather than misread. Notes hold one file-hash table that rows reference by path, which keeps a cumulative note small. Canonical bytes (sorted keys, ordered rows) make the digest reproducible, which the authenticity check depends on. Size limits trim in two fixed steps (undefined row fields, then the counts, which the schema requires and so are zeroed rather than removed) and refuse only what would still exceed the hard limit after trimming. Same-commit merges are a pure function with a total tie-break, instead of a line-based git notes merge, because that interleaves the lines of two JSON documents and corrupts them; two jobs racing on one commit therefore land on the same result in any order. Why: readers need only the nearest noted ancestor, notes must not be forgeable by reordering, and concurrent writers must not lose or corrupt evidence.
