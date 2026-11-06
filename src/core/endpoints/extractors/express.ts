import { lineOf, scanSource } from '../../source-scan.js';
import type { EndpointExtractor, EndpointHit } from '../types.js';

const ROUTE = /\b(?:app|router|fastify|server|\w*Router)\.(get|post|put|patch|delete|head)\s*\(\s*(['"`])(\/[^'"`]*)\2/g;

/** Express and Fastify routes: `app.get('/x', ...)`, `router.post('/x', ...)`, `fastify.delete('/x', ...)`. */
export const express: EndpointExtractor = {
  id: 'express',
  globs: ['**/*.{ts,js,mjs,cjs}', '!**/*.{spec,test}.*', '!**/*.d.ts'],
  defs(source) {
    const scanned = scanSource(source, 'js');
    const out: EndpointHit[] = [];
    for (const m of scanned.clean.matchAll(ROUTE)) {
      out.push({ line: lineOf(scanned.lineStarts, m.index!), method: m[1]!.toUpperCase(), path: m[3]!.replace(/\$\{[^}]*\}/g, '{}') });
    }
    return out;
  },
};
