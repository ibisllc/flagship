/**
 * Boot unlock v2 (architecture v2, pq-suites.md §19). DRAFT, pending Q01 review.
 *
 * v1 seals the disk key to the boot key's X25519 form and nothing PQ authenticates the box's
 * request, so a forger of the classical boot key (or the STK that vouches for it) could have the
 * phone seal the disk key to a key of its own. v2 adds, per box:
 *
 * - an ML-DSA-65 half for the boot key, bound by the boot key's own `pq-key-binding/v1` (role
 *   `boot-key`, subject the server domain), and an X-Wing "lease key" that auto-unlock leases are
 *   sealed to. The STK's hybrid key vouches for both in one statement:
 *     flagship/boot-key-binding/v3|<domain>|<bootPubHex>|<bootHybridKeyId>|<leaseKemKeyId>|<custody>|<issuedAt>
 *   `custody` is `software` (the lease key's seed is a file on /boot) or `tpm` (the seed is sealed
 *   to the box's TPM 2.0 under a PCR policy). A TPM is classical: what it adds is that a copy of
 *   /boot is useless off this machine and boot chain; the PQ part is the hybrid seal around it.
 * - a per-boot reply key: the boot client makes a fresh X-Wing key for each request and signs
 *     flagship/secret-request/v2|<domain>|<bootPubHex>|<purpose>|<nonce>|<replyKemKeyId>|<issuedAt>
 *   with the boot hybrid key. The reply is sealed to that key and opened once.
 * - a reply sealed with `flagship/hybrid-seal/v1` (purpose `flagship/boot-reply/v2`, context
 *   domain, boot key, purpose, nonce) whose plaintext is `u16be(n) || disk key || owner signature`,
 *   the owner's (account IRK) hybrid signature over
 *     flagship/boot-reply/v2|<domain>|<bootPubHex>|<purpose>|<nonce>|<replyKemKeyId>|<sha512(key)>|<issuedAt>
 * - a lease v3: the v2 lease JSON the worker checks (Ed25519 IRK, unchanged), whose `sealedKey`
 *   is a hybrid seal to the lease key (purpose `flagship/auto-unlock-lease/v3`, context domain,
 *   boot key, lease id) carrying the disk key and the owner's hybrid signature over
 *     flagship/auto-unlock-lease/v3|<domain>|<bootPubHex>|<leaseKemKeyId>|<leaseId>|<sha512(key)>|<issuedAt>|<expiresAt>|<maxUses>
 *
 * Downgrade: which version a box takes comes from its unlock policy (`/boot/flagship-unlock-policy`,
 * written by the daemon from the owner's verified assurance-policy chain), never from the reply.
 * Strict refuses every v1 reply and lease (`strict-refuses-v1`); compatibility takes both. A phone
 * seals v2 whenever the box's v2 material verifies and it can sign hybrid, falls back to v1 only
 * outside strict, and refuses under strict. Vectors: test-vectors/boot-unlock-v2/vectors.json
 * (TS, Rust, Go, Swift, Kotlin).
 */
import { sha512 } from "@noble/hashes/sha2.js";
import {
  hybridOpen,
  hybridSeal,
  hybridSealKeygen,
  hybridSealWithRandomness,
  hybridSign,
  hybridVerify,
  parseHybridSealPublicKey,
  PqHybridError,
  pqKeyId,
  SUITE_HYBRID_SEAL_V1,
  SUITE_HYBRID_SIG_ED25519_MLDSA65_V1,
  TAG_ENVELOPE_V2,
  HYBRID_SIG_LEN,
} from "./pqHybrid.js";
import { verifyPqKeyBinding, type VerifiedPqKeyBinding } from "./pqTrust.js";
import type { Bytes } from "./types.js";

