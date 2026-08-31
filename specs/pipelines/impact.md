# Impact Pipeline

<!-- module: src/pipelines/impact.ts -->
<!-- type: pipeline -->
<!-- status: stable -->

## Overview

The impact pipeline performs blast-radius analysis on the workspace contract graph. Given a changed spec, source file, or node ID, it traverses the graph to show which other repos and specs are affected (downstream consumers) and what the start node depends on (upstream providers).

The primary use case is: before or after changing a provider spec (e.g. a GraphQL mutation spec), run `specguard impact` to see which consumer specs in other repos need to be reviewed or drift-checked.

## Acceptance Criteria

- [ ] Accepts target as a node ID (`graphql-api::specs/mutations/designer.md`), relative path, or absolute path
- [ ] Resolves target to a node in the contract graph; emits actionable error if not found
- [ ] Performs BFS traversal in `downstream` direction (provider → consumers)
- [ ] `--upstream` flag also traverses upstream (consumer → providers)
- [ ] Distinguishes direct consumers (depth 1) from transitive (depth > 1)
- [ ] Reports affected node IDs, titles, depth, and the edge type/surface that connects them
- [ ] Generates suggested `specguard drift` commands for each affected consumer repo
- [ ] Docs-type edges generate "Update docs:" suggestions, not drift commands
- [ ] `--max-depth` limits traversal depth (default: 6)
- [ ] Fails gracefully when no `contracts.json` exists with a helpful message

## Scenarios

### Scenario 1: Provider spec change
**Steps:**
1. `contracts.json` exists with edges from admin-app specs → graphql-api specs
2. Run `specguard impact graphql-api::specs/mutations/designer.md`
**Expected Results:**
- Output lists all admin-app specs that depend on the designer mutation spec
- Surface items (mutation names) are shown for each edge
- Suggested actions include `cd practera-admin-app && specguard drift --spec setup/designer`

### Scenario 2: No consumers
**Steps:**
1. Run `specguard impact` on a node with no incoming edges
**Expected Results:**
- Output states "No downstream consumers found"
- Exit code 0 (not an error)

### Scenario 3: Unresolvable target
**Steps:**
1. Run `specguard impact unknown/path.md`
**Expected Results:**
- Error message with example of valid node ID format
- Exit code 1

### Scenario 4: Upstream traversal
**Steps:**
1. Run `specguard impact admin-app::specs/setup/designer.md --upstream`
**Expected Results:**
- Shows all graphql-api specs that the designer spec depends on (its providers)
- Depth 1 = direct providers, depth 2+ = transitive

## Dependencies

### Internal
- `src/core/contracts.ts` — ContractGraph, traverseGraph, findNode
- `src/core/workspace.ts` — WorkspaceManifest

## Security Notes

- Read-only pipeline: does not modify any files
- Only reads from `contracts.json` — no network access
