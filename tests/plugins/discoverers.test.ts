import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  clientRequestPaths,
  graphqlDiscoverer,
  graphqlOperations,
  parseOpenApi,
  resolveModuleFile,
  restDiscoverer,
  trpcCalls,
  trpcDiscoverer,
  trpcProcedures,
} from '../../src/plugins/discoverers.js';
import type { CatalogFeatureInput, FeatureSpec } from '../../src/plugins/types.js';

function workspace(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'sg-disc-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return root;
}

const feature = (over: Partial<CatalogFeatureInput> = {}): CatalogFeatureInput => ({
  id: 'orders.list',
  title: 'Orders list',
  area: '',
  summary: '',
  requires: [],
  specs: ['web:orders/index'],
  tests: { unit: [], regression: [], integration: [], proof: [] },
  status: 'live',
  ...over,
});

const uiSpec: FeatureSpec = { ref: 'web:orders/index', featureIds: ['orders.list'], channel: 'ui', overview: 'Lists orders.', module: 'web/orders/index' };

describe('resolveModuleFile', () => {
  it('tries the path, repo prefix stripped, src/, extra stems, extensions and index files', () => {
    const root = workspace({ 'src/orders/index.tsx': '', 'src/pages/cart.ts': '', 'lib/util.py': '' });
    expect(resolveModuleFile(root, 'web/orders/index')).toBe(path.join(root, 'src/orders/index.tsx'));
    expect(resolveModuleFile(root, 'web/cart')).toBeNull();
    expect(resolveModuleFile(root, 'web/cart', ['src/pages'])).toBe(path.join(root, 'src/pages/cart.ts'));
    expect(resolveModuleFile(root, 'lib/util.py')).toBe(path.join(root, 'lib/util.py'));
    expect(resolveModuleFile(root, 'web/orders')).toBe(path.join(root, 'src/orders/index.tsx'));
  });
});

describe('graphql discoverer', () => {
  it('reads operations and matches the API spec by name', () => {
    expect(graphqlOperations('const q = gql`query { orders { id } } mutation Foo { createOrder { id } }`')).toEqual([
      { kind: 'query', field: 'orders' },
      { kind: 'mutation', field: 'createOrder' },
    ]);
    const root = workspace({
      'web/src/orders/index.tsx': 'export default 1;',
      'web/src/orders/queries.ts': 'gql`query { orders { id } }`',
    });
    const specs: FeatureSpec[] = [uiSpec, { ref: 'api:queries/order', featureIds: [], channel: 'api', overview: 'The orders query.' }];
    const found = graphqlDiscoverer.discover({
      features: [feature()],
      specs,
      repos: [{ key: 'web', absPath: path.join(root, 'web') }],
      moduleStems: [],
    });
    expect(found['orders.list']).toEqual({ ui: 'src/orders/index.tsx', api: 'api:queries/order' });
  });
});

describe('REST / OpenAPI discoverer', () => {
  const openapi = JSON.stringify({
    openapi: '3.0.0',
    paths: {
      '/orders': { get: { operationId: 'listOrders', tags: ['orders'] }, post: { operationId: 'createOrder' } },
      '/orders/{id}': { get: { operationId: 'getOrder' } },
    },
  });

  it('parses operations from JSON and YAML', () => {
    expect(parseOpenApi(openapi).map((o) => `${o.method} ${o.path}`)).toEqual(['GET /orders', 'POST /orders', 'GET /orders/{id}']);
    expect(parseOpenApi('paths:\n  /x:\n    get: {operationId: gx}\n')[0]).toMatchObject({ method: 'GET', path: '/x', operationId: 'gx' });
    expect(parseOpenApi('not: openapi')).toEqual([]);
  });

  it('extracts request paths from client code', () => {
    expect(
      clientRequestPaths("fetch(`/api/orders/${id}?x=1`); axios.post('https://h.example/orders'); ky.get(\"/orders\")"),
    ).toEqual([
      { method: null, path: '/api/orders/{}' },
      { method: 'POST', path: '/orders' },
      { method: 'GET', path: '/orders' },
    ]);
  });

  it('links a screen to an API spec through a documented operation', () => {
    const root = workspace({
      'web/src/orders/index.tsx': "export const load = () => fetch('/orders');",
      'api/openapi.json': openapi,
    });
    const specs: FeatureSpec[] = [uiSpec, { ref: 'api:orders', featureIds: ['orders.list'], channel: 'api', overview: 'Handles GET /orders.' }];
    const found = restDiscoverer.discover({
      features: [feature()],
      specs,
      repos: [{ key: 'web', absPath: path.join(root, 'web') }, { key: 'api', absPath: path.join(root, 'api') }],
      moduleStems: [],
    });
    expect(found['orders.list']).toMatchObject({ ui: 'src/orders/index.tsx', api: 'api:orders' });
  });

  it('reports the operation when no API spec is linked', () => {
    const root = workspace({
      'web/src/orders/index.tsx': "export const load = () => fetch('/orders/42');",
      'api/openapi.json': openapi,
    });
    const found = restDiscoverer.discover({
      features: [feature()],
      specs: [uiSpec],
      repos: [{ key: 'web', absPath: path.join(root, 'web') }, { key: 'api', absPath: path.join(root, 'api') }],
      moduleStems: [],
    });
    expect(found['orders.list'].api).toBe('openapi:GET /orders/{id}');
  });
});

describe('tRPC discoverer', () => {
  it('finds client calls and server procedures', () => {
    expect(trpcCalls('const q = trpc.orders.list.useQuery(); trpc.orders.create.useMutation(); api.user.me.query()')).toEqual([
      'orders.list',
      'orders.create',
      'user.me',
    ]);
    const root = workspace({
      'server/src/routers/orders.ts': 'export const ordersRouter = createTRPCRouter({\n  list: publicProcedure.query(() => []),\n  create: protectedProcedure.mutation(() => 1),\n});\n',
    });
    expect([...trpcProcedures(path.join(root, 'server')).keys()]).toEqual(['orders.list', 'orders.create']);
  });

  it('links a screen to an API spec, or to the procedure when no spec matches', () => {
    const root = workspace({
      'web/src/orders/index.tsx': 'export const A = () => trpc.orders.list.useQuery();',
      'server/src/routers/orders.ts': 'export const ordersRouter = createTRPCRouter({ list: publicProcedure.query(() => []) });\n',
    });
    const repos = [{ key: 'web', absPath: path.join(root, 'web') }, { key: 'server', absPath: path.join(root, 'server') }];
    const withSpec = trpcDiscoverer.discover({
      features: [feature()],
      specs: [uiSpec, { ref: 'server:routers/orders', featureIds: [], channel: 'api', overview: 'The orders router.' }],
      repos,
      moduleStems: [],
    });
    expect(withSpec['orders.list'].api).toBe('server:routers/orders');
    const without = trpcDiscoverer.discover({ features: [feature()], specs: [uiSpec], repos, moduleStems: [] });
    expect(without['orders.list'].api).toBe('trpc:orders.list');
  });
});
