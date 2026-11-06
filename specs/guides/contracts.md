---
id: contracts
kind: journey
title: "Quickstart: contracts between repositories"
audience: user
order: 17
useCase: Map which specs depend on which other repositories, then see what a change reaches.
related:
  - workspaces
  - integration-surfaces
---

# Quickstart: contracts between repositories

## Goal
Build a contract graph of the dependencies between repositories, then ask what else a change to one spec or file reaches.

## Prerequisites
- A workspace with at least two repositories (see [multiple repositories](multi-repo.md)).
- Repositories with roles in the workspace manifest (`consumer`, `provider`), so mapping knows which way dependencies run.
- Optionally, specs with a `## Dependencies` section naming what each consumer depends on.

## Steps
### Build the contract graph
```bash
specguard contracts
```

`contracts` reads the traceability data and the Dependencies sections of the specs across every repository in the workspace and writes `.specguard/contracts.json`. Use `--repo <key>` for one repository and `--force` to re-parse everything. Add `--with-llm` to extract contracts from free-text Dependencies sections; only that section of each spec is sent to the model, and `--max-llm-specs <n>` bounds how many specs go in one run.

### Map consumer specs to provider specs
The `contract-mappings` plugin adds `specguard contracts-map`. It proposes, for each spec in a consumer repository, the provider specs it depends on, and writes them to `.specguard/contract-mappings.json` in that repository, so the graph has edges even when no spec names its dependencies. Enable the plugin, assess first, then preview, then write:

```bash
specguard plugin enable contract-mappings
specguard contracts-map --assess
specguard contracts-map --dry-run --with-code
specguard contracts-map --with-code
```

Where suggestions come from, each with a confidence and the evidence behind it:

- **Spec text** (always, no model): a consumer spec that names a provider spec by `repo::spec`, path, key or title. A title in the consumer's own headings or a table row does not count, and a title found in more than one provider repository is reported as ambiguous (0.5, below the default bar).
- **Code** (`--with-code`, local, no model): client calls in the consumer's code (fetch-style calls, Angular `HttpClient`) matched to endpoint definitions in provider code (Spring, JAX-RS, Express or Fastify routes, OpenAPI documents), then each side mapped to the spec that owns the file. Evidence is `file:line METHOD path`. In an overlay, the code is read where the app's config `repo` points.
- **A model** (`--with-llm`, opt-in): specs nothing else matched are sent, with a numbered list of provider specs to choose from; it can only pick from that list. `--send-code` (with both flags) also sends short excerpts around unmatched calls. Each run says what it will send before sending, and `--max-llm-specs <n>` bounds it.

`--assess` reads specs and code, sends and writes nothing, and says whether reading code would help: the share of specs with no spec-text match, the call sites found, and the provider endpoint definitions per repository.

Settle ambiguity in the consumer repository's `.specguard/config.json`:

```json
"contractMappings": {
  "providerRepos": ["orders-api"],
  "baseRepos": { "environment.ordersApi": "orders-api" }
}
```

`providerRepos` names the only repositories this consumer calls (useful when two backends expose the same endpoints); `baseRepos` maps a client's unresolved base URL to the repository behind it. An endpoint defined in more than one candidate repository is otherwise capped at 0.6 and flagged.

Re-running merges with the file: entries you wrote or edited by hand are kept as manual entries, entries marked `"pinned": true` are kept, and generated entries no longer found are removed and listed under "Removed". `--min-confidence <n>` (default 0.6) sets the bar; `--repo <key>` limits the run to one consumer.

### Rebuild the graph with the mappings
```bash
specguard contracts --force
```

The mapping file is read as contract edges. The plugin's file and keys are configuration (`contractMappings`), so an older mapping file in another shape can be read without converting it.

### Ask what a change reaches
```bash
specguard impact capabilities/payments
specguard impact src/api/orders.ts --upstream --max-depth 3
```

`impact` shows the blast radius of a spec or file across repositories: every consumer downstream. `--upstream` also shows what the target depends on. The VS Code **Show Impact** command does the same.

### Check drift across the edges
```bash
specguard workspace drift
```

A change in a provider flags the consumers that depend on it. See [Detecting drift](drift.md).

### Contracts in the workspace dashboard
The workspace dashboard's contracts bar shows edges, nodes and edges unverified for more than 30 days, and has **Build Contracts** and **Rebuild Contracts** buttons.

## Outcome
`.specguard/contracts.json` describes how the repositories depend on each other, and `impact` and `workspace drift` use it to say what a change affects.

## Related
- [Detecting drift](drift.md)
- [Multiple repositories](multi-repo.md)
- [Plugins](plugins.md)

## Help Topics
- `workspace.contracts` → Contracts in the workspace dashboard: Edges and nodes of the contract graph and how many have gone unverified for more than 30 days; build or rebuild it here.
