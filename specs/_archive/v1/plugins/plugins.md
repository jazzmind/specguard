# Plugin architecture

<!--
  module: src/plugins/index.ts
  type: core
  status: draft
-->

## Overview

Core SpecGuard has no knowledge of any platform. Anything tied to a platform's repo layout, id scheme, or tooling is a plugin, enabled by name in `config.plugins`. A plugin is a directory `src/plugins/<name>/index.ts` that exports `plugin`. The extension points are `CatalogProvider` (a versioned Zod catalog schema and a YAML parser), `ImplementationDiscoverer` (GraphQL, REST/OpenAPI, tRPC built in), `ExternalIdAdapter` (generic tags, Zephyr, Jira), `ResultSource` (case JSON, reporter files), `ContractImporter`, and feature-state tuning (channel maps, id tokens, placeholder summaries).

## Acceptance Criteria

- [ ] `loadPlugins(names)` returns the named plugins in order, rejects a malformed name, and rejects a name with no plugin directory, so `plugins: ["typo"]` is an error and not silently ignored <!-- claim: load-by-name -->
- [ ] Core source never imports a plugin by name: plugins are loaded from the names in config <!-- claim: no-core-coupling -->
- [ ] `CatalogSchemaV1` requires `version: 1` and a `features` list, defaults every optional field, drops unknown channels from `requires`, and keeps `externalIds` and `tags` <!-- claim: catalog-v1 -->
- [ ] `parseCatalogYaml` handles quoted colons, folded text, and nested blocks; an error names the file and the field <!-- claim: real-yaml -->
- [ ] A duplicate feature id across catalog files is an error <!-- claim: duplicate-ids -->
- [ ] The GraphQL discoverer finds the UI file from a spec `module:` and the API spec from the operation names in that file <!-- claim: graphql-discoverer -->
- [ ] The REST discoverer reads OpenAPI JSON or YAML, extracts `fetch`/`axios`/`ky` request paths, and links a screen to an API spec or to the documented operation <!-- claim: rest-discoverer -->
- [ ] The tRPC discoverer reads `trpc.<router>.<procedure>.<call>` usages and router definitions, and links a screen to an API spec or to the procedure <!-- claim: trpc-discoverer -->
- [ ] `normalizeCases` fills `externalId`/`externalIds` from tags, `@ext:` markers, and each configured adapter, without mutating its input <!-- claim: external-ids -->
- [ ] The Zephyr adapter reads `PROJ-T123` keys and the `zephyr` field; the Jira adapter reads `PROJ-123` keys and the `jira` field; neither is active unless configured or supplied by a plugin <!-- claim: zephyr-jira-adapters -->
- [ ] `reporterSource` reads reporter files through `src/core/test-results.ts` and `caseDirSource` reads normalized case JSON <!-- claim: result-sources -->

## Scenarios

### Scenario 1: Unknown plugin

**Steps:**
1. Set `"plugins": ["typo"]`
2. Run `specguard features --state`

**Expected Results:**
- The command fails with a configuration error naming the plugin
