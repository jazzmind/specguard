# SpecGuard Build Plan

Build the complete SpecGuard CLI, MCP server, and core pipelines. Each phase produces working code tested against its own specs, progressively upgrading the bootstrap skill to use the tool it just built.

## Goal

```
Build the SpecGuard CLI tool following the phased plan below.
Use the specs in specs/ as the source of truth for each module.
After building each module, run its tests and verify specs parse correctly.
Follow .cursor/rules/specguard-dev.mdc and .cursor/rules/typescript.mdc.
Use .cursor/skills/specguard/SKILL.md to check spec coverage after each phase.
Start with Phase 0 (project scaffold), then proceed through phases sequentially.
Within each phase, build modules in parallel where marked.
```

---

## Phase 0: Project Scaffold

One agent. No parallelism needed.

### Files to Create

| File | Purpose |
|------|---------|
| `package.json` | name: `specguard`, type: module, bin: `./dist/cli/index.js` |
| `tsconfig.json` | strict, ESM, outDir: `dist/`, rootDir: `src/` |
| `vitest.config.ts` | workspace root config |
| `src/core/types.ts` | `SpecGuardConfig`, `AppConfig`, `PipelineResult`, `SpecMeta`, `ParsedSpec`, `SpecScenario` |
| `src/core/exit-codes.ts` | typed exit code constants (0, 1, 2, 3, 4, 5, 7) |
| `src/core/errors.ts` | `SpecGuardError` class |

### Dependencies

```json
{
  "dependencies": {
    "ai": "^4",
    "@ai-sdk/anthropic": "^1",
    "@ai-sdk/openai": "^1",
    "zod": "^3",
    "fast-glob": "^3",
    "commander": "^13",
    "@modelcontextprotocol/sdk": "^1"
  },
  "devDependencies": {
    "typescript": "^5.7",
    "vitest": "^3",
    "@types/node": "^22",
    "tsx": "^4"
  }
}
```

### Scripts in package.json

```json
{
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "dev": "tsx src/cli/index.ts",
    "lint": "tsc --noEmit"
  }
}
```

### Verify

```bash
npm install && npm run build && npm test
```

All must succeed (empty test suite passes).

---

## Phase 1: Core Foundation

**3 parallel agents.** No cross-dependencies within this phase.

### Agent 1: Spec Parser

**Spec:** `specs/core/spec-parser.md`
**Output:** `src/core/spec-parser.ts`, `tests/core/spec-parser.test.ts`

Implement:
- `parseSpecContent(content: string, filePath: string, specsRoot: string): ParsedSpec`
- `parseMetaComment(content: string): SpecMeta`
- `extractSection(content: string, sectionName: string): string`
- `parseScenarios(content: string): SpecScenario[]`
- `loadAllSpecs(dir: string): ParsedSpec[]`

Pure functions. Zero external dependencies. Uses only Node built-ins + types from `src/core/types.ts`.

**Self-test:** After implementation, parse `specs/core/spec-parser.md` with the parser. It must return a valid `ParsedSpec` with title "Spec Parser", 4 scenarios, and populated metadata.

### Agent 2: Config + Reader + Writer

**Output:** `src/core/config.ts`, `src/core/reader.ts`, `src/core/writer.ts`, `tests/core/config.test.ts`
**Write spec:** `specs/core/config.md` (create it first)

Implement:
- `loadConfig(cwd?: string): Promise<SpecGuardConfig>` — reads `.specguard/config.json`, validates with Zod
- `reader.readFile(path: string): Promise<string>` — thin wrapper
- `reader.expandGlobs(patterns: string[], baseDir: string): Promise<string[]>` — uses `fast-glob`
- `reader.fileExists(path: string): Promise<boolean>`
- `writer.writeFile(path: string, content: string): Promise<void>` — creates intermediate dirs
- `writer.ensureDir(dir: string): Promise<void>`

**Self-test:** Load `.specguard/config.json` from the repo root. Must parse without error.

### Agent 3: LLM Adapter

**Output:** `src/core/llm.ts`, `tests/core/llm.test.ts`
**Write spec:** `specs/core/llm.md` (create it first)

