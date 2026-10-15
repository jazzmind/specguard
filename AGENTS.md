# AGENTS.md

<!-- specguard-managed: true -->

## SpecGuard Enforced (typescript)

This repository uses **SpecGuard** for spec-driven QA. Code is fluid; the specs in
`specs/`, and the tests that prove the code conforms to them, are the source of truth.
`specs/system.md` describes the whole system; each file in `specs/capabilities/` describes
one piece of functionality that delivers value, and lists the code, tests and docs behind it.
As an AI agent you **must** keep specs and code in sync.

### Workflow

1. **Find the spec.** `specguard spec graph` shows which capability owns a file. Read it, and
   `specs/system.md`, before changing the code (target language: typescript).
2. **Edit** — make your code changes.
3. **Update the spec** — if behaviour or requirements change, edit the capability spec: its
   requirements are the bullets under `## Requirements`, each with a claim id
   (`<!-- claim: some-id -->`). Record why with `specguard history add` (or let the
   history hooks capture the plan).
4. **Prove it** — run the tests (`npm test`). Tag a test that proves a requirement
   with a comment above it: `// [claims: capabilities/<id>#<claim-id>]`. Then run
   `specguard check`; it reports files no spec owns, untested requirements, stale proofs and drift.
5. **Report** — include the `check` summary in your response.

> **Tip**: A project with no specs yet starts with `specguard spec draft`; one with a spec per
> file moves to capability specs with `specguard spec consolidate`. `specguard spec tag`
> links existing tests to the requirements they prove.

### Pipelines

| Command | What it does |
|---------|-------------|
| `specguard check` | Spec health for the whole system: ownership, tests, proofs, gaps, drift. Start here |
| `specguard spec graph` | The spec tree, the files each spec owns, and rule violations |
| `specguard spec draft` | Write the system spec and functional capability specs from existing code |
| `specguard history add` | Record why a requirement changed: a prompt, plan or decision |
| `specguard test run` | Run the tests and record the results as proof |
| `specguard verify --all --url <base>` | Judge the running app against each capability's problem and value |
| `specguard security scan` | Code, dependency, secret and spec-level findings as one remediation plan |
| `specguard serve` | Docs and audit API, with a web UI |
| (tests run via) | `npm test` |

Without a global install, run any command as `npx -p specguard-ai specguard <command>`.

### Safety Rules

- NO secrets or credentials in code.
- NEVER edit a spec to make a gap disappear — implement the code instead.
- Treat `heal` `app-bug` results as real defects, not test problems.
