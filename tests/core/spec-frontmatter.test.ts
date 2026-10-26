import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { assignClaimIds } from '../../src/core/claims.js';
import { SpecFrontmatterError } from '../../src/core/errors.js';
import { declaredSources } from '../../src/core/spec-key.js';
import { loadAllSpecs, parseFrontmatter, parseMetaComment, parseSpecContent } from '../../src/core/spec-parser.js';

const CAPABILITY = `---
id: training-learner-journey
kind: capability
title: Training
parent: system
value: Employees build practical AI skills.
status: active
sources:
  - "lib/training/**"
  - "app/api/training/{modules,activities}/**"
tests:
  - "test/e2e/lesson-flow.spec.ts"
docs:
  - "docs/training/**"
history:
  - 2026-10-15-functional-specs-and-four-pillars
---

# AI Mastery Training

## Problem & Value

Staff cannot practise AI skills safely.

## Requirements

- [ ] Lessons unlock in order <!-- claim: lessons-unlock-in-order -->
- [ ] Progress is saved per learner

## Security & Data Considerations

Learner answers are private.
`;

describe('v2 frontmatter [spec-frontmatter]', () => {
  // [claims: capabilities/spec-authoring#frontmatter-v2-metadata]
  it('parses typed fields and block lists with braces in quoted globs [frontmatter-fields]', () => {
    const spec = parseSpecContent(CAPABILITY, '/r/specs/training-learner-journey.md', '/r/specs');
    expect(spec.meta).toMatchObject({
      id: 'training-learner-journey',
      kind: 'capability',
      parent: 'system',
      value: 'Employees build practical AI skills.',
      status: 'active',
      sources: ['lib/training/**', 'app/api/training/{modules,activities}/**'],
      tests: ['test/e2e/lesson-flow.spec.ts'],
      docs: ['docs/training/**'],
      history: ['2026-10-15-functional-specs-and-four-pillars'],
    });
    expect(spec.title).toBe('AI Mastery Training');
    expect(spec.specKey).toBe('training-learner-journey');
  });

  // [claims: capabilities/spec-authoring#frontmatter-v2-metadata]
  it('maps v2 section names onto the v1 fields [section-aliases]', () => {
    const spec = parseSpecContent(CAPABILITY, '/r/specs/x.md', '/r/specs');
    expect(spec.overview).toBe('Staff cannot practise AI skills safely.');
    expect(spec.securityNotes).toBe('Learner answers are private.');
    expect(spec.claims.map((c) => c.id)).toEqual(['lessons-unlock-in-order', undefined]);
  });

  // [claims: capabilities/spec-authoring#declared-sources]
  it('declaredSources prefers the frontmatter list over v1 headers [declared-sources-v2]', () => {
    const spec = parseSpecContent(CAPABILITY, '/r/specs/x.md', '/r/specs');
    expect(declaredSources(spec)).toEqual(['lib/training/**', 'app/api/training/{modules,activities}/**']);
  });

  // [claims: capabilities/spec-authoring#frontmatter-errors]
  it('rejects a flow list with braces with an actionable message [yaml-flow-list]', () => {
    const bad = '---\nid: a\nkind: capability\nsources: [lib/{a,b}/**]\n---\n# A\n';
    expect(() => parseFrontmatter(bad, 'specs/a.md')).toThrow(SpecFrontmatterError);
    expect(() => parseFrontmatter(bad, 'specs/a.md')).toThrow(/block lists with quoted globs/);
  });

  // [claims: capabilities/spec-authoring#frontmatter-errors]
  it('rejects an unquoted glob that starts with * [yaml-alias-glob]', () => {
    const bad = '---\nid: a\nkind: capability\nsources:\n  - **/x.ts\n---\n# A\n';
    expect(() => parseFrontmatter(bad, 'specs/a.md')).toThrow(/block lists with quoted globs/);
  });

  // [claims: capabilities/spec-authoring#frontmatter-errors]
  it('rejects an unknown kind and a non-list sources entry [invalid-fields]', () => {
    expect(() => parseFrontmatter('---\nid: a\nkind: widget\n---\n', 'a.md')).toThrow(/'kind' must be one of/);
    expect(() => parseFrontmatter('---\nid: a\nkind: capability\nsources:\n  - 3\n---\n', 'a.md')).toThrow(/'sources' must be a list/);
  });

  // [claims: capabilities/spec-authoring#frontmatter-v2-metadata]
  it('a frontmatter journey keeps the journey parser working [journey-kind]', () => {
    const src = '---\nid: j\nkind: journey\n---\n# J\n\n## Invariants\n\n### Never double award\nverifies: app:core/awards#award-once\n';
    expect(parseSpecContent(src, '/r/specs/j.md', '/r/specs').meta.type).toBe('journey');
  });

  // [claims: capabilities/spec-authoring#frontmatter-v2-metadata]
  it('returns null for a v1 spec so it keeps the HTML-comment path [v1-fallback]', () => {
    expect(parseFrontmatter('# T\n\n<!--\n  module: src/a.ts\n-->\n')).toBeNull();
    const spec = parseSpecContent('# T\n\n<!--\n  module: src/a.ts\n  type: core\n-->\n\n## Overview\n\nx\n', '/r/specs/t.md', '/r/specs');
    expect(spec.meta).toMatchObject({ module: 'src/a.ts', type: 'core' });
    expect(spec.meta.kind).toBeUndefined();
  });

  // [claims: capabilities/spec-authoring#frontmatter-v2-metadata]
  it('a v1 file with only claim anchors has no metadata [claim-comment-not-meta]', () => {
    const src = '# T\n\n## Acceptance Criteria\n\n- [ ] a <!-- claim: first-claim -->\n';
    expect(parseMetaComment(src)).toEqual({ extra: {} });
    expect(parseSpecContent(src, '/r/specs/t.md', '/r/specs').claims[0].id).toBe('first-claim');
  });

  // [claims: capabilities/spec-authoring#claims-assign]
  it('assignClaimIds anchors bullets under ## Requirements [assign-requirements]', () => {
    const { content, assigned } = assignClaimIds('# T\n\n## Requirements\n\n- [ ] Lessons unlock in order\n\n## Scenarios\n\n- not a claim\n');
    expect(assigned.map((a) => a.id)).toEqual(['lessons-unlock-in-order']);
    expect(content).toContain('Lessons unlock in order <!-- claim: lessons-unlock-in-order -->');
    expect(content).not.toContain('not a claim <!--');
  });

  // [claims: capabilities/spec-authoring#spec-discovery]
  it('loadAllSpecs skips top-level history and _archive but not nested folders of that name [non-spec-dirs]', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-specs-'));
    const put = (rel: string): void => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), '# T\n');
    };
    put('SYSTEM.md');
    put('history/2026-01-01-x.md');
    put('_archive/v1/old.md');
    put('api/history/log.md');
    expect(loadAllSpecs(dir).map((s) => s.specKey).sort()).toEqual(['SYSTEM', 'api/history/log']);
  });
});

