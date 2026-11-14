/**
 * Which Web Push endpoints `.com` will POST to. A browser subscription names a
 * push service, but a UnifiedPush endpoint names whatever server the phone's
 * distributor uses (ntfy.sh, a self-hosted ntfy, NextPush on a Nextcloud), so
 * the URL comes from the device and must not turn `.com` into a request
 * forwarder into private networks: https only, no credentials in the URL, no
 * private, loopback, link-local or otherwise non-public address, no local-only
 * names, and none of Flagship's own hosts.
 *
 * `checkPushEndpointUrl` is syntactic and runs on every send. At registration
 * `resolvePushEndpointHost` also looks the name up over DNS-over-HTTPS and
 * refuses a name that points anywhere non-public. Sends never follow redirects.
 */

import type { FetchLike } from "./pushBridge.js";

export const PUSH_ENDPOINT_MAX_LENGTH = 1024;
export const PUSH_PROVIDER_TOKEN_MAX_LENGTH = 2048;

export type PushEndpointCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".intranet", ".lan", ".home", ".home.arpa", ".corp", ".private", ".test", ".invalid", ".example", ".onion", ".arpa"];

export interface PushEndpointPolicy {
  /** Hosts `.com` must never call (its own apexes); a host equal to one or below it is refused. */
  blockedHosts?: readonly string[];
}

export const DEFAULT_BLOCKED_PUSH_HOSTS: readonly string[] = [
  "flagshipserver.com",
  "fshp.tech",
  "fshp.app",
  "workers.dev",
];

export function checkPushEndpointUrl(raw: string, policy: PushEndpointPolicy = {}): PushEndpointCheck {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > PUSH_ENDPOINT_MAX_LENGTH) {
    return { ok: false, reason: "endpoint length" };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "endpoint is not a URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "endpoint must be https" };
  if (url.username || url.password) return { ok: false, reason: "endpoint carries credentials" };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "endpoint has no host" };

  if (host.startsWith("[")) {
    const v6 = host.slice(1, -1);
    return isPublicIPv6(v6) ? { ok: true, url } : { ok: false, reason: "endpoint address is not public" };
  }
  if (/^[0-9.]+$/.test(host) || /^0x/i.test(host)) {
    const v4 = parseIPv4(host);
    if (!v4 || !isPublicIPv4(v4)) return { ok: false, reason: "endpoint address is not public" };
    return { ok: true, url };
  }
  if (!host.includes(".")) return { ok: false, reason: "endpoint host is not a public name" };
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "endpoint host is not a public name" };
  }
  const blocked = [...DEFAULT_BLOCKED_PUSH_HOSTS, ...(policy.blockedHosts ?? [])].map((h) => h.toLowerCase());
  if (blocked.some((b) => host === b || host.endsWith(`.${b}`))) {
    return { ok: false, reason: "endpoint host is a Flagship host" };
  }
  return { ok: true, url };
}

/**
 * A Web Push / UnifiedPush `providerToken`: `{"endpoint", "keys": {"p256dh", "auth"}}`
 * with a usable endpoint and RFC 8291 keys (65-byte uncompressed P-256 point,
 * 16-byte auth secret, both base64url).
 */
export function checkWebPushSubscription(
  providerToken: string,
  policy: PushEndpointPolicy = {},
): PushEndpointCheck {
  if (providerToken.length > PUSH_PROVIDER_TOKEN_MAX_LENGTH) return { ok: false, reason: "subscription too long" };
  let sub: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  try {
    sub = JSON.parse(providerToken);
  } catch {
    return { ok: false, reason: "subscription is not JSON" };
  }
  if (!sub || typeof sub !== "object" || typeof sub.endpoint !== "string") {
    return { ok: false, reason: "subscription has no endpoint" };
  }
  const p256dh = b64urlLength(sub.keys?.p256dh);
  const auth = b64urlLength(sub.keys?.auth);
  if (p256dh !== 65 || auth !== 16) return { ok: false, reason: "subscription keys" };
  return checkPushEndpointUrl(sub.endpoint, policy);
}

function b64urlLength(v: unknown): number {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(v)) return -1;
  const s = v.replace(/=+$/, "");
  if (s.length % 4 === 1) return -1;
  return Math.floor((s.length * 3) / 4);
}

/**
 * Registration-time DNS check: every A and AAAA answer (CNAME chains
 * included) must be a public address, and there must be at least one.
 * IP-literal endpoints were checked already and pass straight through.
 */
export async function resolvePushEndpointHost(
  url: URL,
  fetchImpl: FetchLike,
  dohUrl = "https://cloudflare-dns.com/dns-query",
): Promise<boolean> {
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^[0-9.]+$/.test(host)) return true;
  let answers = 0;
  for (const type of ["A", "AAAA"] as const) {
    let body: { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
    try {
      const r = await fetchImpl(`${dohUrl}?name=${encodeURIComponent(host)}&type=${type}`, {
        method: "GET",
        headers: { accept: "application/dns-json" },
        redirect: "error",
      });
      if (!r.ok) return false;
      body = (await r.json()) as typeof body;
    } catch {
      return false;
    }
    if (body.Status !== 0 && body.Status !== 3) return false;
    for (const a of body.Answer ?? []) {
      if (a.type === 1) {
        const v4 = typeof a.data === "string" ? parseIPv4(a.data) : null;
        if (!v4 || !isPublicIPv4(v4)) return false;
        answers++;
      } else if (a.type === 28) {
        if (typeof a.data !== "string" || !isPublicIPv6(a.data)) return false;
        answers++;
      }
    }
  }
  return answers > 0;
}

function parseIPv4(s: string): [number, number, number, number] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out as [number, number, number, number];
}

function isPublicIPv4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function parseIPv6(s: string): number[] | null {
  let str = s.toLowerCase();
  const zone = str.indexOf("%");
  if (zone >= 0) return null;
  let tail: number[] = [];
  const lastColon = str.lastIndexOf(":");
  if (str.includes(".") && lastColon >= 0) {
    const v4 = parseIPv4(str.slice(lastColon + 1));
    if (!v4) return null;
    tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
    str = str.slice(0, lastColon + 1);
    if (!str.endsWith("::")) str = str.slice(0, -1);
  }
  const want = 8 - tail.length;
  const halves = str.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parse(halves[0] ?? "");
  const rest = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !rest) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = want - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== want) return null;
  return [...groups, ...tail];
}

function isPublicIPv6(s: string): boolean {
  const g = parseIPv6(s);
  if (!g) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    if (g5 === 0xffff || g5 === 0) {
      if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return false;
      return isPublicIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
    }
    return false;
  }
  if (g0 === 0x64 && g1 === 0xff9b) {
    return isPublicIPv4([g6 >> 8, g6 & 0xff, g7 >> 8, g7 & 0xff]);
  }
  if (g0 === 0x2002) return isPublicIPv4([g1 >> 8, g1 & 0xff, g2 >> 8, g2 & 0xff]);
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 === 0x0db8) return false;
  if (g0 === 0x2001 && g1 < 0x0200) return false;
  if (g0 === 0x3fff && g1 < 0x1000) return false;
  return true;
}
