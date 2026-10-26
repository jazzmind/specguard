---
name: specguard-change
description: Use when you are about to change behaviour in a repository that uses SpecGuard changes, or when a hook or `specguard change status` says a change is blocked. Walks the order spec, approval by a person, tests, red, code, green, and how to read the blocks.
---

# Making a change the spec-first way

A change goes in one order: **spec, approval by a person, tests, red, code, green, validated.** The order is enforced by the edit guard and re-checked by CI, so skipping a stage only costs you a denied edit or a blocked pull request.

## When to start a change

Start one before you edit any file a capability owns (`specguard spec graph` shows who owns what):

- New or different behaviour: `specguard change start <capability>` (a feature).
- Restructuring with no behaviour change: `specguard change start <capability> --refactor`. No requirement may change; it needs code and a green run.
- Exploring: `specguard change start <capability> --spike`. Code first is allowed, but a spike cannot merge. Convert it with `specguard change convert <id> --to feature` once its requirements and tests exist.

The `specguard_change_start` MCP tool does the same.

## The loop

1. **Spec.** Edit the capability's requirements to say what should now be true. Write plain, testable sentences.
2. **Approval.** A person approves the new wording with `specguard spec approve <refs>` (or approves a plan in plan mode). **Never approve yourself**: do not run `spec approve`, do not write approval entries, do not edit `specs/history/`. Ask the person and stop.
3. **Tests.** Write tests for each changed requirement and tag them with the requirement (`// [claims: capabilities/<id>#<claim-id>]`). Weak, skipped or conditional tests do not count.
4. **Red.** `specguard change red` runs exactly those tests against the old code and they must fail. A test that passes before the code exists proves nothing: strengthen it.
5. **Code.** Write the code until the tagged tests pass.
6. **Green.** `specguard change green` records the passing run. Push; CI validates. `specguard change report` shows the proof packet reviewers will read.

When a change is finished, `specguard change done <id>`. To give one up, `specguard change abandon <id> --why <text>`.

## Never edit locked tests

Once red is recorded and code exists, the tagged test files and the changed requirements are locked: editing either invalidates the red run and sends the change back to the tests stage. Do not loosen an assertion, add a skip, or delete a test to get green; CI reports weakened tests whatever the order. If a test is wrong, fix it, then run `specguard change red` again.

## Reading `specguard change status`

`change status [id]` (or the `specguard_change_status` tool) prints the stage, the blocks and one next step. Each block has a code and a fix:

| Block | Meaning | What to do |
|---|---|---|
| `NO_INTENT_CHANGE` | no requirement differs from base | edit the spec first |
| `APPROVAL_PENDING` | a person has not approved the current wording | ask them to run `spec approve` |
| `TESTS_MISSING`, `TESTS_NOT_MEANINGFUL` | no test, or only weak ones | tag a real test to the requirement |
| `RED_MISSING`, `RED_NOT_RED` | red not recorded, or a test passed on old code | run `change red`; fix a test that cannot fail |
| `RED_INVALID_TESTS_EDITED`, `RED_INVALID_SPEC_EDITED` | the lock: tests or spec changed after red | run `change red` again |
| `NO_CODE_CHANGE` | nothing owned has changed | write the code |
| `GREEN_MISSING`, `GREEN_STALE`, `GREEN_FAILING` | no green run, one older than the edits, or failing tests | run `change green` |
| `NOT_VALIDATED` | CI has not judged this commit | push |
| `REFACTOR_CHANGES_INTENT` | a refactor edited a requirement | revert it, or start a feature |
| `SPIKE_CANNOT_VALIDATE` | a spike cannot merge | convert it to a feature |

Do the `next` step, then run `change status` again. Local red and green are provisional guidance for you; CI proves red again by running the tests against the base code.
