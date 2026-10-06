# Framework profiles

<!--
  module: src/core/framework-profiles.ts
  type: core
  status: draft
-->

## Overview

`specguard index` used to look for React entry points only. A framework profile says, for a web, API, or CLI framework, which files declare the application's routes or endpoints, what to call them, and how the prompt should describe them. `detectFramework` picks one from the repo's dependency manifests; `app.entryPoints` overrides the file list.

## Acceptance Criteria

- [ ] `detectFramework(repoDir, app)` recognises Next.js, React, Vue, Angular, Svelte, Express, Fastify, NestJS, FastAPI, Flask, Django, Go HTTP routers, and Spring from `package.json`, Python manifests, `go.mod`, and `pom.xml`, and falls back to a generic profile <!-- claim: detect-framework -->
- [ ] `app.entryPoints` (paths or globs relative to the repo) replaces the profile's entry-point list <!-- claim: entry-override -->
- [ ] `readEntryPoints` returns the first existing candidates, capped in size, as `{ file, source }` rows <!-- claim: read-entry-points -->
- [ ] Each profile names its surface (`routes`, `endpoints`) and code-fence language so prompts and the rendered index fit the framework <!-- claim: surface-noun -->

## Scenarios

### Scenario 1: Express service

**Steps:**
1. A repo has `express` in `package.json` and `src/server.ts`
2. Call `detectFramework`

**Expected Results:**
- The `express` profile is returned and `src/server.ts` is an entry point
