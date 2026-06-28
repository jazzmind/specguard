import { describe, it, expect } from 'vitest';
import { artifactEventFor, cliArgsFor } from './flow-events.js';

describe('artifactEventFor', () => {
  it('classifies a spec path', () => {
    expect(artifactEventFor('specs/core/parser.md', 'create')).toMatchObject({ type: 'artifact', kind: 'spec', change: 'create' });
  });
  it('classifies test and doc paths', () => {
    expect(artifactEventFor('tests/core/parser.test.ts', 'update')?.kind).toBe('test');
    expect(artifactEventFor('docs/user/login.md', 'create')?.kind).toBe('doc');
  });
  it('ignores unrelated paths', () => {
    expect(artifactEventFor('src/core/parser.ts', 'create')).toBeNull();
  });
});

describe('cliArgsFor', () => {
  it('returns the pipeline name plus extras', () => {
    expect(cliArgsFor('drift')).toEqual(['drift']);
    expect(cliArgsFor('reverse', ['--app', 'specguard-core'])).toEqual(['reverse', '--app', 'specguard-core']);
  });
});
