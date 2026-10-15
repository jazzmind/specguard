# CLAUDE.md

## Build Commands

```bash
npm install        # install dependencies
npm run build      # compile TypeScript → dist/
npm test           # run vitest suite
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
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
Specs in `specs/` are the source of truth: `specs/system.md` describes the system,
each file in `specs/capabilities/` one piece of functionality. Read the capability
that owns a file (`specguard spec graph`) before editing it.

After changing code, update the capability spec, record why with `specguard history add`,
and run `specguard check`. Tests run with `npm test`; tag a test with the
requirement it proves: `// [claims: capabilities/<id>#<claim-id>]`. Run `/goal` to build
the whole project from its specs.
<!-- specguard:specguard-workflow:end -->

<!-- specguard:specguard-commands:start -->
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
<!-- specguard:specguard-commands:end -->
