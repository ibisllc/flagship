/**
 * SSRF guard for the BYOK provider `baseUrl`. The base URL is owner-supplied
 * today, but it sits one hop from the prompt-injection surface: the model
 * drives tool calls, and a future path that lets a tool influence the base
 * URL would turn the daemon into a confused deputy able to reach the box's
 * own internal services (the daemon control API, the app Postgres/Redis on
 * loopback, the cloud metadata endpoint). This validator is the
 * defense-in-depth layer that blocks a base URL from pointing at anything
 * internal.
 *
 * RESIDUAL RISK: this is pure string/literal-IP parsing. It cannot stop a
 * DNS-rebinding attack where a hostname resolves to a public IP at check
 * time and an internal IP at fetch time. Blocking literal internal IPs +
 * offering a host allowlist is the right pragmatic layer; closing the
 * rebinding gap would require pinning the resolved IP through to connect
 * time (socket-level), which the FetchLike abstraction doesn't expose.
 */

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
   */
  hostAllowlist?: string[];
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
  if (ip && ipEquals(ip, METADATA_IPV4)) {
    throw new UnsafeBaseUrlError(raw, "cloud metadata IP");
  }

  if (allowlisted) return url;

  if (ip) {
    const cls = classifyIp(ip);
    if (cls === "loopback") throw new UnsafeBaseUrlError(raw, "loopback IP");
    if (cls === "link-local") throw new UnsafeBaseUrlError(raw, "link-local IP");
    if (cls === "private" && !opts.allowPrivate) {
      throw new UnsafeBaseUrlError(raw, "private IP");
    }
  }

  return url;
}

type IpKind = "loopback" | "link-local" | "private" | "public";

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

function classifyIp(ip: ParsedIp): IpKind {
  if (ip.version === 4 && ip.v4) return classifyV4(ip.v4);
  if (ip.version === 6 && ip.v6) return classifyV6(ip.v6);
  return "public";
}

function classifyV4([a, b]: [number, number, number, number]): IpKind {
  if (a === 127) return "loopback"; // 127.0.0.0/8
  if (a === 169 && b === 254) return "link-local"; // 169.254.0.0/16
  if (a === 10) return "private"; // 10.0.0.0/8
  if (a === 192 && b === 168) return "private"; // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return "private"; // 172.16.0.0/12
  if (a === 100 && b >= 64 && b <= 127) return "private"; // 100.64.0.0/10 (CGNAT)
  if (a === 0) return "private"; // 0.0.0.0/8 — "this host"
  return "public";
}

function classifyV6(raw: string): IpKind {
  // Drop a zone id (fe80::1%eth0) if present.
  const v6 = raw.split("%")[0]!.toLowerCase();

  if (v6 === "::1") return "loopback";
  if (v6 === "::" || v6 === "::0") return "private"; // unspecified

  // IPv4-mapped, dotted form (::ffff:127.0.0.1) — classify on the v4.
  const mappedDotted = v6.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) {
    const v4 = parseV4(mappedDotted[1]!);
    if (v4) return classifyV4(v4);
  }
  // IPv4-mapped, hex form (the URL parser normalizes ::ffff:127.0.0.1 to
  // ::ffff:7f00:1) — reconstruct the embedded v4 from the two hextets.
  const mappedHex = v6.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1]!, 16);
    const lo = parseInt(mappedHex[2]!, 16);
    const v4: [number, number, number, number] = [
      (hi >> 8) & 0xff,
      hi & 0xff,
      (lo >> 8) & 0xff,
      lo & 0xff,
    ];
    return classifyV4(v4);
  }

  if (v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb")) {
    return "link-local"; // fe80::/10
  }
  if (v6.startsWith("fc") || v6.startsWith("fd")) return "private"; // fc00::/7 ULA

  return "public";
}
