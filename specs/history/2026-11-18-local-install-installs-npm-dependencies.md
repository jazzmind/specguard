---
id: 2026-11-18-local-install-installs-npm-dependencies
date: 2026-11-18
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Local install installs npm dependencies first"
affects:
  - integration-surfaces
---
# Local install installs npm dependencies first

## Decision

make install runs npm install in the root, extension and webview before building, so a checkout with missing webview dependencies can build the dashboard. install-dev still uses npm ci for a clean locked setup. Builds themselves still use the dependencies already installed.
