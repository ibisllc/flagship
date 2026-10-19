/**
 * RelayHint: a maintainer-signed list of the relay's well-known addresses,
 * an ADVISORY for apps whose DNS cannot resolve a box's name (docs/relay-hints.md).
 *
 *   flagship/relay-hint/v1|<signedBy>|<seq>|<validFrom>|<validUntil>|<addresses>
 *
 * Signed OFFLINE by the same cold ca-track maintainer authority as security
 * notices, never by `.com`. It carries no trust of its own: a box is still
 * authenticated by TLS to its own name and its pinned certificate, so a wrong
 * or hostile address can only fail to connect. The signature only stops a
 * network or `.com` from steering every phone's fallback somewhere useless.
 * Clients fail open: anything unverifiable, expired or malformed is ignored
 * and the compiled-in seed addresses are used instead.
 */
import { ed } from "./edSync.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_RELAY_HINT = "flagship/relay-hint/v1";

/** A hint is valid for at most this long, so a replayed one cannot steer forever. */
export const RELAY_HINT_MAX_WINDOW_MS = 180 * 24 * 3600_000;
export const RELAY_HINT_MAX_ADDRESSES = 8;

export interface RelayHintBody {
  /** Monotonic across all hints ever signed; clients remember the highest. */
  seq: number;
  /** epoch ms, inclusive ... */
  validFrom: number;
  /** ... to here, exclusive. */
  validUntil: number;
  /** IPv4 dotted or IPv6 text, public unicast only, as the relay answers on :443. */
  addresses: string[];
}

export interface RelayHint extends RelayHintBody {
  type: "RelayHint";
  version: 1;
  /** lower-hex Ed25519 pubkey of the ca-track maintainer authority that signed. */
  signedBy: string;
  signature: string;
}

export class RelayHintError extends Error {
  constructor(readonly code: string) {
    super(`${TAG_RELAY_HINT}: ${code}`);
    this.name = "RelayHintError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

function isUint(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function ipv4Problem(a: string): string | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return "bad-address";
  const o = m.slice(1).map(Number) as [number, number, number, number];
  if (o.some((n, i) => n > 255 || String(n) !== m[i + 1])) return "bad-address";
  const [a0, a1] = o;
  if (a0 === 0 || a0 === 10 || a0 === 127 || a0 >= 224) return "not-public";
  if (a0 === 100 && a1 >= 64 && a1 <= 127) return "not-public";
  if (a0 === 169 && a1 === 254) return "not-public";
  if (a0 === 172 && a1 >= 16 && a1 <= 31) return "not-public";
  if (a0 === 192 && a1 === 168) return "not-public";
  return null;
}

function ipv6Problem(a: string): string | null {
  if (!/^[0-9a-f:]+$/.test(a) || !a.includes(":") || a.length > 39) return "bad-address";
  if (a.split("::").length > 2 || /:::/.test(a)) return "bad-address";
  const groups = a.split(":");
  if (groups.some((g) => g.length > 4)) return "bad-address";
  const hasGap = a.includes("::");
  const filled = groups.filter((g) => g !== "").length;
  if (hasGap ? filled > 7 : groups.length !== 8 || filled !== 8) return "bad-address";
  const first = Number.parseInt(groups[0] || "0", 16);
  if (a === "::" || a === "::1") return "not-public";
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return "not-public";
  if ((first & 0xe000) !== 0x2000) return "not-public";
  return null;
}

/** null when `a` is a lowercase, public unicast IPv4 or IPv6 literal, else why not. */
export function relayHintAddressProblem(a: unknown): string | null {
  if (typeof a !== "string") return "bad-address";
  return a.includes(":") ? ipv6Problem(a) : ipv4Problem(a);
}

/** Check every rule and return the bytes to sign. Throws a {@link RelayHintError} naming the first rule broken. */
export function canonicalRelayHint(b: RelayHintBody, signedBy: string): Bytes {
  if (typeof signedBy !== "string" || !HEX64.test(signedBy)) throw new RelayHintError("bad-signer");
  if (!isUint(b.seq) || b.seq < 1) throw new RelayHintError("bad-seq");
  if (!isUint(b.validFrom) || !isUint(b.validUntil)) throw new RelayHintError("bad-time");
  if (b.validUntil <= b.validFrom) throw new RelayHintError("window-order");
  if (b.validUntil - b.validFrom > RELAY_HINT_MAX_WINDOW_MS) throw new RelayHintError("window-too-long");
  if (!Array.isArray(b.addresses) || b.addresses.length === 0) throw new RelayHintError("addresses-required");
  if (b.addresses.length > RELAY_HINT_MAX_ADDRESSES) throw new RelayHintError("too-many-addresses");
  const seen = new Set<string>();
  for (const a of b.addresses) {
    const p = relayHintAddressProblem(a);
    if (p) throw new RelayHintError(p);
    if (seen.has(a)) throw new RelayHintError("duplicate-address");
    seen.add(a);
  }
  return new TextEncoder().encode(
    [TAG_RELAY_HINT, signedBy, String(b.seq), String(b.validFrom), String(b.validUntil), b.addresses.join(",")].join("|"),
  );
}

export function relayHintProblem(b: RelayHintBody, signedBy: string): string | null {
  try {
    canonicalRelayHint(b, signedBy);
    return null;
  } catch (e) {
    return e instanceof RelayHintError ? e.code : "invalid";
  }
}

export function signRelayHint(body: RelayHintBody, authority: Keypair): RelayHint {
  const signedBy = toHex(authority.publicKey);
  return assembleRelayHint(body, signedBy, toHex(ed.sign(canonicalRelayHint(body, signedBy), authority.privateKey)));
}

/** Attach an externally made signature (the maintainers CLI's signer) to a body. */
export function assembleRelayHint(body: RelayHintBody, signedBy: string, signature: string): RelayHint {
  return {
    type: "RelayHint",
    version: 1,
    seq: body.seq,
    validFrom: body.validFrom,
    validUntil: body.validUntil,
    addresses: [...body.addresses],
    signedBy,
    signature,
  };
}

/** Shape-check an untrusted hint and enforce every rule (no signature check). */
export function parseRelayHint(v: unknown): RelayHint | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.type !== "RelayHint" || r.version !== 1) return null;
  if (typeof r.signedBy !== "string" || typeof r.signature !== "string") return null;
  if (!HEX64.test(r.signedBy) || !HEX128.test(r.signature)) return null;
  if (!Array.isArray(r.addresses)) return null;
  const body = { seq: r.seq, validFrom: r.validFrom, validUntil: r.validUntil, addresses: r.addresses } as RelayHintBody;
  try {
    canonicalRelayHint(body, r.signedBy);
  } catch {
    return null;
  }
  return assembleRelayHint(body, r.signedBy, r.signature);
}

