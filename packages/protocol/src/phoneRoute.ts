/**
 * The phone's bare `<account>.<apex>` route (plan H2/H3; decisions in docs/architecture-v2/issuance-and-lease-records.md
 * §4 "Phone routing", wire protocol in phone-route.md). Pure rules shared by `.com` (the ledger), the relay (claim
 * checks, routing) and the phones (vectors): who may claim, the relay-issued generation and its compare-and-set
 * ledger, the claim freshness and nonce rules, the phone certificate's CSR, and the phone endpoint's request policy.
 */
import { sha256 } from "@noble/hashes/sha256";
import { requireMasterAdmin, type AdminGrantView } from "./adminAuthority.js";
import { hex } from "./canonicalBase.js";
import { ed } from "./edSync.js";
import { canonicalRouteClaim, verifyServingRecord, type RouteClaim } from "./servingAuthority.js";
import type { Bytes } from "./types.js";

/** The ledger's routing lease. */
export const PHONE_ROUTE_LEASE_MS = 60_000;
/** How often the holding relay renews it. */
export const PHONE_ROUTE_RENEW_MS = 15_000;
/** A relay stops routing new connections when its last confirmed acquire/renew is older than this. */
export const PHONE_ROUTE_CONFIRMED_MS = 30_000;
/** A claim's `issuedAt` may differ from the relay's clock by at most this. */
export const PHONE_ROUTE_CLAIM_SKEW_MS = 60_000;
/** A session nonce is good for one claim within this. */
export const PHONE_ROUTE_CHALLENGE_TTL_MS = 30_000;
/** The relay pings the phone this often… */
export const PHONE_TUNNEL_PING_MS = 15_000;
/** …and ends the tunnel after this long without hearing from it. */
export const PHONE_TUNNEL_SILENCE_MS = 45_000;
/** A relay holding standbys re-reads the ledger this often (the bound when a vacancy push is lost). */
export const PHONE_ROUTE_STANDBY_POLL_MS = 15_000;
/** While it holds a route the relay re-reads eligibility this often (the bound when a push is lost). */
export const PHONE_ROUTE_ELIGIBILITY_RECHECK_MS = 30_000;
/** On revocation, open streams to the phone are closed within this. */
export const PHONE_ROUTE_REVOKE_CLOSE_MS = 5_000;
/** `/phone-tunnel` connections a relay keeps open from one client address (security review 2026-11-02, M4). */
export const PHONE_TUNNEL_MAX_PER_IP = 8;
/** `begin`s a relay takes from one client address: a token bucket of this burst, refilled at this rate per minute. */
export const PHONE_BEGIN_BURST = 10;
export const PHONE_BEGIN_PER_MINUTE = 20;
/** A relay reuses a ledger read for one hostname this long. */
export const PHONE_LEDGER_READ_CACHE_MS = 2_000;
/** A relay reuses `.com`'s eligibility answer for one account this long. */
export const PHONE_ELIGIBILITY_CACHE_MS = 5_000;
/** A held phone certificate is reordered this long before it expires. */
export const PHONE_CERT_RENEW_BEFORE_MS = 30 * 86_400_000;
/** After a failed order, the next one waits at least this long. */
export const PHONE_CERT_RETRY_AFTER_MS = 6 * 3_600_000;

const ACCOUNT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

/** The phone's name: exactly `<account>.<apex>`. */
export function phoneHostname(account: string, apex: string): string {
  const a = account.toLowerCase();
  if (!ACCOUNT.test(a)) throw new Error("account must be a lowercase account name");
  return `${a}.${apex.toLowerCase()}`;
}

/** The account when `sni` is exactly a bare `<account>.<apex>` name, else null. */
export function barePhoneAccount(sni: string, apex: string): string | null {
  const lower = sni.toLowerCase();
  const suffix = `.${apex.toLowerCase()}`;
  if (!lower.endsWith(suffix)) return null;
  const head = lower.slice(0, -suffix.length);
  return ACCOUNT.test(head) ? head : null;
}

// ── eligibility ───────────────────────────────────────────────────────────

