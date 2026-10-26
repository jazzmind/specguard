import { describe, expect, it } from 'vitest';

import { setEnforceLevel } from '../../src/core/enforce.js';
import { parseSpecContent } from '../../src/core/spec-parser.js';
import type { EnforceLevel } from '../../src/core/types.js';
import { diffSpecPolicy } from '../../src/core/weakening.js';

const content = (front: string) => `---\nid: cart\nkind: capability\nparent: system\nvalue: v\n${front}---\n# Cart\n\n## Problem & Value\n\nV.\n\n## Requirements\n- [ ] Totals add up <!-- claim: totals -->\n- [ ] Tax applies <!-- claim: tax -->\n`;
const parse = (front: string) => parseSpecContent(content(front), '/r/specs/capabilities/cart.md', '/r/specs');
const found = (before: string, after: string, def?: EnforceLevel) => diffSpecPolicy(parse(before), parse(after), [], def).filter((f) => f.kind === 'policy-enforce-lowered');

describe('policy-enforce-lowered [spec-first-changes]', () => {
  // [claims: capabilities/spec-first-changes#enforce-lowering-is-weakening]
  it('a lowered enforce level between versions is an error finding that names the capability and its claims', () => {
    const [f] = found('enforce: enforce\n', 'enforce: warn\n');
    expect(f).toMatchObject({ kind: 'policy-enforce-lowered', severity: 'error', before: 'enforce', after: 'warn', claims: ['capabilities/cart#totals', 'capabilities/cart#tax'] });
    expect(f.message).toContain('lowered from enforce to warn');
    expect(found('enforce: warn\n', 'enforce: observe\n')).toHaveLength(1);
    expect(found('enforce: enforce\n', 'enforce: observe\n')).toHaveLength(1);
  });

  // [claims: capabilities/spec-first-changes#enforce-lowering-is-weakening]
  it('removing the line is a lowering when it drops below the default, using the config default when given', () => {
    const [f] = found('enforce: enforce\n', '');
    expect(f.message).toContain('removed from enforce to observe');
    expect(found('enforce: warn\n', '')).toHaveLength(1);
    expect(found('enforce: warn\n', '', 'warn')).toHaveLength(0);
    expect(found('enforce: warn\n', '', 'enforce')).toHaveLength(0);
    expect(found('enforce: observe\n', '')).toHaveLength(0);
  });

  // [claims: capabilities/spec-first-changes#enforce-lowering-is-weakening]
  it('raising, keeping or newly setting the level is not a finding, and an unreadable value reads as the default', () => {
    expect(found('enforce: warn\n', 'enforce: enforce\n')).toHaveLength(0);
    expect(found('enforce: warn\n', 'enforce: warn\n')).toHaveLength(0);
    expect(found('', 'enforce: enforce\n')).toHaveLength(0);
    expect(found('', '')).toHaveLength(0);
    expect(found('enforce: enforce\n', 'enforce: strict\n')).toHaveLength(1);
  });

  // [claims: capabilities/spec-first-changes#enforce-lowering-is-weakening]
  it('new and deleted specs are not judged, and the finding appears with no claims at all', () => {
    expect(diffSpecPolicy(undefined, parse('enforce: warn\n'), [])).toEqual([]);
    expect(diffSpecPolicy(parse('enforce: warn\n'), undefined, [])).toEqual([]);
    const bare = (front: string) => parseSpecContent(`---\nid: cart\nkind: capability\nparent: system\nvalue: v\n${front}---\n# Cart\n\n## Problem & Value\n\nV.\n`, '/r/specs/capabilities/cart.md', '/r/specs');
    const [f] = diffSpecPolicy(bare('enforce: enforce\n'), bare('enforce: observe\n'), []);
    expect(f).toMatchObject({ kind: 'policy-enforce-lowered', claims: [] });
  });

  // [claims: capabilities/spec-first-changes#enforce-lowering-is-weakening, capabilities/spec-first-changes#enforce-not-hashed]
  it('is the only signal: a lowering written by setEnforceLevel leaves every claim hash alone but is still found', () => {
    const before = content('enforce: enforce\n');
    const after = setEnforceLevel(before, 'observe');
    const all = diffSpecPolicy(parseSpecContent(before, '/r/specs/capabilities/cart.md', '/r/specs'), parseSpecContent(after, '/r/specs/capabilities/cart.md', '/r/specs'), []);
    expect(all.map((f) => f.kind)).toEqual(['policy-enforce-lowered']);
  });
});
