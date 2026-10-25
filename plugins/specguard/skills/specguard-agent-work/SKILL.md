---
name: specguard-agent-work
description: Use when a specguard command exits with code 12 or prints "Agent work pending". Answer the model requests SpecGuard wrote to .specguard/agent-requests/, then rerun the command.
---

# Answering SpecGuard's model requests

When SpecGuard has no API key and runs inside an agent, it asks you for the model work instead. Each request is a JSON file in `.specguard/agent-requests/<hash>.json` with the `system` text, the `prompt`, and for `object` requests the `jsonSchema` your answer must satisfy.

## The loop

1. `specguard agent pending` (or the `specguard_agent_work` MCP tool, action `list`) lists the requests.
2. For each, read the request file, write the answer to a file, and submit it:
   `specguard agent answer <hash> --file answer.json` (a unique 8+ character prefix of the hash is enough; the MCP tool takes action `answer`).
   JSON answers may sit in a markdown code fence; text answers are plain text.
3. Run the command that asked again. It validates each answer against its schema. An answer that fails is set aside and the request is asked again with the reason in its `rejection` field: fix and resubmit.
4. Repeat until the command no longer exits with 12.

Requests whose prompt no longer matches what the command asks now are stale; ignore them.

## What a good answer looks like, by `pipeline`

- **summarize**: one entry per file, using the exact path shown. One or two sentences on what user-visible or business functionality the file provides, not how it is built. Invent nothing the file does not show.
- **cluster** (the capability map): between the number of capabilities the prompt asks for. A capability is a cohesive area of functionality that delivers user or business value, never one file or one layer. Every source file must be owned by some capability. Use directory globs, and check each glob matches real files before you answer. Ids are lowercase kebab-case and not `system`.
- **spec-draft** (one capability's spec): describe what the code does today as behaviour a user or integrating system can observe. 10-20 requirements, each one or two sentences, each testable, each with a short kebab-case id of 2-5 words. Keep the edge cases and limits that matter. State only what the material supports; leave out anything you are unsure of rather than guessing. Do not describe files or functions.
- **tag** (link tests to requirements): for each numbered test, list the requirement ids it proves. `high` only when the test directly asserts the behaviour the requirement states; `medium` when it only touches the same area. Leave a test out rather than guess. A medium link is never applied.
- **drift**: judge whether the changed files alter behaviour any requirement states. Name the affected requirement ids (use `*` only when you cannot tell which), and list behaviour the change adds that no requirement covers. Do not call a change harmless unless you read the diff.
- **docs**, **import** and others: follow the `system` text in the request.

Do not call any other model for these answers and do not write a placeholder to get a command past a step: an invented answer produces specs and links that look real and are not.
