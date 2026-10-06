# Migrating from the Practera test suite

SpecGuard started as a generalisation of the approach used in the `practera-test-suite` repository. Core SpecGuard has no
coupling to that platform. Everything specific to it lives in the built-in `practera` plugin.

## Enable the plugin

```json
{ "plugins": ["practera"] }
```

in `.specguard/config.json` (or `"plugins": ["practera"]` in `.specguard/workspace.json` for workspace commands).

## What the plugin supplies

| Concern | Core default | With `plugins: ["practera"]` |
|---|---|---|
| Feature catalog | none; set `featureState.catalog` to a directory of versioned YAML (`version: 1`) | `practera-test-suite/catalog`, bare `- id:` lists, an `agent:` block is ignored |
| Test results | none; set `featureState.resultsDirs` or `featureState.reporters` | also reads `.results/cases` and `practera-test-suite/.results/cases` |
| Spec `type:` to channel | `ui`, `api`, `mcp` map to themselves | adds `page` (ui), `mutation` and `query` (api), and MCP tool paths |
| Repo to channel | none | `admin-app`, `app`, `login-app`, `project-hub` (ui); `graphql-api`, `login-api`, `services` (api) |
| Implementation discovery | GraphQL, REST/OpenAPI, tRPC | adds admin and learner MCP tool discovery |
| External ids | generic `@ext:` / `@id:` tags | Zephyr keys from the `zephyr` field |
| Feature ids | opaque strings | `area.entity.action`: the area segments are ignored when matching unit files to siblings |
| Placeholder summaries | catalog summary is used as written | `experiences-list — …` style headings are replaced by the spec overview |
| `specguard contracts` legacy import | none | reads `.specguard/legacy-traceability.json` |
| `specguard status` UNFEATURED | only when a catalog is configured | on, for `page`, `feature`, `mutation`, `query` specs |

## Things that changed for existing Practera workspaces

- The legacy dependency file is now `.specguard/legacy-traceability.json`. It used to be
  `.specguard/traceability.json`, which `specguard matrix` also writes. Rename the file.
- The catalog is parsed with a real YAML parser. Unquoted values that contain `: ` now need quotes.
- `workspace init` derives repo keys from directory names (`practera-admin-app` stays `practera-admin-app`) and roles from
  repo contents. Edit `.specguard/workspace.json` if you want the old short keys (`admin-app`).
- Results use `externalId` / `externalIds`. The `zephyr` field is still read through the Zephyr adapter.

## Spec format

The spec format is unchanged. Specs written for the original suite parse without modification.

## Mapping from the original tooling

| Original tool | SpecGuard |
|---|---|
| `packages/spec-tools/src/spec-parser.ts` | Core spec parser (same format) |
| `packages/spec-tools/src/validate.ts` | `specguard validate` |
| `packages/spec-tools/src/reverse-generate.ts` | `specguard reverse` |
| `packages/spec-tools/src/doc-generate.ts` | `specguard docs` |
| `.claude/agents/playwright-test-planner.md` | `specguard generate` (Playwright mode) |
| `.claude/agents/playwright-test-generator.md` | `specguard generate` (code output) |
| `.claude/agents/playwright-test-healer.md` | `specguard heal` |
| Hard-coded `APP_CONFIGS` in reverse-generate.ts | `.specguard/config.json` |
| Fixed `SPECS_DIR` paths | Config-driven `specDir` per app |
| No external requirements import | `specguard import` |
| No security pipeline | `specguard security` (LLM + SAST) |
| No drift detection | `specguard drift` |
| No traceability export | `specguard matrix` |
| Manual CLI only | Parallel agent via Cursor Skill |
| Anthropic-only | Pluggable LLM (Anthropic, OpenAI, Ollama) |

