# Index pipeline

<!--
  module: src/pipelines/index-generate.ts
  type: pipeline
  status: draft
-->

## Overview

`specguard index` writes an architecture index (`index.md`) at the root of the spec tree: an overview, the routes or endpoints grouped by area, and a spec directory map. It finds the routing source through the app's framework profile (`src/core/framework-profiles.ts`) or `entryPoints`, not through React-specific file names.

## Acceptance Criteria

- [ ] The spec tree root is `paths.specsRoot` (default `specs`) when apps do not share one specDir <!-- claim: specs-root -->
- [ ] The routing source comes from the app's `entryPoints`, else the detected framework profile's entry points <!-- claim: framework-entry-points -->
- [ ] The prompt names the surface the profile describes (routes or endpoints) and the code-fence language, and does not assume a frontend or React <!-- claim: neutral-prompt -->
- [ ] An existing index is left alone unless `--force` is given <!-- claim: no-clobber -->
- [ ] An LLM failure writes a skeleton index and still succeeds <!-- claim: skeleton-fallback -->

## Scenarios

### Scenario 1: FastAPI service

**Steps:**
1. A repo has `fastapi` in `requirements.txt` and `app/main.py`
2. Run `specguard index`

**Expected Results:**
- The prompt asks for endpoints and includes `app/main.py`