/**
 * May `phoneRoutePub` claim the account's bare name? Only an admin-root-granted `admin` device (`requireMasterAdmin`
 * on the account's active grants); the bare admin root signs orders, not route claims, and the IRK and box keys never
 * qualify. Returns the grant's expiry so the relay can re-check then.
 */
export function phoneRouteEligibility(
  phoneRoutePub: string,
  account: string,
  adminRootPubHex: string | null | undefined,
  grants: readonly AdminGrantView[],
  now: number,
): { ok: true; expiresAt: number } | { ok: false; reason: string } {
  const pub = phoneRoutePub.toLowerCase();
  if (!HEX64.test(pub)) return { ok: false, reason: "bad key" };
  if (!adminRootPubHex) return { ok: false, reason: "no admin root" };
  if (pub === adminRootPubHex.toLowerCase()) return { ok: false, reason: "the admin root is not a phone key" };
  const view = grants.find((g) => hex(g.grant.devicePubKey).toLowerCase() === pub && g.revokedAt == null);
  if (!view) return { ok: false, reason: "no active admin grant" };
  const d = requireMasterAdmin(pub, account, adminRootPubHex, grants, now);
  return d.ok ? { ok: true, expiresAt: view.grant.expiresAt } : { ok: false, reason: d.reason };
}

// ── the begin (relay mesh, relay-mesh.md §8.2) ────────────────────────────

/** Most grants a phone sends in `begin` (a mesh relay reads no more). */
export const PHONE_BEGIN_MAX_GRANTS = 8;

/** One grant of the phone's eligibility proof, as `.com`'s `/api/users/:u/device-grants` lists it. */
export interface PhoneBeginGrant {
  grant: {
    grantId: string;
    username: string;
    deviceId: string;
    devicePubHex: string;
    scopes: string[];
    issuedAt: number;
    expiresAt: number;
  };
  signatureHex: string;
  signerRoot: "admin-root";
}

export interface PhoneBeginMessage {
  type: "begin";
  account: string;
  grants: PhoneBeginGrant[];
}

/**
 * The phone's own admin grant chain for `begin`, picked from the `/device-grants` body: grants naming this device key
 * and account, signed by the admin root, with the `admin` scope and not yet expired; the latest expiry first (then the
 * smaller grant id), at most {@link PHONE_BEGIN_MAX_GRANTS}. The relay still verifies every one.
 */
export function phoneBeginGrants(body: unknown, account: string, devicePub: string, now: number): PhoneBeginGrant[] {
  const listed = typeof body === "object" && body !== null && Array.isArray((body as { grants?: unknown }).grants) ? (body as { grants: unknown[] }).grants : [];
  const me = devicePub.toLowerCase();
  const user = account.toLowerCase();
  const out: PhoneBeginGrant[] = [];
  for (const raw of listed) {
    if (typeof raw !== "object" || raw === null) continue;
    const g = raw as Record<string, unknown>;
    if (
      typeof g.grantId !== "string" || typeof g.username !== "string" || typeof g.deviceId !== "string" ||
      typeof g.devicePubHex !== "string" || !Array.isArray(g.scopes) || !Number.isSafeInteger(g.issuedAt) ||
      !Number.isSafeInteger(g.expiresAt) || typeof g.signatureHex !== "string" || !/^[0-9a-fA-F]{128}$/.test(g.signatureHex)
    ) continue;
    const scopes = g.scopes.filter((s): s is string => typeof s === "string");
    if (g.devicePubHex.toLowerCase() !== me || g.username.toLowerCase() !== user || g.signerRoot !== "admin-root") continue;
    if (!scopes.includes("admin") || (g.expiresAt as number) <= now) continue;
    out.push({
      grant: {
        grantId: g.grantId,
        username: g.username,
        deviceId: g.deviceId,
        devicePubHex: me,
        scopes,
        issuedAt: g.issuedAt as number,
        expiresAt: g.expiresAt as number,
      },
      signatureHex: g.signatureHex.toLowerCase(),
      signerRoot: "admin-root",
    });
  }
  out.sort((a, b) => b.grant.expiresAt - a.grant.expiresAt || (a.grant.grantId < b.grant.grantId ? -1 : a.grant.grantId > b.grant.grantId ? 1 : 0));
  return out.slice(0, PHONE_BEGIN_MAX_GRANTS);
}

