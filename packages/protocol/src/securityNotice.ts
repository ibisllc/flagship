/**
 * SecurityNotice: a maintainer-signed notice every Flagship app picks up from
 * one anonymous, cacheable GET (`/api/notices`), docs/security-notices.md.
 *
 *   flagship/security-notice/v1|<signedBy>|<seq>|<kind>|<validFrom>|<validUntil>|<eventAt>|<lockFrom>|<platforms>|<advisoryId>|<deprecatesProtocol>|<reason>|<message>
 *
 * It is signed OFFLINE by the cold ca-track maintainer key (the YubiKey that
 * signs CaEndorsement leases), never by `.com` and never by the hot CA key,
 * so a compromised `.com` or Cloudflare cannot forge a lock (which would be a
 * denial of service against every user). A client accepts one only when the
 * signer is the ca-track authority at its own clock, judged from the baked
 * pin (packages/protocol/src/maintainerCa.ts), and it FAILS OPEN: anything
 * unreachable, unverifiable, expired or malformed locks nothing.
 *
 * Kinds:
 *   none             a signed "all clear": supersedes (by seq) an earlier notice
 *   maintenance      a dismissible banner ("we will update on {date}")
 *   update-advisory  a dismissible banner for clients below the minimum
 *   update-required  the banner, then from `lockFrom` the lock; only for a
 *                    security reason, so `advisoryId` and `reason` are
 *                    mandatory and cannot be left out of the signed bytes
 *
 * The notice carries no URL: the store link comes from the app itself.
 */
import { ed } from "./edSync.js";
import type { Bytes, Keypair } from "./types.js";

export const TAG_SECURITY_NOTICE = "flagship/security-notice/v1";

/** A notice is valid for at most this long, so a replayed one cannot lock forever. */
export const SECURITY_NOTICE_MAX_WINDOW_MS = 30 * 24 * 3600_000;
export const SECURITY_NOTICE_MAX_MESSAGE = 280;
export const SECURITY_NOTICE_MAX_REASON = 160;

/**
 * The protocol generation this build speaks. Raise it only when a build ships
 * a breaking change to a signed message or a wire contract, and announce it
 * with a notice (docs/security-notices.md "Protocol versions").
 */
export const CLIENT_PROTOCOL_LEVEL = 1;

export const SECURITY_NOTICE_KINDS = ["none", "maintenance", "update-advisory", "update-required"] as const;
export type SecurityNoticeKind = (typeof SECURITY_NOTICE_KINDS)[number];

export const SECURITY_NOTICE_PLATFORMS = ["android", "ios", "web"] as const;
export type SecurityNoticePlatform = (typeof SECURITY_NOTICE_PLATFORMS)[number];

/** 0 means "no bound" for that field. */
export interface SecurityNoticeMinimum {
  minBuild: number;
  minProtocol: number;
}

export interface SecurityNoticeBody {
  /** Monotonic across all notices ever signed; clients remember the highest. */
  seq: number;
  kind: SecurityNoticeKind;
  /** epoch ms; the notice is shown from here (inclusive) ... */
  validFrom: number;
  /** ... to here (exclusive), at most 30 days later. */
  validUntil: number;
  /** epoch ms the message's `{date}` stands for, or 0. */
  eventAt: number;
  /** update-required only: epoch ms the lock starts, in [validFrom, validUntil). */
  lockFrom: number;
  /** Who it is about. Empty only for none and maintenance (= everyone). */
  platforms: Partial<Record<SecurityNoticePlatform, SecurityNoticeMinimum>>;
  /** The security advisory this answers; required for update-required. */
  advisoryId: string;
  /** update-required only: boxes and `.com` stop accepting protocol <= this at lockFrom; 0 = none. */
  deprecatesProtocol: number;
  /** Why, in a sentence (update-required: required). */
  reason: string;
  /** Plain text for the person; `{date}` is replaced by the local rendering of eventAt. */
  message: string;
}

export interface SecurityNotice extends SecurityNoticeBody {
  type: "SecurityNotice";
  version: 1;
  /** lower-hex Ed25519 pubkey of the ca-track maintainer authority that signed. */
  signedBy: string;
  /** lower-hex Ed25519 signature over the canonical bytes. */
  signature: string;
}

