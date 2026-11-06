---
id: 2026-11-06-ignore-block-covers-nested-repos-in-over
date: 2026-11-06
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Ignore block covers nested repos in overlays"
affects:
  - platform-foundation
---
# Ignore block covers nested repos in overlays

## Decision

An overlay repo keeps several workspace repos under one git root (apps/<key>/.specguard/). The managed ignore block used root-anchored patterns, so each nested repo's run records, publish snapshots, usage and proof caches showed up as untracked or got committed. init and migrate now detect a workspace manifest that lists repos inside the root and write any-depth patterns instead; .specguard/publish/ joins the generated-state list (it was only in SpecGuard's own hand-written ignore). Run records stay uncommitted: they differ per run and machine.
