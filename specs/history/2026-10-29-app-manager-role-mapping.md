---
id: 2026-10-29-app-manager-role-mapping
date: 2026-10-29
kind: decision
title: Map verified application managers to maintainers
affects:
  - team-server
---

DeployKit managers were treated as viewers because only email reached SpecGuard. Export app-specific manager permission through a proxy-overwritten header, with explicit opt-in on SpecGuard and a trusted peer requirement. Keep token authentication authoritative and never grant administrative token powers through browser headers.
