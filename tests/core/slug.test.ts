import { describe, expect, it } from 'vitest';

import { slugify as historySlugify } from '../../src/core/history.js';
import { slugify, uniqueSlug } from '../../src/core/slug.js';

describe('slug [doc-anchors-stable]', () => {
  // [claims: capabilities/documentation-api#doc-anchors-stable]
  it('slugifies headings to lowercase hyphenated words and history uses the same function', () => {
    expect(slugify('Why it exists')).toBe('why-it-exists');
    expect(slugify('  Problem & Value!  ')).toBe('problem-value');
    expect(slugify('')).toBe('entry');
    expect(slugify('***', 40, 'section')).toBe('section');
    expect(slugify('a'.repeat(50), 10)).toBe('a'.repeat(10));
    // history ids must not change
    expect(historySlugify('Ignore block covers nested repos in over', 40)).toBe('ignore-block-covers-nested-repos-in-over');
    expect(historySlugify).toBe(slugify);
  });

  // [claims: capabilities/documentation-api#doc-anchors-stable]
  it('makes repeated headings unique with a numeric suffix', () => {
    const taken = new Set<string>();
    expect(uniqueSlug('Steps', taken)).toBe('steps');
    expect(uniqueSlug('Steps', taken)).toBe('steps-2');
    expect(uniqueSlug('Steps', taken)).toBe('steps-3');
  });
});
