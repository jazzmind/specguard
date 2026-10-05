import { readFileSync } from 'node:fs';

import { describe, it, expect } from 'vitest';

import {
  parseSpecContent,
  parseMetaComment,
  extractSection,
  parseScenarios,
  loadAllSpecs,
} from '../../src/core/spec-parser.js';

const MINIMAL_SPEC = `# Example Module

<!--
  module: src/core/example.ts
  type: core
  status: draft
-->

## Overview

This is the overview text for the example module.

## Acceptance Criteria

- [ ] Does the thing
`;

const UI_SPEC = `# Login Page

<!--
  module: src/pages/login.tsx
  type: ui
  url: /login
-->

## Overview

The login page.

## Acceptance Criteria

- [ ] User can log in with email and password

## Visual Expectations

The page should use the primary brand colour for the submit button.
Logo is centred at the top.

## Accessibility Requirements

The form must meet WCAG 2.2 AA:
- Colour contrast ratio ≥ 4.5:1 for body text
- All inputs have visible labels

## UX Guidelines

Show inline validation errors on blur, not on submit.
`;

const MULTI_SCENARIO_SPEC = `# Multi Scenario

<!--
  module: src/core/multi.ts
  type: core
-->

## Scenarios

### Scenario 1: First scenario

**Steps:**
1. Do the first step
2. Do the second step

**Expected Results:**
- First result
- Second result

---

### Scenario 2: Second scenario

**Steps:**
1. Only step here

**Expected Results:**
- Only result here
`;

describe('parseMetaComment', () => {
  it('parses known keys into typed fields', () => {
    const meta = parseMetaComment(MINIMAL_SPEC);
    expect(meta.module).toBe('src/core/example.ts');
    expect(meta.type).toBe('core');
    expect(meta.status).toBe('draft');
    expect(meta.extra).toEqual({});
  });

  it('puts unknown keys into extra without throwing (Scenario 3)', () => {
    const spec = `# X
<!--
  module: src/core/x.ts
  type: core
  custom-key: some value
  another: thing
-->
`;
    const meta = parseMetaComment(spec);
    expect(meta.module).toBe('src/core/x.ts');
    expect(meta.type).toBe('core');
    expect(meta.extra['custom-key']).toBe('some value');
    expect(meta.extra['another']).toBe('thing');
    // Unknown keys must not leak onto the typed surface.
    expect((meta as Record<string, unknown>)['custom-key']).toBeUndefined();
  });

  it('splits a single-line module comment and reads feature', () => {
    const meta = parseMetaComment('<!-- module: pages/x / type: page / status: live / feature: design.experience.create, platform -->');
    expect(meta.module).toBe('pages/x');
    expect(meta.type).toBe('page');
    expect(meta.status).toBe('live');
    expect(meta.feature).toBe('design.experience.create, platform');
  });

  it('reads an explicit channel', () => {
    const meta = parseMetaComment('<!-- module: src/tools/author/create.ts / type: core / channel: mcp / feature: design.experience.create-scratch -->');
    expect(meta.channel).toBe('mcp');
    expect(meta.feature).toBe('design.experience.create-scratch');
  });

  it('always returns extra as an object even with no comment', () => {
    const meta = parseMetaComment('# No comment here\n');
    expect(meta.extra).toEqual({});
  });
});

describe('extractSection', () => {
  it('returns trimmed text under an H2 heading', () => {
    expect(extractSection(MINIMAL_SPEC, 'Overview')).toBe(
      'This is the overview text for the example module.',
    );
  });

  it('returns empty string for a missing section', () => {
    expect(extractSection(MINIMAL_SPEC, 'Nonexistent')).toBe('');
  });
});

describe('parseSpecContent (Scenario 1: minimal spec)', () => {
  it('parses title, specKey, meta, overview, and empty scenarios', () => {
    const result = parseSpecContent(
      MINIMAL_SPEC,
      'specs/core/example.md',
      'specs',
    );
    expect(result.title).toBe('Example Module');
    expect(result.specKey).toBe('core/example');
    expect(result.filePath).toBe('specs/core/example.md');
    expect(result.meta.module).toBe('src/core/example.ts');
    expect(result.meta.type).toBe('core');
    expect(result.overview).toBe(
      'This is the overview text for the example module.',
    );
    expect(result.scenarios).toEqual([]);
    // UI sections are empty for a non-UI spec
    expect(result.visualExpectations).toBe('');
    expect(result.accessibilityRequirements).toBe('');
    expect(result.uxGuidelines).toBe('');
  });
});

describe('parseSpecContent — typed UI sections', () => {
  it('extracts visualExpectations, accessibilityRequirements, uxGuidelines', () => {
    const result = parseSpecContent(UI_SPEC, 'specs/auth/login.md', 'specs');
    expect(result.visualExpectations).toContain('primary brand colour');
    expect(result.visualExpectations).toContain('Logo is centred');
    expect(result.accessibilityRequirements).toContain('WCAG 2.2 AA');
    expect(result.accessibilityRequirements).toContain('4.5:1');
    expect(result.uxGuidelines).toContain('inline validation errors');
  });

  it('returns empty strings when UI sections are absent', () => {
    const result = parseSpecContent(MINIMAL_SPEC, 'specs/core/example.md', 'specs');
    expect(result.visualExpectations).toBe('');
    expect(result.accessibilityRequirements).toBe('');
    expect(result.uxGuidelines).toBe('');
  });
});

describe('parseScenarios (Scenario 2: multiple scenarios)', () => {
  it('parses two scenarios with steps and expected results', () => {
    const scenarios = parseScenarios(MULTI_SCENARIO_SPEC);
    expect(scenarios).toHaveLength(2);

    expect(scenarios[0].name).toBe('First scenario');
    expect(scenarios[0].steps).toEqual([
      'Do the first step',
      'Do the second step',
    ]);
    expect(scenarios[0].expectedResults).toEqual([
      'First result',
      'Second result',
    ]);

    expect(scenarios[1].name).toBe('Second scenario');
    expect(scenarios[1].steps).toEqual(['Only step here']);
    expect(scenarios[1].expectedResults).toEqual(['Only result here']);
  });

  it('returns empty array when no Scenarios section exists', () => {
    expect(parseScenarios(MINIMAL_SPEC)).toEqual([]);
  });
});

describe('parseSpecContent against the real spec', () => {
  it('parses specs/core/spec-parser.md with title and 4 scenarios', () => {
    const content = readFileSync('specs/core/spec-parser.md', 'utf-8');
    const result = parseSpecContent(
      content,
      'specs/core/spec-parser.md',
      'specs',
    );
    expect(result.title).toBe('Spec Parser');
    expect(result.scenarios).toHaveLength(4);
    expect(result.specKey).toBe('core/spec-parser');
    expect(result.meta.type).toBe('core');
  });
});

describe('loadAllSpecs (Scenario 4: nested files)', () => {
  it('loads specs recursively, excludes README.md, and yields correct specKey', () => {
    const specs = loadAllSpecs('specs');
    expect(specs.length).toBeGreaterThan(0);

    // README.md anywhere must be excluded.
    const hasReadme = specs.some((s) =>
      s.filePath.toLowerCase().endsWith('readme.md'),
    );
    expect(hasReadme).toBe(false);

    // The known spec must be present with the expected key.
    const parser = specs.find((s) => s.specKey === 'core/spec-parser');
    expect(parser).toBeDefined();
    expect(parser?.title).toBe('Spec Parser');
  });
});
