/**
 * Where the browser check may go when an agent starts it.
 *
 * `verify --url <u>` through the MCP server drives a real browser, then sends what it sees (page text, screenshots)
 * to a model. An agent that has read a hostile page could point it at an internal admin console or a production
 * system. So an agent-started run may target loopback and the hosts the project lists in `validate.allowedHosts`
 * (`staging.example.com`, `staging.example.com:8443`, `*.test.example.com`), and nothing else. A person on the command
 * line chose the URL themselves and is not restricted.
 *
 * Spec: specs/capabilities/agentic-verification.md
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Whether `url` may be targeted by an agent-started run, and why not when it may not. */
export function checkAgentTarget(url: string, allowedHosts: string[] = []): { ok: true } | { ok: false; reason: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: `${url} is not a URL` };
  }
  if (!['http:', 'https:'].includes(u.protocol)) return { ok: false, reason: `${u.protocol} URLs cannot be checked` };
  const host = u.hostname.toLowerCase();
  if (LOOPBACK.has(host) || host.endsWith('.localhost')) return { ok: true };
  const matches = (e: string): boolean => {
    if (e.startsWith('*.')) return host.endsWith(e.slice(1)); // `*.test.example.com` matches any subdomain, not the bare domain
    if (e.includes(':') && !e.startsWith('[')) return u.port !== '' && `${host}:${u.port}` === e;
    return host === e; // a bare host matches on any port
  };
  if (allowedHosts.some((entry) => entry.trim() && matches(entry.trim().toLowerCase()))) return { ok: true };
  return { ok: false, reason: `${u.host} is not loopback and is not in validate.allowedHosts; an agent may only check hosts the project allows` };
}
