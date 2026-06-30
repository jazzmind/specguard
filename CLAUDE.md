# CLAUDE.md

## Build Commands

```bash
npm install        # install dependencies
npm run build      # compile TypeScript → dist/
npm test           # run vitest suite
npm run lint       # eslint check
```

## Architecture

TypeScript ESM CLI (`specguard`). Source in `src/`, tests in `tests/`, specs in `specs/`.

Every `src/` module has a matching spec in `specs/` — **read the spec before implementing**.

```
src/
  core/           # Foundation: types, parser, config, llm, reader, writer, errors, exit-codes
  cli/            # CLI entrypoint (commander), subcommand routing
  pipelines/      # One file per pipeline: reverse, forward, validate, heal, security, docs, drift, matrix, status
  adapters/       # Runner adapters: playwright, docker, semgrep, auth-state-machine
  mcp/            # MCP server (exposes pipelines as tools)
tests/            # Mirrors src/ structure — vitest
specs/            # Living Specifications — source of truth for all modules
.specguard/       # Self-referential config (SpecGuard building itself)
```

## Key Files

| File | Purpose |
|------|---------|
| `.specguard/config.json` | Self-referential config — SpecGuard configured to build SpecGuard |
| `.cursor/rules/specguard-dev.mdc` | Always-apply rule enforcing spec coverage after each phase |
| `.cursor/rules/typescript.mdc` | TypeScript standards (ESM, strict, ai-sdk patterns, Zod) |
| `.cursor/skills/specguard/SKILL.md` | Parallel QA agent — check spec coverage after plan phases |
| `specs/README.md` | Spec format documentation and directory layout |

## Rules

1. **Read the spec** for a module BEFORE implementing it (`specs/<area>/<name>.md`)
2. **Run tests** after every module: `npm test`
3. **Check spec coverage** after each phase: run `npx tsx src/cli/index.ts status` (once built)
4. **Never call ai-sdk directly** from pipelines — route through `src/core/llm.ts`
5. **Never call fs directly** from pipelines — use `src/core/reader.ts` / `writer.ts`
6. **Write specs first** for new modules — if no spec exists in `specs/`, create one before coding
7. **Self-test metacircularly** — after building a pipeline, run it against SpecGuard's own source

## Pipeline Pattern

Each pipeline exports one async function:

```typescript
export async function runReverse(config: SpecGuardConfig, opts: ReverseOpts): Promise<PipelineResult>
```

- Accept typed config + options, return `PipelineResult`
- LLM via `src/core/llm.ts`, file I/O via `src/core/reader.ts` + `writer.ts`
- Zod schemas defined in the pipeline file itself

## Metacircular Testing

After building each pipeline, verify it works on SpecGuard itself:
- `specguard reverse --app specguard-core` → should skip or generate valid specs
- `specguard status` → should show spec coverage for this repo
- `specguard drift` → should detect stale specs
- Parser should parse its own spec correctly: `specs/core/spec-parser.md`

## Build Phases

See `BUILD-PLAN.md` for the full phased implementation plan.

<!-- specguard:specguard-workflow:start -->
## SpecGuard

This project uses SpecGuard for spec-driven QA (language: **typescript**).
Specs in `specs/` are the source of truth — read a module's spec before editing it.

After changing code, run `specguard gap-analysis`, `specguard status`, and
`specguard drift`. Tests run with `npm test`. Run `/goal` to build
the whole project from its specs.
<!-- specguard:specguard-workflow:end -->

<!-- specguard:specguard-commands:start -->
| Command | What it does |
|---------|-------------|
| `specguard analyze` | Smart diagnostics — start here when unsure |
| `specguard gap-analysis` | Find unimplemented specs and generate build plans |
| `specguard status` | Spec + test coverage report |
| `specguard reverse --all` | Generate Living Specs from source |
| `specguard generate --all` | Generate test files from specs |
| `specguard heal --all` | Run tests and auto-fix test bugs |
| `specguard drift` | Detect specs out of sync with code |
| `specguard security --all` | OWASP security test stubs |
| (tests run via) | `npm test` |
<!-- specguard:specguard-commands:end -->
