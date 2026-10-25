---
name: specguard
description: Use in a project that has, or should have, SpecGuard specs. Before changing code a capability spec covers, after finishing a change, and whenever the user asks what is proven, what drifted, to draft specs from existing code, or to link tests to requirements.
---

# SpecGuard

SpecGuard keeps a project's specs as the source of truth and shows, per requirement, whether tests prove the code still delivers it. Specs live in `specs/` (`system.md` plus `capabilities/<id>.md`, each requirement carrying a `<!-- claim: id -->` marker). Tests link to requirements with a comment: `// [claims: capabilities/<id>#<claim-id>]`.

## Running it

Run `specguard <command>`. With this plugin it is on your PATH; elsewhere use `npx -y -p specguard-ai specguard <command>` (the package is `specguard-ai`; `npx specguard` is a different, unrelated package). Outside Claude Code set `SPECGUARD_HOST_AGENT=1` so you, not an API key, do the model work.

| To | Run |
|---|---|
| Get a first picture of a project | `specguard start` (sets up, drafts specs, links tests, runs them, reports; resumable) |
| See where specs, tests and code agree | `specguard check` (`--gaps` lists what nothing proves yet) |
| Draft specs from existing code | `specguard spec draft --yes` |
| Link existing tests to requirements | `specguard spec tag --yes` |
| Run tests and record what each requirement is proven by | `specguard test run` |
| Record why a requirement changed | `specguard history add` |
| See the model requests waiting for you | `specguard agent pending` |

## Exit code 12 means "your turn"

A step that needs model output (drafting, tagging, judging drift) writes a request file under `.specguard/agent-requests/` and exits with code 12. That is not a failure: it is waiting for you. Use the `specguard-agent-work` skill to answer each request, then run the same command again. Repeat until it finishes.

## Working in a project that uses specs

1. Before changing code, find the capability that owns it (`specguard check` or read `specs/capabilities/`) and read its spec.
2. If the change alters what the system should do, change the spec first (and say why: `specguard history add`), then write or update the tests that prove it, then the code.
3. Tag each test with the requirement it proves. Run `specguard test run`, then `specguard check`.
4. Never edit a spec, or weaken or skip a test, to make a gap or a failure go away. A failing proven requirement is a defect to fix in the code.
5. A drafted spec describes what the code does today. It is a draft until a person has read it and agrees it states what the system should do; say so when you hand one over.
