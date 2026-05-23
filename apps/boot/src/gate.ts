/**
 * The identity-based gate for the dedicated boot worker
 * (boot.flagshipserver.com).
 *
 * Every request to a /api/boot/* route is authorized by WHO SIGNED IT,
 * NOT by the verb. The signature travels in an `Authorization` header
 * (never the URL/query), is verified against the CANONICAL id-cert
 * source (the identity plane's directory), and is bound to the exact
 * resource it touches.
 *
 * Two principals:
 *   - BOX  — the server's STK (the box's identity key). May READ its own
 *            lease + poll for a response + announce a request.
 *   - OWNER — the account IRK. May WRITE — deposit a lease, revoke a
 *            lease, post a sealed response.
 *
 * Five rules applied to EVERY route (in order):
 *   1. Reject if malformed (before any work).
 *   2. Verify the Ed25519 signature carried in `Authorization`.
 *   3. Freshness window (±5 min on the signed timestamp) + a nonce;
 *      reject stale / replayed.
 *   4. AUTHZ BINDING (not just authn): the box STK must equal the
 *      directory STK for that serverDomain; the owner IRK must equal the
 *      account IRK that owns that serverDomain's account. A box can only
 *      touch ITS OWN lease/response; an owner only their own account.
 *   5. `Cache-Control: no-store` on all responses (applied by the
 *      router, not here).
 *
 * The gate NEVER sees plaintext keys — leases/responses are ciphertext.
 * It only verifies signatures and binds principals to the directory.
 */

import { ed } from "@flagship/protocol";
import { equalHex } from "./hex.js";
import type { DirectoryClient } from "./directory.js";
import type { NonceStore } from "./nonceStore.js";

/** The canonical-bytes tag for a boot-worker request authorization. */
const TAG_BOOT_AUTH = "flagship/boot-auth/v1";

/** Default freshness window — ±5 min on the signed `issuedAt`. */
export const DEFAULT_MAX_AGE_MS = 5 * 60_000;

/** Hex regexes — 32-byte pubkey / nonce, 64-byte signature. */
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export type GateRole = "box" | "owner";

/**
 * The signed authorization envelope. Carried in the `Authorization`
 * header as:
 *
 *   Authorization: Flagship-Boot-v1 <base64url(JSON of GateEnvelope)>
 *
 * The signature is over the canonical bytes of EVERYTHING except the
 * signature itself, so a captured envelope cannot be retargeted to a
 * different role / serverDomain / method / path / body.
 */
export interface GateEnvelope {
  /** "box" ⇒ STK-signed (reads); "owner" ⇒ IRK-signed (writes). */
  role: GateRole;
  /** The box FQDN the request is scoped to (e.g. kitchen.john.flagship.services). */
  serverDomain: string;
  /** HTTP method, uppercased — bound so a GET sig can't replay as a DELETE. */
  method: string;
  /** Request path (no query) — bound so a sig for one route can't hit another. */
  path: string;
  /** The claimed signer's Ed25519 pubkey, hex (32 bytes). */
  pubKeyHex: string;
  /** 32-byte per-request nonce, hex — single-use within the freshness window. */
  nonceHex: string;
  /** Signed wall-clock ms — freshness anchor. */
  issuedAt: number;
  /** Ed25519 signature over the canonical bytes, hex (64 bytes). */
  signatureHex: string;
}

const AUTH_SCHEME = "Flagship-Boot-v1";

/** The authorization header name (case-insensitive on the wire). */
export const AUTH_HEADER = "Authorization";

/**
 * Canonical bytes the signature covers. `|`-separated with the
 * `flagship/<purpose>/v1` tag prefix, matching the house convention.
 * Every field that the verifier binds is included; the signature itself
 * is NOT.
 */
function canonicalBootAuth(e: Omit<GateEnvelope, "signatureHex">): Uint8Array {
  return new TextEncoder().encode(
    [
      TAG_BOOT_AUTH,
      e.role,
      e.serverDomain,
      e.method.toUpperCase(),
      e.path,
      e.pubKeyHex.toLowerCase(),
      e.nonceHex.toLowerCase(),
      e.issuedAt,
    ].join("|"),
  );
}

