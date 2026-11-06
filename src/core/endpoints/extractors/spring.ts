import { lineOf, matchClose, scanSource } from '../../source-scan.js';
import type { EndpointExtractor, EndpointHit } from '../types.js';

const VERB_MAPPING: Record<string, string> = { Get: 'GET', Post: 'POST', Put: 'PUT', Delete: 'DELETE', Patch: 'PATCH' };

const literals = (text: string): string[] => [...text.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);

/** Paths named in an annotation's arguments: `("/a")`, `(value = "/a")`, `(path = {"/a", "/b"})`. */
function annotationPaths(args: string): string[] {
  const named = args.match(/\b(?:value|path)\s*=\s*(\{[^}]*\}|"[^"]*")/);
  const found = literals(named ? named[1]! : args.replace(/\bmethod\s*=\s*[^,)]*/g, ''));
  return found.length > 0 ? found : [''];
}

const join = (base: string, rest: string): string => `/${[base, rest].map((s) => s.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;

/** Spring MVC: class-level `@RequestMapping` joined with method-level mappings. */
export const spring: EndpointExtractor = {
  id: 'spring',
  globs: ['**/*.{java,kt}', '!**/*Test.{java,kt}', '!**/src/test/**'],
  defs(source) {
    const scanned = scanSource(source, 'jvm');
    const cls = /\b(?:class|interface)\s+\w+/.exec(scanned.skeleton);
    if (!cls) return [];
    const annotation = (from: number, to: number, name: string): string | null => {
      const re = new RegExp(`@${name}\\s*(\\()?`, 'g');
      re.lastIndex = from;
      const m = re.exec(scanned.skeleton);
      if (!m || m.index >= to) return null;
      if (!m[1]) return '';
      const open = m.index + m[0].length - 1;
      const close = matchClose(scanned.skeleton, open);
      return close < 0 ? '' : scanned.clean.slice(open + 1, close);
    };
    const classArgs = annotation(0, cls.index, 'RequestMapping');
    const bases = classArgs === null ? [''] : annotationPaths(classArgs);
    const out: EndpointHit[] = [];
    const re = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b\s*(\()?/g;
    re.lastIndex = cls.index;
    for (let m = re.exec(scanned.skeleton); m; m = re.exec(scanned.skeleton)) {
      let args = '';
      if (m[2]) {
        const open = m.index + m[0].length - 1;
        const close = matchClose(scanned.skeleton, open);
        if (close > 0) args = scanned.clean.slice(open + 1, close);
      }
      const verbs =
        m[1] === 'Request'
          ? [...args.matchAll(/RequestMethod\.([A-Z]+)/g)].map((v) => v[1]!)
          : [VERB_MAPPING[m[1]!]!];
      for (const base of bases) {
        for (const rest of annotationPaths(args)) {
          for (const method of verbs.length > 0 ? verbs : [null]) {
            out.push({ line: lineOf(scanned.lineStarts, m.index), method, path: join(base, rest) });
          }
        }
      }
    }
    return out;
  },
};
