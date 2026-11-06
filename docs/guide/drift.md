---
title: "Quickstart: detecting drift"
audience: user
order: 16
source: "specs/guides/drift.md"
generated: true
---
<a id="quickstart-detecting-drift"></a>
# Quickstart: detecting drift

> Find out when code has changed faster than its specs, in one repository and across repositories.

<a id="goal"></a>
## Goal
Find capabilities whose code changed without their spec changing, and proofs that went stale, before they turn into surprises.

<a id="prerequisites"></a>
## Prerequisites
- Capability specs with `sources` globs (see [one repository](single-repo.md)).
- A git history. Drift compares against a git ref.

<a id="steps"></a>
## Steps
<a id="one-verdict-per-capability"></a>
### One verdict per capability
```bash
specguard check --drift
specguard check --drift --since origin/main
```

With capability specs, `check --drift` gives one verdict per capability: it looks at the code that changed and judges it against that capability's requirements. Without `--since` it compares the working tree with HEAD. Restrict to one capability with `--spec <id>`.

<a id="the-older-commands-still-work"></a>
### The older commands still work
```bash
specguard drift --since HEAD~1
specguard status
```

`drift` keeps its exit code (3 when specs are stale) and, in a repo with capability specs, delegates to the same model. `--force` re-evaluates every file instead of using the hash cache.

<a id="stale-proofs-are-drift-too"></a>
### Stale proofs are drift too
A proof goes stale when its spec, an owned source file or a lockfile changes after the run that earned it.

```bash
specguard proof status
specguard check --gaps
```

Both list stale claims. Rerun the tests (`specguard test run`) to refresh them; a claim whose test no longer passes becomes `failed`, which is the signal you wanted.

<a id="intent-gaps"></a>
### Intent gaps
`check` also reports an intent gap when code changed after the last recorded intent for a capability. Record the intent that explains the change:

```bash
specguard history add --kind decision --title "Retry payments twice" --affects checkout --decision "A failed charge is retried twice before the order fails"
```

Set `history.failOnIntentGap` in the config to make an intent gap fail the check.

<a id="across-repositories"></a>
### Across repositories
Contracts connect one repository's specs to another's. A change in a provider flags its consumers:

```bash
specguard workspace drift --since origin/main
specguard workspace drift --repo api --force
```

`--repo <key>` restricts to one repository and `--force` rechecks every contract regardless of git changes. See [Contracts](contracts.md).

<a id="make-it-automatic"></a>
### Make it automatic
Run `check` in CI so a stale proof or an intent gap shows up on the pull request, and let the edit guard (`enforce` levels) stop code changes that skip the spec. See [QA automation](qa-automation.md) and [Adding a new feature](new-features.md).

<a id="outcome"></a>
## Outcome
You know which capabilities have drifted, which proofs are stale, and which changes have no recorded intent, in one repository or across several.

<a id="related"></a>
## Related
- [Contracts](contracts.md)
- [QA automation](qa-automation.md)
- [Core concepts](concepts.md)

<a id="reference-pages"></a>
## Reference pages

- [Traceability and Drift](./reference/traceability-and-drift.md)
- [Workspaces - Multi-Repo and Monorepo](./reference/workspaces.md)
- [Requirement History](./reference/requirement-history.md)
