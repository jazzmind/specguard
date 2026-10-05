# `specguard features` — Spec to Feature Back-references

<!-- module: src/cli/commands/features.ts / type: cli-command / status: draft -->

## Overview

`specguard features` prints a JSON array that maps each spec to the catalog feature ids named in its `feature:` meta value. The Practera test-suite catalog uses it to check that specs and catalog rows agree. `collectFeatures(config)` is the pure part; the command loads the CLI config and writes its result to stdout.

## Acceptance Criteria

- AC1: Each row is `{ spec: "<app>:<specKey>", features: string[] }`.
- AC2: A comma separated `feature:` value is split and trimmed.
- AC3: `platform` is returned like any other value; the caller decides what it means.
- AC4: A spec with no `feature:` value is omitted.
- AC5: An app whose spec directory cannot be read is skipped, not an error.
- AC6: The command writes only the JSON array to stdout.
