---
description: Show where specs, tests and code agree, and what nothing proves yet
argument-hint: "[--gaps | --coverage | --drift]"
---

Run `specguard check $ARGUMENTS` and explain the result: per capability, how many requirements are proven, stale, failing or unproven, and anything unowned or drifting. If a requirement is failing, say which and look at the code and test before suggesting a fix. If the command exits with code 12, answer the pending requests (the `specguard-agent-work` skill) and run it again.
