import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOutputLocations, describeOutputs, outputDirectory, saveOutputLocation } from '../../src/core/output-locations.js';
import { loadRepoSpecs } from '../../src/core/spec-graph.js';
import { canonicalSpecKey } from '../../src/core/spec-key.js';
import type { SpecGuardConfig } from '../../src/core/types.js';
let root: string;
let config: SpecGuardConfig;
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'sg-output-')); config = { rootDir: root, apps: [{ name: 'api', repo: 'code', language: 'java', framework: 'junit', specDir: 'specs/core', testOutput: 'tags', sources: { tests: ['src/test/**/*.java'] } }], paths: { specsRoot: 'specs' }, llm: { provider: 'host', model: 'test', apiKeyEnv: 'TEST_KEY' } }; });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const put = (file: string, data: string) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), data); };
describe('explicit output locations', () => {
  // [claims: capabilities/integration-surfaces#output-destinations]
  it('isolates test layers and adds generated directories to discovery without replacing native tests', () => {
    config.apps[0].extraTestSources = ['tags/*.md'];
    saveOutputLocation(config, 'api', 'tests.e2e', 'browser/journeys');
    saveOutputLocation(config, 'api', 'tests.unit', 'code/src/test/java');
    applyOutputLocations(config);
    expect(outputDirectory(config, config.apps[0], 'tests.e2e')).toBe(path.join(root, 'browser/journeys'));
    expect(outputDirectory(config, config.apps[0], 'tests.unit')).toBe(path.join(root, 'code/src/test/java'));
    expect(config.apps[0].extraTestSources).toEqual(expect.arrayContaining(['tags/*.md', path.join(root, 'browser/journeys/**/*')]));
    expect(config.apps[0].sources.tests).toEqual(['src/test/**/*.java']);
  });
  // [claims: capabilities/integration-surfaces#output-destinations]
  it('copies specs when switching roots and preserves canonical claim keys, including subsequent switches', () => {
    put('specs/core/login.md', '# Login');
    saveOutputLocation(config, 'api', 'specs', 'overlay/specs'); applyOutputLocations(config);
    expect(readFileSync(path.join(root, 'overlay/specs/login.md'), 'utf8')).toBe('# Login');
    expect(existsSync(path.join(root, 'specs/core/login.md'))).toBe(true);
    expect(canonicalSpecKey(config, path.join(root, 'overlay/specs/login.md'))).toBe('core/login');
    saveOutputLocation(config, 'api', 'specs', 'another/specs'); applyOutputLocations(config);
    expect(canonicalSpecKey(config, path.join(root, 'another/specs/login.md'))).toBe('core/login');
  });
  // [claims: capabilities/integration-surfaces#output-destinations]
  it('refuses conflicting copies before writing anything and rejects overlapping spec roots', () => {
    put('specs/core/a.md', 'a'); put('specs/core/z.md', 'z'); put('new/z.md', 'other');
    expect(() => saveOutputLocation(config, 'api', 'specs', 'new')).toThrow(/conflicting/);
    expect(existsSync(path.join(root, 'new/a.md'))).toBe(false);
    expect(() => saveOutputLocation(config, 'api', 'specs', 'specs/core/nested')).toThrow(/separate/);
    expect(outputDirectory(config, config.apps[0], 'specs')).toBe(path.join(root, 'specs/core'));
  });
  // [claims: capabilities/integration-surfaces#extension-output-routing]
  it('recognizes mapping-only output and finds the established native test directory', () => {
    put('code/src/test/java/OneTest.java', 'test'); put('code/src/test/java/sub/TwoTest.java', 'test');
    const [row] = describeOutputs(config);
    expect(row.outputs.find(o => o.kind === 'tests.unit')?.mappingOnly).toBe(true);
    expect(row.testDirectories.unit).toBe(path.join(root, 'code/src/test/java'));
  });
  // [claims: capabilities/integration-surfaces#extension-output-routing]
  it('offers Maven module test roots rather than a parent directory outside every runner', () => {
    config.apps[0].sources.tests = ['**/src/test/**/*.java'];
    put('code/module-a/src/test/java/OneTest.java', 'test'); put('code/module-b/src/test/java/TwoTest.java', 'test');
    const [row] = describeOutputs(config);
    expect(row.testDirectoryOptions.unit).toEqual([path.join(root, 'code/module-a/src/test/java'), path.join(root, 'code/module-b/src/test/java')]);
  });

  // [claims: capabilities/integration-surfaces#output-destinations]
  it('keeps a shared system root and other applications while retiring only the copied spec subtree', () => {
    config.apps.push({ ...config.apps[0], name: 'ui', specDir: 'specs/ui' });
    put('specs/system.md', '# System'); put('specs/core/login.md', '# Login'); put('specs/ui/screen.md', '# Screen');
    saveOutputLocation(config, 'api', 'specs', 'overlay/specs'); applyOutputLocations(config);
    put('specs/core/login.md', '# Superseded copy');
    const specs = loadRepoSpecs(config);
    expect(specs.map(s => s.spec.specKey).sort()).toEqual(['core/login', 'system', 'ui/screen']);
    expect(specs.find(s => s.spec.specKey === 'core/login')?.spec.title).toBe('Login');
  });

});