Implement:
- `llmGenerateText(opts: LlmTextOpts): Promise<string>`
- `llmGenerateObject<T>(opts: LlmObjectOpts<T>): Promise<T>`

Where opts include: `{ provider, model, system, prompt, schema?, apiKeyEnv }`.

Uses `ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai`. Provider selection via config. API key from `process.env`.

Tests should mock the ai-sdk call (don't make real API calls in CI).

### Phase 1 Complete When

```bash
npm test  # all core tests pass
npx tsx -e "import { parseSpecContent } from './src/core/spec-parser.js'; import { readFileSync } from 'fs'; const c = readFileSync('specs/core/spec-parser.md','utf-8'); const r = parseSpecContent(c, 'specs/core/spec-parser.md', 'specs'); console.log(r.title, r.scenarios.length)"
# Output: "Spec Parser 4"
```

---

## Phase 2: CLI + Reverse Pipeline

**2 parallel agents.** CLI depends on Phase 1 core modules. Reverse pipeline depends on Phase 1 core modules.

### Agent 1: CLI Shell

**Spec:** `specs/core/cli.md`
**Output:** `src/cli/index.ts`, `src/cli/commands/*.ts`

Implement using `commander`:
- `specguard --help` / `--version`
- `specguard init` — scaffolds config, specs/README, skill file
- `specguard reverse --app <name> [--file <path>] [--force]`
- `specguard status` (stub — will be filled in Phase 3)
- All other subcommands: stub with "Not yet implemented" message
- Config loading with "No config found" error handling
- Exit code wiring via `src/core/exit-codes.ts`

**Verify:** `npx tsx src/cli/index.ts --help` shows all subcommands.

### Agent 2: Reverse Generate Pipeline

**Spec:** `specs/pipelines/reverse-generate.md`
**Output:** `src/pipelines/reverse-generate.ts`, `tests/pipelines/reverse-generate.test.ts`

Implement:
- `runReverseGenerate(config: SpecGuardConfig, opts: ReverseOpts): Promise<PipelineResult>`
- Expand globs from config app's `sources`
- Read files (cap 20k chars)
- Check spec existence (skip if exists and not `--force`)
- Call LLM with spec format system prompt
- Write generated spec files
- Return `{ created, skipped, failed }` counts

Tests: mock `llmGenerateText` to return a fixed spec string.

### Phase 2 Metacircular Test

After both agents complete:

```bash
# Build and link
npm run build

# Run reverse against itself (should skip existing specs)
npx tsx src/cli/index.ts reverse --app specguard-core

# Parse the output to verify well-formedness
npx tsx -e "
import { loadAllSpecs } from './src/core/spec-parser.js';
const specs = loadAllSpecs('specs');
console.log('Specs found:', specs.length);
specs.forEach(s => console.log(' ', s.specKey, '—', s.title));
"
```

---

## Phase 3: Status + Drift

**2 parallel agents.**

### Agent 1: Status Pipeline

**Write spec first:** `specs/pipelines/status.md`
**Output:** `src/pipelines/status.ts`, `tests/pipelines/status.test.ts`

Implement:
- Scan source globs from each app in config
- Cross-reference against specs in `specDir`
- Cross-reference against tests in `testOutput`
- Print report: total files, specs written (%), tests generated (%), missing specs
- Exit code 4 if any files lack specs

**Self-test:** `npx tsx src/cli/index.ts status` shows coverage for this repo.

### Agent 2: Drift Pipeline

**Write spec first:** `specs/pipelines/drift.md`
**Output:** `src/pipelines/drift.ts`, `tests/pipelines/drift.test.ts`

Implement:
- Run `git diff --name-only <since>..HEAD` (or `HEAD~1..HEAD` if no `--since`)
- Map changed files to their specs via config source patterns
- Compare file modification times: source newer than spec = drift
- Exit code 3 if drift detected

**Self-test:** `npx tsx src/cli/index.ts drift` runs against the repo.

### After Phase 3

Update `.cursor/skills/specguard/SKILL.md`:
- Replace "Manual Reverse" section with: `npx tsx src/cli/index.ts reverse --app specguard-core`
- Add: after each plan phase, run `npx tsx src/cli/index.ts status` and `npx tsx src/cli/index.ts drift`

---

## Phase 4: Forward Generate + Heal

**2 parallel agents.**

### Agent 1: Forward Generate Pipeline

**Write spec first:** `specs/pipelines/forward-generate.md`
**Output:** `src/pipelines/forward-generate.ts`, `tests/pipelines/forward-generate.test.ts`

Implement:
- Read spec via `parseSpecContent`
- Generate Vitest test code using LLM (each scenario → one `it()`)
- Write test file to `testOutput/<specKey>.test.ts`
- Support `--framework` flag (vitest default, playwright, jest)

**Self-test:** Generate tests from `specs/core/spec-parser.md`. Compare with hand-written `tests/core/spec-parser.test.ts` — should be structurally similar.

### Agent 2: Heal Pipeline

**Write spec first:** `specs/pipelines/heal.md`
**Output:** `src/pipelines/heal.ts`, `tests/pipelines/heal.test.ts`

Implement:
- Run `config.heal.testCommand` (e.g. `npm test`)
- Parse vitest JSON output for failures
- For each failure: send failure + spec + test code to LLM
- LLM classifies: test bug (regenerate) vs app bug (report)
- If test bug: rewrite test, re-run. Repeat up to `maxRetries`.
- Return heal report: fixed, still-broken, app-bugs

### After Phase 4

Update skill to use `specguard generate` and `specguard heal`.

---

## Phase 5: MCP + Security + Docs

**3 parallel agents.**

### Agent 1: MCP Server

**Write spec first:** `specs/core/mcp-server.md`
**Output:** `src/mcp/server.ts`, `src/mcp/tools/*.ts`

Implement using `@modelcontextprotocol/sdk`:
- Stdio transport
- One tool per pipeline: `specguard_reverse`, `specguard_generate`, `specguard_validate`, `specguard_security`, `specguard_docs`, `specguard_drift`, `specguard_matrix`, `specguard_status`
- Utility tools: `specguard_read_spec`, `specguard_write_spec`
- Each tool calls the same pipeline function the CLI uses
- Add `bin` entry in package.json: `specguard-mcp`

### Agent 2: Security Pipeline

**Write spec first:** `specs/pipelines/security.md`
**Output:** `src/pipelines/security.ts`, `tests/pipelines/security.test.ts`

Implement:
- Read spec `## Security Notes` section
- Read source code for the spec's module
- LLM generates security test stubs (OWASP-annotated)
- Optional `--with-sast`: invoke Semgrep Docker adapter, feed findings to LLM
- Write security tests to `tests/security/<specKey>.test.ts`

### Agent 3: Doc Generation Pipeline

**Write spec first:** `specs/pipelines/doc-generate.md`
**Output:** `src/pipelines/doc-generate.ts`, `tests/pipelines/doc-generate.test.ts`

Implement:
- Read specs, strip `## Scenarios`, `## Security Notes`, metadata comments
- Transform via LLM into user-facing documentation
- Add frontmatter (title, sidebar_label, generated: true)
- Write to configured output dir (default: `docs/user/`)

### After Phase 5

Full skill upgrade: `.cursor/skills/specguard/SKILL.md` v1.0 — delegates all operations to CLI or MCP tools. No manual steps remain.

---

## Final Verification

After all phases complete:

```bash
# Full build + test
npm run build && npm test

# Self-assessment
npx tsx src/cli/index.ts status
npx tsx src/cli/index.ts drift

# Metacircular: generate specs from self, should all skip (already exist)
npx tsx src/cli/index.ts reverse --app specguard-core
npx tsx src/cli/index.ts reverse --app specguard-pipelines

# Parse all specs
npx tsx -e "
import { loadAllSpecs } from './src/core/spec-parser.js';
const specs = loadAllSpecs('specs');
console.log(specs.length + ' specs parsed successfully');
const noTitle = specs.filter(s => !s.title);
if (noTitle.length) { console.error('BROKEN:', noTitle); process.exit(1); }
"
```
