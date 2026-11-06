/**
 * OpenAPI reading and client-request scanning, shared by the feature catalog's REST discoverer and
 * `contracts-map`.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { EndpointHit } from './types.js';

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export interface OpenApiOperation {
  method: string;
  path: string;
  operationId?: string;
  tags: string[];
}

const OPENAPI_NAMES = ['openapi.json', 'openapi.yaml', 'openapi.yml', 'swagger.json', 'swagger.yaml', 'swagger.yml'];
const OPENAPI_DIRS = ['', 'docs', 'api', 'spec', 'specs', 'openapi'];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

/** Operations from an OpenAPI 3 / Swagger 2 document (JSON or YAML text). */
export function parseOpenApi(text: string): OpenApiOperation[] {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return [];
  }
  const paths = doc && typeof doc === 'object' ? (doc as { paths?: Record<string, Record<string, unknown>> }).paths : undefined;
  if (!paths || typeof paths !== 'object') return [];
  const ops: OpenApiOperation[] = [];
  for (const [route, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = (item as Record<string, unknown>)[method];
      if (!op || typeof op !== 'object') continue;
      const rec = op as { operationId?: unknown; tags?: unknown };
      ops.push({
        method: method.toUpperCase(),
        path: route,
        operationId: typeof rec.operationId === 'string' ? rec.operationId : undefined,
        tags: Array.isArray(rec.tags) ? rec.tags.map(String) : [],
      });
    }
  }
  return ops;
}

export function findOpenApiDocs(repos: Array<{ key: string; absPath: string }>): Array<{ repo: string; ops: OpenApiOperation[] }> {
  const docs: Array<{ repo: string; ops: OpenApiOperation[] }> = [];
  for (const repo of repos) {
    for (const dir of OPENAPI_DIRS) {
      for (const name of OPENAPI_NAMES) {
        const file = path.join(repo.absPath, dir, name);
        if (!isFile(file)) continue;
        const ops = parseOpenApi(readFileSync(file, 'utf8'));
        if (ops.length > 0) docs.push({ repo: repo.key, ops });
      }
    }
  }
  return docs;
}

export function routeRegex(route: string): RegExp {
  const body = route
    .split('/')
    .map((seg) => (/^\{.+\}$/.test(seg) || /^:/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return new RegExp(`^${body}/?$`);
}

const CLIENT_CALL = /\b(fetch|axios(?:\.(get|post|put|patch|delete))?|ky(?:\.(get|post|put|patch|delete))?|\$http\.(get|post|put|patch|delete)|http\.(get|post|put|patch|delete))\(\s*([`'"])([^`'"]+)\6/g;

/** Like {@link clientRequestPaths}, with the line of each call. */
export function clientRequestHits(source: string): EndpointHit[] {
  const out: EndpointHit[] = [];
  for (const match of source.matchAll(CLIENT_CALL)) {
    const method = (match[2] ?? match[3] ?? match[4] ?? match[5] ?? null)?.toUpperCase() ?? null;
    let url = match[7].replace(/\$\{[^}]*\}/g, '{}');
    url = url.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
    if (url.startsWith('/')) out.push({ method, path: url, line: source.slice(0, match.index).split('\n').length });
  }
  return out;
}

/** Request URLs found in client code. Template holes become `{}`; origin and query are dropped. */
export function clientRequestPaths(source: string): Array<{ method: string | null; path: string }> {
  return clientRequestHits(source).map(({ method, path: p }) => ({ method, path: p }));
}
