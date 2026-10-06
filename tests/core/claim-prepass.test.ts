import { describe, it, expect } from 'vitest';
import path from 'node:path';

import { buildAppPrepass, collectTestFiles, prepassSpec } from '../../src/core/claim-prepass.js';
import { loadConfig } from '../../src/core/config.js';
import { parseSpecContent } from '../../src/core/spec-parser.js';
import { makeRepo, SPEC_AWARDS } from '../helpers/repo.js';

describe('claim prepass', () => {
  it('collects the union of testOutput, sources.tests, extraTestSources and extra globs', async () => {
    const repo = makeRepo();
    repo.write('tests/a.test.ts', '');
    repo.write('tests/node_modules/skip.test.ts', '');
    repo.write('e2e/b.spec.ts', '');
    repo.write('other/c.test.ts', '');
    repo.write('cli/d.test.ts', '');
    const config = await loadConfig(repo.dir);
    const app = config.apps[0];
    app.sources.tests = ['e2e/**/*.spec.ts'];
    app.extraTestSources = ['other/*.test.ts'];
    const files = await collectTestFiles(config, app, ['cli/*.test.ts']);
    expect(files.map((f) => path.relative(repo.dir, f))).toEqual(['cli/d.test.ts', 'e2e/b.spec.ts', 'other/c.test.ts', 'tests/a.test.ts']);
  });

  it('settles claims by tag (with or without repo prefix) and scenarios by title', async () => {
    const repo = makeRepo();
    const a = repo.write('tests/a.test.ts', "it('Award @claim:myrepo:core/awards#award-once', () => {});\nit('award', () => {});\n");
    const config = await loadConfig(repo.dir);
    const pre = buildAppPrepass(config, [a]);
    const spec = parseSpecContent(SPEC_AWARDS, path.join(repo.dir, 'specs/core/awards.md'), path.join(repo.dir, 'specs'));
    const settled = prepassSpec(spec, pre);
    expect(settled.coveredClaims.map((c) => c.id)).toEqual(['award-once']);
    expect(settled.uncoveredClaims.map((c) => c.id)).toEqual(['no-dupes', 'untested']);
    expect(settled.coveredScenarios.map((s) => s.scenario)).toEqual(['Award']);
    expect(settled.taggedFiles).toEqual(['tests/a.test.ts']);
  });
});
