/**
 * Direct access (docs/direct-access-and-domains.md §1, §5, §6 steps 1-2): the owner lets the box be
 * reached at its own public addresses instead of only through the relay.
 *
 * Three messages:
 *
 *   flagship/direct-access/v1|<serverDomain>|<on|off>|<addresses>|<prefixes>|<port>|<issuedAt>
 *
 *     The owner's order, signed like every sensitive order (admin root; the IRK only on a box that
 *     pins none; biometric on the phones). `addresses` are exact public addresses the owner
 *     approved (an IPv4 forwarded on the router, a fixed IPv6); `prefixes` are the ranges inside
 *     which the box may report its own address by itself (a home /56 that the ISP renumbers).
 *     Both are sorted and ","-joined, in RFC 5952 / dotted-quad canonical text. "off" carries
 *     none. A newer order replaces the older one.
 *
 *   flagship/direct-address/v1|<serverDomain>|<orderSha256>|<addresses>|<port>|<issuedAt>
 *
 *     The box (STK) naming the public addresses it holds right now, inside the order whose
 *     canonical bytes hash to `orderSha256`. A verifier that holds the order checks every address
 *     against it, so a box can never widen its own grant. The newest `issuedAt` wins.
 *
 *   flagship/lan-hint/v2|<serverDomain>|<certSha256>|<lan>|<direct>|<orderSha256>|<issuedAt>|<expiresAt>
 *
 *     LAN-direct's hint (lanHint.ts) grown by the public endpoints. `lan` keeps v1's rule (private
 *     addresses only). `direct` must be empty, or every endpoint must be inside the owner's order
 *     named by `orderSha256` (empty when `direct` is). The device verifies the order itself before
 *     it dials a public address; without a verified order it uses the LAN part only.
 *
 * Private, loopback, link-local, CGNAT, documentation, multicast and every other special-purpose
 * address is refused in an order and in an address update: public DNS (step 3) pointing at one
 * is a DNS-rebinding vector against visitors' own networks.
 */
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { isPublicAddress } from "./addressPolicy.js";
import { hex, legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import { formatLanEndpoint, isLanAddress, LAN_HINT_MAX_ENDPOINTS, LAN_HINT_MAX_TTL_MS, type LanEndpoint } from "./lanHint.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_DIRECT_ACCESS = "flagship/direct-access/v1";
export const TAG_DIRECT_ADDRESS = "flagship/direct-address/v1";
export const TAG_LAN_HINT_V2 = "flagship/lan-hint/v2";

export const DIRECT_MAX_ADDRESSES = 8;
export const DIRECT_MAX_PREFIXES = 4;
/** Shortest prefixes the owner may grant. At these lengths a prefix is wholly inside or wholly outside every special-purpose range. */
export const DIRECT_MIN_PREFIX_V4 = 24;
export const DIRECT_MIN_PREFIX_V6 = 32;
const CLOCK_SKEW_MS = 5 * 60_000;
const HEX64 = /^[0-9a-f]{64}$/;

// ---- addresses ---------------------------------------------------------------------------------

export interface ParsedIp {
  family: 4 | 6;
  bytes: Uint8Array;
}

/** An IPv4 dotted quad (no leading zeros) or an IPv6 address (hex groups, "::"; no zone, no dotted tail). */
export function parseIp(text: string): ParsedIp | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 45) return null;
  if (/^[0-9.]+$/.test(text)) {
    const parts = text.split(".");
    if (parts.length !== 4) return null;
    const bytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      const p = parts[i]!;
      if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
      const n = Number(p);
      if (n > 255) return null;
      bytes[i] = n;
    }
    return { family: 4, bytes };
  }
  if (!/^[0-9a-fA-F:]+$/.test(text) || !text.includes(":")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string): string[] | null => (s === "" ? [] : s.split(":"));
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return null;
  const all = [...head, ...tail];
  if (all.some((g) => g.length === 0 || g.length > 4)) return null;
  if (halves.length === 1 ? all.length !== 8 : all.length > 7) return null;
  const words = [...head, ...Array<string>(8 - all.length).fill("0"), ...tail].map((g) => parseInt(g, 16));
  const bytes = new Uint8Array(16);
  words.forEach((w, i) => {
    bytes[2 * i] = w >> 8;
    bytes[2 * i + 1] = w & 0xff;
  });
  return { family: 6, bytes };
}

