# AGENTS.md

<!-- specguard-managed: true -->

## SpecGuard Enforced (typescript)

This repository uses **SpecGuard** for spec-driven QA. Specs in `specs/` are the
source of truth. As an AI agent you **must** keep specs and code in sync.

### Workflow

1. **Read the spec** for a module before implementing it.
2. **Edit** — make your code changes (target language: typescript).
3. **Update the spec** — if implementation reveals gaps or changes, edit the spec file in `specs/` to match.
4. **Validate** — run `specguard drift` when done. Run tests: `npm test`.
5. **Report** — include the pipeline summary in your response.

> **Tip**: For new modules with no test coverage yet, run `specguard generate --spec <key>`
> then `specguard heal --all` to bootstrap tests. Run `specguard align --all` to map
> existing tests to spec scenarios.

### Pipelines

| Command | What it does |
|---------|-------------|
| `specguard analyze` | Smart diagnostics — start here when unsure |
| `specguard gap-analysis` | Find unimplemented specs and generate build plans |
| `specguard status` | Spec + test coverage report |
| `specguard reverse --all` | Generate Living Specs from source |
| `specguard generate --all` | Generate test files from specs |
| `specguard align --all` | Map existing tests to spec scenarios |
| `specguard heal --all` | Run tests and auto-fix test bugs |
| `specguard drift` | Detect specs out of sync with code |
| `specguard security --all` | OWASP security test stubs |
| (tests run via) | `npm test` |

### Safety Rules

- NO secrets or credentials in code.
- NEVER edit a spec to make a gap disappear — implement the code instead.
- Treat `heal` `app-bug` results as real defects, not test problems.
