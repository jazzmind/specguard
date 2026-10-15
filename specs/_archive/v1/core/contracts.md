# Contract Graph

<!-- module: src/core/contracts.ts -->
<!-- type: core -->
<!-- status: stable -->

## Overview

The contract graph module defines the data model, types, file I/O, and graph operations for the workspace contract graph (`contracts.json`). It is the foundation for the `contracts`, `impact`, and `workspace drift` pipelines.

A contract graph models cross-repo dependencies as directed edges between spec nodes:
- **Node**: a spec file (or API surface) in a specific repo, identified by `<repoKey>::<specPath>`
- **Edge**: a directed dependency from a consumer spec to a provider spec, typed by contract kind

## Contracts Block Format

Specs can declare cross-repo dependencies in a structured block within the `## Dependencies` section:

```markdown
## Dependencies

### Contracts
<!-- contracts:start -->
- graphql-api::specs/mutations/designer.md [graphql: createMilestone, updateMilestone, deleteMilestone]
- graphql-api::specs/queries/experiences.md [graphql: GET_DESIGN_PROJECT]
- login-api::api/code/send [rest: POST /code/send]
- admin-php::legacy/iframe [iframe: /feedback?iframe=1, /badges?iframe=1]
<!-- contracts:end -->

### Internal
- `src/lib/apollo.ts` — Apollo client setup
```

**Format rules:**
- Block delimited by `<!-- contracts:start -->` and `<!-- contracts:end -->`
- One dependency per line, starting with `-` bullet
- Provider ID: `<repoKey>::<specPath>` where repo key matches `workspace.json`
- Type annotation: `[<type>: <item1>, <item2>]` (optional if type is obvious)
- Valid types: `graphql`, `rest`, `iframe`, `upload`, `event`, `test`, `docs`
- Surface items: comma-separated operation/endpoint/path names

## Acceptance Criteria

- [ ] `ContractNode` has `id`, `repo`, `spec`, `title` fields
- [ ] `ContractEdge` has `consumer`, `provider`, `type`, `surface`, `lastVerified`, `source` fields
- [ ] `ContractGraph` has `version`, `generatedAt`, `nodes`, `edges` fields
- [ ] `nodeId(repo, spec)` returns `<repo>::<spec>`
- [ ] `parseNodeId(id)` splits on first `::` and returns `{repo, spec}` or null
- [ ] `loadContractGraph(workspaceRoot)` returns null if file does not exist
- [ ] `saveContractGraph(workspaceRoot, graph)` writes to `<workspaceRoot>/.specguard/contracts.json`
- [ ] `emptyContractGraph()` returns a valid empty graph
- [ ] `upsertNode` adds new nodes and updates titles on existing nodes
- [ ] `upsertEdge` adds new edges and merges surface items on existing edges
- [ ] `outgoingEdges(graph, nodeId)` returns edges where nodeId is consumer
- [ ] `incomingEdges(graph, nodeId)` returns edges where nodeId is provider
- [ ] `traverseGraph(graph, startId, 'downstream', maxDepth)` BFS follows consumer edges
- [ ] `traverseGraph(graph, startId, 'upstream', maxDepth)` BFS follows provider edges
- [ ] `validateGraph(graph)` returns array of errors for missing node references
- [ ] `parseContractsBlock(dependenciesText)` parses `<!-- contracts:start -->` blocks
- [ ] Structured block lines without type annotation default to `graphql` type
- [ ] Lines that don't match the expected format are silently skipped

## Scenarios

### Scenario 1: Parse contracts block
**Steps:**
1. Spec has a `<!-- contracts:start -->` block with 2 lines
2. Call `parseContractsBlock(dependenciesText)`
**Expected Results:**
- Returns 2 `ParsedContractLine` objects
- Provider, type, and surface are correctly parsed

### Scenario 2: Graph traversal downstream
**Steps:**
1. Graph has edges: A → B → C (A is provider of B, B is provider of C)
2. Call `traverseGraph(graph, 'A', 'downstream', 6)`
**Expected Results:**
- Returns steps for B (depth 1) and C (depth 2)
- Start node A is not included

### Scenario 3: Validate graph with broken link
**Steps:**
1. Graph has an edge referencing a provider node ID that doesn't exist in nodes
2. Call `validateGraph(graph)`
**Expected Results:**
- Returns array containing error string about the missing node

### Scenario 4: Upsert edge surface merge
**Steps:**
1. Edge exists with surface: `['createMilestone']`
2. Upsert same edge (same consumer+provider+type) with surface: `['createMilestone', 'deleteMilestone']`
**Expected Results:**
- Merged surface: `['createMilestone', 'deleteMilestone']` (union, no duplicates)

## Dependencies

### Internal
- `src/core/reader.ts` — readFile, fileExists
- `src/core/writer.ts` — writeFile
- `src/core/errors.ts` — ConfigInvalidError