/** Dotted quad, or RFC 5952 text (lowercase, no leading zeros, the longest run of 2+ zero groups as "::", the first on a tie). */
export function formatIp(ip: ParsedIp): string {
  if (ip.family === 4) return Array.from(ip.bytes).join(".");
  const w: number[] = [];
  for (let i = 0; i < 8; i++) w.push((ip.bytes[2 * i]! << 8) | ip.bytes[2 * i + 1]!);
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (w[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && w[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const groups = (a: number[]) => a.map((x) => x.toString(16)).join(":");
  if (best < 0) return groups(w);
  return `${groups(w.slice(0, best))}::${groups(w.slice(best + bestLen))}`;
}

/** The canonical text of an address, or null when it isn't one. */
export function canonicalIp(text: string): string | null {
  const p = parseIp(text);
  return p ? formatIp(p) : null;
}

function inRange(bytes: Uint8Array, net: number[], len: number): boolean {
  for (let bit = 0; bit < len; bit++) {
    const byte = bit >> 3;
    const mask = 0x80 >> (bit & 7);
    if ((bytes[byte]! & mask) !== ((net[byte] ?? 0) & mask)) return false;
  }
  return true;
}

export interface ParsedPrefix {
  ip: ParsedIp;
  length: number;
}

/** `<address>/<length>` with no host bits set; null otherwise. */
export function parsePrefix(text: string): ParsedPrefix | null {
  if (typeof text !== "string") return null;
  const m = /^([^/]+)\/(0|[1-9][0-9]{0,2})$/.exec(text);
  if (!m) return null;
  const ip = parseIp(m[1]!);
  const length = Number(m[2]);
  if (!ip || length > ip.bytes.length * 8) return null;
  for (let bit = length; bit < ip.bytes.length * 8; bit++) {
    if (ip.bytes[bit >> 3]! & (0x80 >> (bit & 7))) return null;
  }
  return { ip, length };
}

export function formatPrefix(p: ParsedPrefix): string {
  return `${formatIp(p.ip)}/${p.length}`;
}

export function prefixContains(prefix: ParsedPrefix, address: string): boolean {
  const ip = parseIp(address);
  if (!ip || ip.family !== prefix.ip.family) return false;
  return inRange(ip.bytes, Array.from(prefix.ip.bytes), prefix.length);
}

// ---- the owner's order -------------------------------------------------------------------------

export interface DirectAccessOrder {
  /** The box this order is for (its FQDN). */
  serverDomain: string;
  enabled: boolean;
  /** Exact public addresses, canonical text. */
  addresses: string[];
  /** `<network>/<length>` ranges the box may report its own address inside, canonical text. */
  prefixes: string[];
  /** The port visitors reach (443 unless the router maps another). */
  port: number;
  /** Unix ms. */
  issuedAt: number;
}

/**
 * Why an order can't be signed or taken, as a reason code (clients turn it into a sentence), or
 * null when its shape is fine. Freshness against a clock is the box's check, not this one.
 */
export function directAccessOrderProblem(o: DirectAccessOrder): string | null {
  if (!o || typeof o !== "object") return "malformed";
  if (typeof o.serverDomain !== "string" || o.serverDomain.length === 0 || /[|,\s]/.test(o.serverDomain)) return "no-server";
  if (typeof o.enabled !== "boolean" || !Array.isArray(o.addresses) || !Array.isArray(o.prefixes)) return "malformed";
  if (!Number.isSafeInteger(o.issuedAt) || o.issuedAt <= 0) return "bad-time";
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) return "bad-port";
  if (!o.enabled) return o.addresses.length === 0 && o.prefixes.length === 0 ? null : "off-with-addresses";
  if (o.addresses.length === 0 && o.prefixes.length === 0) return "no-addresses";
  if (o.addresses.length > DIRECT_MAX_ADDRESSES || o.prefixes.length > DIRECT_MAX_PREFIXES) return "too-many";
  for (const a of o.addresses) {
    if (typeof a !== "string") return "malformed";
    const c = canonicalIp(a);
    if (!c) return "bad-address";
    if (c !== a) return "non-canonical-address";
    if (!isPublicAddress(a)) return "private-address";
  }
  for (const p of o.prefixes) {
    if (typeof p !== "string") return "malformed";
    const parsed = parsePrefix(p);
    if (!parsed) return "bad-prefix";
    if (formatPrefix(parsed) !== p) return "non-canonical-address";
    if (parsed.length < (parsed.ip.family === 4 ? DIRECT_MIN_PREFIX_V4 : DIRECT_MIN_PREFIX_V6)) return "prefix-too-wide";
    if (!isPublicAddress(formatIp(parsed.ip))) return "private-address";
  }
  if (new Set(o.addresses).size !== o.addresses.length || new Set(o.prefixes).size !== o.prefixes.length) return "duplicate";
  return null;
}

export function canonicalDirectAccessOrder(o: DirectAccessOrder): Bytes {
  legacyFieldGuard("serverDomain", o.serverDomain);
  if (!Number.isSafeInteger(o.issuedAt) || !Number.isInteger(o.port)) throw new Error("direct-access order numbers must be integers");
  const list = (xs: string[], name: string) => {
    for (const x of xs) {
      legacyFieldGuard(name, x);
      if (x.includes(",")) throw new Error(`direct-access ${name} contains ','`);
    }
    return [...xs].sort().join(",");
  };
  return new TextEncoder().encode(
    [
      TAG_DIRECT_ACCESS,
      o.serverDomain,
      o.enabled ? "on" : "off",
      list(o.addresses, "address"),
      list(o.prefixes, "prefix"),
      String(o.port),
      String(o.issuedAt),
    ].join("|"),
  );
}

/** SHA-256 of the order's canonical bytes, lowercase hex: how the box's messages name the order they sit inside. */
export function directAccessOrderSha256(o: DirectAccessOrder): string {
  return hex(sha256(canonicalDirectAccessOrder(o)));
}

/** Sign with the sensitive-order key (admin root, or the IRK on a box that pins none). */
export function signDirectAccessOrder(o: DirectAccessOrder, key: Keypair): Bytes {
  const problem = directAccessOrderProblem(o);
  if (problem) throw new Error(`direct-access order refused: ${problem}`);
  return ed.sign(canonicalDirectAccessOrder(o), key.privateKey);
}

/** Never throws. An order with a bad shape (a private address included) never verifies. */
export function verifyDirectAccessOrder(o: DirectAccessOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    if (directAccessOrderProblem(o)) return false;
    return ed.verify(sig, canonicalDirectAccessOrder(o), pub);
  } catch {
    return false;
  }
}

/** Read an order object with exactly its fields; null on any other shape. */
export function parseDirectAccessOrder(raw: unknown): DirectAccessOrder | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = ["serverDomain", "enabled", "addresses", "prefixes", "port", "issuedAt"];
  const have = Object.keys(o);
  if (have.length !== keys.length || !keys.every((k) => have.includes(k))) return null;
  if (
    typeof o.serverDomain !== "string" ||
    typeof o.enabled !== "boolean" ||
    !Array.isArray(o.addresses) ||
    !o.addresses.every((a) => typeof a === "string") ||
    !Array.isArray(o.prefixes) ||
    !o.prefixes.every((a) => typeof a === "string") ||
    typeof o.port !== "number" ||
    typeof o.issuedAt !== "number"
  ) {
    return null;
  }
  return {
    serverDomain: o.serverDomain,
    enabled: o.enabled,
    addresses: [...(o.addresses as string[])],
    prefixes: [...(o.prefixes as string[])],
    port: o.port,
    issuedAt: o.issuedAt,
  };
}

