/**
 * Finding ids for a remediation commit and its pull request body.
 *
 * An id is `sg:<owner>/<repo>:<fingerprint>`. `<owner>/<repo>` comes from the
 * `origin` remote URL, lower-cased; `<fingerprint>` is the remediation-plan
 * item's fingerprint, and only a 6 to 64 character lower-case hex string is
 * kept. Anything else is dropped so it cannot forge a git trailer or close
 * the HTML comment. Rendering is pure: callers append the returned text, and
 * empty text leaves a message or body unchanged.
 *
 * Spec: specs/capabilities/security-and-remediation.md
 */

export const MAX_FINDING_IDS = 50;

const SLUG = /^[\w.-]+$/;
const FINGERPRINT = /^[0-9a-f]{6,64}$/;
const FINDING_ID = /^sg:([^/\s]+)\/([^/\s]+):([0-9a-f]{6,64})$/;

/** `owner/repo` is neither empty nor `.` or `..`, and matches the slug rule. */
function slugPair(owner: string, repo: string): string | undefined {
  if (!SLUG.test(owner) || !SLUG.test(repo)) return undefined;
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..') return undefined;
  return `${owner}/${repo}`;
}

function slugFromPath(pathPart: string): string | undefined {
  let text = pathPart.trim().toLowerCase();
  if (text.endsWith('/')) text = text.slice(0, -1);
  if (text.endsWith('.git')) text = text.slice(0, -'.git'.length);
  const parts = text.split('/');
  if (parts.length !== 2) return undefined;
  return slugPair(parts[0], parts[1]);
}

/**
 * `owner/repo` from `git@host:owner/repo(.git)`, `https://host/owner/repo(.git)`,
 * or `ssh://git@host[:port]/owner/repo(.git)`. Owner and repo are lower-cased.
 * `.` and `..` are rejected.
 */
export function repoSlugFromRemote(url: string): string | undefined {
  const text = url.trim();
  if (text.startsWith('git@')) {
    const colon = text.indexOf(':');
    const host = colon > 'git@'.length ? text.slice('git@'.length, colon) : '';
    if (!host || /[\s/]/.test(host)) return undefined;
    return slugFromPath(text.slice(colon + 1));
  }
  if (text.startsWith('https://') || text.startsWith('ssh://')) {
    const marker = text.startsWith('https://') ? 'https://' : 'ssh://';
    const rest = text.slice(marker.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) return undefined;
    const authority = rest.slice(0, slash);
    if (!authority || /\s/.test(authority)) return undefined;
    if (marker === 'ssh://') {
      const at = authority.lastIndexOf('@');
      const hostport = at >= 0 ? authority.slice(at + 1) : authority;
      if (!hostport) return undefined;
      const colon = hostport.lastIndexOf(':');
      const host = colon >= 0 ? hostport.slice(0, colon) : hostport;
      const port = colon >= 0 ? hostport.slice(colon + 1) : undefined;
      if (!host || (port !== undefined && !/^\d+$/.test(port))) return undefined;
    }
    return slugFromPath(rest.slice(slash + 1));
  }
  return undefined;
}

/** `sg:<owner>/<repo>:<fingerprint>`, or undefined when either part is not acceptable. */
export function findingId(repoSlug: string, fingerprint: string): string | undefined {
  const parts = repoSlug.trim().toLowerCase().split('/');
  if (parts.length !== 2) return undefined;
  const slug = slugPair(parts[0], parts[1]);
  const fp = fingerprint.trim();
  if (!slug || !FINGERPRINT.test(fp)) return undefined;
  return `sg:${slug}:${fp}`;
}

/** A well-formed id, with owner and repo lower-cased, or undefined. */
export function canonicalFindingId(id: string): string | undefined {
  const match = FINDING_ID.exec(id.trim());
  if (!match) return undefined;
  return findingId(`${match[1]}/${match[2]}`, match[3]);
}

