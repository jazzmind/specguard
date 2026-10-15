# Claim tags

<!--
  module: src/core/claim-tags.ts
  type: core
  status: draft
-->

## Overview

A claim tag ties a test to an acceptance-criteria claim without an LLM. The canonical form is `@claim:<specKey>#<claimId>` (with an optional `repo:` prefix on the spec key) placed in a test title, a Playwright tag, or an annotation. `[claim: ref]` suffixes and `[claims: ref, ref]` lists are accepted as well. `matrix`, `align`, and `results ingest` all read tags through this module so they agree on what a test covers.

## Acceptance Criteria

- [ ] `extractClaimRefs` finds `@claim:spec#id`, `[claim: spec#id]`, and `[claims: a#b, c#d]` forms in a string and returns normalized refs with the claim id lowercased <!-- claim: extract-forms -->
- [ ] A spec key may contain slashes and a `repo:` prefix, and a trailing sentence period is not part of the ref <!-- claim: spec-key-shape -->
- [ ] `scanSourceForClaimTags` returns each ref with the 1-based line number and the nearest enclosing test title when one is on that line <!-- claim: scan-source -->
- [ ] `buildClaimTestIndex` merges tags found in test sources with tags found in result files into one `ref -> tests[]` map <!-- claim: build-index -->
- [ ] `claimTag(ref)` returns the exact string `@claim:<ref>` so generated tests and the parser agree <!-- claim: tag-roundtrip -->

## Scenarios

### Scenario 1: Title tag and suffix tag

**Steps:**
1. Call `extractClaimRefs('award once @claim:core/awards#award-once [claim: core/awards#no-dupes]')`

**Expected Results:**
- Both refs are returned