/** Whether `address` is one the order lets the box use: listed exactly, or inside one of its prefixes. */
export function directOrderAllows(o: DirectAccessOrder, address: string): boolean {
  if (!o.enabled || !isPublicAddress(address) || canonicalIp(address) !== address) return false;
  if (o.addresses.includes(address)) return true;
  return o.prefixes.some((p) => {
    const parsed = parsePrefix(p);
    return parsed !== null && prefixContains(parsed, address);
  });
}

// ---- the box's address update ------------------------------------------------------------------

export interface DirectAddressUpdate {
  serverDomain: string;
  orderSha256: string;
  addresses: string[];
  port: number;
  issuedAt: number;
}

export function canonicalDirectAddressUpdate(u: DirectAddressUpdate): Bytes {
  legacyFieldGuard("serverDomain", u.serverDomain);
  legacyFieldGuard("orderSha256", u.orderSha256);
  if (!Number.isSafeInteger(u.issuedAt) || !Number.isInteger(u.port)) throw new Error("direct-address numbers must be integers");
  for (const a of u.addresses) {
    legacyFieldGuard("address", a);
    if (a.includes(",")) throw new Error("direct-address address contains ','");
  }
  return new TextEncoder().encode(
    [TAG_DIRECT_ADDRESS, u.serverDomain, u.orderSha256, [...u.addresses].sort().join(","), String(u.port), String(u.issuedAt)].join("|"),
  );
}