/** De-duplicated, sorted, capped at {@link MAX_FINDING_IDS}. Malformed ids are dropped. */
export function normalizeFindingIds(ids: readonly string[]): { ids: string[]; dropped: boolean } {
  const seen = new Set<string>();
  const out: string[] = [];
  let dropped = false;
  for (const raw of ids) {
    const id = canonicalFindingId(raw);
    if (!id) {
      if (raw.trim()) dropped = true;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  out.sort();
  return { ids: out.slice(0, MAX_FINDING_IDS), dropped };
}

export interface FindingLinkItem {
  /** The id remediate uses for this plan item: an advisory id, or `semgrep:<rule>@<path>`. */
  key: string;
  fingerprint: string;
}

export interface FindingLinkResult {
  /** Ids for each plan item that had a well-formed fingerprint, keyed by {@link FindingLinkItem.key}. */
  byItem?: Record<string, string[]>;
  /** Set when `origin` could not be read or parsed. The fix still ships. */
  reason?: string;
  /** A fingerprint or id was not well-formed and was left out. The value is not included. */
  dropped?: boolean;
}

/**
 * One id per plan item, keyed so the remediate loop can name only that item.
 * No items means nothing to write. A missing or unparseable URL is a reason and no ids.
 */
export function findingIdsByKey(remoteUrl: string | undefined, items: readonly FindingLinkItem[]): FindingLinkResult {
  const present = items.filter((item) => item.key.trim() && item.fingerprint.trim());
  if (present.length === 0) return {};
  let dropped = false;
  const valid = present.filter((item) => {
    if (FINGERPRINT.test(item.fingerprint.trim())) return true;
    dropped = true;
    return false;
  });
  const droppedFlag = dropped ? { dropped: true as const } : {};
  if (remoteUrl === undefined || remoteUrl.trim() === '') {
    return { reason: 'finding links omitted: the origin remote could not be read', ...droppedFlag };
  }
  const slug = repoSlugFromRemote(remoteUrl);
  if (!slug) return { reason: 'finding links omitted: the origin remote URL could not be parsed', ...droppedFlag };
  const byItem: Record<string, string[]> = {};
  for (const item of valid) {
    const id = findingId(slug, item.fingerprint);
    if (!id) {
      dropped = true;
      continue;
    }
    const normalized = normalizeFindingIds([...(byItem[item.key] ?? []), id]);
    if (normalized.dropped) dropped = true;
    if (normalized.ids.length > 0) byItem[item.key] = normalized.ids;
  }
  return {
    ...(Object.keys(byItem).length > 0 ? { byItem } : {}),
    ...(dropped ? { dropped: true } : {}),
  };
}

/**
 * Fingerprints plus a remote URL. Kept for callers that have fingerprints and no plan-item keys.
 * A missing or unparseable URL is a reason and no ids.
 */
export function findingIdsFromRemote(remoteUrl: string | undefined, fingerprints: readonly string[]): { ids?: string[]; reason?: string; dropped?: boolean } {
  const linked = findingIdsByKey(
    remoteUrl,
    fingerprints.map((fingerprint, index) => ({ key: String(index), fingerprint })),
  );
  const ids = linked.byItem ? normalizeFindingIds(Object.values(linked.byItem).flat()).ids : undefined;
  return {
    ...(ids && ids.length > 0 ? { ids } : {}),
    ...(linked.reason ? { reason: linked.reason } : {}),
    ...(linked.dropped ? { dropped: true } : {}),
  };
}

/**
 * Ids for one remediate item: only the map entries whose key is one of its advisory ids.
 * An item the plan did not name gets nothing.
 */
export function findingIdsForAdvisories(
  map: Readonly<Record<string, readonly string[]>> | undefined,
  advisoryIds: readonly string[],
): { ids: string[]; dropped: boolean } {
  if (!map) return { ids: [], dropped: false };
  const raw: string[] = [];
  for (const id of advisoryIds) {
    const hit = map[id];
    if (hit) raw.push(...hit);
  }
  if (raw.length === 0) return { ids: [], dropped: false };
  return normalizeFindingIds(raw);
}

/** Blank line, then one `Resolves-Finding` trailer per id. Empty when there are no ids. */
export function renderFindingTrailers(ids: readonly string[] | undefined): string {
  const list = normalizeFindingIds(ids ?? []).ids;
  if (list.length === 0) return '';
  return `\n\n${list.map((id) => `Resolves-Finding: ${id}`).join('\n')}\n`;
}

/** The `finding-links` block. Empty when there are no ids. */
export function renderFindingLinksBlock(ids: readonly string[] | undefined): string {
  const list = normalizeFindingIds(ids ?? []).ids;
  if (list.length === 0) return '';
  return `<!-- finding-links\n${JSON.stringify(list)}\n-->\n`;
}
