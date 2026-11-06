/**
 * Path normalisation and scoring for endpoint matching.
 *
 * Spec: specs/capabilities/integration-surfaces.md
 */
import type { EndpointHit } from './types.js';

/** Leading path segments that are a deployment prefix, not part of the endpoint. */
export const DEFAULT_BASE_PREFIXES = ['/api', '/v1', '/v2'];

/**
 * A path as segments: origin, query and fragment dropped, `${}`, `{id}` and `:id` all `{}`, slashes
 * collapsed, and any leading segment named in `basePrefixes` removed (repeatedly, so `/api/v1/x` is `x`).
 */
export function normalizePath(raw: string, basePrefixes: string[] = DEFAULT_BASE_PREFIXES): string[] {
  let p = raw.trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/, '');
  p = p.replace(/\$\{[^}]*\}/g, '{}');
  const segs = p
    .split('/')
    .filter((s) => s !== '')
    .map((s) => (/^\{.*\}$/.test(s) || s.startsWith(':') || /\{\}/.test(s) ? '{}' : s.toLowerCase()));
  const prefixes = new Set(basePrefixes.map((x) => x.replace(/^\/+|\/+$/g, '').toLowerCase()).filter(Boolean));
  while (segs.length > 1 && prefixes.has(segs[0]!)) segs.shift();
  return segs;
}

const methodsAgree = (a: string | null, b: string | null): boolean => a === null || b === null || a === b;

/**
 * How well a client call matches a definition: 0.9 for the same path and method, 0.75 when one path is
 * the tail of the other, 0.6 when the call's base is a variable and its path is the tail of the
 * definition's, else 0.
 */
export function matchScore(call: EndpointHit, def: EndpointHit, basePrefixes: string[] = DEFAULT_BASE_PREFIXES): number {
  if (!methodsAgree(call.method, def.method)) return 0;
  const c = normalizePath(call.path, basePrefixes);
  const d = normalizePath(def.path, basePrefixes);
  if (c.length === 0 || d.length === 0) return 0;
  if (c.join('/') === d.join('/')) return 0.9;
  const [short, long] = c.length <= d.length ? [c, d] : [d, c];
  if (short.every((s) => s === '{}')) return 0;
  const tail = long.slice(long.length - short.length).join('/') === short.join('/');
  if (!tail) return 0;
  if (call.baseKey) return c.length <= d.length ? 0.6 : 0;
  return 0.75;
}