export const TAG_BOOT_KEY_BINDING_V3 = "flagship/boot-key-binding/v3";
export const TAG_SECRET_REQUEST_V2 = "flagship/secret-request/v2";
export const TAG_BOOT_REPLY_V2 = "flagship/boot-reply/v2";
export const TAG_AUTO_UNLOCK_LEASE_V3 = "flagship/auto-unlock-lease/v3";
export const BOOT_KEY_CUSTODIES = ["software", "tpm"] as const;
export type BootKeyCustody = (typeof BOOT_KEY_CUSTODIES)[number];
export type UnlockPolicy = "strict" | "compat";

export type BootUnlockV2ErrorCode =
  | "v2-malformed"
  | "material-boot-key"
  | "material-binding"
  | "material-signature"
  | "request-signature"
  | "strict-refuses-v1"
  | "owner-signature"
  | "recipient-mismatch"
  | "decrypt-failed"
  | "other-server"
  | "lease-expired"
  | "phone-cannot-sign-hybrid"
  | "box-has-no-v2";

export class BootUnlockV2Error extends Error {
  readonly code: BootUnlockV2ErrorCode;
  constructor(code: BootUnlockV2ErrorCode) {
    super(code);
    this.name = "BootUnlockV2Error";
    this.code = code;
  }
}

const fail = (code: BootUnlockV2ErrorCode): never => {
  throw new BootUnlockV2Error(code);
};

const enc = new TextEncoder();
const HEX32 = /^[0-9a-f]{64}$/;
const DOMAIN = /^[a-z0-9][a-z0-9.-]{0,252}$/;
const LEASE_ID = /^[0-9a-f]{16,128}$/;
const MLDSA_PK_HEX = 1952 * 2;
const KEM_PK_HEX = 1216 * 2;
const MAX_KEY = 1024;

export const bootHybridPublicKey = (bootPubHex: string, bootMldsaPubHex: string): Bytes => fromHex(bootPubHex + bootMldsaPubHex);
export const hybridKeyIdHex = (pk: Bytes): string => toHex(pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, pk));
export const kemKeyIdHex = (pk: Bytes): string => toHex(pqKeyId(SUITE_HYBRID_SEAL_V1, pk));