/** `{type:"begin", account, grants}`; a relay without the mesh ignores `grants`. */
export function phoneBeginMessage(account: string, grants: readonly PhoneBeginGrant[]): PhoneBeginMessage {
  return { type: "begin", account: account.toLowerCase(), grants: [...grants] };
}

// ── the claim ─────────────────────────────────────────────────────────────

export type RouteClaimRefusal =
  | "malformed"
  | "wrong-account"
  | "wrong-hostname"
  | "wrong-session"
  | "wrong-generation"
  | "stale"
  | "bad-signature";

/**
 * Check a claim against the session that offered it: the hostname is exactly the account's bare name under `apex`,
 * the nonce and generation are the ones this session offered, `issuedAt` is within the skew, and the signature
 * verifies under `phoneRoutePub`. Eligibility and the ledger's compare-and-set are separate steps.
 */
export function checkRouteClaim(o: {
  claim: RouteClaim;
  signature: string;
  apex: string;
  account: string;
  sessionNonce: string;
  generation: number;
  now: number;
}): { ok: true } | { ok: false; code: RouteClaimRefusal } {
  const c = o.claim;
  try {
    canonicalRouteClaim(c);
  } catch {
    return { ok: false, code: "malformed" };
  }
  if (c.account !== o.account) return { ok: false, code: "wrong-account" };
  if (c.hostname !== phoneHostname(o.account, o.apex)) return { ok: false, code: "wrong-hostname" };
  if (!HEX32.test(o.sessionNonce) || c.sessionNonce !== o.sessionNonce) return { ok: false, code: "wrong-session" };
  if (c.generation !== o.generation) return { ok: false, code: "wrong-generation" };
  if (Math.abs(c.issuedAt - o.now) > PHONE_ROUTE_CLAIM_SKEW_MS) return { ok: false, code: "stale" };
  if (!verifyServingRecord("route-claim", c, o.signature, c.phoneRoutePub)) return { ok: false, code: "bad-signature" };
  return { ok: true };
}

// ── the ledger (`.com`'s single source of truth, one entry per bare hostname) ─

export interface PhoneRouteHolder {
  relayId: string;
  /** The relay's id for the phone's tunnel session. */
  sessionId: string;
  phoneRoutePub: string;
}

export interface PhoneRouteEntry {
  /** The last generation committed; 0 before any. Never goes down, never reused. */
  generation: number;
  holder: PhoneRouteHolder | null;
  /** The holder's routing lease; past it the entry has no holder. */
  leaseUntil: number;
}

export type LedgerResult =
  | { ok: true; entry: PhoneRouteEntry }
  | { ok: false; code: "route-held" | "stale-generation" | "not-holder" | "expired" | "malformed"; entry: PhoneRouteEntry };

export function emptyPhoneRouteEntry(): PhoneRouteEntry {
  return { generation: 0, holder: null, leaseUntil: 0 };
}

/** The entry as seen at `now`: a lapsed lease has no holder. */
export function liveEntry(e: PhoneRouteEntry, now: number): PhoneRouteEntry {
  return e.holder && e.leaseUntil > now ? e : { generation: e.generation, holder: null, leaseUntil: 0 };
}

function validHolder(h: PhoneRouteHolder): boolean {
  return (
    typeof h?.relayId === "string" && h.relayId.length > 0 && h.relayId.length <= 64 &&
    typeof h.sessionId === "string" && h.sessionId.length > 0 && h.sessionId.length <= 64 &&
    typeof h.phoneRoutePub === "string" && HEX64.test(h.phoneRoutePub)
  );
}

/**
 * Commit `generation` for `holder` only while the route is vacant (no holder, or its lease lapsed: the ledger decides,
 * never the claimant) and only for exactly the next generation (owner, 2026-11-01: no preemption).
 */
