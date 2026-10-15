# Feature alignment

<!--
  module: src/pipelines/feature-state.ts
  type: pipeline
  status: draft
-->

## Overview

`specguard features --state` reports one row per feature in the workspace catalog. Each row has a summary, the channels the feature requires, a state for UI, API, and MCP, and whether an agent may run. `specguard align` stays the scenario-to-test check. The dashboard and the agent runner read the feature-state command. They do not keep a second copy of the rules.

The catalog is a directory of versioned YAML (`version: 1`, a `features` list) named by `featureState.catalog` in config, or by the `catalog` path on `.specguard/workspace.json`, relative to the root. Nothing is assumed when neither is set: the command prints `[]` and a note. A plugin may supply its own provider and default directory. A spec may set `channel: ui`, `channel: api`, or `channel: mcp`. Otherwise the `featureState.channelByType` map (plus any plugin's map) gives the channel for the spec `type:`, then a module-path pattern a plugin may supply, then the `featureState.repoChannels` entry for the spec's repo. Feature ids are opaque strings; nothing about their shape is assumed.

Test results come from `featureState.reporters` (Vitest, Jest, Playwright, JUnit, pytest, Go, Cargo output files), `featureState.resultsDirs` (normalized case JSON), and any plugin result source. Results carry `externalId`/`externalIds` and `tags`; external-id adapters (`generic`, `zephyr`, `jira`, selected by `featureState.externalIds`) read ids from raw rows, tags, and titles.

## Acceptance Criteria

- [ ] A feature summary is the catalog sentence. The catalog sentence is used as written, unless a plugin declares it a placeholder or it is empty. The first Overview sentence is then used for a list or index feature, and when exactly one spec is linked <!-- claim: summary-source -->
- [ ] `requires` starts from the catalog list. A channel the implementation actually has is added even when the catalog omitted it. When the catalog omits `requires`, channels are inferred from `featureState.repoChannels` for the repos of linked specs, and MCP is required only when it is the only surface <!-- claim: requires-inferred -->
- [ ] A channel is No when it is not required, no spec is tagged for it, and the implementation was not found <!-- claim: channel-no -->
- [ ] A required channel with no spec, no test, and no implementation is No, and the row marks it required <!-- claim: channel-required-missing -->
- [ ] A linked spec or test with no pass or fail, and no implementation file, is Stub <!-- claim: channel-stub -->
- [ ] A screen, API operation, or MCP tool that a discoverer finds in the repo, with no test result yet, is Built <!-- claim: channel-built -->
- [ ] A tool a discoverer reports as evidence-only is shown on MCP and does not make MCP Built <!-- claim: mcp-learner -->
- [ ] The latest failed or error result makes the channel Broken <!-- claim: channel-broken -->
- [ ] A unit pass, with nothing higher passed, makes the channel Passing <!-- claim: channel-passing -->
- [ ] An integration, regression, e2e, or agent pass, or a non-stale proven claim on that channel, makes the channel Proven. A result matches a feature by `featureId`, an `@feature:<id>` tag, a shared external id, or a linked test file or name <!-- claim: channel-proven -->
- [ ] The agent gate opens only when a linked unit or integration test has a latest result of passed <!-- claim: agent-gate -->
- [ ] A passing regression does not open the agent gate <!-- claim: regression-not-enough -->
- [ ] `specguard features --state` prints the rows, and the MCP tool `specguard_feature_state` returns the same payload <!-- claim: align-callers -->

- [ ] The catalog is parsed with a real YAML parser and validated against a versioned schema; an unversioned or malformed file is an error that names the file <!-- claim: catalog-schema -->
- [ ] Built-in discoverers read GraphQL operations, OpenAPI documents with client request paths, and tRPC calls, and report the UI file and the API spec per feature <!-- claim: builtin-discoverers -->
- [ ] A claim's proof goes stale when a recorded source file changes on disk or a lockfile changes, even before `drift` runs <!-- claim: live-staleness -->
- [ ] With no catalog configured the command prints `[]` plus a note and does not fail <!-- claim: no-catalog-note -->

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
