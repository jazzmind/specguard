# Contracts Pipeline

<!-- module: src/pipelines/contracts.ts -->
<!-- type: pipeline -->
<!-- status: stable -->

## Overview

The contracts pipeline builds and maintains a workspace-level contract graph (`contracts.json`) that models cross-repo dependencies across all repos in the workspace. It is the foundation for impact analysis, workspace drift, and cross-repo sync enforcement.

The pipeline runs three passes in order:
1. **Contract importers** — run the importers supplied by enabled plugins (for example a plugin that reads a legacy dependency file). With no plugin enabled this pass adds nothing
2. **Spec block parsing** — extracts structured `<!-- contracts:start -->` blocks from spec Dependencies sections
3. **LLM extraction** (optional, `--with-llm`) — uses LLM to parse unstructured free-text Dependencies sections

Output: `<workspace>/.specguard/contracts.json`

## Acceptance Criteria

- [ ] Runs the `contractImporters` of every plugin named in `opts.plugins`, or in the repos' `plugins` when none is given, and turns their edges into typed `ContractEdge` entries with `source: 'traceability'` <!-- claim: importers-from-plugins -->
- [ ] Never reads `.specguard/traceability.json`: that path belongs to `specguard matrix` and an importer must use a file name of its own <!-- claim: no-matrix-collision -->
- [ ] An importer's `docPage` entries become `docs`-type edges
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

### Scenario 1: Importer edges
**Steps:**
1. Workspace enables a plugin whose importer reads a dependency file in `admin-app`
2. Run `specguard contracts`
**Expected Results:**
- Each `graphqlDependencies` path becomes a `graphql`-type edge in contracts.json
- Consumer node = admin-app spec, Provider node = graphql-api spec
- Edge `source` = `traceability`
- With the plugin disabled, no importer edge is produced

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
