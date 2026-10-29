---
id: 2026-10-28-readable-two-column-repository-cards
date: 2026-10-28
kind: decision
author: "Wes Sonnenreich"
source: manual
title: "Readable two-column repository cards"
affects:
  - integration-surfaces
---
# Readable two-column repository cards

## Prompt

Make the cards look much better. Too many per line.

## Decision

Replace nested repository catalog tables with compact summaries and catalog links. Limit the grid to two columns, collapse to one at narrow widths, use neutral card surfaces and clear metrics, move paths/revisions/setup diagnostics behind Technical details, and make activation explicit rather than turning the entire card into a switch target.
