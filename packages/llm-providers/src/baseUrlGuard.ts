/**
 * SSRF guard for the BYOK provider `baseUrl`. The base URL is owner-supplied
 * today, but it sits one hop from the prompt-injection surface: the model
 * drives tool calls, and a future path that lets a tool influence the base
 * URL would turn the daemon into a confused deputy able to reach the box's
 * own internal services (the daemon control API, the app Postgres on
 * loopback, the cloud metadata endpoint). This validator is the
 * defense-in-depth layer that blocks a base URL from pointing at anything
 * internal.
 *
 * `assertSafeProviderBaseUrl` is the SYNC fast pre-check: pure string /
 * literal-IP parsing. It cannot, on its own, stop a hostname with a public
 * spelling that *resolves* to an internal address (e.g. localtest.me →
 * 127.0.0.1, *.nip.io). `assertSafeResolvedUrl` closes that gap: it runs
 * the sync guard first, then resolves the host and classifies EVERY
 * resolved address through the same IP classifier. The fetch layer
 * (`guardedFetch` / `guardedStreamingFetch`) calls the resolving guard at
 * connect time and re-validates every redirect `Location`, so a public
 * URL can't `302 → http://169.254.169.254/` or a DNS name can't smuggle
 * an internal A record past the check.
 *
 * RESIDUAL RISK: a narrow time-of-check / time-of-use DNS-rebinding window
 * survives between resolve-and-classify and the actual socket connect (the
 * `FetchLike` abstraction carries only method/headers/body — it exposes no
 * dispatcher/connect hook to pin the resolved IP through to connect). The
 * window is bounded by the resolver TTL and the gap is far narrower than a
 * pure string guard; fully closing it would require an `undici` connect-
 * time check, a dependency this deliberately dependency-free package does
 * not take. Blocking literal internal IPs, resolving + classifying every
 * address, and re-validating redirects is the pragmatic layer.
 */

import { classifyAddress, type AddressClass } from "@flagship/protocol";

export interface BaseUrlGuardOptions {
  /**
   * Allow `http://` (not just https). Off by default — only flip on for an
   * explicitly-configured dev/LAN deployment (e.g. a self-hoster running
   * Ollama over plain HTTP on the LAN).
   */
  allowHttp?: boolean;
  /**
   * Permit private / RFC1918 / unique-local / loopback / link-local ranges.
   * Off by default (public-build posture). Self-hosters who run a model
   * server on their LAN flip this on. Even when on, the cloud metadata IP
   * (169.254.169.254) stays blocked.
   */
  allowPrivate?: boolean;
  /**
   * Exact host allowlist (case-insensitive hostname match). When a host is
   * on this list it bypasses the private-range block (but still must satisfy
   * the scheme rule). Lets an operator permit one specific internal host
   * without opening the whole private range.
   *
   * NOTE: this is a PERMIT list (bypass private ranges), NOT a restriction —
   * a host not on it that is otherwise public still passes. To PIN traffic
   * to exactly one host (rejecting every other host, incl. a redirect to
   * another public host), use `exclusiveHost`.
   */
  hostAllowlist?: string[];
  /**
   * Hard pin: when set, the URL's host MUST equal this (case-insensitive)
   * or it is rejected — every other host, public or private, is denied.
   * Because `guardedFetch` re-runs the guard on each redirect hop, this
   * also blocks a `302 → attacker.example.com`. Used for promo (free-
   * credits) credentials so a leaked scoped token can only ever be
   * presented to the blessed inference host.
   */
  exclusiveHost?: string;
}

export class UnsafeBaseUrlError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: string,
  ) {
    super(`unsafe baseUrl rejected (${reason}): ${url}`);
    this.name = "UnsafeBaseUrlError";
  }
}

/** The cloud-provider metadata IP — blocked even when private ranges are allowed. */
const METADATA_IPV4 = "169.254.169.254";

/**
 * Validate a provider base URL, throwing `UnsafeBaseUrlError` if it could
 * reach an internal service. Returns the parsed URL on success.
 */