/** True when `sealed` is a v2 envelope (a v1 seal starts with a random X25519 point). */
export function isV2Sealed(sealed: Bytes): boolean {
  const magic = enc.encode(TAG_ENVELOPE_V2);
  if (sealed.length < magic.length + 1 || sealed[0] !== magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (sealed[i + 1] !== magic[i]) return false;
  return true;
}

// ── boot PQ material (the STK vouches for it) ────────────────────────────

export interface BootPqStatement {
  serverDomain: string;
  bootPubHex: string;
  bootMldsaPubHex: string;
  leaseKemPubHex: string;
  custody: BootKeyCustody;
  issuedAt: number;
}

export interface BootPqWire extends BootPqStatement {
  v: 1;
  /** The boot key's own `pq-key-binding/v1` (role boot-key, subject the domain). */
  bootBinding: unknown;
  /** The STK's hybrid signature over the v3 statement, hex. */
  stkSignature: string;
}

function checkStatement(s: BootPqStatement): void {
  if (typeof s.serverDomain !== "string" || !DOMAIN.test(s.serverDomain)) fail("v2-malformed");
  if (typeof s.bootPubHex !== "string" || !HEX32.test(s.bootPubHex)) fail("v2-malformed");
  if (typeof s.bootMldsaPubHex !== "string" || s.bootMldsaPubHex.length !== MLDSA_PK_HEX || !/^[0-9a-f]+$/.test(s.bootMldsaPubHex)) fail("v2-malformed");
  if (typeof s.leaseKemPubHex !== "string" || s.leaseKemPubHex.length !== KEM_PK_HEX || !/^[0-9a-f]+$/.test(s.leaseKemPubHex)) fail("v2-malformed");
  if (!(BOOT_KEY_CUSTODIES as readonly string[]).includes(s.custody)) fail("v2-malformed");
  if (!Number.isSafeInteger(s.issuedAt) || s.issuedAt < 0) fail("v2-malformed");
}

export function canonicalBootKeyBindingV3(s: BootPqStatement): Bytes {
  checkStatement(s);
  return enc.encode(
    [
      TAG_BOOT_KEY_BINDING_V3,
      s.serverDomain,
      s.bootPubHex,
      hybridKeyIdHex(bootHybridPublicKey(s.bootPubHex, s.bootMldsaPubHex)),
      kemKeyIdHex(fromHex(s.leaseKemPubHex)),
      s.custody,
      String(s.issuedAt),
    ].join("|"),
  );
}

export interface VerifiedBootPq {
  serverDomain: string;
  bootPubHex: string;
  bootHybridPublicKey: Bytes;
  leaseKemPublicKey: Bytes;
  leaseKemKeyIdHex: string;
  custody: BootKeyCustody;
  issuedAt: number;
}

/**
 * Verifies the v2 boot material `.com` serves beside the boot-key binding. The caller supplies
 * what it already trusts: the boot key it verified through the STK it pinned, and the STK's
 * verified `box-stk` binding (the hybrid key that must have signed). Codes: `v2-malformed`,
 * `material-boot-key` (another boot key), `material-binding` (the boot key's own binding),
 * `material-signature` (the STK's hybrid signature).
 */
export function verifyBootPq(
  wire: unknown,
  expect: { serverDomain: string; bootPubHex: string; stkBinding: VerifiedPqKeyBinding; now: number; pinnedBootMldsaPubHex?: string | null },
): VerifiedBootPq {
  if (typeof wire !== "object" || wire === null || Array.isArray(wire)) return fail("v2-malformed");
  const o = wire as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "bootBinding,bootMldsaPubHex,bootPubHex,custody,issuedAt,leaseKemPubHex,serverDomain,stkSignature,v" || o.v !== 1) fail("v2-malformed");
  const s = o as unknown as BootPqWire;
  checkStatement(s);
  if (typeof s.stkSignature !== "string" || s.stkSignature.length !== HYBRID_SIG_LEN * 2 || !/^[0-9a-f]+$/.test(s.stkSignature)) fail("v2-malformed");
  if (s.serverDomain !== expect.serverDomain.toLowerCase() || s.bootPubHex !== expect.bootPubHex.toLowerCase()) fail("material-boot-key");
  if (expect.stkBinding.role !== "box-stk" || expect.stkBinding.subjectId !== s.serverDomain) fail("material-signature");
  let bootBinding: VerifiedPqKeyBinding;
  try {
    bootBinding = verifyPqKeyBinding(s.bootBinding, {
      role: "boot-key",
      subjectId: s.serverDomain,
      ed25519PubHex: s.bootPubHex,
      mldsaPubHex: expect.pinnedBootMldsaPubHex ?? s.bootMldsaPubHex,
      now: expect.now,
    });
  } catch {
    return fail("material-binding");
  }
  if (bootBinding.mldsaPubHex !== s.bootMldsaPubHex) fail("material-binding");
  const kem = fromHex(s.leaseKemPubHex);
  try {
    parseHybridSealPublicKey(kem);
  } catch {
    fail("v2-malformed");
  }
  try {
    hybridVerify(expect.stkBinding.hybridPublicKey, TAG_BOOT_KEY_BINDING_V3, canonicalBootKeyBindingV3(s), fromHex(s.stkSignature));
  } catch {
    fail("material-signature");
  }
  return {
    serverDomain: s.serverDomain,
    bootPubHex: s.bootPubHex,
    bootHybridPublicKey: bootBinding.hybridPublicKey,
    leaseKemPublicKey: kem,
    leaseKemKeyIdHex: kemKeyIdHex(kem),
    custody: s.custody,
    issuedAt: s.issuedAt,
  };
}

// ── request v2 (box → phone) ──────────────────────────────────────────────

