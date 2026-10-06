import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SPEC_AWARDS = `# Awards

<!--
  module: src/awards.ts
  type: core
  status: draft
-->

## Overview

Awards points once.

## Acceptance Criteria

- [ ] Award is skipped when already earned <!-- claim: award-once -->
- [ ] Duplicates are rejected <!-- claim: no-dupes -->
- [ ] Nothing tests this <!-- claim: untested -->

## Scenarios

### Scenario 1: Award
**Steps:**
1. Award

**Expected Results:**
- Awarded
`;

export interface TmpRepo {
  dir: string;
  write: (rel: string, content: string) => string;
}

/** A throwaway single-app repo with one spec (core/awards) and a SpecGuard config. */
export function makeRepo(extraConfig: Record<string, unknown> = {}): TmpRepo {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-repo-'));
  const write = (rel: string, content: string): string => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    return abs;
  };
  write(
    '.specguard/config.json',
    JSON.stringify({
      apps: [
        {
          name: 'app',
          repo: '.',
          specDir: 'specs',
          sources: { routes: ['src/**/*.ts'], tests: ['tests/**/*.test.ts'] },
          framework: 'vitest',
          testOutput: 'tests/',
        },
      ],
      llm: { provider: 'none', model: 'none', apiKeyEnv: 'NONE' },
      ...extraConfig,
    }),
  );
  write('specs/core/awards.md', SPEC_AWARDS);
  write('src/core/awards.ts', 'export const x = 1;\n');
  write('package-lock.json', '{"lockfileVersion":3}\n');
  return { dir, write };
}
