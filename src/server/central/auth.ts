/**
 * Who is calling the team server, and the token routes.
 *
 * Browsers arrive through the sandbox's sign-in, which names the user in a header. That header is only as trustworthy
 * as the path it arrived by: another container on the same network could send it directly and name anyone. So:
 *  - it is never enough for anything administrative;
 *  - without `trustedProxies` it signs in a viewer at most (read, and minting viewer tokens), whoever it names;
 *  - with `trustedProxies` it is honoured only from those addresses, and only then can naming a maintainer's email
 *    make a signed-in browser a maintainer (change plans and workspaces with `X-Requested-With`, mint tokens up to
 *    that role).
 * Everything else that changes state, and everything administrative, goes through a token: a user's own, a project's
 * CI token, or the bootstrap token the operator sets.
 *
 * Spec: specs/capabilities/team-server.md
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import type { ApiResponse, Identity } from '../api.js';
import type { Backend, TokenRecord, TokenRole } from './backend.js';
import { PROJECT_NAME } from './backend.js';

export interface AuthConfig {
  backend: Backend;
  /** People who may maintain every project when they sign in through the browser from a trusted proxy. They are never admins that way. */
  maintainerEmails?: string[];
  /** Listed for the record and for the UI; an admin acts only through an admin token. */
  adminEmails?: string[];
  /** A secret the operator sets; presenting it is an admin. Absent: there is no bootstrap admin. */
  bootstrapToken?: string;
  /** Header that carries the signed-in user. Default `x-deploykit-email`. */
  emailHeader?: string;
  /** Accept the header only for this domain (for example `acme.test`). */
  allowedDomain?: string;
  /** Addresses (IPv4 or IPv6, or IPv4 CIDR ranges) the sign-in header is accepted from. Absent: from anywhere. */
  trustedProxies?: string[];
}

/** An IPv4 address as a number, or undefined. */
function ipv4(addr: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (!m || [m[1], m[2], m[3], m[4]].some((p) => Number(p) > 255)) return undefined;
  return ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
}

const unmap = (addr: string): string => addr.trim().toLowerCase().replace(/^::ffff:/, '');

