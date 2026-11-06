---
id: new-features
kind: journey
title: "Quickstart: adding new features"
audience: user
order: 15
useCase: Add a feature in the order that keeps intent first, spec, approval, tests, red, code, green, with a coding agent or by hand.
related:
  - spec-first-changes
  - intent-approval
  - proof-store
  - requirement-history
---

# Quickstart: adding new features

## Goal
Add or change a feature in one fixed order: spec, approval by a person, tests, red, code, green. Review then reads a short proof packet instead of the whole diff.

## Prerequisites
- A project with capability specs (see [one repository](single-repo.md) or [existing code](existing-code.md)).
- Optionally the Claude Code or Codex plugin, so an agent runs the loop and the edit guard is active.

## Steps
### Open a change
```bash
specguard change start shop --why "free shipping over fifty dollars"
```

This writes one committed record of intent, `.specguard/changes/<id>.json`, for the capability `shop`. Use `--refactor` for a change with no new requirement, or `--spike` to allow code first (a spike can never merge as a spike; `specguard change convert <id> --to feature` turns it into a feature once requirements and tests exist).

### Write the requirement and stop
Edit the capability spec to add the requirement as a claim:

```
- [ ] Orders over fifty dollars ship free. <!-- claim: free-shipping -->
```

A person approves the new wording in their own terminal:

```bash
specguard spec approve capabilities/shop#free-shipping --yes
```

An agent environment is refused, `history add` cannot write approvals, and the edit guard denies hand-written approval files.

### Write tests and see them fail
Tag each test with the requirement it proves, for example `// [claims: capabilities/shop#free-shipping]`, then:

```bash
specguard change red
```

This runs exactly those tests against the old code. They must fail, which proves they test something.

### Write the code, then record green
```bash
specguard change green
specguard change status
```

`change green` records the passing run. `change status` shows the stage, what blocks it and the one next command. Once red is recorded and code exists, the tagged tests and changed requirements are locked: editing either sends the change back to the tests stage.

### Push and let CI validate
CI records the evidence as a git note (`specguard ci run`), and the pull request gets one comment with the proof packet: what the requirements now say, the evidence for each changed requirement, certification, test weakening and code no requirement asked for. Build the same packet locally, marked provisional, with `specguard change report`.

### Close the change
```bash
specguard change done
```

`change abandon --why "<reason>"` gives it up.

### Decide how strict each capability is
`enforce:` in a capability's frontmatter sets what happens when code is edited without a valid change:

| Level | Editing the capability's code without a valid change |
|---|---|
| `observe` (default) | allowed, and logged |
| `warn` | allowed, with a message naming the command to run |
| `enforce` | denied, until a change is approved and has a valid red |

```bash
specguard enforce show
specguard enforce raise shop
```

`enforce raise` moves a capability one step up; `--to enforce` is accepted only while the capability is certified. `enforce lower` needs `--why` and is recorded in history.

## Outcome
Every feature has an approved requirement, tests that were seen failing, and a passing run recorded on CI evidence. The history says why.

## Related
- [Detecting drift](drift.md)
- [Core concepts](concepts.md)
- [QA automation](qa-automation.md)
