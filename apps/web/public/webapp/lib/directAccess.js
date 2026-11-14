// Direct access (docs/direct-access-and-domains.md §5, §7): the owner lets a
// server be reached at its own public addresses instead of only through the
// relay. The admin device signs one sensitive order:
//
//   flagship/direct-access/v1|<serverDomain>|<on|off>|<addresses>|<prefixes>|<port>|<issuedAt>
//
// Port of packages/protocol/src/directAccess.ts (the order only; the box's
// address update and the v2 hint are for the phones). Must pass
// packages/protocol/test-vectors/direct-access/vectors.json.

import { sha256 } from "../vendor/noble-hashes/sha2.js";
import { bytesToHex, hexToBytes, verifyWithEd25519Pub } from "../keystore.js";
import { sensitiveSigner } from "./adminRoot.js";
import { getSession } from "./state.js";

export const TAG_DIRECT_ACCESS = "flagship/direct-access/v1";
export const DIRECT_MAX_ADDRESSES = 8;
export const DIRECT_MAX_PREFIXES = 4;
export const DIRECT_MIN_PREFIX_V4 = 24;
export const DIRECT_MIN_PREFIX_V6 = 32;

/** `{family, bytes}` for a dotted quad (no leading zeros) or IPv6 hex groups with "::" (no zone, no dotted tail); null otherwise. */
export function parseIp(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 45) return null;
  if (/^[0-9.]+$/.test(text)) {
    const parts = text.split(".");
    if (parts.length !== 4) return null;
    const bytes = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      if (!/^(0|[1-9][0-9]{0,2})$/.test(parts[i])) return null;
      const n = Number(parts[i]);
      if (n > 255) return null;
      bytes[i] = n;
    }
    return { family: 4, bytes };
  }
  if (!/^[0-9a-fA-F:]+$/.test(text) || !text.includes(":")) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (s) => (s === "" ? [] : s.split(":"));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const all = [...head, ...tail];
  if (all.some((g) => g.length === 0 || g.length > 4)) return null;
  if (halves.length === 1 ? all.length !== 8 : all.length > 7) return null;
  const words = [...head, ...Array(8 - all.length).fill("0"), ...tail].map((g) => parseInt(g, 16));
  const bytes = new Uint8Array(16);
  words.forEach((w, i) => {
    bytes[2 * i] = w >> 8;
    bytes[2 * i + 1] = w & 0xff;
  });
  return { family: 6, bytes };
}

/** Dotted quad, or RFC 5952 text (lowercase, the longest run of 2+ zero groups as "::", the first on a tie). */
export function formatIp(ip) {
  if (ip.family === 4) return Array.from(ip.bytes).join(".");
  const w = [];
  for (let i = 0; i < 8; i++) w.push((ip.bytes[2 * i] << 8) | ip.bytes[2 * i + 1]);
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
  const hex = (a) => a.map((x) => x.toString(16)).join(":");
  if (best < 0) return hex(w);
  return `${hex(w.slice(0, best))}::${hex(w.slice(best + bestLen))}`;
}

export function canonicalIp(text) {
  const p = parseIp(text);
  return p ? formatIp(p) : null;
}

function inRange(bytes, net, len) {
  for (let bit = 0; bit < len; bit++) {
    const mask = 0x80 >> (bit & 7);
    if ((bytes[bit >> 3] & mask) !== ((net[bit >> 3] ?? 0) & mask)) return false;
  }
  return true;
}

const V4_SPECIAL = [
  [[0], 8], [[10], 8], [[100, 64], 10], [[127], 8], [[169, 254], 16], [[172, 16], 12],
  [[192, 0, 0], 24], [[192, 0, 2], 24], [[192, 88, 99], 24], [[192, 168], 16], [[198, 18], 15],
  [[198, 51, 100], 24], [[203, 0, 113], 24], [[224], 4], [[240], 4],
];
const V6_SPECIAL = [
  [[0x20, 0x01, 0x00, 0x00], 23], [[0x20, 0x01, 0x0d, 0xb8], 32], [[0x20, 0x02], 16], [[0x3f, 0xff], 20],
];

/** Globally routable unicast only (the rule of packages/protocol/src/addressPolicy.ts). Fails closed. */
export function isPublicAddress(text) {
  const p = parseIp(text);
  if (!p) return false;
  if (p.family === 4) return !V4_SPECIAL.some(([net, len]) => inRange(p.bytes, net, len));
  if (!inRange(p.bytes, [0x20], 3)) return false;
  return !V6_SPECIAL.some(([net, len]) => inRange(p.bytes, net, len));
}