/** Whether the connection's peer address is one of `trusted` (exact addresses or IPv4 CIDR ranges). */
export function peerIsTrusted(peer: string | undefined, trusted: string[]): boolean {
  if (!peer) return false;
  const p = unmap(peer);
  const pn = ipv4(p);
  for (const entry of trusted) {
    const [base, bitsText] = unmap(entry).split('/');
    if (bitsText === undefined) {
      if (base === p) return true;
      continue;
    }
    const bits = Number(bitsText);
    const bn = ipv4(base);
    if (pn === undefined || bn === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    if ((pn & mask) >>> 0 === (bn & mask) >>> 0) return true;
  }
  return false;
}

export type Via = 'token' | 'bootstrap' | 'header';

export interface AuthResult {
  identity?: Identity;
  via?: Via;
  /** A bearer credential was sent and is not valid. */
  rejected?: boolean;
}

export const TOKEN_PREFIX = 'sg_';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export const newToken = (): string => `${TOKEN_PREFIX}${randomBytes(24).toString('base64url')}`;

const ROLE_RANK: Record<TokenRole, number> = { viewer: 1, maintainer: 2, admin: 3 };

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function authenticate(headers: Record<string, string | undefined>, cfg: AuthConfig, peer?: string): Promise<AuthResult> {
  const authorization = headers.authorization;
  if (authorization) {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (!match) return { rejected: true };
    const presented = match[1];
    if (cfg.bootstrapToken && safeEqual(presented, cfg.bootstrapToken)) return { identity: { user: 'bootstrap', role: 'admin' }, via: 'bootstrap' };
    if (!presented.startsWith(TOKEN_PREFIX)) return { rejected: true };
    const record = await cfg.backend.tokens.findByHash(hashToken(presented));
    if (!record || record.revokedAt) return { rejected: true };
    void cfg.backend.tokens.touch(record.id).catch(() => undefined);
    return { identity: { user: record.owner, role: record.role, ...(record.project ? { project: record.project } : {}) }, via: 'token' };
  }
  // The header names a user only when it came through the proxy that sets it.
  if (cfg.trustedProxies && cfg.trustedProxies.length > 0 && !peerIsTrusted(peer, cfg.trustedProxies)) return {};
  const email = headers[cfg.emailHeader ?? 'x-deploykit-email']?.trim().toLowerCase();
  if (!email || !email.includes('@')) return {};
  if (cfg.allowedDomain && !email.endsWith(`@${cfg.allowedDomain.toLowerCase()}`)) return {};
  const maintainers = [...(cfg.maintainerEmails ?? []), ...(cfg.adminEmails ?? [])].map((e) => e.toLowerCase());
  // Naming a maintainer makes you one only when the request provably came through the sign-in proxy. Without
  // `trustedProxies` the header could have been written by anyone who can reach this server, so it is read-only.
  const throughProxy = Boolean(cfg.trustedProxies?.length) && peerIsTrusted(peer, cfg.trustedProxies ?? []);
  return { identity: { user: email, role: maintainers.includes(email) && throughProxy ? 'maintainer' : 'viewer' }, via: 'header' };
}

const json = (status: number, value: unknown): ApiResponse => ({ status, type: 'application/json; charset=utf-8', body: JSON.stringify(value) });

const publicRecord = (t: TokenRecord) => ({ id: t.id, name: t.name, role: t.role, project: t.project ?? null, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt ?? null, revokedAt: t.revokedAt ?? null });

interface MintBody {
  name?: unknown;
  role?: unknown;
  project?: unknown;
  owner?: unknown;
}

function parseMint(body: string | undefined): { ok: true; name: string; role?: TokenRole; project?: string; owner?: string } | { ok: false; error: string } {
  let parsed: MintBody;
  try {
    parsed = JSON.parse(body ?? '') as MintBody;
  } catch {
    return { ok: false, error: 'the body must be JSON: { "name": "...", "role"?: "viewer|maintainer|admin", "project"?: "..." }' };
  }
  if (typeof parsed.name !== 'string' || parsed.name.trim().length < 1 || parsed.name.length > 64) return { ok: false, error: '`name` is required, up to 64 characters' };
  if (parsed.role !== undefined && !['viewer', 'maintainer', 'admin'].includes(String(parsed.role))) return { ok: false, error: '`role` must be viewer, maintainer or admin' };
  if (parsed.project !== undefined && (typeof parsed.project !== 'string' || !PROJECT_NAME.test(parsed.project))) return { ok: false, error: '`project` must be a project name' };
  if (parsed.owner !== undefined && (typeof parsed.owner !== 'string' || parsed.owner.length < 1 || parsed.owner.length > 128)) return { ok: false, error: '`owner` must be text' };
  return { ok: true, name: parsed.name.trim(), role: parsed.role as TokenRole | undefined, project: parsed.project as string | undefined, owner: parsed.owner as string | undefined };
}

/**
 * The token routes: `/tokens` for a signed-in user's own, `/admin/tokens` for an admin minting or revoking anyone's.
 * Returns null when the path is not a token route.
 */
export async function tokenRoute(
  method: string,
  parts: string[],
  body: string | undefined,
  auth: AuthResult,
  backend: Backend,
): Promise<ApiResponse | null> {
  const admin = parts[0] === 'admin' && parts[1] === 'tokens';
  const own = parts[0] === 'tokens';
  if (!admin && !own) return null;
  const rest = parts.slice(admin ? 2 : 1);
  const identity = auth.identity;
  if (!identity) return json(401, { error: 'sign in, or send a token' });
  if (admin && (identity.role !== 'admin' || auth.via === 'header')) return json(403, { error: 'administering tokens needs an admin token' });
  const audit = (action: string, detail: string, project?: string): Promise<void> => backend.audit({ at: new Date().toISOString(), actor: identity.user, action, ...(project ? { project } : {}), detail }).catch(() => undefined);

  if (method === 'GET' && rest.length === 0) {
    if (admin) return json(405, { error: 'list a user\'s tokens by signing in as them' });
    return json(200, { tokens: (await backend.tokens.list(identity.user)).map(publicRecord) });
  }

  if (method === 'POST' && rest.length === 0) {
    const mint = parseMint(body);
    if (!mint.ok) return json(400, { error: mint.error });
    const role: TokenRole = mint.role ?? (ROLE_RANK[identity.role] >= ROLE_RANK.maintainer ? 'maintainer' : 'viewer');
    // Nobody mints more power than they hold, and an admin token is minted only through the admin route.
    if (ROLE_RANK[role] > ROLE_RANK[identity.role] || (role === 'admin' && !admin)) return json(403, { error: `you cannot create a ${role} token` });
    if (identity.project && mint.project !== identity.project) return json(403, { error: `a credential limited to "${identity.project}" can only create tokens for it` });
    const owner = admin ? (mint.owner ?? identity.user) : identity.user;
    const token = newToken();
    const record: TokenRecord = { id: randomUUID(), owner, name: mint.name, role, ...(mint.project ? { project: mint.project } : {}), hash: hashToken(token), createdAt: new Date().toISOString() };
    await backend.tokens.create(record);
    await audit('token.create', `${record.id} ${role} for ${owner}${mint.project ? ` on ${mint.project}` : ''}`, mint.project);
    // The only time the token itself is shown.
    return json(201, { ...publicRecord(record), token });
  }

  if (method === 'DELETE' && rest.length === 1) {
    const revoked = await backend.tokens.revoke(rest[0], admin ? undefined : identity.user);
    if (!revoked) return json(404, { error: 'no such token' });
    await audit('token.revoke', rest[0]);
    return json(200, { revoked: rest[0] });
  }
  return json(405, { error: `no token route ${method} /${parts.join('/')}` });
}