export interface SecretRequestV2 {
  serverDomain: string;
  bootPubHex: string;
  purpose: "unlock-key";
  nonceHex: string;
  replyKemPubHex: string;
  issuedAt: number;
}

/** What rides beside the v1 request JSON on POST /api/boot/request. */
export interface SecretRequestPqWire {
  v: 2;
  replyKemPubHex: string;
  signature: string;
}

export function canonicalSecretRequestV2(r: SecretRequestV2): Bytes {
  if (!DOMAIN.test(r.serverDomain) || !HEX32.test(r.bootPubHex) || r.purpose !== "unlock-key" || !HEX32.test(r.nonceHex)) fail("v2-malformed");
  if (r.replyKemPubHex.length !== KEM_PK_HEX || !Number.isSafeInteger(r.issuedAt) || r.issuedAt < 0) fail("v2-malformed");
  return enc.encode(
    [TAG_SECRET_REQUEST_V2, r.serverDomain, r.bootPubHex, r.purpose, r.nonceHex, kemKeyIdHex(fromHex(r.replyKemPubHex)), String(r.issuedAt)].join("|"),
  );
}

/** Box side (and vectors): sign with the boot hybrid secret key (ed25519 seed || ML-DSA seed). */
export function signSecretRequestV2(r: SecretRequestV2, bootHybridSecretKey: Bytes, opts: { deterministic?: boolean } = {}): SecretRequestPqWire {
  const sig = hybridSign(bootHybridSecretKey, TAG_SECRET_REQUEST_V2, canonicalSecretRequestV2(r), opts);
  return { v: 2, replyKemPubHex: r.replyKemPubHex, signature: toHex(sig) };
}

/**
 * Phone side: the v1 request fields (already checked under the boot key) plus the `pq` wire,
 * checked under the boot key's hybrid key from verified material. Returns the reply key.
 */
export function verifySecretRequestV2(
  v1: { serverDomain: string; bootPubHex: string; purpose: string; nonceHex: string; issuedAt: number },
  pq: unknown,
  material: VerifiedBootPq,
): Bytes {
  if (typeof pq !== "object" || pq === null) return fail("v2-malformed");
  const p = pq as Record<string, unknown>;
  if (Object.keys(p).sort().join(",") !== "replyKemPubHex,signature,v" || p.v !== 2) fail("v2-malformed");
  if (typeof p.replyKemPubHex !== "string" || typeof p.signature !== "string" || p.signature.length !== HYBRID_SIG_LEN * 2) fail("v2-malformed");
  if (v1.serverDomain.toLowerCase() !== material.serverDomain || v1.bootPubHex.toLowerCase() !== material.bootPubHex) fail("other-server");
  if (v1.purpose !== "unlock-key") fail("v2-malformed");
  const r: SecretRequestV2 = {
    serverDomain: material.serverDomain,
    bootPubHex: material.bootPubHex,
    purpose: "unlock-key",
    nonceHex: v1.nonceHex.toLowerCase(),
    replyKemPubHex: (p.replyKemPubHex as string).toLowerCase(),
    issuedAt: v1.issuedAt,
  };
  const kem = fromHex(r.replyKemPubHex);
  try {
    parseHybridSealPublicKey(kem);
  } catch {
    fail("v2-malformed");
  }
  try {
    hybridVerify(material.bootHybridPublicKey, TAG_SECRET_REQUEST_V2, canonicalSecretRequestV2(r), fromHex((p.signature as string).toLowerCase()));
  } catch {
    fail("request-signature");
  }
  return kem;
}

// ── reply v2 (phone → box) ────────────────────────────────────────────────

export interface ReplyV2Context {
  serverDomain: string;
  bootPubHex: string;
  nonceHex: string;
  replyKemPubHex: string;
}

export function canonicalBootReplyV2(c: ReplyV2Context, keyDigestHex: string, issuedAt: number): Bytes {
  return enc.encode(
    [TAG_BOOT_REPLY_V2, c.serverDomain, c.bootPubHex, "unlock-key", c.nonceHex, kemKeyIdHex(fromHex(c.replyKemPubHex)), keyDigestHex, String(issuedAt)].join("|"),
  );
}

