# Practera plugin

<!--
  module: src/plugins/practera/index.ts
  type: core
  status: draft
-->

## Overview

Everything specific to the Practera platform layout, enabled with `"plugins": ["practera"]`. See `docs/migration-from-practera.md` for the user-facing description.

## Acceptance Criteria

- [ ] The catalog provider reads bare `- id:` feature lists from `practera-test-suite/catalog` by default and ignores an `agent:` block <!-- claim: catalog-default -->
- [ ] Case JSON is read from `.results/cases` and `practera-test-suite/.results/cases` <!-- claim: results-dirs -->
- [ ] Channel maps cover `page`, `mutation`, `query`, the Practera repo keys, and MCP tool paths <!-- claim: channel-maps -->
- [ ] Feature ids are `area.entity.action`; only the segments after the area name a feature when matching unit files <!-- claim: id-tokens -->
- [ ] A `slug — text` catalog summary is a placeholder replaced by the spec overview <!-- claim: heading-summary -->
- [ ] The MCP discoverer reads `server.tool('name'` definitions under `mcp-server/src/tools`, matches them to the GraphQL fields a screen calls, and records a learner tool as evidence without counting it as built <!-- claim: mcp-discoverer -->
- [ ] The Zephyr adapter is enabled with the plugin <!-- claim: zephyr -->
- [ ] The legacy importer reads `.specguard/legacy-traceability.json`, never `.specguard/traceability.json` <!-- claim: legacy-importer -->

## Scenarios

### Scenario 1: Experiences index

**Steps:**
1. A page spec resolves to `src/pages/experiences/index.tsx`
2. The page's query selects `experiences`
3. Only a learner MCP tool wraps that field

**Expected Results:**
- UI and API are Built and MCP is No, with the learner tool as evidence
