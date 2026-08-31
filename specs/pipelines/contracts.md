# Contracts Pipeline

<!-- module: src/pipelines/contracts.ts -->
<!-- type: pipeline -->
<!-- status: stable -->

## Overview

The contracts pipeline builds and maintains a workspace-level contract graph (`contracts.json`) that models cross-repo dependencies across all repos in the workspace. It is the foundation for impact analysis, workspace drift, and cross-repo sync enforcement.

The pipeline runs three passes in order:
1. **Legacy traceability** — imports existing `graphqlDependencies` from each repo's `.specguard/traceability.json`
2. **Spec block parsing** — extracts structured `<!-- contracts:start -->` blocks from spec Dependencies sections
3. **LLM extraction** (optional, `--with-llm`) — uses LLM to parse unstructured free-text Dependencies sections

Output: `<workspace>/.specguard/contracts.json`

## Acceptance Criteria

- [ ] Reads every repo listed in `workspace.json` that has a `.specguard/traceability.json`
- [ ] Extracts `graphqlDependencies` paths and converts them to typed `ContractEdge` entries with `source: 'traceability'`
- [ ] Extracts `docPage` entries from traceability as `docs`-type edges
- [ ] Parses `<!-- contracts:start --> ... <!-- contracts:end -->` blocks in spec Dependencies sections
- [ ] Structured block lines follow the format: `<repoKey>::<specPath> [<type>: <surface1>, <surface2>]`
- [ ] LLM extraction pass is only triggered when `--with-llm` flag is set
- [ ] LLM extraction is skipped for specs that already have a structured block
- [ ] Validates graph: all edge consumer/provider IDs exist as nodes
- [ ] Validation warnings are reported but do not fail the pipeline
- [ ] Idempotent: running twice on the same input produces the same output
- [ ] `--force` flag clears existing graph and rebuilds from scratch
- [ ] `--repo <key>` restricts processing to a single repo
- [ ] Output is written atomically to `<workspace>/.specguard/contracts.json`

## Scenarios

### Scenario 1: Legacy traceability migration
**Steps:**
1. Workspace contains `admin-app` with `.specguard/traceability.json` containing `graphqlDependencies`
2. Run `specguard contracts`
**Expected Results:**
- Each `graphqlDependencies` path becomes a `graphql`-type edge in contracts.json
- Consumer node = admin-app spec, Provider node = graphql-api spec
- Edge `source` = `traceability`

### Scenario 2: Structured block parsing
**Steps:**
1. A spec has a `<!-- contracts:start -->` block in its Dependencies section
2. Run `specguard contracts`
**Expected Results:**
- Each line in the block becomes a `ContractEdge` with `source: 'spec-block'`
- Surface items are parsed from the `[type: item1, item2]` bracket notation
- Block takes precedence over any overlapping LLM-extracted edges

### Scenario 3: LLM extraction
**Steps:**
1. A spec has free-text Dependencies mentioning another repo but no structured block
2. Run `specguard contracts --with-llm`
**Expected Results:**
- LLM identifies cross-repo references and emits structured edges
- Edge `source` = `llm`
- LLM is not called for specs that already have a structured block

### Scenario 4: Incremental update
**Steps:**
1. Existing contracts.json is present
2. One new spec is added to a repo
3. Run `specguard contracts` (no `--force`)
**Expected Results:**
- Existing edges are preserved
- New edges from the new spec are added
- `generatedAt` is updated

## Dependencies

### Internal
- `src/core/workspace.ts` — WorkspaceManifest, WorkspaceRepoWithConfig
- `src/core/contracts.ts` — ContractGraph types, upsertNode, upsertEdge, parseContractsBlock
- `src/core/spec-parser.ts` — loadAllSpecs
- `src/core/llm.ts` — llmGenerateText

## Security Notes

- LLM is only used when explicitly enabled with `--with-llm`
- No secrets or credentials are extracted from spec content
- File reads are bounded to workspace repos defined in workspace.json