/** `<address>/<length>` with no host bits set; null otherwise. */
export function parsePrefix(text) {
  if (typeof text !== "string") return null;
  const m = /^([^/]+)\/(0|[1-9][0-9]{0,2})$/.exec(text);
  if (!m) return null;
  const ip = parseIp(m[1]);
  const length = Number(m[2]);
  if (!ip || length > ip.bytes.length * 8) return null;
  for (let bit = length; bit < ip.bytes.length * 8; bit++) {
    if (ip.bytes[bit >> 3] & (0x80 >> (bit & 7))) return null;
  }
  return { ip, length };
}

export function formatPrefix(p) {
  return `${formatIp(p.ip)}/${p.length}`;
}

export function prefixContains(prefix, address) {
  const ip = parseIp(address);
  if (!ip || ip.family !== prefix.ip.family) return false;
  return inRange(ip.bytes, Array.from(prefix.ip.bytes), prefix.length);
}

/** The reason code an order can't be signed or taken (lib/directNames.js turns it into a sentence), or null. */
export function directAccessOrderProblem(o) {
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

function guard(name, v) {
  if (/[|\x00-\x1f\x7f]/.test(v)) throw new Error(`${name} contains a separator or control character`);
}

export function canonicalDirectAccessOrder(o) {
  guard("serverDomain", o.serverDomain);
  if (!Number.isSafeInteger(o.issuedAt) || !Number.isInteger(o.port)) throw new Error("direct-access order numbers must be integers");
  const list = (xs, name) => {
    for (const x of xs) {
      guard(name, x);
      if (x.includes(",")) throw new Error(`direct-access ${name} contains ','`);
    }
    return [...xs].sort().join(",");
  };
  return new TextEncoder().encode(
    [TAG_DIRECT_ACCESS, o.serverDomain, o.enabled ? "on" : "off", list(o.addresses, "address"), list(o.prefixes, "prefix"), String(o.port), String(o.issuedAt)].join("|"),
  );
}

export function directAccessOrderSha256(o) {
  return bytesToHex(sha256(canonicalDirectAccessOrder(o)));
}

/** True only for a well-formed order whose signature verifies under `pubHex`. Never throws. */
export async function verifyDirectAccessOrder(o, signatureHex, pubHex) {
  try {
    if (directAccessOrderProblem(o)) return false;
    if (!/^[0-9a-f]{128}$/.test(signatureHex) || !/^[0-9a-f]{64}$/.test(pubHex)) return false;
    return await verifyWithEd25519Pub(hexToBytes(pubHex), hexToBytes(signatureHex), canonicalDirectAccessOrder(o));
  } catch {
    return false;
  }
}

/** Words of a list field (whitespace or commas). */
export function listWords(text) {
  return String(text ?? "")
    .split(/[\s,]+/)
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);
}

/** `{ok: true, list}` of canonical, sorted, deduplicated addresses, or `{ok: false, code: "bad-address"}`. */
export function parseAddressList(text) {
  const out = [];
  for (const w of listWords(text)) {
    const c = canonicalIp(w);
    if (!c) return { ok: false, code: "bad-address" };
    if (!out.includes(c)) out.push(c);
  }
  return { ok: true, list: out.sort() };
}

/** The same for address ranges; `{ok: false, code: "bad-prefix"}` on one that isn't. */
export function parsePrefixList(text) {
  const out = [];
  for (const w of listWords(text)) {
    const p = parsePrefix(w);
    if (!p) return { ok: false, code: "bad-prefix" };
    const c = formatPrefix(p);
    if (!out.includes(c)) out.push(c);
  }
  return { ok: true, list: out.sort() };
}

/** A port typed by the owner, or null. */
export function parsePort(text) {
  const t = String(text ?? "").trim();
  return /^[0-9]{1,5}$/.test(t) ? Number(t) : null;
}

export class DirectOrderRefused extends Error {
  constructor(code) {
    super(code);
    this.name = "DirectOrderRefused";
    this.code = code;
  }
}

/** Sign `{order, signatureHex}` with the sensitive-order key (admin root; the IRK only where none is pinned). Throws {@link DirectOrderRefused} before signing a bad order. */
export async function signDirectAccessOrder(order, deps = {}) {
  const problem = directAccessOrderProblem(order);
  if (problem) throw new DirectOrderRefused(problem);
  const umk = deps.umk ?? getSession()?.umk;
  if (!umk) throw new DirectOrderRefused("locked");
  const sign = deps.sign ?? sensitiveSigner();
  const sig = await sign(umk, canonicalDirectAccessOrder(order));
  return { order, signatureHex: bytesToHex(sig) };
}
