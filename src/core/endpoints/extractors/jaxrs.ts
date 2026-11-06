import { lineOf, scanSource } from '../../source-scan.js';
import type { EndpointExtractor, EndpointHit } from '../types.js';

const join = (base: string, rest: string): string => `/${[base, rest].map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;

/** JAX-RS: class `@Path` joined with method `@Path` and a verb annotation (`@GET`, `@POST`, ...). */
export const jaxrs: EndpointExtractor = {
  id: 'jaxrs',
  globs: ['**/*.{java,kt}', '!**/*Test.{java,kt}', '!**/src/test/**'],
  defs(source) {
    const scanned = scanSource(source, 'jvm');
    const cls = /\b(?:class|interface)\s+\w+/.exec(scanned.skeleton);
    if (!cls) return [];
    const pathAt = (index: number): string | null => {
      const m = /^@Path\s*\(\s*(?:value\s*=\s*)?"([^"]*)"/.exec(scanned.clean.slice(index));
      return m ? m[1]! : null;
    };
    const paths = [...scanned.skeleton.matchAll(/@Path\b/g)].map((m) => ({ index: m.index!, value: pathAt(m.index!) ?? '' }));
    const base = paths.find((p) => p.index < cls.index)?.value ?? '';
    const out: EndpointHit[] = [];
    for (const m of scanned.skeleton.matchAll(/@(GET|POST|PUT|DELETE|PATCH|HEAD)\b/g)) {
      if (m.index! < cls.index) continue;
      // The method's own @Path sits in the same annotation block: no `{`, `}` or `;` between it and the verb.
      const own = paths.find((p) => {
        if (p.index < cls.index) return false;
        const [a, b] = p.index < m.index! ? [p.index, m.index!] : [m.index!, p.index];
        return Math.abs(a - b) < 400 && !/[{};]/.test(scanned.skeleton.slice(a, b));
      });
      out.push({ line: lineOf(scanned.lineStarts, m.index!), method: m[1]!, path: join(base, own?.value ?? '') });
    }
    return out;
  },
};
