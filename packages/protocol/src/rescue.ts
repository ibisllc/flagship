/**
 * Rescue session: the owner's phone reaches its own box with no help from
 * `.com` or `.services` and takes a backup off it (docs/data-sovereignty.md).
 *
 * Two signed messages, both bound to the TLS leaf certificate of the
 * connection they travel on, so neither needs a certificate authority, a
 * working DNS name or an unexpired certificate:
 *
 *   flagship/rescue-hello/v1|<serverDomain>|<clientNonce>|<boxNonce>|<certSha256>|<issuedAt>
 *     signed by the BOX (its STK). The phone derives the same STK from its
 *     account key, so it knows the box without asking anyone. `certSha256` is
 *     the leaf certificate the box is presenting on this connection: the phone
 *     compares it with what its own TLS stack saw, so a machine in the middle
 *     (which must present another certificate) is caught.
 *
 *   flagship/rescue-session/v1|<serverDomain>|<clientNonce>|<boxNonce>|<certSha256>|<issuedAt>
 *     signed by the OWNER with the sensitive-order key (the admin root on a
 *     box that pins one, else the IRK). It answers exactly one hello: the
 *     box's nonce is spent by it, and the certificate hash it names must be
 *     the box's own, so a signature gathered on one connection cannot be
 *     replayed on another.
 *
 * All nonces are 16 bytes, lowercase hex.
 */
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import { hex, legacyFieldGuard, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import type { Bytes } from "./types.js";

export const TAG_RESCUE_HELLO = "flagship/rescue-hello/v1";
export const TAG_RESCUE_SESSION = "flagship/rescue-session/v1";
const TAG_RESCUE_DISCOVERY = "flagship/lan-discovery/v1";

/** A hello and the order that answers it are good for this long. */
export const RESCUE_HELLO_TTL_MS = 2 * 60_000;
const CLOCK_SKEW_MS = 2 * 60_000;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface RescueExchange {
  /** The box's FQDN. */
  serverDomain: string;
  /** Chosen by the phone: 16 random bytes. */
  clientNonce: string;
  /** Chosen by the box: 16 random bytes, spent by one session order. */
  boxNonce: string;
  /** SHA-256 of the box's leaf certificate (DER), lowercase hex. */
  certSha256: string;
  /** Unix ms. */
  issuedAt: number;
}

export type RescueHello = RescueExchange;
export type RescueSessionOrder = RescueExchange;

function canonical(tag: string, x: RescueExchange): Bytes {
  if (x.serverDomain.length === 0) throw new Error("rescue: empty serverDomain");
  legacyFieldGuard("serverDomain", x.serverDomain);
  if (!HEX32.test(x.clientNonce)) throw new Error("rescue: bad clientNonce");
  if (!HEX32.test(x.boxNonce)) throw new Error("rescue: bad boxNonce");
  if (!HEX64.test(x.certSha256)) throw new Error("rescue: bad certSha256");
  if (!Number.isSafeInteger(x.issuedAt) || x.issuedAt < 0) throw new Error("rescue: bad issuedAt");
  return new TextEncoder().encode([tag, x.serverDomain, x.clientNonce, x.boxNonce, x.certSha256, String(x.issuedAt)].join("|"));
}

export const rescueHelloCanonicalBytes = (h: RescueHello): Bytes => canonical(TAG_RESCUE_HELLO, h);
export const rescueSessionCanonicalBytes = (o: RescueSessionOrder): Bytes => canonical(TAG_RESCUE_SESSION, o);

export function signRescueHello(h: RescueHello, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(rescueHelloCanonicalBytes(h));
}
export function signRescueSession(o: RescueSessionOrder, signer: MsgSigner): Bytes {
  return resolveMsgSigner(signer)(rescueSessionCanonicalBytes(o));
}

/** Never throws: a malformed message simply fails. */
export function verifyRescueHello(h: RescueHello, sig: Bytes, stkPub: Bytes): boolean {
  try {
    return ed.verify(sig, rescueHelloCanonicalBytes(h), stkPub);
  } catch {
    return false;
  }
}
/** Never throws: a malformed order simply fails. */
export function verifyRescueSession(o: RescueSessionOrder, sig: Bytes, pub: Bytes): boolean {
  try {
    return ed.verify(sig, rescueSessionCanonicalBytes(o), pub);
  } catch {
    return false;
  }
}

/** Shape-check an untrusted JSON exchange (no signature check). */
export function parseRescueExchange(v: unknown): RescueExchange | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.serverDomain !== "string" || typeof r.clientNonce !== "string" || typeof r.boxNonce !== "string" || typeof r.certSha256 !== "string") return null;
  if (typeof r.issuedAt !== "number" || !Number.isSafeInteger(r.issuedAt)) return null;
  const x: RescueExchange = { serverDomain: r.serverDomain, clientNonce: r.clientNonce, boxNonce: r.boxNonce, certSha256: r.certSha256, issuedAt: r.issuedAt };
  try {
    canonical(TAG_RESCUE_HELLO, x);
  } catch {
    return null;
  }
  return x;
}

export type RescueHelloCheck = { ok: true } | { ok: false; reason: string };

/**
 * What the PHONE checks before it signs anything: the hello is signed by the
 * STK it derived for this server, answers its own nonce, is current, and
 * names the very certificate its TLS stack is looking at. `seenCertSha256` is
 * the hash of the leaf the connection actually presented (expired or not).
 */
export function checkRescueHello(
  h: RescueHello,
  sig: Bytes,
  stkPub: Bytes,
  expect: { serverDomain: string; clientNonce: string; seenCertSha256: string; now: number },
): RescueHelloCheck {
  if (!verifyRescueHello(h, sig, stkPub)) return { ok: false, reason: "bad-signature" };
  if (h.serverDomain.toLowerCase() !== expect.serverDomain.toLowerCase()) return { ok: false, reason: "wrong-server" };
  if (h.clientNonce !== expect.clientNonce) return { ok: false, reason: "wrong-nonce" };
  if (h.certSha256 !== expect.seenCertSha256.toLowerCase()) return { ok: false, reason: "cert-mismatch" };
  if (h.issuedAt > expect.now + CLOCK_SKEW_MS) return { ok: false, reason: "not-yet-valid" };
  if (expect.now - h.issuedAt > RESCUE_HELLO_TTL_MS) return { ok: false, reason: "expired" };
  return { ok: true };
}

/**
 * The opaque id a box announces on its local network so its owner's phone can
 * find it without anyone else learning which server it is: the first 8 bytes
 * of HMAC-SHA256 keyed with the box's STK public key (which only the box and
 * its owner's devices have seen on that network) over the server's name.
 * The phone derives the STK public key from its account key, so it can
 * recompute the id for each of its servers and match.
 */
export function rescueDiscoveryId(stkPub: Bytes, serverDomain: string): string {
  legacyFieldGuard("serverDomain", serverDomain);
  return hex(hmac(sha256, stkPub, new TextEncoder().encode(`${TAG_RESCUE_DISCOVERY}|${serverDomain.toLowerCase()}`)).slice(0, 8));
}
