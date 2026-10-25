---
description: Set SpecGuard up for this project, draft specs from the code, link tests to requirements, run them and report
argument-hint: "[--skip-tests]"
---

Get a first SpecGuard picture of this project.

1. Run `specguard start $ARGUMENTS`. It sets the project up if needed, drafts specs from the code, links existing tests to requirements, runs the tests and reports. It needs no API key here: when a step needs model output it writes requests and exits with code 12.
2. On exit code 12, follow the `specguard-agent-work` skill to answer every pending request, then run `specguard start` again. It continues from where it stopped. Repeat until it finishes.
3. Report the result in plain language: how many capabilities and requirements, how many are proven by existing tests, and the three most important gaps.
4. Tell the user that the drafted specs describe what the code does today, that they are drafts to review (`specs/capabilities/`), and what to do next (`specguard check --gaps`).