const replyContext = (c: ReplyV2Context): Bytes[] => [enc.encode(c.serverDomain), fromHex(c.bootPubHex), enc.encode("unlock-key"), fromHex(c.nonceHex)];

/** A hybrid signer for the owner key: purpose and payload in, 3373 bytes out. */
export type OwnerHybridSigner = (purpose: string, payload: Bytes) => Bytes;

function packKeyAndSig(key: Bytes, sig: Bytes): Bytes {
  if (key.length === 0 || key.length > MAX_KEY) fail("v2-malformed");
  if (sig.length !== HYBRID_SIG_LEN) fail("owner-signature");
  const out = new Uint8Array(2 + key.length + sig.length);
  out[0] = key.length >> 8;
  out[1] = key.length & 0xff;
  out.set(key, 2);
  out.set(sig, 2 + key.length);
  return out;
}

function unpackKeyAndSig(p: Bytes): { key: Bytes; sig: Bytes } {
  if (p.length < 2) fail("v2-malformed");
  const n = (p[0]! << 8) | p[1]!;
  if (n === 0 || n > MAX_KEY || p.length !== 2 + n + HYBRID_SIG_LEN) fail("v2-malformed");
  return { key: p.slice(2, 2 + n), sig: p.slice(2 + n) };
}

/** Phone side: seal `diskKey` to the request's reply key and sign it as the owner. */
export function buildBootReplyV2(args: {
  ctx: ReplyV2Context;
  diskKey: Bytes;
  ownerHybridPublicKey: Bytes;
  sign: OwnerHybridSigner;
  issuedAt: number;
  /** Vectors only. */
  randomness?: Bytes;
}): Bytes {
  const c = normCtx(args.ctx);
  const sig = args.sign(TAG_BOOT_REPLY_V2, canonicalBootReplyV2(c, toHex(sha512(args.diskKey)), args.issuedAt));
  const plaintext = packKeyAndSig(args.diskKey, sig);
  const opts = { purpose: TAG_BOOT_REPLY_V2, senderKeyId: pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, args.ownerHybridPublicKey), issuedAt: args.issuedAt, sessionNonce: fromHex(c.nonceHex) };
  try {
    return args.randomness
      ? hybridSealWithRandomness(fromHex(c.replyKemPubHex), opts, replyContext(c), plaintext, args.randomness)
      : hybridSeal(fromHex(c.replyKemPubHex), opts, replyContext(c), plaintext);
  } finally {
    plaintext.fill(0);
  }
}

function sealCode(e: unknown): BootUnlockV2ErrorCode {
  if (e instanceof PqHybridError) {
    if (e.code === "recipient-mismatch") return "recipient-mismatch";
    if (e.code === "decrypt-failed") return "decrypt-failed";
  }
  return "v2-malformed";
}

/**
 * Box side (the Rust and Go ports do the same): open a v2 reply with the per-boot reply key and
 * check the owner's hybrid signature. `policy` is the box's unlock policy; a v1 reply under strict
 * is `strict-refuses-v1` before anything is opened.
 */
export function openBootReplyV2(args: {
  sealed: Bytes;
  ctx: Omit<ReplyV2Context, "replyKemPubHex">;
  replyKemSecretKey: Bytes;
  ownerHybridPublicKey: Bytes;
}): Bytes {
  if (!isV2Sealed(args.sealed)) fail("v2-malformed");
  const { publicKey } = hybridSealKeygen(args.replyKemSecretKey);
  const c = normCtx({ ...args.ctx, replyKemPubHex: toHex(publicKey) });
  let opened: ReturnType<typeof hybridOpen>;
  try {
    opened = hybridOpen(args.replyKemSecretKey, TAG_BOOT_REPLY_V2, replyContext(c), args.sealed);
  } catch (e) {
    return fail(sealCode(e));
  }
  const { key, sig } = unpackKeyAndSig(opened.plaintext);
  opened.plaintext.fill(0);
  if (opened.header.sessionNonce === undefined || toHex(opened.header.sessionNonce) !== c.nonceHex) fail("decrypt-failed");
  try {
    hybridVerify(args.ownerHybridPublicKey, TAG_BOOT_REPLY_V2, canonicalBootReplyV2(c, toHex(sha512(key)), opened.header.issuedAt), sig);
  } catch {
    key.fill(0);
    fail("owner-signature");
  }
  return key;
}