/** Build the `Authorization` header value for a signed envelope (clients). */
export function encodeAuthHeader(e: GateEnvelope): string {
  const json = JSON.stringify(e);
  return `${AUTH_SCHEME} ${b64urlEncode(new TextEncoder().encode(json))}`;
}

/**
 * Sign a boot-worker request. The caller supplies the 32-byte Ed25519
 * private seed (STK seed for a box, IRK seed for an owner). Returns the
 * full `Authorization` header value.
 */
export function signBootRequest(
  args: {
    role: GateRole;
    serverDomain: string;
    method: string;
    path: string;
    pubKeyHex: string;
    nonceHex: string;
    issuedAt: number;
  },
  privSeed: Uint8Array,
): string {
  const sig = ed.sign(canonicalBootAuth(args), privSeed);
  return encodeAuthHeader({ ...args, signatureHex: bytesToHexLocal(sig) });
}

export type GateResult =
  | { ok: true; role: GateRole; serverDomain: string; pubKeyHex: string; nonceHex: string }
  | { ok: false; status: number; error: string };

export interface GateDeps {
  directory: DirectoryClient;
  nonces: NonceStore;
  maxAgeMs?: number;
  now?: () => number;
}

/**
 * Parse + verify the `Authorization` envelope against the rules above,
 * for a route that requires `requiredRole`.
 *
 * `serverDomain` / `method` / `path` are the values the ROUTER resolved
 * from the actual request — the gate asserts the envelope was signed for
 * exactly these, so a sig minted for one resource can't be replayed
 * against another (rule 1 + binding).
 */
export async function gate(
  deps: GateDeps,
  required: {
    role: GateRole;
    serverDomain: string;
    method: string;
    path: string;
  },
  authHeader: string | null,
): Promise<GateResult> {
  const now = deps.now ?? (() => Date.now());
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  // ── Rule 1: malformed → reject before any work. ──────────────────────
  const parsed = parseAuthHeader(authHeader);
  if (!parsed) return deny(400, "malformed authorization");
  const e = parsed;

  if (e.role !== "box" && e.role !== "owner") return deny(400, "unknown role");
  if (typeof e.serverDomain !== "string" || e.serverDomain.length === 0) {
    return deny(400, "malformed serverDomain");
  }
  if (typeof e.method !== "string" || typeof e.path !== "string") {
    return deny(400, "malformed request binding");
  }
  if (!HEX64.test(e.pubKeyHex.toLowerCase())) return deny(400, "pubKey must be 32 bytes hex");
  if (!HEX64.test(e.nonceHex.toLowerCase())) return deny(400, "nonce must be 32 bytes hex");
  if (!HEX128.test(e.signatureHex.toLowerCase())) return deny(400, "signature must be 64 bytes hex");
  if (typeof e.issuedAt !== "number" || !Number.isFinite(e.issuedAt)) {
    return deny(400, "malformed issuedAt");
  }

  // The envelope MUST match the role the route requires + the exact
  // resource the router resolved. Binding the method/path/serverDomain
  // here is what makes the signature non-transferable across routes.
  if (e.role !== required.role) return deny(403, "wrong principal for this route");
  if (!equalHex(e.serverDomain.toLowerCase(), required.serverDomain.toLowerCase())) {
    return deny(403, "serverDomain binding mismatch");
  }
  if (e.method.toUpperCase() !== required.method.toUpperCase()) {
    return deny(403, "method binding mismatch");
  }
  if (e.path !== required.path) return deny(403, "path binding mismatch");

  // ── Rule 3 (part a): freshness window. ───────────────────────────────
  // Checked BEFORE the directory round-trip so a stale envelope is cheap
  // to reject and never reaches the identity plane.
  if (Math.abs(now() - e.issuedAt) > maxAgeMs) return deny(403, "stale request");

  // ── Rule 2: verify the Ed25519 signature over the canonical bytes. ──
  let pubKey: Uint8Array;
  let sig: Uint8Array;
  try {
    pubKey = hexToBytesLocal(e.pubKeyHex);
    sig = hexToBytesLocal(e.signatureHex);
  } catch {
    return deny(400, "invalid hex");
  }
  let sigOk = false;
  try {
    sigOk = ed.verify(sig, canonicalBootAuth(stripSig(e)), pubKey);
  } catch {
    sigOk = false;
  }
  if (!sigOk) return deny(403, "invalid signature");

  // ── Rule 4: AUTHZ BINDING — bind the verified pubkey to the directory.
  // For a box: the STK must be the directory-bound STK for serverDomain.
  // For an owner: the IRK must be the account IRK that OWNS serverDomain.
  // A foreign key — even with a valid self-signature — is rejected here,
  // and cross-account access (box A reaching box B's lease) is impossible
  // because the binding is resolved from serverDomain, not from the
  // caller's claim.
  if (e.role === "box") {
    const dirStk = await deps.directory.boxStkForDomain(e.serverDomain);
    if (dirStk === null) return deny(404, "unknown server");
    if (!equalHex(e.pubKeyHex, dirStk)) return deny(403, "box STK not bound to this server");
  } else {
    const dirIrk = await deps.directory.ownerIrkForDomain(e.serverDomain);
    if (dirIrk === null) return deny(404, "unknown server");
    if (!equalHex(e.pubKeyHex, dirIrk)) return deny(403, "owner IRK does not own this server");
  }

  // ── Rule 3 (part b): nonce — single-use within the freshness window. ──
  // Done LAST so a request that fails any earlier check (and therefore
  // never executed) doesn't burn its nonce. The store keys the nonce by
  // (role, serverDomain, nonce) so two principals can't shadow each
  // other, and expires it after the freshness window.
  const fresh = await deps.nonces.claim(
    `${e.role}|${e.serverDomain.toLowerCase()}|${e.nonceHex.toLowerCase()}`,
    now() + maxAgeMs,
    now(),
  );
  if (!fresh) return deny(403, "replayed nonce");

  return {
    ok: true,
    role: e.role,
    serverDomain: e.serverDomain,
    pubKeyHex: e.pubKeyHex.toLowerCase(),
    nonceHex: e.nonceHex.toLowerCase(),
  };
}

