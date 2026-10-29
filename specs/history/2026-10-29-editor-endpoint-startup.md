---
id: 2026-10-29-editor-endpoint-startup
date: 2026-10-29
kind: decision
title: Keep editor endpoint defaults from breaking CLI startup
affects:
  - integration-surfaces
  - platform-foundation
---

Anthropic workspace defaults passed OPENAI_BASE_URL as an empty string. The OpenAI SDK validates its default client during import and crashed every CLI command, making intact overlay registrations look absent and Plugins display the Node version footer. Remove inactive endpoint variables, test actual bundled CLI startup with editor environments, and show a concise underlying CLI error instead of the footer.