// ── lease v3 ──────────────────────────────────────────────────────────────

export interface LeaseV3Fields {
  serverDomain: string;
  bootPubHex: string;
  leaseId: string;
  issuedAt: number;
  expiresAt: number;
  maxUses?: number;
}

export function canonicalLeaseV3(l: LeaseV3Fields, leaseKemKeyId: string, keyDigestHex: string): Bytes {
  if (!DOMAIN.test(l.serverDomain) || !HEX32.test(l.bootPubHex) || !LEASE_ID.test(l.leaseId)) fail("v2-malformed");
  return enc.encode(
    [TAG_AUTO_UNLOCK_LEASE_V3, l.serverDomain, l.bootPubHex, leaseKemKeyId, l.leaseId, keyDigestHex, String(l.issuedAt), String(l.expiresAt), String(l.maxUses ?? -1)].join("|"),
  );
}

const leaseContext = (l: LeaseV3Fields): Bytes[] => [enc.encode(l.serverDomain), fromHex(l.bootPubHex), enc.encode(l.leaseId)];

/** Phone side: the `sealedKey` of a v3 lease (the outer v2 lease JSON carries it unchanged). */
export function sealLeaseV3(args: {
  lease: LeaseV3Fields;
  leaseKemPublicKey: Bytes;
  diskKey: Bytes;
  ownerHybridPublicKey: Bytes;
  sign: OwnerHybridSigner;
  randomness?: Bytes;
}): Bytes {
  const l = normLease(args.lease);
  const sig = args.sign(TAG_AUTO_UNLOCK_LEASE_V3, canonicalLeaseV3(l, kemKeyIdHex(args.leaseKemPublicKey), toHex(sha512(args.diskKey))));
  const plaintext = packKeyAndSig(args.diskKey, sig);
  const opts = {
    purpose: TAG_AUTO_UNLOCK_LEASE_V3,
    senderKeyId: pqKeyId(SUITE_HYBRID_SIG_ED25519_MLDSA65_V1, args.ownerHybridPublicKey),
    issuedAt: l.issuedAt,
    expiresAt: l.expiresAt,
  };
  try {
    return args.randomness
      ? hybridSealWithRandomness(args.leaseKemPublicKey, opts, leaseContext(l), plaintext, args.randomness)
      : hybridSeal(args.leaseKemPublicKey, opts, leaseContext(l), plaintext);
  } finally {
    plaintext.fill(0);
  }
}

/**
 * Box side: open a v3 lease's sealed key with the lease key and check the owner's hybrid
 * signature over the lease fields the worker served (so `.com` cannot change id, times or cap).
 * `nowMs` is the box's clock raised to its time floor.
 */
