---
id: 2026-10-26-test-strength-is-a-static-reading-of-tes
date: 2026-10-26
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Test strength is a static reading of test source, with policy findings guarding unhashed frontmatter"
affects:
  - test-strength
---
# Test strength is a static reading of test source, with policy findings guarding unhashed frontmatter

## Decision

A tagged test counts as proof only if a static reader of its source finds it neither skipped nor gated and asserting something meaningful; helpers are trusted by convention or config, not followed across files; snapshot-only is weak by default; each required layer except functional needs its own strong test; weakening between versions (including policy-* findings for layers, assurance and evidence frontmatter, which sit outside the claim hash) is reported as findings and does not extend approvals or hashes.
