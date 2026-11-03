---
id: 2026-11-03-trusted-proxies-by-host-name
date: 2026-11-03
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Trusted proxies by host name"
affects:
  - team-server
---
# Trusted proxies by host name

## Decision

SPECGUARD_TRUSTED_PROXIES accepts host names (re-resolved every 30s). A pinned container IP broke sign-in when the sign-in proxy restarted (172.18.0.15 -> .31); the deployment now trusts deploykit-nginx by name.
