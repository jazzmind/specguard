# Dashboard Protocol – Flow Graph Metadata

<!-- module: specguard-extension/src/dashboard/protocol / type: data-contract / status: draft -->

## Overview

The `protocol` module defines the static metadata that describes the dashboard's pipeline flow graph, including all pipeline nodes (`PIPELINE_NODES`) and the subset of those pipelines that are directly runnable (`RUNNABLE_PIPELINES`). Each node carries an `id`, a `kind`, and a `from` array that declares its upstream dependencies, forming a directed acyclic graph. Non-input nodes must declare at least one upstream source, ensuring the graph is fully connected from a data-flow perspective. The `RUNNABLE_PIPELINES` collection exposes a curated list of pipelines that the dashboard UI can invoke directly. This module acts as the single source of truth for pipeline topology consumed by other dashboard components.

## Acceptance Criteria

- AC-1: Every node in `PIPELINE_NODES` whose `kind` is not `"input"` must have a `from` array containing at least one entry.
- AC-2: Every id referenced in any node's `from` array must correspond to an existing node id within `PIPELINE_NODES`.
- AC-3: `RUNNABLE_PIPELINES` must include entries with ids `"reverse"`, `"generate"`, `"drift"`, `"matrix"`, and `"status"`.
- AC-4: `PIPELINE_NODES` must export a valid array (non-null, non-undefined) at module load time.
- AC-5: `RUNNABLE_PIPELINES` must export a valid array (non-null, non-undefined) at module load time.

## Scenarios

### Scenario 1: Non-input nodes declare upstream sources

**Steps:**
1. Import `PIPELINE_NODES` from `protocol.js`.
2. Filter the array to all nodes where `kind !== "input"`.
3. For each filtered node, read the `from` property and check its length.

**Expected Results:**
- Every non-input node's `from` array has a length greater than `0`.
- No non-input node has an empty or missing `from` array.

---

### Scenario 2: All upstream references resolve to known node ids

**Steps:**
1. Import `PIPELINE_NODES` from `protocol.js`.
2. Collect all node `id` values into a Set.
3. Iterate every node and every entry in that node's `from` array.
4. For each `from` entry, check whether the Set contains that id.

**Expected Results:**
- Every `from` id resolves to a node that exists in `PIPELINE_NODES`.
- No dangling or orphaned upstream references are present.

---

### Scenario 3: Core pipelines are present in RUNNABLE_PIPELINES

**Steps:**
1. Import `RUNNABLE_PIPELINES` from `protocol.js`.
2. Map the array to extract each entry's `id` field, producing an array of id strings.
3. Assert that the resulting array contains each of the following values: `"reverse"`, `"generate"`, `"drift"`, `"matrix"`, `"status"`.

**Expected Results:**
- All five core pipeline ids (`"reverse"`, `"generate"`, `"drift"`, `"matrix"`, `"status"`) are present in the extracted id list.
- The check passes regardless of the order of entries or the presence of additional pipeline ids.

---

### Scenario 4: Module exports are defined at load time

**Steps:**
1. Import both `PIPELINE_NODES` and `RUNNABLE_PIPELINES` from `protocol.js`.
2. Assert that `PIPELINE_NODES` is not `null` and not `undefined`.
3. Assert that `RUNNABLE_PIPELINES` is not `null` and not `undefined`.
4. Assert that both values are instances of `Array`.

**Expected Results:**
- Both exports are non-null, non-undefined arrays immediately upon module import.
- No runtime error is thrown during module initialisation.

## Security Notes

- This module contains only structural metadata (node ids, kinds, and dependency references). No credentials, tokens, API keys, or user data are present or expected.
- Consumers should treat `PIPELINE_NODES` and `RUNNABLE_PIPELINES` as read-only; mutation of these exported arrays at runtime could corrupt graph integrity checks across the dashboard.

## Dependencies

- `protocol.js` (runtime module under `extension/src/dashboard/`) — provides `PIPELINE_NODES` and `RUNNABLE_PIPELINES`.
- `vitest` — test framework used to execute the acceptance scenarios (`describe`, `it`, `expect`).