describe('capability map rendering [capability-map-escape]', () => {
  // [claims: capabilities/spec-authoring#index-generation]
  it('escapes a pipe in a capability title as well as in its value', async () => {
    const { renderCapabilityMap } = await import('../../src/core/spec-render.js');
    const table = renderCapabilityMap([{ id: 'a', title: 'Auth | Access', value: 'Sign in | out', status: 'active', specKey: 'capabilities/a', claims: 2 }]);
    const row = table.split('\n')[2];
    expect(row).toBe('| [Auth \\| Access](capabilities/a.md) | Sign in \\| out | active | 2 |');
  });
});

describe('assurance and evidence frontmatter [assurance-evidence]', () => {
  const spec = (front: string) => `---\nid: x\nkind: capability\n${front}\n---\n# X\n\n## Problem & Value\n\nV.\n\n## Requirements\n- [ ] A claim <!-- claim: a-claim -->\n`;

  // [claims: capabilities/spec-authoring#assurance-evidence-frontmatter]
  it('assurance is a level or a default plus per-claim levels; values off the ladder go to unknown', () => {
    expect(parseFrontmatter(spec('assurance: property'))?.meta.assurance).toEqual({ default: 'property', claims: {}, unknown: [] });
    expect(parseFrontmatter(spec('assurance:\n  default: tested\n  claims:\n    a-claim: bounded\n    b: magic'))?.meta.assurance).toEqual({
      default: 'tested',
      claims: { 'a-claim': 'bounded' },
      unknown: ['magic'],
    });
    expect(parseFrontmatter(spec('assurance: certain'))?.meta.assurance).toEqual({ claims: {}, unknown: ['certain'] });
  });

  // [claims: capabilities/spec-authoring#assurance-evidence-frontmatter]
  it('evidence maps a claim id to its kind and verifier, keeping a missing verifier as an empty string', () => {
    const meta = parseFrontmatter(spec('evidence:\n  copy: { kind: manual, verifier: "Content lead" }\n  map: { kind: agentic }'))?.meta;
    expect(meta?.evidence).toEqual({ copy: { kind: 'manual', verifier: 'Content lead' }, map: { kind: 'agentic', verifier: '' } });
  });

  // [claims: capabilities/spec-authoring#assurance-evidence-frontmatter]
  it('an evidence entry with a kind other than agentic or manual fails with the file name', () => {
    expect(() => parseFrontmatter(spec('evidence:\n  copy: { kind: vibes }'), 'specs/x.md')).toThrow(SpecFrontmatterError);
    expect(() => parseFrontmatter(spec('evidence: nope'), 'specs/x.md')).toThrow(/specs\/x\.md/);
  });

  // [claims: capabilities/spec-authoring#assurance-evidence-frontmatter]
  // [claims: capabilities/spec-authoring#claim-hash-unchanged-by-tables]
  it('neither key enters the claim hash', async () => {
    const { claimHashOf } = await import('../../src/core/claim-hash.js');
    const hash = (front: string) => {
      const parsed = parseSpecContent(spec(front), '/r/specs/x.md', '/r/specs');
      return claimHashOf(parsed, 'a-claim');
    };
    expect(hash('assurance: property\nevidence:\n  a-claim: { kind: manual, verifier: "Lead" }')).toBe(hash('status: active'));
  });
});