export function ledgerAcquire(e: PhoneRouteEntry, generation: number, holder: PhoneRouteHolder, now: number): LedgerResult {
  if (!Number.isSafeInteger(generation) || generation < 1 || !validHolder(holder)) return { ok: false, code: "malformed", entry: e };
  if (liveEntry(e, now).holder) return { ok: false, code: "route-held", entry: e };
  if (generation !== e.generation + 1) return { ok: false, code: "stale-generation", entry: e };
  return { ok: true, entry: { generation, holder: { ...holder }, leaseUntil: now + PHONE_ROUTE_LEASE_MS } };
}

/** Extend the lease only for the current generation's own session, and only while it has not lapsed. */
export function ledgerRenew(e: PhoneRouteEntry, generation: number, sessionId: string, now: number): LedgerResult {
  if (generation !== e.generation) return { ok: false, code: "stale-generation", entry: e };
  if (!e.holder || e.holder.sessionId !== sessionId) return { ok: false, code: "not-holder", entry: e };
  if (e.leaseUntil <= now) return { ok: false, code: "expired", entry: e };
  return { ok: true, entry: { ...e, leaseUntil: now + PHONE_ROUTE_LEASE_MS } };
}

/** Give the route up (tunnel gone, voluntary release, revocation). The generation stays. */
export function ledgerRelease(e: PhoneRouteEntry, generation: number, sessionId: string): LedgerResult {
  if (generation !== e.generation) return { ok: false, code: "stale-generation", entry: e };
  if (!e.holder || e.holder.sessionId !== sessionId) return { ok: false, code: "not-holder", entry: e };
  return { ok: true, entry: { generation: e.generation, holder: null, leaseUntil: 0 } };
}

// ── the holder's voluntary release and the presence hello ─────────────────

export const TAG_ROUTE_RELEASE = "flagship/route-release/v1";
export const TAG_PHONE_PRESENCE = "flagship/phone-presence/v1";

/** The holder gives the route up: bound to the claim it holds (its generation and session nonce). */
export interface RouteRelease {
  account: string;
  phoneRoutePub: string;
  hostname: string;
  generation: number;
  sessionNonce: string;
  issuedAt: number;
}

export function canonicalRouteRelease(r: RouteRelease): Bytes {
  // Same fields and rules as the claim it ends, under its own tag.
  const claimBytes = canonicalRouteClaim(r);
  const text = new TextDecoder().decode(claimBytes);
  return new TextEncoder().encode(TAG_ROUTE_RELEASE + text.slice("flagship/route-claim/v1".length));
}

/** "I'm here": an account device says hello to the phone holding the bare name (it records who and when). */
export interface PhonePresence {
  account: string;
  devicePub: string;
  hostname: string;
  issuedAt: number;
}

export function canonicalPhonePresence(p: PhonePresence): Bytes {
  if (!ACCOUNT.test(p.account)) throw new Error("account must be a lowercase account name");
  if (!HEX64.test(p.devicePub)) throw new Error("devicePub must be 64 lowercase hex");
  if (!p.hostname.startsWith(`${p.account}.`) || p.hostname.split(".").length < 3 || p.hostname !== p.hostname.toLowerCase() || p.hostname.includes("|")) {
    throw new Error("hostname must be the account's own bare name");
  }
  if (!Number.isSafeInteger(p.issuedAt) || p.issuedAt < 0) throw new Error("issuedAt must be a safe integer");
  return new TextEncoder().encode([TAG_PHONE_PRESENCE, p.account, p.devicePub, p.hostname, p.issuedAt].join("|"));
}