export type RelayHintReject = "malformed" | "unauthorized-signer" | "signature-invalid";

export function verifyRelayHint(
  h: RelayHint,
  authorityKeys: readonly string[],
): { ok: true } | { ok: false; reason: RelayHintReject } {
  let bytes: Bytes;
  try {
    bytes = canonicalRelayHint(h, h.signedBy);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!HEX128.test(h.signature)) return { ok: false, reason: "malformed" };
  if (!authorityKeys.includes(h.signedBy)) return { ok: false, reason: "unauthorized-signer" };
  try {
    if (ed.verify(fromHex(h.signature), bytes, fromHex(h.signedBy))) return { ok: true };
  } catch {
    /* falls through */
  }
  return { ok: false, reason: "signature-invalid" };
}

/** What a client persists between launches. */
export interface RelayHintStore {
  /** The highest seq ever verified (anti-rollback). */
  highestSeq: number;
  /** The newest verified hint (re-verified on load), or null. */
  hint: RelayHint | null;
}

export type RelayHintRefusal = RelayHintReject | "stale";

/**
 * Fold a fetched candidate into the store. A candidate that is malformed,
 * not signed by the authority, or not newer than the highest seq verified is
 * dropped and the store stays as it was.
 */
export function acceptRelayHint(
  store: RelayHintStore,
  candidate: unknown,
  authorityKeys: readonly string[],
): { store: RelayHintStore; refused: RelayHintRefusal | null } {
  if (candidate === null || candidate === undefined) return { store, refused: null };
  const h = parseRelayHint(candidate);
  if (!h) return { store, refused: "malformed" };
  const v = verifyRelayHint(h, authorityKeys);
  if (!v.ok) return { store, refused: v.reason };
  if (h.seq <= store.highestSeq) return { store, refused: "stale" };
  return { store: { highestSeq: h.seq, hint: h }, refused: null };
}

/**
 * The addresses to try when DNS fails, in order: the stored hint's if it is
 * in its window and still verifies against the authority now, then the
 * compiled-in seed (deduplicated). Never throws.
 */
export function relayHintAddresses(
  store: RelayHintStore,
  authorityKeys: readonly string[],
  seed: readonly string[],
  now: number,
): string[] {
  const out: string[] = [];
  const h = store.hint;
  if (h && now >= h.validFrom && now < h.validUntil && verifyRelayHint(h, authorityKeys).ok) out.push(...h.addresses);
  for (const a of seed) if (!out.includes(a)) out.push(a);
  return out;
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(h: string): Bytes {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