function stripSig(e: GateEnvelope): Omit<GateEnvelope, "signatureHex"> {
  const { signatureHex: _sig, ...rest } = e;
  return rest;
}

function deny(status: number, error: string): GateResult {
  return { ok: false, status, error };
}

/**
 * Parse `Authorization: Flagship-Boot-v1 <base64url-json>` into a
 * GateEnvelope. Returns null on any structural failure — the gate maps
 * that to a 400. Tolerant of the scheme token's case.
 */
function parseAuthHeader(header: string | null): GateEnvelope | null {
  if (!header) return null;
  const sp = header.indexOf(" ");
  if (sp <= 0) return null;
  const scheme = header.slice(0, sp);
  if (scheme.toLowerCase() !== AUTH_SCHEME.toLowerCase()) return null;
  const payload = header.slice(sp + 1).trim();
  if (!payload) return null;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const o = json as Record<string, unknown>;
  if (
    typeof o.role !== "string" ||
    typeof o.serverDomain !== "string" ||
    typeof o.method !== "string" ||
    typeof o.path !== "string" ||
    typeof o.pubKeyHex !== "string" ||
    typeof o.nonceHex !== "string" ||
    typeof o.issuedAt !== "number" ||
    typeof o.signatureHex !== "string"
  ) {
    return null;
  }
  return {
    role: o.role as GateRole,
    serverDomain: o.serverDomain,
    method: o.method,
    path: o.path,
    pubKeyHex: o.pubKeyHex,
    nonceHex: o.nonceHex,
    issuedAt: o.issuedAt,
    signatureHex: o.signatureHex,
  };
}

// ── base64url (no padding) — exported for the client helpers + tests. ──

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexToBytesLocal(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(v)) throw new Error("non-hex");
    out[i] = v;
  }
  return out;
}

function bytesToHexLocal(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
