/** Minimal semver helpers. Enough to rank fix candidates; not a full range solver. */

export interface Ver {
  major: number;
  minor: number;
  patch: number;
  pre: string;
}

export function parseVer(input: string): Ver | null {
  const m = /v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?/.exec(input.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), pre: m[4] ?? '' };
}

export function compareVer(a: string, b: string): number {
  const x = parseVer(a);
  const y = parseVer(b);
  if (!x || !y) return a.localeCompare(b);
  return (
    x.major - y.major ||
    x.minor - y.minor ||
    x.patch - y.patch ||
    (x.pre === y.pre ? 0 : x.pre === '' ? 1 : y.pre === '' ? -1 : x.pre.localeCompare(y.pre))
  );
}

export function bumpKind(from: string, to: string): 'patch' | 'minor' | 'major' | 'unknown' {
  const a = parseVer(from);
  const b = parseVer(to);
  if (!a || !b) return 'unknown';
  if (b.major !== a.major) return 'major';
  if (b.minor !== a.minor) return 'minor';
  return 'patch';
}

/** Every concrete version number mentioned in a range or list string. */
export function versionsIn(text: string): string[] {
  return [...text.matchAll(/\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?/g)].map((m) => m[0]);
}

/** Versions that fix a vulnerable range such as `<4.17.21` or `>=1.0.0 <1.2.5 || >=2.0.0 <2.0.3`. */
export function fixedFromRange(range: string): string[] {
  const out: string[] = [];
  for (const m of range.matchAll(/<\s*(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)/g)) {
    if (!/<=/.test(m[0])) out.push(m[1]);
  }
  return out;
}

const RANK = { patch: 0, minor: 1, major: 2, unknown: 3 } as const;

/** Order fix versions: patch before minor before major, then ascending. Drops versions not above `installed`. */
export function rankFixes(installed: string, fixed: string[]): Array<{ version: string; bump: 'patch' | 'minor' | 'major' | 'unknown' }> {
  const seen = new Set<string>();
  const list = fixed
    .filter((v) => (seen.has(v) ? false : (seen.add(v), true)))
    .filter((v) => !parseVer(installed) || compareVer(v, installed) > 0)
    .map((version) => ({ version, bump: bumpKind(installed, version) }));
  return list.sort((a, b) => RANK[a.bump] - RANK[b.bump] || compareVer(a.version, b.version));
}