export function assertSafeProviderBaseUrl(
  raw: string,
  opts: BaseUrlGuardOptions = {},
): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeBaseUrlError(raw, "unparseable");
  }

  if (url.protocol !== "https:" && !(opts.allowHttp && url.protocol === "http:")) {
    throw new UnsafeBaseUrlError(raw, `scheme ${url.protocol} not allowed`);
  }

  const host = url.hostname.toLowerCase();

  // Hard pin: reject any host other than the exclusive one, BEFORE any
  // allowlist/scheme reasoning. Enforced on every redirect hop by
  // guardedFetch, so a promo credential's scoped token can't be steered
  // to another host.
  if (opts.exclusiveHost !== undefined && host !== opts.exclusiveHost.toLowerCase()) {
    throw new UnsafeBaseUrlError(raw, "host not pinned");
  }

  const allowlist = (opts.hostAllowlist ?? []).map((h) => h.toLowerCase());
  const allowlisted = allowlist.includes(host);

  // `localhost` (and any *.localhost) always resolves to loopback.
  if (!allowlisted && (host === "localhost" || host.endsWith(".localhost"))) {
    throw new UnsafeBaseUrlError(raw, "loopback host");
  }

  const ip = parseIpLiteral(host);

  // The metadata IP is special: blocked unconditionally (even on the
  // allowlist would be surprising, but private-range permission must NOT
  // re-open it).
  if (ip && (ipEquals(ip, METADATA_IPV4) || classifyIp(ip) === "metadata")) {
    throw new UnsafeBaseUrlError(raw, "cloud metadata IP");
  }

  if (allowlisted) return url;

  if (ip) assertIpAllowed(raw, ip, opts);

  return url;
}

/**
 * Reject a resolved IP that lands in an internal range. The metadata IP
 * is checked by the caller (it must be blocked even on the allowlist);
 * here we enforce loopback / link-local / private per the override flags.
 */
function assertIpAllowed(raw: string, ip: ParsedIp, opts: BaseUrlGuardOptions): void {
  const cls = classifyIp(ip);
  if (cls === "metadata") throw new UnsafeBaseUrlError(raw, "cloud metadata IP");
  if (cls === "loopback") throw new UnsafeBaseUrlError(raw, "loopback IP");
  if (cls === "link-local") throw new UnsafeBaseUrlError(raw, "link-local IP");
  if ((cls === "multicast" || cls === "reserved" || cls === "invalid") ) {
    throw new UnsafeBaseUrlError(raw, "non-public IP");
  }
  if (cls === "private" && !opts.allowPrivate) {
    throw new UnsafeBaseUrlError(raw, "private IP");
  }
}

/**
 * A name resolver injected for testability. Returns the IP-literal
 * strings a hostname resolves to (mixed v4/v6). Production wires Node's
 * `dns.promises.lookup({ all: true })`; tests pass a stub so no real
 * network is touched.
 */
export type HostResolver = (host: string) => Promise<string[]>;

/**
 * The resolving SSRF guard. Runs the sync string/literal guard first
 * (preserving every scheme / allowlist / private-range rule), then — for
 * a hostname that is NOT an allowlisted host and NOT already an IP literal
 * — resolves it and classifies EVERY resolved address. Rejects if any
 * resolved address is internal (loopback / link-local / metadata /
 * private), closing the "public name → internal A record" bypass.
 *
 * Allowlisted hosts skip resolution (the operator vouched for the name —
 * the same semantics as the sync guard). Literal-IP hosts were already
 * fully classified by the sync guard, so they skip resolution too.
 *
 * The metadata IP is rejected for ANY resolved address regardless of
 * `allowPrivate`, matching the sync guard's unconditional block.
 */
export async function assertSafeResolvedUrl(
  raw: string,
  opts: BaseUrlGuardOptions = {},
  resolve?: HostResolver,
): Promise<URL> {
  const url = assertSafeProviderBaseUrl(raw, opts);

  const host = url.hostname.toLowerCase();
  const allowlist = (opts.hostAllowlist ?? []).map((h) => h.toLowerCase());
  if (allowlist.includes(host)) return url;

  // Already a literal IP — the sync guard classified it exactly; resolving
  // would only re-derive the same address.
  if (parseIpLiteral(host)) return url;

  const resolver = resolve ?? defaultHostResolver;
  let addrs: string[];
  try {
    addrs = await resolver(host);
  } catch {
    throw new UnsafeBaseUrlError(raw, "DNS resolution failed");
  }
  if (addrs.length === 0) throw new UnsafeBaseUrlError(raw, "host did not resolve");

  for (const addr of addrs) {
    const ip = parseIpLiteral(addr);
    if (!ip) {
      // A resolver that hands back a non-IP string is unexpected; fail closed.
      throw new UnsafeBaseUrlError(raw, "unparseable resolved address");
    }
    if (ipEquals(ip, METADATA_IPV4)) {
      throw new UnsafeBaseUrlError(raw, "resolves to cloud metadata IP");
    }
    assertIpAllowed(raw, ip, opts);
  }

  return url;
}

/**
 * Production host resolver over Node's DNS. Lives behind a dynamic import
 * so this package stays runnable in a non-Node runtime (the resolving
 * guard is only ever reached on the daemon, which is Node).
 */
