# AGENTS.md

<!-- specguard-managed: true -->

## SpecGuard Enforced

This repository uses **SpecGuard** for spec-driven QA. As an AI agent you **must**
follow this workflow before finishing any task:

### Workflow

1. **Edit** — make your code changes.
2. **Validate** — run the SpecGuard pipeline:
   ```bash
   npx specguard validate --all
   ```
3. **Repair** — if validation fails, fix the issues and re-run.
4. **Report** — include the pipeline output summary in your response.

### Available Pipelines

| Command | What it does |
|---------|-------------|
| `specguard init` | Scaffold `.specguard/config.json` and first specs |
| `specguard reverse --all` | Generate Living Specs from source code |
| `specguard generate --all` | Generate test files from specs |
| `specguard validate --all` | Validate specs against the running app |
| `specguard drift` | Detect specs out of sync with code |
| `specguard heal --all` | Auto-fix failing generated tests |
| `specguard security --all` | OWASP security tests and SAST |
| `specguard deps` | Dependency vulnerability audit |
| `specguard quality` | ESLint + dead-code checks |
| `specguard matrix` | Traceability matrix (spec → test → doc) |
| `specguard docs --all` | Generate user-facing docs from specs |
| `specguard analyze` | Smart diagnostics — start here when unsure |

### Artifacts

- Config: `.specguard/config.json`
- Specs: `specs/<area>/<module>.md`
- Generated tests: `tests/`
- Reports: `.specguard/`

### MCP Tools (Cursor / Claude with MCP enabled)

All pipelines are also available as MCP tools: `specguard_reverse`,
`specguard_generate`, `specguard_validate`, etc. Use these when available
instead of the CLI to get structured results.

### Safety Rules

- NO secrets or credentials in code.
- NO destructive shell commands (rm -rf, force push, etc.) unless explicitly approved.
- ALWAYS run `specguard validate` before marking a task complete.
- If a pipeline outputs findings, run `specguard heal` to fix before committing.
