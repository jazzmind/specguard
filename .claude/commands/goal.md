---
description: Build the whole project from its specs, with SpecGuard tracking coverage.
---

<!-- specguard-managed: true -->

# /goal — Build everything from the specs

You are building this typescript project from its Living Specifications.

## Steps

1. Run `specguard check --gaps` (or the `specguard_check` MCP tool). It lists the
   requirements nothing proves yet.
2. Read `specs/system.md` and `specs/capabilities/**` — the specs are the source of
   truth. Read a capability's spec before implementing it.
3. Build an ordered capability list, in dependency order.
4. For each capability:
   - Implement its requirements (language: typescript).
   - Write tests and tag each with the requirement it proves
     (`// [claims: capabilities/<id>#<claim-id>]`).
   - Run `specguard test run` (tests run via `npm test`) and confirm
     `specguard check` shows the requirements proven.
5. Stop when `specguard check` shows every requirement proven.

## Rules

- NEVER edit a spec to make a gap disappear — implement the code.
- A failing proven requirement is a real defect: fix the code, do not weaken the test.
- Keep going capability-by-capability; report progress after each.