function unhex(h: string): Bytes {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function edVerifyHex(msg: Bytes, sigHex: string, pubHex: string): boolean {
  try {
    if (!/^[0-9a-f]{128}$/.test(sigHex) || !HEX64.test(pubHex)) return false;
    return ed.verify(unhex(sigHex), msg, unhex(pubHex));
  } catch {
    return false;
  }
}

/** The relay's check of a release: the held claim's key, generation and nonce, fresh, signed. */
export function checkRouteRelease(o: {
  release: RouteRelease;
  signature: string;
  held: { account: string; hostname: string; generation: number; phoneRoutePub: string; sessionNonce: string };
  now: number;
}): { ok: true } | { ok: false; code: RouteClaimRefusal | "not-holder" } {
  const r = o.release;
  let bytes: Bytes;
  try {
    bytes = canonicalRouteRelease(r);
  } catch {
    return { ok: false, code: "malformed" };
  }
  const h = o.held;
  if (r.account !== h.account || r.hostname !== h.hostname || r.phoneRoutePub !== h.phoneRoutePub) return { ok: false, code: "not-holder" };
  if (r.generation !== h.generation) return { ok: false, code: "wrong-generation" };
  if (r.sessionNonce !== h.sessionNonce) return { ok: false, code: "wrong-session" };
  if (Math.abs(r.issuedAt - o.now) > PHONE_ROUTE_CLAIM_SKEW_MS) return { ok: false, code: "stale" };
  return edVerifyHex(bytes, o.signature, r.phoneRoutePub) ? { ok: true } : { ok: false, code: "bad-signature" };
}

/** The holder's check of a presence hello: its own bare name, fresh, signed by the key it names. */
export function checkPhonePresence(p: PhonePresence, signature: string, hostname: string, now: number): boolean {
  try {
    if (p.hostname !== hostname || Math.abs(p.issuedAt - now) > PHONE_ROUTE_CLAIM_SKEW_MS) return false;
    return edVerifyHex(canonicalPhonePresence(p), signature, p.devicePub);
  } catch {
    return false;
  }
}

// ── the phone certificate's CSR (PKCS #10, ECDSA P-256, exactly one name) ─

function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v >>= 8) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}
function tlv(tag: number, body: Bytes): Bytes {
  const len = derLen(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}
function cat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function oid(dotted: string): Bytes {
  const parts = dotted.split(".").map(Number);
  const out = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const bytes: number[] = [];
    let v = p;
    do {
      bytes.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < bytes.length - 1; i++) bytes[i]! |= 0x80;
    out.push(...bytes);
  }
  return tlv(0x06, new Uint8Array(out));
}
const ascii = (s: string) => new TextEncoder().encode(s);
const SEQ = 0x30;
const SET = 0x31;

/**
 * The CertificationRequestInfo for the phone's key and name: version 0, subject CN=`hostname` (UTF8String), the
 * P-256 SubjectPublicKeyInfo, and one extensionRequest with a subjectAltName of exactly one dNSName. Deterministic,
 * so TS, Swift and Kotlin must produce the same bytes (vectors in test-vectors/phone-route/).
 *
 * @param publicKey the uncompressed SEC1 point (65 bytes, 0x04…)
 */
export function phoneCsrInfo(publicKey: Bytes, hostname: string): Bytes {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) throw new Error("publicKey must be an uncompressed P-256 point");
  if (!/^[a-z0-9.-]{1,253}$/.test(hostname) || hostname.includes("*")) throw new Error("hostname must be one lowercase DNS name");
  const name = tlv(SEQ, tlv(SET, tlv(SEQ, cat(oid("2.5.4.3"), tlv(0x0c, ascii(hostname))))));
  const spki = tlv(SEQ, cat(tlv(SEQ, cat(oid("1.2.840.10045.2.1"), oid("1.2.840.10045.3.1.7"))), tlv(0x03, cat(new Uint8Array([0]), publicKey))));
  const san = tlv(SEQ, cat(oid("2.5.29.17"), tlv(0x04, tlv(SEQ, tlv(0x82, ascii(hostname))))));
  const attr = tlv(SEQ, cat(oid("1.2.840.113549.1.9.14"), tlv(SET, tlv(SEQ, san))));
  return tlv(SEQ, cat(tlv(0x02, new Uint8Array([0])), name, spki, tlv(0xa0, attr)));
}

/** The full CSR from its info and a DER ECDSA-SHA256 signature over the info. */
export function phoneCsr(info: Bytes, signatureDer: Bytes): Bytes {
  return tlv(SEQ, cat(info, tlv(SEQ, oid("1.2.840.10045.4.3.2")), tlv(0x03, cat(new Uint8Array([0]), signatureDer))));
}

export function csrSha256Hex(csr: Bytes): string {
  return hex(sha256(csr));
}

