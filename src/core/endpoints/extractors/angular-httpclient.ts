import { lineOf, matchClose, scanSource, splitTopLevel } from '../../source-scan.js';
import type { EndpointExtractor, EndpointHit } from '../types.js';

const CALL = /\b(?:this\.)?\w*[Hh]ttp\w*\.(get|post|put|patch|delete)\s*(?:<[^()]*>)?\s*\(/g;

/** The path and unresolved base of a URL expression: a literal, a template or `base + '/path'` pieces. */
export function parseUrlExpression(expr: string): { path: string; baseKey?: string } | null {
  const pieces: string[] = [];
  let cur = '';
  let quote = '';
  let depth = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const c = expr[i]!;
    if (quote) {
      cur += c;
      if (c === '\\') cur += expr[++i] ?? '';
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    if (c === '(' || c === '[' || c === '{') depth += 1;
    if (c === ')' || c === ']' || c === '}') depth -= 1;
    if (c === '+' && depth === 0) {
      pieces.push(cur);
      cur = '';
    } else cur += c;
  }
  pieces.push(cur);
  let path = '';
  let baseKey: string | undefined;
  pieces.forEach((raw, idx) => {
    const piece = raw.trim();
    const lit = piece.match(/^(['"`])([\s\S]*)\1$/);
    if (!lit) {
      if (idx === 0) baseKey = piece;
      else path += '{}';
      return;
    }
    let text = lit[2]!;
    if (lit[1] === '`') {
      if (idx === 0) {
        const lead = text.match(/^\$\{([^}]*)\}/);
        if (lead) {
          baseKey = lead[1]!.trim();
          text = text.slice(lead[0].length);
        }
      }
      text = text.replace(/\$\{[^}]*\}/g, '{}');
    }
    path += text;
  });
  path = path.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/[?#].*$/, '');
  if (!path.startsWith('/')) return null;
  return baseKey ? { path, baseKey } : { path };
}

/** Angular `HttpClient` calls: `this.http.get<T>(url)`, `http.post(url, body)`. */
export const angularHttpClient: EndpointExtractor = {
  id: 'angular-httpclient',
  globs: ['**/*.ts', '!**/*.{spec,test}.ts', '!**/*.d.ts'],
  calls(source) {
    const scanned = scanSource(source, 'js');
    const out: EndpointHit[] = [];
    for (const m of scanned.clean.matchAll(CALL)) {
      const open = m.index! + m[0].length - 1;
      const close = matchClose(scanned.skeleton, open);
      if (close < 0) continue;
      const [first] = splitTopLevel(scanned.skeleton, open + 1, close);
      if (!first) continue;
      const url = parseUrlExpression(scanned.clean.slice(first[0], first[1]));
      if (url) out.push({ line: lineOf(scanned.lineStarts, m.index!), method: m[1]!.toUpperCase(), ...url });
    }
    return out;
  },
};