export class SecurityNoticeError extends Error {
  constructor(readonly code: string) {
    super(`${TAG_SECURITY_NOTICE}: ${code}`);
    this.name = "SecurityNoticeError";
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const ADVISORY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isUint(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function textProblem(s: unknown, max: number): string | null {
  if (typeof s !== "string") return "bad-text";
  if (s.length > max) return "too-long";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x7c || c <= 0x1f || c === 0x7f) return "bad-char";
  }
  return null;
}

function platformsCanonical(
  p: SecurityNoticeBody["platforms"],
): { text: string; entries: [SecurityNoticePlatform, SecurityNoticeMinimum][] } {
  if (typeof p !== "object" || p === null || Array.isArray(p)) throw new SecurityNoticeError("bad-platforms");
  const entries: [SecurityNoticePlatform, SecurityNoticeMinimum][] = [];
  for (const name of Object.keys(p)) {
    if (!(SECURITY_NOTICE_PLATFORMS as readonly string[]).includes(name)) {
      throw new SecurityNoticeError("bad-platforms");
    }
    const m = (p as Record<string, SecurityNoticeMinimum>)[name];
    if (!m || typeof m !== "object" || !isUint(m.minBuild) || !isUint(m.minProtocol)) {
      throw new SecurityNoticeError("bad-minimum");
    }
    entries.push([name as SecurityNoticePlatform, { minBuild: m.minBuild, minProtocol: m.minProtocol }]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { text: entries.map(([n, m]) => `${n}:${m.minBuild}:${m.minProtocol}`).join(","), entries };
}

/**
 * Check the whole rule set and return the bytes to sign. Throws a
 * {@link SecurityNoticeError} whose `code` names the first rule broken, so a
 * notice that breaks a rule cannot even be signed.
 */
export function canonicalSecurityNotice(b: SecurityNoticeBody, signedBy: string): Bytes {
  if (typeof signedBy !== "string" || !HEX64.test(signedBy)) throw new SecurityNoticeError("bad-signer");
  if (!isUint(b.seq) || b.seq < 1) throw new SecurityNoticeError("bad-seq");
  if (!(SECURITY_NOTICE_KINDS as readonly string[]).includes(b.kind)) throw new SecurityNoticeError("bad-kind");
  if (!isUint(b.validFrom) || !isUint(b.validUntil)) throw new SecurityNoticeError("bad-time");
  if (b.validUntil <= b.validFrom) throw new SecurityNoticeError("window-order");
  if (b.validUntil - b.validFrom > SECURITY_NOTICE_MAX_WINDOW_MS) throw new SecurityNoticeError("window-too-long");
  if (!isUint(b.eventAt)) throw new SecurityNoticeError("bad-event-at");
  if (b.eventAt !== 0 && (b.eventAt < b.validFrom || b.eventAt > b.validUntil)) {
    throw new SecurityNoticeError("bad-event-at");
  }
  if (!isUint(b.lockFrom)) throw new SecurityNoticeError("bad-lock-from");
  if (!isUint(b.deprecatesProtocol)) throw new SecurityNoticeError("bad-deprecates");
  const { text: platforms, entries } = platformsCanonical(b.platforms);

  if (textProblem(b.advisoryId, 64) !== null) throw new SecurityNoticeError("bad-advisory");
  if (b.advisoryId !== "" && !ADVISORY_ID.test(b.advisoryId)) throw new SecurityNoticeError("bad-advisory");
  if (textProblem(b.reason, SECURITY_NOTICE_MAX_REASON) !== null) throw new SecurityNoticeError("bad-reason");
  if (textProblem(b.message, SECURITY_NOTICE_MAX_MESSAGE) !== null) throw new SecurityNoticeError("bad-message");
  if (b.message.includes("://")) throw new SecurityNoticeError("message-has-link");
  if (b.reason.includes("://")) throw new SecurityNoticeError("message-has-link");
  if (b.message.includes("{date}") && b.eventAt === 0) throw new SecurityNoticeError("date-token-needs-event");

  const carriesMinimums = b.kind === "update-advisory" || b.kind === "update-required";
  if (b.kind === "none") {
    if (entries.length) throw new SecurityNoticeError("platforms-not-allowed");
    if (b.message !== "") throw new SecurityNoticeError("message-not-allowed");
    if (b.eventAt !== 0) throw new SecurityNoticeError("bad-event-at");
  } else if (b.message === "") {
    throw new SecurityNoticeError("message-required");
  }
  if (carriesMinimums) {
    if (entries.length === 0) throw new SecurityNoticeError("platforms-required");
    for (const [, m] of entries) {
      if (m.minBuild === 0 && m.minProtocol === 0) throw new SecurityNoticeError("minimum-required");
    }
  } else {
    for (const [, m] of entries) {
      if (m.minBuild !== 0 || m.minProtocol !== 0) throw new SecurityNoticeError("minimum-not-allowed");
    }
  }
  if (b.kind === "update-required") {
    if (b.advisoryId === "") throw new SecurityNoticeError("advisory-required");
    if (b.reason === "") throw new SecurityNoticeError("reason-required");
    if (b.lockFrom < b.validFrom || b.lockFrom >= b.validUntil) throw new SecurityNoticeError("bad-lock-from");
    if (b.deprecatesProtocol !== 0) {
      for (const [, m] of entries) {
        if (m.minProtocol <= b.deprecatesProtocol) throw new SecurityNoticeError("deprecates-not-enforced");
      }
    }
  } else {
    if (b.lockFrom !== 0) throw new SecurityNoticeError("lock-from-not-allowed");
    if (b.deprecatesProtocol !== 0) throw new SecurityNoticeError("deprecates-not-allowed");
    if (b.kind !== "update-advisory") {
      if (b.advisoryId !== "") throw new SecurityNoticeError("advisory-not-allowed");
      if (b.reason !== "") throw new SecurityNoticeError("reason-not-allowed");
    }
  }

  return new TextEncoder().encode(
    [
      TAG_SECURITY_NOTICE,
      signedBy,
      String(b.seq),
      b.kind,
      String(b.validFrom),
      String(b.validUntil),
      String(b.eventAt),
      String(b.lockFrom),
      platforms,
      b.advisoryId,
      String(b.deprecatesProtocol),
      b.reason,
      b.message,
    ].join("|"),
  );
}

/** The error code a body breaks, or null when it is signable. */
export function securityNoticeProblem(b: SecurityNoticeBody, signedBy: string): string | null {
  try {
    canonicalSecurityNotice(b, signedBy);
    return null;
  } catch (e) {
    return e instanceof SecurityNoticeError ? e.code : "invalid";
  }
}

export function signSecurityNotice(body: SecurityNoticeBody, authority: Keypair): SecurityNotice {
  const signedBy = toHex(authority.publicKey);
  const sig = ed.sign(canonicalSecurityNotice(body, signedBy), authority.privateKey);
  return assemble(body, signedBy, toHex(sig));
}

/** Attach an externally made signature (the maintainers CLI's signer) to a body. */
export function assembleSecurityNotice(body: SecurityNoticeBody, signedBy: string, signatureHex: string): SecurityNotice {
  return assemble(body, signedBy, signatureHex);
}

function assemble(body: SecurityNoticeBody, signedBy: string, signature: string): SecurityNotice {
  const platforms: SecurityNoticeBody["platforms"] = {};
  for (const name of SECURITY_NOTICE_PLATFORMS) {
    const m = body.platforms[name];
    if (m) platforms[name] = { minBuild: m.minBuild, minProtocol: m.minProtocol };
  }
  return {
    type: "SecurityNotice",
    version: 1,
    seq: body.seq,
    kind: body.kind,
    validFrom: body.validFrom,
    validUntil: body.validUntil,
    eventAt: body.eventAt,
    lockFrom: body.lockFrom,
    platforms,
    advisoryId: body.advisoryId,
    deprecatesProtocol: body.deprecatesProtocol,
    reason: body.reason,
    message: body.message,
    signedBy,
    signature,
  };
}

/** Shape-check an untrusted notice and enforce every rule (no signature check). */
export function parseSecurityNotice(v: unknown): SecurityNotice | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.type !== "SecurityNotice" || r.version !== 1) return null;
  if (typeof r.signedBy !== "string" || typeof r.signature !== "string") return null;
  if (!HEX64.test(r.signedBy) || !HEX128.test(r.signature)) return null;
  if (typeof r.kind !== "string" || typeof r.advisoryId !== "string") return null;
  if (typeof r.reason !== "string" || typeof r.message !== "string") return null;
  if (typeof r.platforms !== "object" || r.platforms === null || Array.isArray(r.platforms)) return null;
  const body = {
    seq: r.seq,
    kind: r.kind,
    validFrom: r.validFrom,
    validUntil: r.validUntil,
    eventAt: r.eventAt,
    lockFrom: r.lockFrom,
    platforms: r.platforms,
    advisoryId: r.advisoryId,
    deprecatesProtocol: r.deprecatesProtocol,
    reason: r.reason,
    message: r.message,
  } as SecurityNoticeBody;
  try {
    canonicalSecurityNotice(body, r.signedBy);
  } catch {
    return null;
  }
  return assemble(body, r.signedBy, r.signature);
}

export type SecurityNoticeReject = "malformed" | "unauthorized-signer" | "signature-invalid";

/**
 * Is the signature good, and is the signer one of `authorityKeys` (the
 * ca-track maintainer authority at the verifier's clock)? Time windows are
 * judged separately by {@link securityNoticeOutcome}.
 */
export function verifySecurityNotice(
  n: SecurityNotice,
  authorityKeys: readonly string[],
): { ok: true } | { ok: false; reason: SecurityNoticeReject } {
  let bytes: Bytes;
  try {
    bytes = canonicalSecurityNotice(n, n.signedBy);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!HEX128.test(n.signature)) return { ok: false, reason: "malformed" };
  if (!authorityKeys.includes(n.signedBy)) return { ok: false, reason: "unauthorized-signer" };
  try {
    if (ed.verify(fromHex(n.signature), bytes, fromHex(n.signedBy))) return { ok: true };
  } catch {
    /* falls through */
  }
  return { ok: false, reason: "signature-invalid" };
}

export interface SecurityNoticeClient {
  platform: SecurityNoticePlatform;
  /** This build's number (CFBundleVersion, versionCode, the webapp's shell version). */
  build: number;
  /** This build's {@link CLIENT_PROTOCOL_LEVEL}. */
  protocol: number;
}

export type SecurityNoticeWhy = "kind-none" | "not-yet" | "expired" | "other-platform" | "up-to-date";

export type SecurityNoticeOutcome =
  | { action: "none"; why: SecurityNoticeWhy }
  | { action: "banner"; style: "maintenance" | "update"; notice: SecurityNotice }
  | { action: "lock"; notice: SecurityNotice };

/** Is this client below the notice's minimum for its platform? (false when the platform isn't listed.) */
export function clientBelowMinimum(n: SecurityNoticeBody, c: SecurityNoticeClient): boolean {
  const m = n.platforms[c.platform];
  if (!m) return false;
  return (m.minBuild > 0 && c.build < m.minBuild) || (m.minProtocol > 0 && c.protocol < m.minProtocol);
}

/**
 * What a client shows for an already VERIFIED notice. Fail open: outside
 * [validFrom, validUntil) nothing is shown, and only update-required, past
 * lockFrom, for a client below the minimum, locks.
 */
export function securityNoticeOutcome(n: SecurityNotice, c: SecurityNoticeClient, now: number): SecurityNoticeOutcome {
  if (n.kind === "none") return { action: "none", why: "kind-none" };
  if (now < n.validFrom) return { action: "none", why: "not-yet" };
  if (now >= n.validUntil) return { action: "none", why: "expired" };
  if (n.kind === "maintenance") {
    if (Object.keys(n.platforms).length > 0 && !n.platforms[c.platform]) {
      return { action: "none", why: "other-platform" };
    }
    return { action: "banner", style: "maintenance", notice: n };
  }
  if (!n.platforms[c.platform]) return { action: "none", why: "other-platform" };
  if (!clientBelowMinimum(n, c)) return { action: "none", why: "up-to-date" };
  if (n.kind === "update-required" && now >= n.lockFrom) return { action: "lock", notice: n };
  return { action: "banner", style: "update", notice: n };
}

/** What a client persists between launches. */
export interface SecurityNoticeStore {
  /** The highest seq ever verified (anti-rollback). */
  highestSeq: number;
  /** The newest verified notice (it is re-verified on load), or null. */
  notice: SecurityNotice | null;
}

export type SecurityNoticeRefusal = SecurityNoticeReject | "stale";

/**
 * Fold a fetched candidate into the store. A candidate that is malformed,
 * unsigned by the authority, or not newer than the highest seq verified is
 * dropped and the store stays as it was (so an unreachable or hostile
 * endpoint never removes or adds a lock).
 */
export function acceptSecurityNotice(
  store: SecurityNoticeStore,
  candidate: unknown,
  authorityKeys: readonly string[],
): { store: SecurityNoticeStore; refused: SecurityNoticeRefusal | null } {
  if (candidate === null || candidate === undefined) return { store, refused: null };
  const n = parseSecurityNotice(candidate);
  if (!n) return { store, refused: "malformed" };
  const v = verifySecurityNotice(n, authorityKeys);
  if (!v.ok) return { store, refused: v.reason };
  if (n.seq <= store.highestSeq) return { store, refused: "stale" };
  return { store: { highestSeq: n.seq, notice: n }, refused: null };
}

/**
 * The stored notice's outcome, re-verified against the authority NOW. If the
 * authority can no longer be established (offline with a lapsed mandate) the
 * answer is "nothing": a lock is never shown on trust alone.
 */
export function storedSecurityNoticeOutcome(
  store: SecurityNoticeStore,
  authorityKeys: readonly string[],
  client: SecurityNoticeClient,
  now: number,
): SecurityNoticeOutcome {
  const n = store.notice;
  if (!n) return { action: "none", why: "kind-none" };
  if (!verifySecurityNotice(n, authorityKeys).ok) return { action: "none", why: "kind-none" };
  return securityNoticeOutcome(n, client, now);
}

/** Replace `{date}` with the caller's rendering of eventAt. */
export function securityNoticeText(n: SecurityNoticeBody, formatDate: (ms: number) => string): string {
  return n.eventAt === 0 ? n.message : n.message.split("{date}").join(formatDate(n.eventAt));
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