export function openLeaseV3(args: { lease: LeaseV3Fields; sealedKey: Bytes; leaseKemSecretKey: Bytes; ownerHybridPublicKey: Bytes; nowMs: number }): Bytes {
  const l = normLease(args.lease);
  if (!isV2Sealed(args.sealedKey)) fail("v2-malformed");
  const { publicKey } = hybridSealKeygen(args.leaseKemSecretKey);
  let opened: ReturnType<typeof hybridOpen>;
  try {
    opened = hybridOpen(args.leaseKemSecretKey, TAG_AUTO_UNLOCK_LEASE_V3, leaseContext(l), args.sealedKey);
  } catch (e) {
    return fail(sealCode(e));
  }
  const { key, sig } = unpackKeyAndSig(opened.plaintext);
  opened.plaintext.fill(0);
  try {
    hybridVerify(args.ownerHybridPublicKey, TAG_AUTO_UNLOCK_LEASE_V3, canonicalLeaseV3(l, kemKeyIdHex(publicKey), toHex(sha512(key))), sig);
  } catch {
    key.fill(0);
    fail("owner-signature");
  }
  if (opened.header.issuedAt !== l.issuedAt || opened.header.expiresAt !== l.expiresAt) {
    key.fill(0);
    fail("owner-signature");
  }
  if (l.expiresAt <= args.nowMs) {
    key.fill(0);
    fail("lease-expired");
  }
  return key;
}

// ── the downgrade rules ───────────────────────────────────────────────────

/** Box side: may a reply or lease of this version be opened under `policy`? */
export function boxAcceptsVersion(policy: UnlockPolicy, version: 1 | 2): void {
  if (policy === "strict" && version === 1) fail("strict-refuses-v1");
}

/** Parses `/boot/flagship-unlock-policy`; anything but exactly `compat` (or no file) is strict once any v2 material exists. */
export function parseUnlockPolicy(text: string | null, hasV2Material: boolean): UnlockPolicy {
  if (text === null) return "compat";
  const t = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (t === "compat") return "compat";
  if (t === "strict") return "strict";
  return hasV2Material ? "strict" : "compat";
}

/**
 * Phone side: which reply to send. `strict` is the server's policy as the phone replays it;
 * `material` is whether the box's v2 material verified; `requestHasPq` whether this request
 * carried a verified v2 extension; `canSignHybrid` whether this device holds the owner key's
 * ML-DSA half.
 */
export function chooseReplyVersion(s: { strict: boolean; material: boolean; requestHasPq: boolean; canSignHybrid: boolean }): 1 | 2 {
  if (s.material && s.requestHasPq && s.canSignHybrid) return 2;
  if (!s.strict) return 1;
  if (!s.material || !s.requestHasPq) return fail("box-has-no-v2");
  return fail("phone-cannot-sign-hybrid");
}

/** Phone side, for a lease: v3 when the box's material verified and this device signs hybrid. */
export function chooseLeaseVersion(s: { strict: boolean; material: boolean; canSignHybrid: boolean }): 2 | 3 {
  if (s.material && s.canSignHybrid) return 3;
  if (!s.strict) return 2;
  return fail(s.material ? "phone-cannot-sign-hybrid" : "box-has-no-v2");
}

function normCtx(c: ReplyV2Context): ReplyV2Context {
  const n = { serverDomain: c.serverDomain.toLowerCase(), bootPubHex: c.bootPubHex.toLowerCase(), nonceHex: c.nonceHex.toLowerCase(), replyKemPubHex: c.replyKemPubHex.toLowerCase() };
  if (!DOMAIN.test(n.serverDomain) || !HEX32.test(n.bootPubHex) || !HEX32.test(n.nonceHex) || n.replyKemPubHex.length !== KEM_PK_HEX) fail("v2-malformed");
  return n;
}

function normLease(l: LeaseV3Fields): LeaseV3Fields {
  const n: LeaseV3Fields = { ...l, serverDomain: l.serverDomain.toLowerCase(), bootPubHex: l.bootPubHex.toLowerCase(), leaseId: l.leaseId.toLowerCase() };
  if (!Number.isSafeInteger(n.issuedAt) || !Number.isSafeInteger(n.expiresAt) || n.expiresAt <= n.issuedAt) fail("v2-malformed");
  if (n.maxUses !== undefined && (!Number.isSafeInteger(n.maxUses) || n.maxUses < 1)) fail("v2-malformed");
  return n;
}

function toHex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

function fromHex(s: string): Bytes {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) fail("v2-malformed");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
