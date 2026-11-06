---
title: "Quickstart: one repository"
audience: user
order: 10
source: "specs/guides/single-repo.md"
generated: true
---
<a id="quickstart-one-repository"></a>
# Quickstart: one repository

> Put one repository under SpecGuard and see, requirement by requirement, whether tests prove the code.

<a id="goal"></a>
## Goal
Take a single repository from nothing to a first `specguard check`: specs drafted from the code, existing tests linked to the requirements they prove, and a view of what is proven and what is not.

<a id="prerequisites"></a>
## Prerequisites
- Node.js 20 or newer and a git repository with some code and, ideally, some tests.
- Either a coding agent (Claude Code or Codex, no API key needed) or a model key set once with `specguard key set`.

<a id="steps"></a>
## Steps
<a id="start"></a>
### Start
Inside a coding agent, install the plugin and run the start command:

```
/plugin marketplace add jazzmind/specguard
/plugin install specguard@specguard
/specguard:start
```

From any terminal, one command does the same job:

```bash
npx -y -p specguard-ai specguard start
```

`start` sets the project up if needed (one config file and a specs README), drafts specs from your code, links existing tests to the requirements they prove, runs them, and reports where things stand. When a step needs a model, it writes a request under `.specguard/agent-requests/` and exits with code 12, which means "waiting for the agent", not a failure. The agent answers (`specguard agent pending`, then `specguard agent answer <hash> --file <path>`) and you run the same command again.

<a id="read-what-was-drafted"></a>
### Read what was drafted
The drafted specs describe what the code does today. They are drafts for you to read and correct, not yet statements of what the system should do.

```bash
specguard spec graph
```

You will see `specs/system.md`, one capability spec per piece of functionality, the files each owns, and any rule violations. Edit the wording, merge or split capabilities, and delete requirements that are accidents of the implementation.

<a id="run-the-first-check"></a>
### Run the first check
```bash
specguard check
specguard check --gaps
```

`check` prints a proof statement per capability, the source files no spec owns, orphan specs and intent gaps. `--gaps` lists untested claims and claims that are stale, failed or unproven.

<a id="link-tests-to-requirements"></a>
### Link tests to requirements
If `start` did not link every test, do it explicitly:

```bash
specguard spec tag --list
specguard spec tag --yes
```

`spec tag` finds existing tests (JavaScript and TypeScript, Python, Go, Rust, Java and Kotlin) and tags each with the claim it proves. Tags look like `// [claims: capabilities/shop#free-shipping]`. Use `--index <file>` to record the links in a text file instead of editing the tests.

<a id="run-the-tests-and-record-proof"></a>
### Run the tests and record proof
```bash
specguard test run
specguard check
```

`test run` runs the configured suites, reads their reports and records a verdict per claim in `.specguard/proofs.json`. Configure each app's `test` block (command, reporter) in `.specguard/config.json` if `init` could not detect it.

<a id="keep-the-history"></a>
### Keep the history
```bash
specguard history add --kind decision --title "Free shipping threshold" --affects shop --decision "Orders over fifty dollars ship free"
```

History records why a requirement exists. `specguard init --history-hooks` records prompts and approved plans automatically.

<a id="outcome"></a>
## Outcome
You have `specs/` in git, tagged tests, a proof ledger, and a `check` that tells you which capabilities are proven, failing, stale or untested. Local proof is `provisional`; it becomes `certified` when CI records it (see [QA automation](qa-automation.md)).

<a id="related"></a>
## Related
- [Adding a new feature](new-features.md)
- [Detecting drift](drift.md)
- [QA automation](qa-automation.md)
- [Core concepts](concepts.md)

<a id="reference-pages"></a>
## Reference pages

- [Spec Authoring](./reference/spec-authoring.md)
- [Traceability and Drift](./reference/traceability-and-drift.md)
- [Conformance Testing](./reference/conformance-testing.md)
