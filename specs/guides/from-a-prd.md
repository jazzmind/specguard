---
id: from-a-prd
kind: journey
title: "Quickstart: working from a PRD"
audience: user
order: 13
useCase: Turn a product requirements document into specs a person approves, then tests and code that prove them.
related:
  - spec-authoring
  - intent-approval
  - spec-first-changes
---

# Quickstart: working from a PRD

## Goal
Start from a product requirements document (a Markdown file, or a page at a URL) and end with capability specs whose requirements a person has approved, ready for tests and code.

## Prerequisites
- A project set up with `specguard init` (see [one repository](single-repo.md)).
- The document as a file or an `https://` URL. A URL that resolves to a loopback, private or link-local address is refused unless you pass `--allow-private`.
- A model: a coding agent in host mode, or a configured provider.

## Steps
### Import the document
```bash
specguard import docs/prd-checkout.md
```

`import` reads the document and writes spec files from it. Use `--app <name>` to pick the target app, `--out <path>` to choose the spec path, and `--force` to overwrite. Read what it wrote: a PRD describes intent, and the specs it produces are drafts.

### Add to an existing capability instead
When the system already has specs and the document extends one of them:

```bash
specguard import docs/prd-checkout.md --capability checkout
specguard import docs/prd-checkout.md --capability checkout --yes
```

The first command is a dry run that shows the requirements it would add; `--yes` writes them.

### Make the requirements testable
Each requirement should be a claim with a stable id and, where possible, an examples table, so a test can prove it. Edit the capability spec until every bullet is something a test can pass or fail. `specguard check --gaps` lists claims with no test.

### Record why
```bash
specguard history add --kind plan --title "Checkout from the Q3 PRD" --plan docs/prd-checkout.md --affects checkout
```

The history entry keeps the document's intent next to the requirements it produced.

### Approve in your own terminal
Approval is a person's act. An agent environment is refused, and `history add` cannot write approvals:

```bash
specguard spec approve capabilities/checkout#free-shipping --yes
specguard spec approvals
```

### Build it spec first
From here, each requirement goes through the change protocol: tests written and seen failing, then code, then green. See [Adding a new feature](new-features.md).

## Outcome
The PRD's intent is in specs under version control, each requirement has an id, the approval is on record, and `check` shows which requirements still have no test or no proof.

## Related
- [Adding a new feature](new-features.md)
- [Working with existing code](existing-code.md)
- [Core concepts](concepts.md)
