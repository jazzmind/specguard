/**
 * The per-capability ratchet: which level a capability enforces at, and who may move it.
 *
 * A capability's `enforce:` frontmatter says how strictly spec-first change binds it: `observe` only
 * reports, `warn` tells the agent, `enforce` blocks (in the hooks and in CI). Absent, it takes the
 * config's `enforce.default` (which is `observe` unless set). The level is policy, not intent, so it is
 * outside every claim hash: moving it never stales an approval, and lowering it is caught by weakening
 * detection instead (`policy-enforce-lowered`).
 *
 * Everything here is pure. The commands that read specs, check certification and write history are in
 * src/pipelines/enforce.ts.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */
import { parse as parseYaml } from 'yaml';

import type { CertLevel } from './proof-statement.js';
import { ENFORCE_LEVELS, type EnforceConfig, type EnforceLevel, type SpecMeta } from './types.js';

/** Config fallback when neither the spec nor the config names a level. */
const FALLBACK: EnforceLevel = 'observe';

export const isEnforceLevel = (v: unknown): v is EnforceLevel => typeof v === 'string' && (ENFORCE_LEVELS as readonly string[]).includes(v);

/** Position on the ladder, weakest first: observe 0, warn 1, enforce 2. */
export const enforceRank = (level: EnforceLevel): number => ENFORCE_LEVELS.indexOf(level);

/** The level a capability that sets none takes: `enforce.default`, else `observe`. */
export function defaultEnforce(cfg?: Pick<EnforceConfig, 'default'>): EnforceLevel {
  return cfg?.default && isEnforceLevel(cfg.default) ? cfg.default : FALLBACK;
}

/** The level written into a new capability's frontmatter: `enforce.newCapabilities`, else the default level. */
export function newCapabilityEnforce(cfg?: Pick<EnforceConfig, 'default' | 'newCapabilities'>): EnforceLevel {
  return cfg?.newCapabilities && isEnforceLevel(cfg.newCapabilities) ? cfg.newCapabilities : defaultEnforce(cfg);
}

/**
 * A capability's effective level: its `enforce:` frontmatter, else the config default. A value off the
 * ladder was never read into `meta.enforce` (see `unknownEnforce`), so it takes the default too.
 */
export function effectiveEnforce(meta: Pick<SpecMeta, 'enforce'>, cfg?: Pick<EnforceConfig, 'default'>): EnforceLevel {
  return meta.enforce && isEnforceLevel(meta.enforce) ? meta.enforce : defaultEnforce(cfg);
}

/** An `enforce:` value the parser could not read (not observe, warn or enforce), as written; undefined when there is none. */
export function unknownEnforce(meta: Pick<SpecMeta, 'extra'>): string | undefined {
  return meta.extra.enforce;
}

/** True when moving from `from` to `to` makes the capability less strict. */
export function isLowering(from: EnforceLevel, to: EnforceLevel): boolean {
  return enforceRank(to) < enforceRank(from);
}

/** The next level up the ladder, or undefined at the top. */
export function nextLevel(from: EnforceLevel): EnforceLevel | undefined {
  return ENFORCE_LEVELS[enforceRank(from) + 1];
}

/**
 * Whether a capability at `from` may be raised to `to`. Moving to `warn` is advisory and always allowed.
 * Moving to `enforce` is allowed only while the capability's proof statement is `certified`: a
 * capability that is not yet proven would start blocking its own next change.
 */
export function canRaise(from: EnforceLevel, to: EnforceLevel, statementLevel: CertLevel): { ok: true } | { ok: false; reason: string } {
  if (to === from) return { ok: false, reason: `already at ${from}` };
  if (isLowering(from, to)) return { ok: false, reason: `${from} to ${to} lowers the level; use \`enforce lower\`` };
  if (to === 'enforce' && statementLevel !== 'certified') {
    return { ok: false, reason: `a capability can move to enforce only while it is certified, and it is ${statementLevel}` };
  }
  return { ok: true };
}

const FRONT = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;

/**
 * Set `enforce: <level>` in a spec's frontmatter with a minimal line edit: an existing line keeps its place
 * and any trailing comment, a missing one is added after the last frontmatter line. Everything else, the
 * body included, is byte for byte the same, so no claim hash moves. Content without frontmatter, or whose
 * edited frontmatter would not read back with that level, is returned unchanged.
 */
export function setEnforceLevel(content: string, level: EnforceLevel): string {
  const m = content.match(FRONT);
  if (!m) return content;
  const eol = m[1].endsWith('\r\n') ? '\r\n' : '\n';
  const lines = m[2].split(/\r?\n/);
  const at = lines.findIndex((l) => /^enforce:/.test(l));
  let next: string[];
  if (at === -1) {
    let end = lines.length;
    while (end > 0 && lines[end - 1].trim() === '') end -= 1;
    next = [...lines.slice(0, end), `enforce: ${level}`, ...lines.slice(end)];
  } else {
    const line = lines[at].replace(/^(enforce:[ \t]*)(?:"[^"]*"|'[^']*'|[^#\s]*)/, `$1${level}`);
    next = [...lines.slice(0, at), line, ...lines.slice(at + 1)];
  }
  try {
    const doc = parseYaml(next.join('\n')) as { enforce?: unknown } | null;
    if (!doc || doc.enforce !== level) return content;
  } catch {
    return content;
  }
  return `${m[1]}${next.join(eol)}${m[3]}${content.slice(m[0].length)}`;
}

/** The history line that records a move: `enforce raised: cart observe->warn`. */
export function policyLine(kind: 'raised' | 'lowered', capability: string, from: EnforceLevel, to: EnforceLevel): string {
  return `enforce ${kind}: ${capability} ${from}->${to}`;
}
