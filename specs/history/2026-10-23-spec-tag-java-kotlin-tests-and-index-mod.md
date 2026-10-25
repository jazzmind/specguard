---
id: 2026-10-23-spec-tag-java-kotlin-tests-and-index-mod
date: 2026-10-23
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "spec tag: Java/Kotlin tests and --index mode"
affects:
  - spec-authoring
---
# spec tag: Java/Kotlin tests and --index mode

## Decision

spec tag supports JUnit/TestNG Java and Kotlin tests and an --index mode. Brownfield Java/Spring + Angular suites live in another repo and the specs in a separate overlay repo, so tests cannot be edited in place; --index writes one 'file:line :: title  [claims: refs]' line per matched test into a text file that check reads as a listed test file. Chosen over a sidecar JSON because check already picks up [claims: ...] anywhere on a line. The index is dry-run unless --yes like the in-place mode, and already-indexed tests are skipped by file:line or file+title so re-runs and line drift do not re-spend model calls or duplicate lines.