export function signDirectAddressUpdate(u: DirectAddressUpdate, identity: MsgSigner): Bytes {
  return resolveMsgSigner(identity)(canonicalDirectAddressUpdate(u));
}

export type DirectCheck = { ok: true } | { ok: false; reason: string };

/**
 * Accept an address update only if the box's STK signed it AND it sits inside `order`, which the
 * caller has already verified under the owner's sensitive-order key: same box, the order's hash,
 * the order is on, every address public, canonical and allowed by the order, the order's port.
 * Keeping the newest `issuedAt` (replay) is the caller's job.
 */
export function checkDirectAddressUpdate(
  u: DirectAddressUpdate,
  sig: Bytes,
  stkPub: Bytes,
  order: DirectAccessOrder,
  expect: { serverDomain: string; now: number },
): DirectCheck {
  let sigOk = false;
  try {
    sigOk = ed.verify(sig, canonicalDirectAddressUpdate(u), stkPub);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: "bad-signature" };
  if (u.serverDomain.toLowerCase() !== expect.serverDomain.toLowerCase()) return { ok: false, reason: "wrong-server" };
  if (order.serverDomain.toLowerCase() !== u.serverDomain.toLowerCase()) return { ok: false, reason: "wrong-server" };
  let orderHash: string;
  try {
    orderHash = directAccessOrderSha256(order);
  } catch {
    return { ok: false, reason: "order-mismatch" };
  }
  if (!HEX64.test(u.orderSha256) || u.orderSha256 !== orderHash) return { ok: false, reason: "order-mismatch" };
  if (!order.enabled) return { ok: false, reason: "direct-access-off" };
  if (!Number.isSafeInteger(u.issuedAt) || u.issuedAt > expect.now + CLOCK_SKEW_MS) return { ok: false, reason: "not-yet-valid" };
  if (u.addresses.length === 0 || u.addresses.length > DIRECT_MAX_ADDRESSES) return { ok: false, reason: "bad-endpoint-count" };
  if (new Set(u.addresses).size !== u.addresses.length) return { ok: false, reason: "duplicate" };
  if (u.port !== order.port) return { ok: false, reason: "bad-port" };
  for (const a of u.addresses) {
    if (canonicalIp(a) !== a) return { ok: false, reason: "non-canonical-address" };
    if (!isPublicAddress(a)) return { ok: false, reason: "private-address" };
    if (!directOrderAllows(order, a)) return { ok: false, reason: "outside-grant" };
  }
  return { ok: true };
}

// ---- hint v2 -----------------------------------------------------------------------------------

export interface LanHintV2 {
  serverDomain: string;
  certSha256: string;
  /** Private addresses on the box's own network (v1's rule). */
  lan: LanEndpoint[];
  /** Public endpoints inside the owner's order. */
  direct: LanEndpoint[];
  /** The order the `direct` endpoints sit inside; "" when `direct` is empty. */
  orderSha256: string;
  issuedAt: number;
  expiresAt: number;
}

