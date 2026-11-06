import { describe, expect, it } from 'vitest';

import { matchScore, normalizePath } from '../../src/core/endpoints/normalize.js';
import { angularHttpClient, express, fetchLike, jaxrs, openapi, spring } from '../../src/core/endpoints/extractors/index.js';
import { parseUrlExpression } from '../../src/core/endpoints/extractors/angular-httpclient.js';

const shape = (hits: Array<{ method: string | null; path: string; baseKey?: string }>) =>
  hits.map((h) => `${h.method} ${h.path}${h.baseKey ? ` @${h.baseKey}` : ''}`);

describe('endpoint extractors and matching [contracts-map-code-extractors]', () => {
  // [claims: capabilities/integration-surfaces#contracts-map-code-extractors]
  it('normalises paths: origin, query, base prefixes dropped and every parameter form becomes {}', () => {
    expect(normalizePath('https://h.example/api/v1/orders/${id}/items?x=1')).toEqual(['orders', '{}', 'items']);
    expect(normalizePath('/orders/:id')).toEqual(['orders', '{}']);
    expect(normalizePath('/orders/{orderId}/')).toEqual(['orders', '{}']);
    expect(normalizePath('/api/orders', [])).toEqual(['api', 'orders']);
    expect(normalizePath('/billing/orders', ['/billing'])).toEqual(['orders']);
  });

  // [claims: capabilities/integration-surfaces#contracts-map-code-extractors]
  it('scores exact path and method 0.9, a tail match 0.75, a variable base with a tail match 0.6, and a method clash 0', () => {
    expect(matchScore({ line: 1, method: 'GET', path: '/api/orders/{}' }, { line: 1, method: 'GET', path: '/orders/{id}' })).toBe(0.9);
    expect(matchScore({ line: 1, method: null, path: '/orders' }, { line: 1, method: 'POST', path: '/orders' })).toBe(0.9);
    expect(matchScore({ line: 1, method: 'GET', path: '/orders' }, { line: 1, method: 'GET', path: '/shop/orders' })).toBe(0.75);
    expect(matchScore({ line: 1, method: 'GET', path: '/orders', baseKey: 'cfg.api' }, { line: 1, method: 'GET', path: '/shop/orders' })).toBe(0.6);
    expect(matchScore({ line: 1, method: 'GET', path: '/orders' }, { line: 1, method: 'POST', path: '/orders' })).toBe(0);
    expect(matchScore({ line: 1, method: 'GET', path: '/orders' }, { line: 1, method: 'GET', path: '/payments' })).toBe(0);
    expect(matchScore({ line: 1, method: 'GET', path: '/{}' }, { line: 1, method: 'GET', path: '/x/{}' })).toBe(0);
  });

  // [claims: capabilities/integration-surfaces#contracts-map-code-extractors]
  it('fetch-like finds literal URLs with their line; Angular HttpClient also reads templates and a variable base', () => {
    const src = "fetch('/orders');\n\nconst r = await axios.post(`/orders/${id}/pay`, {});\n";
    expect(fetchLike.calls!(src, 'a.ts').map((h) => [h.line, h.method, h.path])).toEqual([[1, null, '/orders'], [3, 'POST', '/orders/{}/pay']]);
    const ng = `
      this.http.get<Order[]>('/orders');
      this.http.post<Order>(\`/orders/\${id}\`, body);
      this.http.get(this.cfg.api + '/orders/' + id);
      this.http.delete(\`\${this.base}/orders/1\`);
      // this.http.get('/commented');
    `;
    expect(shape(angularHttpClient.calls!(ng, 'a.ts'))).toEqual([
      'GET /orders',
      'POST /orders/{}',
      'GET /orders/{} @this.cfg.api',
      'DELETE /orders/1 @this.base',
    ]);
    expect(parseUrlExpression("'no-slash'")).toBeNull();
  });

  // [claims: capabilities/integration-surfaces#contracts-map-code-extractors]
  it('Spring joins a class-level mapping with method-level ones, including RequestMapping with a method', () => {
    const src = `
      @RestController
      @RequestMapping("/orders")
      public class OrderController {
        @GetMapping
        public List<Order> list() { return null; }
        @GetMapping("/{id}")
        public Order get() { return null; }
        @PostMapping(value = "/bulk")
        public void bulk() {}
        @RequestMapping(value = "/legacy", method = RequestMethod.PUT)
        public void legacy() {}
        // @DeleteMapping("/gone")
      }`;
    expect(shape(spring.defs!(src, 'O.java'))).toEqual(['GET /orders', 'GET /orders/{id}', 'POST /orders/bulk', 'PUT /orders/legacy']);
  });

  // [claims: capabilities/integration-surfaces#contracts-map-code-extractors]
  it('JAX-RS joins the class @Path, the method @Path and the verb annotation', () => {
    const src = `
      @Path("/payments")
      public class PaymentResource {
        @GET
        public List<Payment> all() { return null; }
        @GET
        @Path("/{id}")
        public Payment one() { return null; }
        @POST @Path("refund")
        public void refund() {}
      }`;
    expect(shape(jaxrs.defs!(src, 'P.java'))).toEqual(['GET /payments', 'GET /payments/{id}', 'POST /payments/refund']);
  });

  // [claims: capabilities/integration-surfaces#contracts-map-code-extractors]
  it('Express and Fastify routes and OpenAPI operations are definitions', () => {
    const routes = "app.get('/billing/invoices', h);\nrouter.post('/billing/invoices/:id/pay', h);\nfastify.delete('/billing/invoices/:id', h);";
    expect(shape(express.defs!(routes, 'r.ts'))).toEqual(['GET /billing/invoices', 'POST /billing/invoices/:id/pay', 'DELETE /billing/invoices/:id']);
    expect(shape(openapi.defs!('paths:\n  /orders:\n    get: {}\n    post: {}\n  /orders/{id}:\n    get: {}\n', 'openapi.yaml'))).toEqual([
      'GET /orders',
      'POST /orders',
      'GET /orders/{id}',
    ]);
  });
});