/** Should the phone order a certificate now? Reuse a held one until 30 days before its end; back off after a failure. */
export function phoneCertNeedsOrder(o: { notAfter: number | null; lastFailureAt: number | null; now: number }): boolean {
  if (o.lastFailureAt !== null && o.now - o.lastFailureAt < PHONE_CERT_RETRY_AFTER_MS) return false;
  if (o.notAfter === null) return true;
  return o.notAfter - o.now <= PHONE_CERT_RENEW_BEFORE_MS;
}

// ── the phone endpoint's request policy (Appendix H, scenario 11) ─────────

export const PHONE_SESSION_COOKIE = "__Host-flagship-phone";
export const PHONE_CSRF_HEADER = "x-flagship-csrf";

export interface PhoneEndpointRequest {
  method: string;
  /** The Host header (no port: the relay only forwards :443). */
  host: string;
  /** The Origin header, or null when the request had none. */
  origin: string | null;
  /** The value of PHONE_SESSION_COOKIE, or null. A sibling's `Domain=` cookie of the same name is never `__Host-`. */
  sessionCookie: string | null;
  /** The value of PHONE_CSRF_HEADER, or null. */
  csrf: string | null;
  /** WebSocket upgrade. */
  upgrade: boolean;
  /** Opening a session (POST with the one-time code the phone shows): needs the exact Origin, not a session yet. */
  establish?: boolean;
}

export type PhoneEndpointVerdict = "allow" | "wrong-host" | "cross-origin" | "no-session" | "csrf";

/**
 * May the phone endpoint act on this request? The Host must be exactly the phone's name. A safe read (GET/HEAD, not
 * an upgrade) needs nothing more. Anything that changes state or opens a WebSocket needs an Origin of exactly
 * `https://<host>` (a sibling app is same-site, not same-origin), the host-only session cookie, and the CSRF header
 * equal to the session's token; opening a session needs the exact Origin and the one-time code the phone shows
 * (checked by the endpoint). The endpoint sends no CORS headers at all.
 */
export function phoneEndpointCheck(r: PhoneEndpointRequest, o: { hostname: string; sessionToken: string | null; csrfToken: string | null }): PhoneEndpointVerdict {
  if (r.host.toLowerCase() !== o.hostname.toLowerCase()) return "wrong-host";
  const method = r.method.toUpperCase();
  if ((method === "GET" || method === "HEAD") && !r.upgrade) return "allow";
  if (r.origin !== `https://${o.hostname.toLowerCase()}`) return "cross-origin";
  if (r.establish === true && method === "POST" && !r.upgrade) return "allow";
  if (!o.sessionToken || !r.sessionCookie || !constantTimeEqual(r.sessionCookie, o.sessionToken)) return "no-session";
  if (!o.csrfToken || !r.csrf || !constantTimeEqual(r.csrf, o.csrfToken)) return "csrf";
  return "allow";
}

