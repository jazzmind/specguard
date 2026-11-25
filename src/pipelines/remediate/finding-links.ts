/**
 * Finding ids for a remediation commit and its pull request body.
 *
 * An id is `sg:<owner>/<repo>:<fingerprint>`. `<owner>/<repo>` comes from the
 * `origin` remote URL; `<fingerprint>` is the remediation-plan item's fingerprint.
 * Rendering is pure: callers append the returned text, and empty text leaves
 * a message or body unchanged.
 *
 * Spec: specs/capabilities/security-and-remediation.md
 */

export const MAX_FINDING_IDS = 50;

const SLUG = /^[\w.-]+$/;

/** `owner/repo` from `git@host:owner/repo(.git)` or `https://host/owner/repo(.git)`. */
export function repoSlugFromRemote(url: string): string | undefined {
  const text = url.trim();
  let pathPart: string | undefined;
  if (text.startsWith('git@')) {
    const colon = text.indexOf(':');
    const host = colon > 'git@'.length ? text.slice('git@'.length, colon) : '';
    if (!host || /[\s/]/.test(host)) return undefined;
    pathPart = text.slice(colon + 1);
  } else if (text.startsWith('https://')) {
    const rest = text.slice('https://'.length);
    const slash = rest.indexOf('/');
    const host = slash > 0 ? rest.slice(0, slash) : '';
    if (!host || /\s/.test(host)) return undefined;
    pathPart = rest.slice(slash + 1);
  } else {
    return undefined;
  }
  if (pathPart.endsWith('/')) pathPart = pathPart.slice(0, -1);
  if (pathPart.endsWith('.git')) pathPart = pathPart.slice(0, -'.git'.length);
  const parts = pathPart.split('/');
  if (parts.length !== 2) return undefined;
  const [owner, repo] = parts;
  if (!SLUG.test(owner) || !SLUG.test(repo)) return undefined;
  return `${owner}/${repo}`;
}

/** `sg:<owner>/<repo>:<fingerprint>`. */
export function findingId(repoSlug: string, fingerprint: string): string {
  return `sg:${repoSlug}:${fingerprint}`;
}

/** De-duplicated, sorted, capped at {@link MAX_FINDING_IDS}. */
export function normalizeFindingIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort();
  return out.slice(0, MAX_FINDING_IDS);
}

/**
 * Fingerprints plus a remote URL. No fingerprints means nothing to write.
 * A missing or unparseable URL is a reason and no ids, so the fix can continue.
 */
export function findingIdsFromRemote(remoteUrl: string | undefined, fingerprints: readonly string[]): { ids?: string[]; reason?: string } {
  const wanted = fingerprints.map((fp) => fp.trim()).filter((fp) => fp.length > 0);
  if (wanted.length === 0) return {};
  if (remoteUrl === undefined || remoteUrl.trim() === '') {
    return { reason: 'finding links omitted: the origin remote could not be read' };
  }
  const slug = repoSlugFromRemote(remoteUrl);
  if (!slug) return { reason: 'finding links omitted: the origin remote URL could not be parsed' };
  const ids = normalizeFindingIds(wanted.map((fp) => findingId(slug, fp)));
  return ids.length > 0 ? { ids } : {};
}

/** Blank line, then one `Resolves-Finding` trailer per id. Empty when there are no ids. */
export function renderFindingTrailers(ids: readonly string[] | undefined): string {
  const list = normalizeFindingIds(ids ?? []);
  if (list.length === 0) return '';
  return `\n\n${list.map((id) => `Resolves-Finding: ${id}`).join('\n')}\n`;
}

/** The `finding-links` block. Empty when there are no ids. */
export function renderFindingLinksBlock(ids: readonly string[] | undefined): string {
  const list = normalizeFindingIds(ids ?? []);
  if (list.length === 0) return '';
  return `<!-- finding-links\n${JSON.stringify(list)}\n-->\n`;
}
