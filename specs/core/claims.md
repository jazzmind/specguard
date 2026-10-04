# Claims

<!--
  module: src/core/claims.ts
  type: core
  status: draft
-->

## Overview

Gives every acceptance-criteria bullet a stable id and lets a journey spec cite those ids. The id lives in an HTML comment on the bullet (`<!-- claim: award-once -->`) so reordering bullets does not change what a proof refers to. A full reference is `repo:specKey#claimId`, where `repo` is a key in `.specguard/workspace.json` and `specKey` is the path of the spec under that repo's `specs/` directory.

`src/pipelines/claims.ts` assigns missing ids and lists the catalog. Assign never rewrites an id that is already on a bullet.

## Acceptance Criteria

- [ ] `parseClaims` reads `-` and `- [ ]` / `- [x]` bullets and returns the claim id when the anchor is present <!-- claim: parse-bullets -->
- [ ] A bullet without an anchor is still returned, with `id` omitted, so unanchored criteria stay visible <!-- claim: unanchored-visible -->
- [ ] `assignClaimIds` appends an anchor to bullets inside `## Acceptance Criteria` that lack one, and leaves every existing anchor byte-for-byte <!-- claim: assign-preserves -->
- [ ] Generated slugs are lowercase, at most six words, and unique within the file <!-- claim: slug-unique -->
- [ ] `parseClaimRef` accepts `repo:specKey#claimId` and `specKey#claimId`, and rejects a string with no `#` <!-- claim: parse-ref -->
- [ ] A spec with `type: journey` parses `World`, `Actors and Goals`, `Invariants`, `Budget`, and `Evidence` <!-- claim: journey-sections -->
- [ ] Each invariant is an H3 whose `verifies:` line lists claim refs <!-- claim: invariant-verifies -->
- [ ] `danglingClaimRefs` returns every cited ref that is not in the catalog <!-- claim: dangling-refs -->
- [ ] `specguard claims list --workspace` exits with code 2 when a journey cites a missing claim or a spec repeats a claim id <!-- claim: list-fails-dangling -->

## Scenarios

### Scenario 1: Assign leaves an existing id alone

**Steps:**
1. Pass markdown whose Acceptance Criteria has one anchored bullet and one plain bullet
2. Call `assignClaimIds`
3. Call `assignClaimIds` again on the result

**Expected Results:**
- The first call adds exactly one id
- The existing anchor is unchanged
- The second call adds nothing

### Scenario 2: A journey with a missing claim fails the catalog check

**Steps:**
1. Parse a journey whose invariant verifies `services:automation/index#missing`
2. Build a catalog that does not contain that ref
3. Call `danglingClaimRefs`

**Expected Results:**
- The missing ref is reported against the invariant id

## Dependencies

- specs/core/spec-parser.md