/** The Set-Cookie line for the session: host-only (`__Host-`, no Domain), Secure, HttpOnly, SameSite=Strict, Path=/. */
export function phoneSessionCookie(token: string): string {
  return `${PHONE_SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ── the phone endpoint's voi.ci operations (docs/voici-and-messages.md §8.2) ─────────────

/**
 * The only website origins that may reach the phone endpoint cross-origin, and only for `deliver` and `live`. The
 * session routes (`POST /api/phone/session`, `/api/phone/ping`, the cookie) are retired in 0.3; `phoneEndpointCheck`
 * above stays for any later browser operation.
 */
export const PHONE_WEB_ORIGINS: readonly string[] = ["https://voi.ci"];
export const PHONE_WEB_ORIGINS_GYM: readonly string[] = ["https://gym.voi.ci"];
export const PHONE_DELIVER_PATH = "/api/phone/deliver";
export const PHONE_LIVE_PATH = "/api/phone/live";
export const PHONE_ENVELOPE_CONTENT_TYPE = "application/flagship-envelope+json";
/** Phone limits (§8.2): a message body; drafts may be larger (VOICI_DRAFT_MAX_ENVELOPE_BYTES). */
export const PHONE_DELIVER_MAX_BYTES = 64 * 1024;
export const PHONE_DELIVER_MAX_CONCURRENT = 8;
export const PHONE_DELIVER_PER_SENDER_PER_MINUTE = 20;
export const PHONE_DELIVER_PER_MINUTE = 120;

export interface PhoneWebRequest {
  method: string;
  /** Path without the query string. */
  path: string;
  host: string;
  origin: string | null;
  contentType: string | null;
  /** Access-Control-Request-Method / -Headers on a preflight, else null. */
  acrMethod: string | null;
  acrHeaders: string | null;
}

export type PhoneWebVerdict =
  | { kind: "preflight"; status: 204; headers: Record<string, string> }
  | { kind: "live" | "deliver"; corsHeaders: Record<string, string> }
  | { kind: "refuse"; status: 403 | 405 | 415 | 421; code: "wrong-host" | "origin" | "preflight" | "method" | "content-type" }
  /** No Origin and not one of the two operations: the endpoint's other (native / same-origin) rules apply. */
  | { kind: "other" };

function corsFor(origin: string | null): Record<string, string> {
  return origin === null ? {} : { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
}

/**
 * The phone endpoint's verdict for a request (§8.2): Host exactly the phone's name (421 otherwise); an Origin, when
 * present, must be in `origins` (403, no CORS headers); `OPTIONS /api/phone/deliver` is a preflight only for
 * method POST and exactly the `content-type` request header (204 with the allow headers, never Allow-Credentials);
 * `GET /api/phone/live`; `POST /api/phone/deliver` only with Content-Type exactly application/flagship-envelope+json
 * (415). Anything else with an Origin is 403. No cookie is read or set.
 */
export function phoneWebCheck(r: PhoneWebRequest, o: { hostname: string; origins: readonly string[] }): PhoneWebVerdict {
  if (r.host.toLowerCase() !== o.hostname.toLowerCase()) return { kind: "refuse", status: 421, code: "wrong-host" };
  const method = r.method.toUpperCase();
  const listed = r.origin !== null && o.origins.includes(r.origin);
  if (r.origin !== null && !listed) return { kind: "refuse", status: 403, code: "origin" };
  const known = r.path === PHONE_DELIVER_PATH || r.path === PHONE_LIVE_PATH;
  if (method === "OPTIONS") {
    if (r.path !== PHONE_DELIVER_PATH || !listed) return { kind: "refuse", status: 403, code: "preflight" };
    const hdrs = (r.acrHeaders ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => h !== "");
    if (r.acrMethod?.toUpperCase() !== "POST" || hdrs.length !== 1 || hdrs[0] !== "content-type") return { kind: "refuse", status: 403, code: "preflight" };
    return {
      kind: "preflight",
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": r.origin!,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      },
    };
  }
  if (!known) return r.origin !== null ? { kind: "refuse", status: 403, code: "origin" } : { kind: "other" };
  if (r.path === PHONE_LIVE_PATH) {
    return method === "GET" ? { kind: "live", corsHeaders: corsFor(r.origin) } : { kind: "refuse", status: 405, code: "method" };
  }
  if (method !== "POST") return { kind: "refuse", status: 405, code: "method" };
  if (r.contentType !== PHONE_ENVELOPE_CONTENT_TYPE) return { kind: "refuse", status: 415, code: "content-type" };
  return { kind: "deliver", corsHeaders: corsFor(r.origin) };
}

/** `GET /api/phone/live` answer: {live:true, account, ownerSignPub}. */
export interface PhoneLiveAnswer {
  live: true;
  account: string;
  ownerSignPub: string;
}

export function parsePhoneLiveAnswer(v: unknown): PhoneLiveAnswer | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const ks = Object.keys(r).sort();
  if (ks.join(",") !== "account,live,ownerSignPub" || r.live !== true) return null;
  if (typeof r.account !== "string" || !ACCOUNT.test(r.account) || typeof r.ownerSignPub !== "string" || !HEX64.test(r.ownerSignPub)) return null;
  return { live: true, account: r.account, ownerSignPub: r.ownerSignPub };
}
