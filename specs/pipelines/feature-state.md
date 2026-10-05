# Feature alignment

<!--
  module: src/pipelines/feature-state.ts
  type: pipeline
  status: draft
-->

## Overview

`specguard features --state` reports one row per feature in the workspace catalog. Each row has a summary, the channels the feature requires, a state for UI, API, and MCP, and whether an agent may run. `specguard align` stays the scenario-to-test check. The dashboard and the agent runner read the feature-state command. They do not keep a second copy of the rules.

The catalog directory is the `catalog` path on `.specguard/workspace.json`, relative to the workspace root. A spec may set `channel: ui`, `channel: api`, or `channel: mcp`. When it does not, `page` and `ui` are UI, `mutation` and `query` are API, and a module path under an MCP tools directory is MCP.

## Acceptance Criteria

- [ ] A feature summary is the catalog sentence. A heading shaped like `experiences-list — …` is rejected. The first Overview sentence is used for a list or index feature, and when exactly one spec is linked and the catalog sentence is empty <!-- claim: summary-source -->
- [ ] `requires` starts from the catalog list. A channel the implementation actually has is added even when the catalog omitted it. When the catalog omits `requires`, UI and API are inferred from spec repo prefixes, and MCP is required only when it is the only surface <!-- claim: requires-inferred -->
- [ ] A channel is No when it is not required, no spec is tagged for it, and the implementation was not found <!-- claim: channel-no -->
- [ ] A required channel with no spec, no test, and no implementation is No, and the row marks it required <!-- claim: channel-required-missing -->
- [ ] A linked spec or test with no pass or fail, and no implementation file, is Stub <!-- claim: channel-stub -->
- [ ] A screen, query, or admin MCP tool that exists in the repo, with no test result yet, is Built <!-- claim: channel-built -->
- [ ] A learner MCP tool on the same GraphQL field is evidence on MCP and does not make MCP Built <!-- claim: mcp-learner -->
- [ ] The latest failed or error result makes the channel Broken <!-- claim: channel-broken -->
- [ ] A unit pass, with nothing higher passed, makes the channel Passing <!-- claim: channel-passing -->
- [ ] An integration, regression, e2e, or agent pass, or a non-stale proven claim on that channel, makes the channel Proven <!-- claim: channel-proven -->
- [ ] The agent gate opens only when a linked unit or integration test has a latest result of passed <!-- claim: agent-gate -->
- [ ] A passing regression does not open the agent gate <!-- claim: regression-not-enough -->
- [ ] `specguard features --state` prints the rows, and the MCP tool `specguard_feature_state` returns the same payload <!-- claim: align-callers -->

## Scenarios

### Scenario 1: Unit pass, no higher proof

**Steps:**
1. A feature requires UI and API
2. Its unit test's latest result is passed
3. No integration, regression, or proof claim has passed

**Expected Results:**
- UI and API are Passing
- MCP is No
- `agentGate.allowed` is true

### Scenario 2: Nothing cheaper has passed

**Steps:**
1. A feature has a regression key and no unit or integration test
2. That regression's latest result is passed

**Expected Results:**
- The required channel is Proven
- `agentGate.allowed` is false
- The reason says no unit or integration test is linked

### Scenario 3: Experiences index is already built

**Steps:**
1. The experiences index spec's module resolves to `src/pages/experiences/index.tsx`
2. That page's query selects `experiences`, which is `graphql-api:queries/experience`
3. The only MCP tool on that field is the learner tool `list_experiences`
4. The catalog unit file is `switch.test.tsx`, which belongs to the switch feature
5. No unit or integration result has been ingested

**Expected Results:**
- The summary is the Overview sentence, not the `experiences-list —` heading
- UI is Built and API is Built
- MCP is No, and the evidence names the learner tool and says there is no admin tool
- The agent gate stays closed
