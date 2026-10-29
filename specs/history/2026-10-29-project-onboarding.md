---
id: 2026-10-29-project-onboarding
date: 2026-10-29
kind: decision
title: Project selection and creation before connecting the editor
affects:
  - team-server
---

Remove the circular dependency between selecting a project and obtaining a token. Show accessible projects at the server root, keep token management independent of published capabilities, persist empty projects on both storage backends, and let the extension select or create a project after verifying its credential. Preserve maintainer authorization for project creation and existing browser CSRF protection.
