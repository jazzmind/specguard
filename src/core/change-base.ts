/**
 * Base resolution for a change: which ref the change's base commit is computed from. This is the pure half. It decides
 * the order of candidate refs, refuses anything git could read as an option, and picks the first candidate that
 * resolves. The git calls (`symbolic-ref`, `merge-base`) live in the change pipeline and arrive as arguments.
 *
 * Order: `--base`, the record's `baseRef`, config `change.baseRef`, the branch `origin/HEAD` points at, `origin/main`,
 * `main`, `master`. In CI the base is the pull request's base sha, which the caller passes as the flag.
 *
 * Spec: specs/capabilities/spec-first-changes.md
 */

export type BaseSource = 'flag' | 'record' | 'config' | 'origin-head' | 'origin-main' | 'main' | 'master';

export interface BaseCandidate {
  ref: string;
  source: BaseSource;
}

export interface BaseInputs {
  /** `--base <ref>`. An explicit choice: when it is unusable the resolution fails instead of falling through. */
  flag?: string;
  /** `record.baseRef`. */
  recordBaseRef?: string;
  /** Config `change.baseRef`. */
  configBaseRef?: string;
  /** Output of `git symbolic-ref refs/remotes/origin/HEAD` (`refs/remotes/origin/main`), when git gave one. */
  originHead?: string;
}

/** The same shape `statement-input` accepts: a name git can resolve; a leading `-` (an option) never matches. */
const SAFE_REF = /^[\w][\w./@^~{}:+-]*$/;
const MAX_REF = 256;

export function isSafeBaseRef(ref: string): boolean {
  return ref.length <= MAX_REF && SAFE_REF.test(ref);
}

/** `refs/remotes/origin/main` -> `origin/main`; other values are kept. */
export function shortenRemoteRef(ref: string): string {
  return ref.trim().replace(/^refs\/remotes\//, '');
}

/** Candidates in order, without empty values or repeats (the first source of a ref wins). Unsafe refs are kept: they are refused, not hidden. */
export function baseCandidates(inputs: BaseInputs): BaseCandidate[] {
  const raw: Array<[string | undefined, BaseSource]> = [
    [inputs.flag, 'flag'],
    [inputs.recordBaseRef, 'record'],
    [inputs.configBaseRef, 'config'],
    [inputs.originHead === undefined ? undefined : shortenRemoteRef(inputs.originHead), 'origin-head'],
    ['origin/main', 'origin-main'],
    ['main', 'main'],
    ['master', 'master'],
  ];
  const seen = new Set<string>();
  const out: BaseCandidate[] = [];
  for (const [ref, source] of raw) {
    const trimmed = ref?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push({ ref: trimmed, source });
  }
  return out;
}

export interface BaseSkip {
  ref: string;
  source: BaseSource;
  reason: 'unsafe' | 'unresolved';
}

export type BaseResolution =
  | { ok: true; ref: string; source: BaseSource; sha: string; skipped: BaseSkip[] }
  | { ok: false; error: string; skipped: BaseSkip[] };

/**
 * First candidate that resolves. `resolve(ref)` gives the base commit for a ref (`merge-base(HEAD, ref)`) or undefined
 * when the ref does not exist; it is only called with refs that passed {@link isSafeBaseRef}.
 *
 * An explicit `--base` that is unsafe or does not resolve is an error. The record's and config's refs, and the defaults,
 * are skipped when unusable and listed in `skipped`, so the caller can say which base it ended up on and why.
 */
export function pickBase(inputs: BaseInputs, resolve: (ref: string) => string | undefined): BaseResolution {
  const skipped: BaseSkip[] = [];
  for (const c of baseCandidates(inputs)) {
    if (!isSafeBaseRef(c.ref)) {
      if (c.source === 'flag') return { ok: false, error: `base ref "${c.ref}" is not a usable ref name`, skipped };
      skipped.push({ ...c, reason: 'unsafe' });
      continue;
    }
    const sha = resolve(c.ref);
    if (sha) return { ok: true, ref: c.ref, source: c.source, sha, skipped };
    if (c.source === 'flag') return { ok: false, error: `base ref "${c.ref}" does not resolve to a commit`, skipped };
    skipped.push({ ...c, reason: 'unresolved' });
  }
  return { ok: false, error: 'no base ref resolves (tried the record, config, origin/HEAD, origin/main, main, master); pass --base <ref>', skipped };
}