export function canonicalLanHintV2(h: LanHintV2): Bytes {
  legacyFieldGuard("serverDomain", h.serverDomain);
  legacyFieldGuard("certSha256", h.certSha256);
  legacyFieldGuard("orderSha256", h.orderSha256);
  const list = (es: LanEndpoint[]) => {
    const out = es.map(formatLanEndpoint).sort();
    for (const e of out) legacyFieldGuard("endpoint", e);
    return out.join(",");
  };
  return new TextEncoder().encode(
    [TAG_LAN_HINT_V2, h.serverDomain, h.certSha256, list(h.lan), list(h.direct), h.orderSha256, String(h.issuedAt), String(h.expiresAt)].join("|"),
  );
}

export function signLanHintV2(h: LanHintV2, identity: MsgSigner): Bytes {
  return resolveMsgSigner(identity)(canonicalLanHintV2(h));
}

export type LanHintV2Check = { ok: true; useDirect: boolean } | { ok: false; reason: string };

/**
 * Accept a v2 hint. Everything v1 checks holds for the whole hint. The `direct` endpoints are used
 * (`useDirect`) only when `order` is given (verified by the caller under the owner's key), its hash
 * is the hint's, and every endpoint is inside it on its port; a hint whose `direct` part contradicts
 * the order it names is refused whole. Without an order the LAN part alone is usable.
 */
export function checkLanHintV2(
  h: LanHintV2,
  sig: Bytes,
  stkPub: Bytes,
  expect: { serverDomain: string; certSha256: string; now: number },
  order: DirectAccessOrder | null,
): LanHintV2Check {
  let sigOk = false;
  try {
    sigOk = ed.verify(sig, canonicalLanHintV2(h), stkPub);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: "bad-signature" };
  if (h.serverDomain.toLowerCase() !== expect.serverDomain.toLowerCase()) return { ok: false, reason: "wrong-server" };
  if (!HEX64.test(h.certSha256) || h.certSha256 !== expect.certSha256.toLowerCase()) return { ok: false, reason: "cert-mismatch" };
  if (h.issuedAt > expect.now + CLOCK_SKEW_MS) return { ok: false, reason: "not-yet-valid" };
  if (h.expiresAt <= expect.now) return { ok: false, reason: "expired" };
  if (h.expiresAt - h.issuedAt > LAN_HINT_MAX_TTL_MS) return { ok: false, reason: "ttl-too-long" };
  if (h.lan.length > LAN_HINT_MAX_ENDPOINTS || h.direct.length > DIRECT_MAX_ADDRESSES || h.lan.length + h.direct.length === 0) {
    return { ok: false, reason: "bad-endpoint-count" };
  }
  for (const e of [...h.lan, ...h.direct]) {
    if (!Number.isInteger(e.port) || e.port < 1 || e.port > 65535) return { ok: false, reason: "bad-port" };
  }
  if (h.lan.some((e) => !isLanAddress(e.address))) return { ok: false, reason: "non-lan-endpoint" };
  if (h.direct.length === 0) {
    return h.orderSha256 === "" ? { ok: true, useDirect: false } : { ok: false, reason: "order-mismatch" };
  }
  if (h.direct.some((e) => canonicalIp(e.address) !== e.address || !isPublicAddress(e.address))) {
    return { ok: false, reason: "private-address" };
  }
  if (!HEX64.test(h.orderSha256)) return { ok: false, reason: "order-mismatch" };
  if (!order) return h.lan.length > 0 ? { ok: true, useDirect: false } : { ok: false, reason: "direct-without-order" };
  let orderHash: string;
  try {
    orderHash = directAccessOrderSha256(order);
  } catch {
    return { ok: false, reason: "order-mismatch" };
  }
  if (orderHash !== h.orderSha256 || order.serverDomain.toLowerCase() !== h.serverDomain.toLowerCase()) {
    return { ok: false, reason: "order-mismatch" };
  }
  if (!order.enabled) return { ok: false, reason: "direct-access-off" };
  for (const e of h.direct) {
    if (e.port !== order.port) return { ok: false, reason: "bad-port" };
    if (!directOrderAllows(order, e.address)) return { ok: false, reason: "outside-grant" };
  }
  return { ok: true, useDirect: true };
}
