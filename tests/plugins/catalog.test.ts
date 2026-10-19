import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CatalogError, loadCatalogDir, parseCatalogYaml, parseFeatureList, listCatalogProvider, yamlCatalogProvider } from '../../src/plugins/feature-catalog/catalog.js';

const V1 = `
version: 1
features:
  - id: orders.create
    title: "Create an order: fast"
    summary: >
      Customers place an order.
      It is saved.
    requires: [ui, api, bogus]
    specs: ["web:orders/create"]
    tests:
      unit: [orders.test.ts]
      regression: [QA-T12, QA-T13]
    externalIds: [QA-T12]
    tags: [checkout]
    status: live
    agent:
      prompt: 'ignored: here'
  - id: 42
`;

describe('catalog', () => {
  // [claims: capabilities/integration-surfaces#feature-catalog]
  it('parses versioned YAML with a real parser (colons, folded text, nesting)', () => {
    const [a, b] = parseCatalogYaml(V1);
    expect(a).toMatchObject({
      id: 'orders.create',
      title: 'Create an order: fast',
      summary: 'Customers place an order. It is saved.\n',
      requires: ['ui', 'api'],
      specs: ['web:orders/create'],
      externalIds: ['QA-T12'],
      tags: ['checkout'],
      status: 'live',
    });
    expect(a.tests).toEqual({ unit: ['orders.test.ts'], regression: ['QA-T12', 'QA-T13'], integration: [], proof: [] });
    expect(b.id).toBe('42');
    expect(b.status).toBe('planned');
  });

  // [claims: capabilities/integration-surfaces#feature-catalog]
  it('rejects an unversioned or wrong-version file with a CatalogError', () => {
    expect(() => parseCatalogYaml('features: []')).toThrow(CatalogError);
    expect(() => parseCatalogYaml('version: 2\nfeatures: []')).toThrow(/version/);
    expect(() => parseCatalogYaml('version: 1\nfeatures:\n  - title: no id')).toThrow(/id/);
    expect(() => parseCatalogYaml('version: 1\nfeatures: [\n')).toThrow(CatalogError);
  });

  // [claims: capabilities/integration-surfaces#feature-catalog]
  it('loads a directory and rejects duplicate ids across files', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sg-cat-'));
    writeFileSync(path.join(dir, 'a.yaml'), 'version: 1\nfeatures:\n  - id: a\n');
    writeFileSync(path.join(dir, 'b.yml'), 'version: 1\nfeatures:\n  - id: b\n');
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored');
    expect(loadCatalogDir(dir).map((f) => f.id)).toEqual(['a', 'b']);
    writeFileSync(path.join(dir, 'c.yaml'), 'version: 1\nfeatures:\n  - id: a\n');
    expect(() => loadCatalogDir(dir)).toThrow(/duplicate/);
    expect(loadCatalogDir(path.join(dir, 'missing'))).toEqual([]);
  });

  // [claims: capabilities/integration-surfaces#catalog-layout-config]
  it('generic provider has no default directory', async () => {
    expect(yamlCatalogProvider.defaultDir).toBeUndefined();
    expect(await yamlCatalogProvider.load({ rootDir: '/nonexistent' })).toEqual([]);
  });

  // [claims: capabilities/integration-surfaces#catalog-layout-config, capabilities/integration-surfaces#feature-catalog]
  it('the list provider reads bare feature lists from the directory config names, and has no default [list-provider]', async () => {
    expect(listCatalogProvider.defaultDir).toBeUndefined();
    expect(await listCatalogProvider.load({ rootDir: '/nonexistent' })).toEqual([]);
    const root = mkdtempSync(path.join(os.tmpdir(), 'sg-cat-'));
    const dir = path.join(root, 'qa', 'catalog');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'x.yaml'), '- id: a.b.c\n  title: "T: x"\n  requires: [ui]\n  tests:\n    unit: [x.test.ts]\n  agent:\n    prompt: hi\n');
    const [f] = await listCatalogProvider.load({ rootDir: root, dir: 'qa/catalog' });
    expect(f).toMatchObject({ id: 'a.b.c', title: 'T: x', requires: ['ui'] });
    expect(parseFeatureList('- id: z\n')[0].id).toBe('z');
  });

  // [claims: capabilities/integration-surfaces#feature-catalog, capabilities/integration-surfaces#catalog-layout-config]
  it('catalogExclude skips matching file names before they are parsed', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'sg-cat-'));
    const dir = path.join(root, 'catalog');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'features.yaml'), '- id: kept\n');
    writeFileSync(path.join(dir, 'tours.yaml'), '- id: skipped\n  not: [valid\n');
    await expect(listCatalogProvider.load({ rootDir: root, dir: 'catalog' })).rejects.toThrow(CatalogError);
    const kept = await listCatalogProvider.load({ rootDir: root, dir: 'catalog', exclude: ['tours.yaml', 'other*.yaml'] });
    expect(kept.map((feature) => feature.id)).toEqual(['kept']);
    expect(loadCatalogDir(dir, parseFeatureList, ['tour?.yaml']).map((feature) => feature.id)).toEqual(['kept']);
  });
});
