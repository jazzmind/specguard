/**
 * Fetching a document from a URL without letting the URL reach into the network the machine is on.
 *
 * `import <url>` is also reachable from the MCP server, so an agent that was handed a hostile page can be told to
 * fetch `http://169.254.169.254/` or an internal admin URL and have the answer written into a spec. The defence is
 * the usual one: resolve the host ourselves, refuse every address that is not a public one, connect to the address
 * that was checked (so a name that resolves differently the second time gains nothing), check every redirect the same
 * way, and cap the redirects and the size of the answer. A person importing an intranet document opts in with
 * `--allow-private`.
 *
 * Spec: specs/capabilities/spec-authoring.md
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

export interface SafeFetchOptions {
  /** Allow loopback, private and link-local addresses (an intranet document). Default false. */
  allowPrivate?: boolean;
  /** Redirects followed. Default 5. */
  maxRedirects?: number;
  /** Largest answer accepted, in bytes. Default 5 MB. */
  maxBytes?: number;
  timeoutMs?: number;
  /** Replaces `dns.lookup`, for tests. */
  resolve?: (host: string) => Promise<string[]>;
}

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Whether `address` is anything other than a public unicast address, for IPv4 and IPv6. */
export function isNonPublicAddress(address: string): boolean {
  let a = address.trim().toLowerCase();
  if (a.startsWith('[') && a.endsWith(']')) a = a.slice(1, -1);
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) a = mapped[1];
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (hexMapped) {
    const hi = parseInt(hexMapped[1], 16);
    const lo = parseInt(hexMapped[2], 16);
    a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  const m = V4.exec(a);
  if (m) {
    const [o1, o2, o3] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if ([o1, o2, o3, Number(m[4])].some((n) => n > 255)) return true;
    return (
      o1 === 0 || // "this network"
      o1 === 10 ||
      o1 === 127 ||
      (o1 === 100 && o2 >= 64 && o2 <= 127) || // carrier-grade NAT
      (o1 === 169 && o2 === 254) || // link-local, including the cloud metadata address
      (o1 === 172 && o2 >= 16 && o2 <= 31) ||
      (o1 === 192 && o2 === 0 && (o3 === 0 || o3 === 2)) ||
      (o1 === 192 && o2 === 168) ||
      (o1 === 198 && (o2 === 18 || o2 === 19)) ||
      (o1 === 198 && o2 === 51 && o3 === 100) ||
      (o1 === 203 && o2 === 0 && o3 === 113) ||
      o1 >= 224 // multicast, reserved, broadcast
    );
  }
  if (net.isIPv6(a)) {
    return (
      a === '::' ||
      a === '::1' ||
      /^f[cd]/.test(a) || // unique local
      /^fe[89ab]/.test(a) || // link-local
      /^ff/.test(a) || // multicast
      a.startsWith('64:ff9b:') || // NAT64 can reach IPv4 private space
      a.startsWith('2001:db8') ||
      a.startsWith('2002:') // 6to4 embeds an IPv4 address
    );
  }
  return true; // not an address we can reason about
}

const defaultResolve = (host: string): Promise<string[]> =>
  new Promise((resolve, reject) => dns.lookup(host, { all: true, verbatim: true }, (err, list) => (err ? reject(err) : resolve(list.map((l) => l.address)))));

/** The addresses to connect to for `host`, or an error naming why none may be used. */
export async function publicAddressesFor(host: string, opts: SafeFetchOptions = {}): Promise<string[]> {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const addresses = net.isIP(bare) ? [bare] : await (opts.resolve ?? defaultResolve)(bare);
  if (addresses.length === 0) throw new UnsafeUrlError(`${host} did not resolve to an address`);
  if (!opts.allowPrivate) {
    const bad = addresses.filter(isNonPublicAddress);
    if (bad.length > 0) throw new UnsafeUrlError(`${host} resolves to ${bad[0]}, which is not a public address (pass --allow-private to import from your own network)`);
  }
  return addresses;
}

/** Fetch `url` as text. Rejects with `UnsafeUrlError` for a URL the rules above refuse. */
export async function safeFetchText(url: string, opts: SafeFetchOptions = {}): Promise<string> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const parsed = new URL(current);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new UnsafeUrlError(`Unsupported protocol: ${parsed.protocol}`);
    if (parsed.username || parsed.password) throw new UnsafeUrlError('a URL with a user name or password is not fetched');
    if (hop > 0 && parsed.protocol === 'http:' && new URL(url).protocol === 'https:') throw new UnsafeUrlError('refusing a redirect from https to http');
    const addresses = await publicAddressesFor(parsed.hostname, opts);
    const result = await getOnce(parsed, addresses[0], opts.timeoutMs ?? 15_000, maxBytes);
    if (result.redirect === undefined) return result.body;
    current = new URL(result.redirect, parsed).toString();
  }
  throw new UnsafeUrlError(`more than ${maxRedirects} redirects`);
}

function getOnce(url: URL, address: string, timeoutMs: number, maxBytes: number): Promise<{ body: string; redirect?: string }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    // Connect to the address that was checked. The name is still sent as the Host header and the TLS server name.
    const req = lib.get(
      {
        protocol: url.protocol,
        hostname: address,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers: { Host: url.host, 'User-Agent': 'SpecGuard/1.0' },
        ...(url.protocol === 'https:' ? { servername: net.isIP(url.hostname) ? undefined : url.hostname } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume();
          resolve({ body: '', redirect: res.headers.location });
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`HTTP ${status}: ${url.toString()}`));
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          reject(new UnsafeUrlError(`the answer is larger than ${maxBytes} bytes`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            res.destroy();
            reject(new UnsafeUrlError(`the answer is larger than ${maxBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf-8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url.toString()}`));
    });
  });
}