const defaultHostResolver: HostResolver = async (host) => {
  const dns = await import("node:dns");
  const records = await dns.promises.lookup(host, { all: true });
  return records.map((r) => r.address);
};

/**
 * Resolve + classify a bare HOST (no scheme/URL) against the internal-range
 * policy. The git-clone SSRF guard reuses this so a clone URL can't point
 * at the box's loopback data plane (Postgres/Forgejo) or the cloud
 * metadata endpoint via either a literal internal IP or a name with an
 * internal A record. Mirrors `assertSafeResolvedUrl`'s classification (incl.
 * the unconditional metadata block + the allowlist / allowPrivate
 * overrides) but takes a host string and a free-form `subject` for the
 * error message rather than a parsed URL. Returns the (lowercased) host on
 * success.
 */
export async function assertResolvedHostSafe(
  host: string,
  subject: string,
  opts: BaseUrlGuardOptions = {},
  resolve?: HostResolver,
): Promise<string> {
  return (await resolveSafeHost(host, subject, opts, resolve)).host;
}

/**
 * Like `assertResolvedHostSafe`, but also returns the addresses that passed so
 * the caller can connect to exactly those (resolve, classify, then dial the
 * numeric address) instead of resolving the name a second time. `addresses` is
 * empty for an IP literal or an allowlisted host, which need no pinning.
 */
export async function resolveSafeHost(
  host: string,
  subject: string,
  opts: BaseUrlGuardOptions = {},
  resolve?: HostResolver,
): Promise<{ host: string; addresses: string[] }> {
  const h = host.toLowerCase();
  if (h.length === 0) throw new UnsafeBaseUrlError(subject, "empty host");

  const allowlist = (opts.hostAllowlist ?? []).map((x) => x.toLowerCase());
  const allowlisted = allowlist.includes(h);

  if (!allowlisted && (h === "localhost" || h.endsWith(".localhost"))) {
    throw new UnsafeBaseUrlError(subject, "loopback host");
  }

  const literal = parseIpLiteral(h);
  if (literal) {
    if (ipEquals(literal, METADATA_IPV4) || classifyIp(literal) === "metadata") {
      throw new UnsafeBaseUrlError(subject, "cloud metadata IP");
    }
    if (!allowlisted) assertIpAllowed(subject, literal, opts);
    return { host: h, addresses: [] };
  }

  if (allowlisted) return { host: h, addresses: [] };

  const resolver = resolve ?? defaultHostResolver;
  let addrs: string[];
  try {
    addrs = await resolver(h);
  } catch {
    throw new UnsafeBaseUrlError(subject, "DNS resolution failed");
  }
  if (addrs.length === 0) throw new UnsafeBaseUrlError(subject, "host did not resolve");

  for (const addr of addrs) {
    const ip = parseIpLiteral(addr);
    if (!ip) throw new UnsafeBaseUrlError(subject, "unparseable resolved address");
    if (ipEquals(ip, METADATA_IPV4) || classifyIp(ip) === "metadata") {
      throw new UnsafeBaseUrlError(subject, "resolves to cloud metadata IP");
    }
    assertIpAllowed(subject, ip, opts);
  }
  return { host: h, addresses: addrs };
}

/**
 * True when `addr` is an IP literal in a loopback / link-local / private /
 * CGNAT / unique-local range: a LAN or on-box address, not the internet.
 * A non-IP string is false.
 */
export function isInternalIpLiteral(addr: string): boolean {
  const ip = parseIpLiteral(addr.toLowerCase());
  return ip !== null && classifyIp(ip) !== "public";
}

function classifyIp(ip: ParsedIp): AddressClass {
  return classifyAddress(ip.version === 4 ? ip.v4!.join(".") : ip.v6!);
}

interface ParsedIp {
  version: 4 | 6;
  /** For v4: the four octets. For v6: the normalized lowercase form. */
  v4?: [number, number, number, number];
  v6?: string;
}

function ipEquals(ip: ParsedIp, dottedV4: string): boolean {
  if (ip.version !== 4 || !ip.v4) return false;
  const want = dottedV4.split(".").map((n) => Number(n));
  return ip.v4.every((o, i) => o === want[i]);
}

function parseIpLiteral(host: string): ParsedIp | null {
  // URL hostname brackets are already stripped for IPv6 by the URL parser,
  // but a raw `[::1]` may still arrive; normalize.
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  const v4 = parseV4(h);
  if (v4) return { version: 4, v4 };

  if (h.includes(":")) return { version: 6, v6: h };

  return null;
}

function parseV4(h: string): [number, number, number, number] | null {
  const parts = h.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}
