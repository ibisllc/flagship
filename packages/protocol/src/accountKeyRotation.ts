/**
 * Account master-key (UMK) rotation: the shared protocol.
 *
 * An admin device mints a new UMK and publishes one hop that moves the account from key epoch
 * N to N+1. The hop is authorised by the pinned admin root only; the account's old IRK never
 * signs it (whoever held the old UMK holds that key too). The new IRK and new AID sign the same
 * bytes as proof of possession. Kept devices receive the new UMK sealed to their own keys, which
 * must not be derivable from the old UMK. Boxes replay hops under the admin root they pin.
 *
 * Canonical bytes (`|`-separated, every field validated before joining):
 *
 *   flagship/account-key-rotation/v1|<username>|<fromEpoch>|<toEpoch>|<oldIrkPubHex>|<newIrkPubHex>
 *     |<newIrkScheme>|<oldAidPubHex>|<newAidPubHex>|<adminRootPubHex>|<removedDeviceIds sorted ","|none>
 *     |<keptDevicesDigestHex>|<recoveryRecordDigestHex|none>|<nonceHex>|<issuedAt>
 *   flagship/account-key-rotation/v2|<the v1 fields after the tag>|<newIrkKeyIdHex>   (hybrid companion)
 *   flagship/umk-rotation-delivery/v1|<username>|<toEpoch>|<deviceId>|<devicePubHex>|<rotationDigestHex>
 *     |<sealedDigestHex>|<issuedAt>                                                      (admin root)
 *   flagship/device-key-rotate/v1|<username>|<deviceId>|<oldDevicePubHex>|<newDevicePubHex>|<issuedAt>
 *                                                                        (new key, then admin root)
 *   flagship/device-receive-key/v1|<username>|<deviceId>|<devicePubHex>|<xwingPubHex>|<issuedAt>
 *                                                                        (device identity key)
 *   flagship/cgk-rekey/v1|<serverDomain>|<toEpoch>|<sealedHex>|<issuedAt>                (admin root)
 *   flagship/swk-rekey/v1|<serverDomain>|<toEpoch>|<oldSwkCommitHex>|<sealedHex>|<issuedAt> (admin root)
 *   flagship/luks-rekey-confirm/v1|<serverDomain>|<toEpoch>|<sealedKeyDigestHex>|<issuedAt> (new IRK)
 *
 * keptDevicesDigest = SHA-256 of the lines `<deviceId>:<devicePubHex>\n`, sorted by device id.
 * A new IRK is always version 1 of the rotator's scheme (a fresh UMK has used no version yet).
 *
 * Vectors: packages/protocol/test-vectors/account-key-rotation/vectors.json
 * (tools/account-key-rotation-vectors.ts), read by every port.
 */
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { ed, isAcceptableEd25519PublicKey } from "./edSync.js";
import { hex, resolveMsgSigner, type MsgSigner } from "./canonicalBase.js";
import { deriveAccountDeviceKeySeed } from "./accountMetadata.js";
import { verifyAdminRootRotation, type AdminRootRotation } from "./adminRootRotation.js";
import { verifyAdminRootRotationPq, pqBindingKeyIdHex } from "./pqAuthorityRecords.js";
import { strictInForce, type PolicyState } from "./assurancePolicy.js";
import {
  sealForRecipientWithRandomness,
  sealForEd25519Recipient,
  openSealedFromEd25519Recipient,
} from "./encryption.js";
import {
  HYBRID_SEAL_RANDOMNESS_LEN,
  hybridOpen,
  hybridSeal,
  hybridSealWithRandomness,
  hybridSign,
  parseHybridSealPublicKey,
} from "./pqHybrid.js";
import {
  PqTrustError,
  pqKeyBindingFromWire,
  verifyCriticalSignature,
  verifyPqKeyBinding,
  type PqKeyBindingWire,
  type SignatureEnvelope,
  type VerifiedPqKeyBinding,
} from "./pqTrust.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Bytes } from "./types.js";

export const TAG_ACCOUNT_KEY_ROTATION = "flagship/account-key-rotation/v1";
export const TAG_ACCOUNT_KEY_ROTATION_V2 = "flagship/account-key-rotation/v2";
export const TAG_UMK_ROTATION_DELIVERY = "flagship/umk-rotation-delivery/v1";
export const TAG_DEVICE_KEY_ROTATE = "flagship/device-key-rotate/v1";
export const TAG_DEVICE_RECEIVE_KEY = "flagship/device-receive-key/v1";
export const TAG_CGK_REKEY = "flagship/cgk-rekey/v1";
export const TAG_SWK_REKEY = "flagship/swk-rekey/v1";
export const TAG_LUKS_REKEY_CONFIRM = "flagship/luks-rekey-confirm/v1";

export const IRK_SCHEMES = ["web", "ios", "android"] as const;
export type IrkScheme = (typeof IRK_SCHEMES)[number];
/** The plaintext's scheme byte. */
const SCHEME_BYTE: Record<IrkScheme, number> = { web: 1, ios: 2, android: 3 };
const FLAG_ADMIN_ROOT = 0x01;
const HYBRID = "hybrid-ed25519-mldsa65/v1";

const HEX32 = /^[0-9a-f]{64}$/;
const HEX16 = /^[0-9a-f]{32}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const DEVICE_ID = HEX16;
const DOMAIN = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;
const enc = new TextEncoder();

export type AccountKeyRotationErrorCode =
  | "malformed"
  | "wrong-account"
  | "signed-by-irk"
  | "wrong-admin-root"
  | "stale-epoch"
  | "epoch-gap"
  | "bad-epoch-step"
  | "wrong-old-irk"
  | "wrong-old-aid"
  | "weak-key"
  | "key-not-new"
  | "bad-admin-signature"
  | "bad-new-irk-signature"
  | "bad-new-aid-signature"
  | "bad-admin-root-rotation"
  | "not-kept"
  | "kept-digest-mismatch"
  | "wrong-recipient"
  | "rotation-mismatch"
  | "sealed-mismatch"
  | "open-failed"
  | "bad-plaintext"
  | "umk-mismatch"
  | "bad-signature";

export class AccountKeyRotationError extends Error {
  constructor(readonly code: AccountKeyRotationErrorCode | string) {
    super(code);
    this.name = "AccountKeyRotationError";
  }
}
const fail = (code: AccountKeyRotationErrorCode): never => {
  throw new AccountKeyRotationError(code);
};

function bytesOf(h: string): Bytes {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(`account-key-rotation: invalid ${what}`);
}
const isUint = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
function username(u: string): string {
  need(typeof u === "string" && u.length > 0 && u.length <= 64 && u === u.toLowerCase(), "username");
  for (let i = 0; i < u.length; i++) {
    const c = u.charCodeAt(i);
    need(c !== 0x7c && c > 0x1f && c !== 0x7f, "username");
  }
  return u;
}
const hex32 = (v: string, what: string): string => (need(typeof v === "string" && HEX32.test(v), what), v);
const uint = (v: number, what: string): number => (need(isUint(v), what), v);
const domain = (v: string): string => (need(typeof v === "string" && DOMAIN.test(v), "serverDomain"), v);
const deviceId = (v: string): string => (need(typeof v === "string" && DEVICE_ID.test(v), "deviceId"), v);
const sealedHex = (v: string): string => (need(typeof v === "string" && HEX.test(v), "sealedHex"), v);

function verifyEd(sigHex: string, msg: Bytes, pubHex: string): boolean {
  if (typeof sigHex !== "string" || !/^[0-9a-f]{128}$/.test(sigHex)) return false;
  if (!HEX32.test(pubHex) || !isAcceptableEd25519PublicKey(pubHex)) return false;
  try {
    return ed.verify(bytesOf(sigHex), msg, bytesOf(pubHex));
  } catch {
    return false;
  }
}
const signEd = (signer: MsgSigner, msg: Bytes): string => hex(resolveMsgSigner(signer)(msg));

// ── The hop ───────────────────────────────────────────────────────────────

export interface AccountKeyRotation {
  username: string;
  fromEpoch: number;
  toEpoch: number;
  oldIrkPubHex: string;
  newIrkPubHex: string;
  newIrkScheme: IrkScheme;
  oldAidPubHex: string;
  newAidPubHex: string;
  /** The admin root that authorises the hop: the one every verifier already pins. */
  adminRootPubHex: string;
  removedDeviceIds: string[];
  keptDevicesDigestHex: string;
  /** SHA-256 of the replacement recovery record, or null when the old one is deleted. */
  recoveryRecordDigestHex: string | null;
  /** 16 random bytes, lowercase hex. */
  nonceHex: string;
  issuedAt: number;
}

export interface AccountKeyRotationSignatures {
  adminRootSignatureHex: string;
  newIrkSignatureHex: string;
  newAidSignatureHex: string;
}

function rotationFields(r: AccountKeyRotation): string[] {
  need(IRK_SCHEMES.includes(r.newIrkScheme), "newIrkScheme");
  need(Array.isArray(r.removedDeviceIds), "removedDeviceIds");
  const removed = [...r.removedDeviceIds].map(deviceId).sort();
  for (let i = 1; i < removed.length; i++) need(removed[i] !== removed[i - 1], "removedDeviceIds (duplicate)");
  need(r.recoveryRecordDigestHex === null || HEX32.test(r.recoveryRecordDigestHex), "recoveryRecordDigestHex");
  need(typeof r.nonceHex === "string" && HEX16.test(r.nonceHex), "nonceHex");
  return [
    username(r.username),
    String(uint(r.fromEpoch, "fromEpoch")),
    String(uint(r.toEpoch, "toEpoch")),
    hex32(r.oldIrkPubHex, "oldIrkPubHex"),
    hex32(r.newIrkPubHex, "newIrkPubHex"),
    r.newIrkScheme,
    hex32(r.oldAidPubHex, "oldAidPubHex"),
    hex32(r.newAidPubHex, "newAidPubHex"),
    hex32(r.adminRootPubHex, "adminRootPubHex"),
    removed.length ? removed.join(",") : "none",
    hex32(r.keptDevicesDigestHex, "keptDevicesDigestHex"),
    r.recoveryRecordDigestHex ?? "none",
    r.nonceHex,
    String(uint(r.issuedAt, "issuedAt")),
  ];
}

export function canonicalAccountKeyRotation(r: AccountKeyRotation): Bytes {
  return enc.encode([TAG_ACCOUNT_KEY_ROTATION, ...rotationFields(r)].join("|"));
}

/** SHA-256 of the hop's canonical bytes: what deliveries and `.com`'s idempotency key name. */
export function accountKeyRotationDigestHex(r: AccountKeyRotation): string {
  return hex(sha256(canonicalAccountKeyRotation(r)));
}

export function signAccountKeyRotation(
  r: AccountKeyRotation,
  signers: { adminRoot: MsgSigner; newIrk: MsgSigner; newAid: MsgSigner },
): AccountKeyRotationSignatures {
  const msg = canonicalAccountKeyRotation(r);
  return {
    adminRootSignatureHex: signEd(signers.adminRoot, msg),
    newIrkSignatureHex: signEd(signers.newIrk, msg),
    newAidSignatureHex: signEd(signers.newAid, msg),
  };
}

/** What the verifier holds now: its pinned admin root, and the account's current key state. */
export interface AccountKeyState {
  username: string;
  epoch: number;
  irkPubHex: string;
  /** Unknown to a verifier that never pinned the AID; the hop's old AID is then not checked. */
  aidPubHex?: string | null;
  adminRootPubHex: string;
}

/**
 * Verifies one hop against the verifier's own state. Never trusts the hop's word for the admin
 * root: it must equal the pinned one. Throws `AccountKeyRotationError`.
 */
export function verifyAccountKeyRotation(args: {
  rotation: AccountKeyRotation;
  signatures: AccountKeyRotationSignatures;
  state: AccountKeyState;
}): void {
  const { rotation: r, signatures: s } = args;
  const state = {
    username: args.state.username.toLowerCase(),
    epoch: args.state.epoch,
    irkPubHex: args.state.irkPubHex.toLowerCase(),
    aidPubHex: args.state.aidPubHex ? args.state.aidPubHex.toLowerCase() : null,
    adminRootPubHex: args.state.adminRootPubHex.toLowerCase(),
  };
  let msg: Bytes;
  try {
    msg = canonicalAccountKeyRotation(r);
  } catch {
    return fail("malformed");
  }
  if (!s || typeof s !== "object") return fail("malformed");
  if (r.username !== state.username) fail("wrong-account");
  if (r.adminRootPubHex === state.irkPubHex || r.adminRootPubHex === r.oldIrkPubHex || r.adminRootPubHex === r.oldAidPubHex) {
    fail("signed-by-irk");
  }
  if (r.adminRootPubHex !== state.adminRootPubHex) fail("wrong-admin-root");
  if (r.fromEpoch < state.epoch) fail("stale-epoch");
  if (r.fromEpoch > state.epoch) fail("epoch-gap");
  if (r.toEpoch !== r.fromEpoch + 1) fail("bad-epoch-step");
  if (r.oldIrkPubHex !== state.irkPubHex) fail("wrong-old-irk");
  if (state.aidPubHex && r.oldAidPubHex !== state.aidPubHex) fail("wrong-old-aid");
  if (!isAcceptableEd25519PublicKey(r.newIrkPubHex) || !isAcceptableEd25519PublicKey(r.newAidPubHex)) fail("weak-key");
  const keys = [r.oldIrkPubHex, r.newIrkPubHex, r.oldAidPubHex, r.newAidPubHex, r.adminRootPubHex];
  if (new Set(keys).size !== keys.length) fail("key-not-new");
  if (!verifyEd(s.adminRootSignatureHex, msg, r.adminRootPubHex)) fail("bad-admin-signature");
  if (!verifyEd(s.newIrkSignatureHex, msg, r.newIrkPubHex)) fail("bad-new-irk-signature");
  if (!verifyEd(s.newAidSignatureHex, msg, r.newAidPubHex)) fail("bad-new-aid-signature");
}

// ── Hybrid companion (strict) ─────────────────────────────────────────────

export interface AccountKeyRotationPq {
  /** The admin root's hybrid signature over the v2 bytes. */
  signature: SignatureEnvelope;
  /** The new IRK's `account-irk` binding (its ML-DSA key, signed by both halves). */
  newIrkBinding: PqKeyBindingWire;
}

export function canonicalAccountKeyRotationV2(r: AccountKeyRotation, newIrkKeyIdHex: string): Bytes {
  need(HEX32.test(newIrkKeyIdHex), "newIrkKeyIdHex");
  return enc.encode([TAG_ACCOUNT_KEY_ROTATION_V2, ...rotationFields(r), newIrkKeyIdHex].join("|"));
}

/** Signs the companion with the admin root's hybrid secret (Ed25519 seed || ML-DSA seed). */
export function signAccountKeyRotationPq(
  r: AccountKeyRotation,
  adminRootHybridSecret: Bytes,
  newIrkBinding: PqKeyBindingWire,
  opts: { deterministic?: boolean } = {},
): AccountKeyRotationPq {
  const msg = canonicalAccountKeyRotationV2(r, pqBindingKeyIdHex(newIrkBinding));
  const sig = hybridSign(adminRootHybridSecret, TAG_ACCOUNT_KEY_ROTATION_V2, msg, opts);
  return { signature: { suite: HYBRID, signature: hex(sig) }, newIrkBinding };
}

/**
 * Verifies the companion under the verifier's own binding for the admin root and returns the new
 * IRK's verified binding. Throws `PqTrustError`.
 */
export function verifyAccountKeyRotationPq(args: {
  rotation: AccountKeyRotation;
  pq: unknown;
  adminRootBinding: VerifiedPqKeyBinding | null;
  policy: PolicyState;
  now: number;
}): VerifiedPqKeyBinding {
  const o = args.pq && typeof args.pq === "object" ? (args.pq as Record<string, unknown>) : null;
  if (!o) throw new PqTrustError("strict-requires-hybrid");
  const e = o.signature && typeof o.signature === "object" ? (o.signature as Record<string, unknown>) : null;
  if (!e || typeof e.suite !== "string" || typeof e.signature !== "string") throw new PqTrustError("bad-signature");
  if (e.suite !== HYBRID) throw new PqTrustError(e.suite === "ed25519/v1" ? "strict-requires-hybrid" : "unknown-suite");
  const binding = verifyPqKeyBinding(pqKeyBindingFromWire(o.newIrkBinding), {
    role: "account-irk",
    subjectId: args.rotation.username,
    ed25519PubHex: args.rotation.newIrkPubHex,
    now: args.now,
  });
  let message: Bytes;
  try {
    message = canonicalAccountKeyRotationV2(args.rotation, binding.keyIdHex);
  } catch {
    throw new PqTrustError("bad-signature");
  }
  verifyCriticalSignature({
    message,
    expectedPurpose: TAG_ACCOUNT_KEY_ROTATION_V2,
    envelope: { suite: HYBRID, signature: e.signature },
    signerEd25519PubHex: args.rotation.adminRootPubHex,
    binding: args.adminRootBinding,
    policy: args.policy,
  });
  return binding;
}

// ── The box's chain ───────────────────────────────────────────────────────

export type AccountKeyChainEvent =
  | {
      kind: "admin-root-rotation";
      rotation: { username: string; oldAdminRootPubHex: string; newAdminRootPubHex: string; issuedAt: number };
      signatureHex: string;
      pq?: unknown;
    }
  | {
      kind: "account-key-rotation";
      rotation: AccountKeyRotation;
      signatures: AccountKeyRotationSignatures;
      pq?: unknown;
    };

export interface AccountKeyChainResult {
  state: AccountKeyState;
  /** Account-key hops applied (admin-root rotations are not counted). */
  applied: number;
  /** Under strict: the admin root's and the new IRK's verified bindings after the last event. */
  adminRootBinding: VerifiedPqKeyBinding | null;
  irkBinding: VerifiedPqKeyBinding | null;
}

/**
 * Replays the account's lane in order from the box's pinned state: admin-root rotations re-pin
 * the root (signed by the root pinned at that point), account-key hops move the epoch (signed by
 * the root pinned at that point, never by an IRK). Epochs must be contiguous from the box's own.
 * Under strict (`pq.policy`) every event needs its hybrid companion. All or nothing: a bad event
 * throws and nothing is applied. Throws `AccountKeyRotationError` (PQ refusals keep their
 * `PqTrustError` code).
 */
export function verifyAccountKeyRotationChain(args: {
  start: AccountKeyState;
  events: readonly AccountKeyChainEvent[];
  pq?: { policy: PolicyState; adminRootBinding: VerifiedPqKeyBinding | null; now: number };
}): AccountKeyChainResult {
  const state: AccountKeyState = {
    username: args.start.username.toLowerCase(),
    epoch: args.start.epoch,
    irkPubHex: args.start.irkPubHex.toLowerCase(),
    aidPubHex: args.start.aidPubHex ? args.start.aidPubHex.toLowerCase() : null,
    adminRootPubHex: args.start.adminRootPubHex.toLowerCase(),
  };
  const strict = args.pq ? strictInForce(args.pq.policy) : false;
  let adminRootBinding = args.pq?.adminRootBinding ?? null;
  let irkBinding: VerifiedPqKeyBinding | null = null;
  let applied = 0;
  const pqCode = (e: unknown): never => {
    if (e instanceof PqTrustError) throw new AccountKeyRotationError(e.code);
    throw e;
  };
  for (const ev of args.events) {
    if (ev.kind === "admin-root-rotation") {
      const r = ev.rotation;
      if (!r || r.username !== state.username) fail("wrong-account");
      if (!HEX32.test(r.oldAdminRootPubHex) || !HEX32.test(r.newAdminRootPubHex)) fail("malformed");
      if (r.oldAdminRootPubHex !== state.adminRootPubHex) fail("wrong-admin-root");
      if (!isAcceptableEd25519PublicKey(r.newAdminRootPubHex)) fail("weak-key");
      const rot: AdminRootRotation = {
        username: r.username,
        oldAdminRootPub: bytesOf(r.oldAdminRootPubHex),
        newAdminRootPub: bytesOf(r.newAdminRootPubHex),
        issuedAt: r.issuedAt,
      };
      if (!/^[0-9a-f]{128}$/.test(ev.signatureHex ?? "") || !verifyAdminRootRotation(rot, bytesOf(ev.signatureHex), rot.oldAdminRootPub)) {
        fail("bad-admin-root-rotation");
      }
      if (strict && args.pq) {
        try {
          adminRootBinding = verifyAdminRootRotationPq({ rotation: rot, pq: ev.pq, oldRootBinding: adminRootBinding, policy: args.pq.policy, now: args.pq.now });
        } catch (e) {
          pqCode(e);
        }
      }
      state.adminRootPubHex = r.newAdminRootPubHex;
      continue;
    }
    if (ev.kind !== "account-key-rotation") fail("malformed");
    verifyAccountKeyRotation({ rotation: ev.rotation, signatures: ev.signatures, state });
    if (strict && args.pq) {
      try {
        irkBinding = verifyAccountKeyRotationPq({ rotation: ev.rotation, pq: ev.pq, adminRootBinding, policy: args.pq.policy, now: args.pq.now });
      } catch (e) {
        pqCode(e);
      }
    }
    state.epoch = ev.rotation.toEpoch;
    state.irkPubHex = ev.rotation.newIrkPubHex;
    state.aidPubHex = ev.rotation.newAidPubHex;
    applied++;
  }
  return { state, applied, adminRootBinding, irkBinding };
}

// ── Kept devices ──────────────────────────────────────────────────────────

export interface KeptDevice {
  deviceId: string;
  devicePubHex: string;
}

/** The lines the digest hashes, sorted by device id; duplicates and bad fields throw. */
export function keptDevicesLines(devices: readonly KeptDevice[]): string {
  need(Array.isArray(devices) && devices.length > 0, "kept devices");
  const sorted = devices.map((d) => ({ id: deviceId(d.deviceId), pub: hex32(d.devicePubHex, "devicePubHex") }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) need(sorted[i]!.id !== sorted[i - 1]!.id, "kept devices (duplicate id)");
  return sorted.map((d) => `${d.id}:${d.pub}\n`).join("");
}

export function keptDevicesDigestHex(devices: readonly KeptDevice[]): string {
  return hex(sha256(enc.encode(keptDevicesLines(devices))));
}

/** A receiving device: the list `.com` relayed must hash to the hop's digest and name this device. */
export function verifyKeptDevice(args: { rotation: AccountKeyRotation; kept: readonly KeptDevice[]; self: KeptDevice }): void {
  let digest: string;
  try {
    digest = keptDevicesDigestHex(args.kept);
  } catch {
    return fail("malformed");
  }
  if (digest !== args.rotation.keptDevicesDigestHex) fail("kept-digest-mismatch");
  if (!args.kept.some((d) => d.deviceId === args.self.deviceId && d.devicePubHex === args.self.devicePubHex)) fail("not-kept");
}

// ── Derived-key detection ─────────────────────────────────────────────────

/**
 * True when `devicePubHex` is the account device key `HKDF(umk, account-device-key/v1|acct|id)`:
 * anyone holding that UMK can sign as the device, so it must not receive the new one.
 */
export function deviceKeyIsUmkDerived(umk: Bytes, accountName: string, id: string, devicePubHex: string): boolean {
  if (!DEVICE_ID.test(id) || !HEX32.test(devicePubHex)) return false;
  const seed = deriveAccountDeviceKeySeed(umk, accountName, id);
  return hex(ed.getPublicKey(seed)) === devicePubHex;
}

// ── The new UMK's derivations ─────────────────────────────────────────────

/** The IRK seed of `scheme` at `version` (tools/irk-lineage-vectors.mjs has all three). */
export function deriveIrkSeedInScheme(umk: Bytes, scheme: IrkScheme, version = 1): Bytes {
  need(umk.length === 32, "umk");
  need(Number.isSafeInteger(version) && version >= 1, "irk version");
  const [salt, info] =
    scheme === "web" ? ["", `flagship.irk.v${version}`] :
    scheme === "ios" ? ["", `flagship/irk/v${version}`] :
    [`flagship/irk/v${version}`, "ed25519-seed"];
  return hkdf(sha256, umk, enc.encode(salt), enc.encode(info), 32);
}

export function deriveAidSeed(umk: Bytes): Bytes {
  need(umk.length === 32, "umk");
  return hkdf(sha256, umk, new Uint8Array(0), enc.encode("flagship/account-id/v1"), 32);
}

/** After opening: the delivered UMK must yield the hop's new IRK (its scheme, v1) and new AID. */
export function checkRotatedUmk(r: AccountKeyRotation, p: UmkRotationPlaintext): void {
  if (p.irkScheme !== r.newIrkScheme) fail("umk-mismatch");
  if (hex(ed.getPublicKey(deriveIrkSeedInScheme(p.umk, p.irkScheme, 1))) !== r.newIrkPubHex) fail("umk-mismatch");
  if (hex(ed.getPublicKey(deriveAidSeed(p.umk))) !== r.newAidPubHex) fail("umk-mismatch");
}

// ── The delivery ──────────────────────────────────────────────────────────

export interface UmkRotationPlaintext {
  umk: Bytes;
  irkScheme: IrkScheme;
  /** Present only when this device stays a bare-root admin. */
  adminRootSeed?: Bytes | null;
}

/** `umk(32) | irkScheme(1) | flags(1) | [adminRootSeed(32)]`; flags bit 0 = admin root follows. */
export function encodeUmkRotationPlaintext(p: UmkRotationPlaintext): Bytes {
  need(p.umk instanceof Uint8Array && p.umk.length === 32, "umk");
  need(IRK_SCHEMES.includes(p.irkScheme), "irkScheme");
  const root = p.adminRootSeed ?? null;
  need(root === null || (root instanceof Uint8Array && root.length === 32), "adminRootSeed");
  const out = new Uint8Array(root ? 66 : 34);
  out.set(p.umk, 0);
  out[32] = SCHEME_BYTE[p.irkScheme];
  out[33] = root ? FLAG_ADMIN_ROOT : 0;
  if (root) out.set(root, 34);
  return out;
}

export function decodeUmkRotationPlaintext(b: Bytes): UmkRotationPlaintext {
  if (!(b instanceof Uint8Array) || (b.length !== 34 && b.length !== 66)) return fail("bad-plaintext");
  const scheme = IRK_SCHEMES.find((s) => SCHEME_BYTE[s] === b[32]);
  if (!scheme) return fail("bad-plaintext");
  const flags = b[33]!;
  if ((flags & ~FLAG_ADMIN_ROOT) !== 0) fail("bad-plaintext");
  const hasRoot = (flags & FLAG_ADMIN_ROOT) !== 0;
  if (hasRoot !== (b.length === 66)) fail("bad-plaintext");
  return { umk: b.slice(0, 32), irkScheme: scheme, adminRootSeed: hasRoot ? b.slice(34, 66) : null };
}

export interface UmkRotationDelivery {
  username: string;
  toEpoch: number;
  deviceId: string;
  devicePubHex: string;
  rotationDigestHex: string;
  sealedDigestHex: string;
  issuedAt: number;
}

export function canonicalUmkRotationDelivery(d: UmkRotationDelivery): Bytes {
  return enc.encode([
    TAG_UMK_ROTATION_DELIVERY,
    username(d.username),
    String(uint(d.toEpoch, "toEpoch")),
    deviceId(d.deviceId),
    hex32(d.devicePubHex, "devicePubHex"),
    hex32(d.rotationDigestHex, "rotationDigestHex"),
    hex32(d.sealedDigestHex, "sealedDigestHex"),
    String(uint(d.issuedAt, "issuedAt")),
  ].join("|"));
}

export type SealKind = "xwing" | "ed25519";

/** The hybrid seal's context: account, epoch, device. */
export function umkDeliveryContext(accountName: string, toEpoch: number, id: string): Bytes[] {
  return [enc.encode(username(accountName)), enc.encode(String(uint(toEpoch, "toEpoch"))), enc.encode(deviceId(id))];
}

/** The hybrid seal's sender key id: SHA-256 of the admin root's Ed25519 key. */
export function umkDeliverySenderKeyId(adminRootPubHex: string): Bytes {
  return sha256(bytesOf(hex32(adminRootPubHex, "adminRootPubHex")));
}

/**
 * Seals the plaintext to the device: X-Wing to its receive key when it has one, else to its
 * random Ed25519 identity key (classical; harvestable later). `randomness` is for vectors only.
 */
export function sealUmkRotation(args: {
  rotation: AccountKeyRotation;
  deviceId: string;
  plaintext: Bytes;
  recipient: { kind: "xwing"; publicKey: Bytes } | { kind: "ed25519"; devicePub: Bytes };
  issuedAt: number;
  randomness?: { xwing?: Bytes; ephPriv?: Bytes; nonce?: Bytes };
}): { kind: SealKind; sealed: Bytes } {
  const r = args.rotation;
  if (args.recipient.kind === "xwing") {
    parseHybridSealPublicKey(args.recipient.publicKey);
    const opts = { purpose: TAG_UMK_ROTATION_DELIVERY, senderKeyId: umkDeliverySenderKeyId(r.adminRootPubHex), issuedAt: uint(args.issuedAt, "issuedAt") };
    const ctx = umkDeliveryContext(r.username, r.toEpoch, args.deviceId);
    const rnd = args.randomness?.xwing;
    if (rnd) need(rnd.length === HYBRID_SEAL_RANDOMNESS_LEN, "randomness");
    const sealed = rnd
      ? hybridSealWithRandomness(args.recipient.publicKey, opts, ctx, args.plaintext, rnd)
      : hybridSeal(args.recipient.publicKey, opts, ctx, args.plaintext);
    return { kind: "xwing", sealed };
  }
  const pub = args.recipient.devicePub;
  need(pub.length === 32, "devicePub");
  const { ephPriv, nonce } = args.randomness ?? {};
  const sealed = ephPriv && nonce
    ? sealForRecipientWithRandomness(args.plaintext, ed25519.utils.toMontgomery(pub), ephPriv, nonce)
    : sealForEd25519Recipient(args.plaintext, pub);
  return { kind: "ed25519", sealed };
}

/** Builds and admin-root-signs the delivery for one sealed blob. */
export function buildUmkRotationDelivery(args: {
  rotation: AccountKeyRotation;
  deviceId: string;
  devicePubHex: string;
  sealed: Bytes;
  issuedAt: number;
  adminRoot: MsgSigner;
}): { delivery: UmkRotationDelivery; signatureHex: string } {
  const delivery: UmkRotationDelivery = {
    username: args.rotation.username,
    toEpoch: args.rotation.toEpoch,
    deviceId: args.deviceId,
    devicePubHex: args.devicePubHex,
    rotationDigestHex: accountKeyRotationDigestHex(args.rotation),
    sealedDigestHex: hex(sha256(args.sealed)),
    issuedAt: args.issuedAt,
  };
  return { delivery, signatureHex: signEd(args.adminRoot, canonicalUmkRotationDelivery(delivery)) };
}

/**
 * A kept device opens its delivery: the admin root (the hop's, which the caller has already
 * verified against its own pin) signed it, it names this hop, this device and these sealed bytes;
 * then the seal opens and the UMK yields the hop's new keys. Throws `AccountKeyRotationError`.
 */
export function openUmkRotationDelivery(args: {
  rotation: AccountKeyRotation;
  delivery: UmkRotationDelivery;
  signatureHex: string;
  sealed: Bytes;
  kind: SealKind;
  self: KeptDevice;
  /** X-Wing receive-key seed (kind "xwing") or the Ed25519 identity seed (kind "ed25519"). */
  secret: Bytes;
}): UmkRotationPlaintext {
  const { rotation: r, delivery: d } = args;
  let msg: Bytes;
  try {
    msg = canonicalUmkRotationDelivery(d);
  } catch {
    return fail("malformed");
  }
  if (!verifyEd(args.signatureHex, msg, r.adminRootPubHex)) fail("bad-signature");
  if (d.username !== r.username || d.toEpoch !== r.toEpoch) fail("rotation-mismatch");
  if (d.rotationDigestHex !== accountKeyRotationDigestHex(r)) fail("rotation-mismatch");
  if (d.deviceId !== args.self.deviceId || d.devicePubHex !== args.self.devicePubHex) fail("wrong-recipient");
  if (d.sealedDigestHex !== hex(sha256(args.sealed))) fail("sealed-mismatch");
  let plain: Bytes;
  try {
    if (args.kind === "xwing") {
      const opened = hybridOpen(args.secret, TAG_UMK_ROTATION_DELIVERY, umkDeliveryContext(r.username, r.toEpoch, d.deviceId), args.sealed);
      if (opened.header.issuedAt !== d.issuedAt) throw new Error("issuedAt");
      if (hex(opened.header.senderKeyId) !== hex(umkDeliverySenderKeyId(r.adminRootPubHex))) throw new Error("sender");
      plain = opened.plaintext;
    } else if (args.kind === "ed25519") {
      if (hex(ed.getPublicKey(args.secret)) !== d.devicePubHex) throw new Error("seed");
      plain = openSealedFromEd25519Recipient(args.sealed, args.secret);
    } else {
      throw new Error("kind");
    }
  } catch {
    return fail("open-failed");
  }
  const p = decodeUmkRotationPlaintext(plain);
  checkRotatedUmk(r, p);
  return p;
}

// ── Device key rotate / receive key ───────────────────────────────────────

export interface DeviceKeyRotate {
  username: string;
  deviceId: string;
  oldDevicePubHex: string;
  newDevicePubHex: string;
  issuedAt: number;
}

export function canonicalDeviceKeyRotate(r: DeviceKeyRotate): Bytes {
  return enc.encode([
    TAG_DEVICE_KEY_ROTATE,
    username(r.username),
    deviceId(r.deviceId),
    hex32(r.oldDevicePubHex, "oldDevicePubHex"),
    hex32(r.newDevicePubHex, "newDevicePubHex"),
    String(uint(r.issuedAt, "issuedAt")),
  ].join("|"));
}

export function signDeviceKeyRotate(r: DeviceKeyRotate, signers: { newKey: MsgSigner; adminRoot: MsgSigner }): { newKeySignatureHex: string; adminRootSignatureHex: string } {
  const msg = canonicalDeviceKeyRotate(r);
  return { newKeySignatureHex: signEd(signers.newKey, msg), adminRootSignatureHex: signEd(signers.adminRoot, msg) };
}

/** Both signatures, the new key acceptable and different from the old. */
export function verifyDeviceKeyRotate(r: DeviceKeyRotate, s: { newKeySignatureHex: string; adminRootSignatureHex: string }, adminRootPubHex: string): boolean {
  let msg: Bytes;
  try {
    msg = canonicalDeviceKeyRotate(r);
  } catch {
    return false;
  }
  if (r.newDevicePubHex === r.oldDevicePubHex || r.newDevicePubHex === adminRootPubHex) return false;
  return verifyEd(s.newKeySignatureHex, msg, r.newDevicePubHex) && verifyEd(s.adminRootSignatureHex, msg, adminRootPubHex);
}

export interface DeviceReceiveKey {
  username: string;
  deviceId: string;
  devicePubHex: string;
  /** The X-Wing encapsulation key (1216 bytes), lowercase hex. */
  xwingPubHex: string;
  issuedAt: number;
}

export function canonicalDeviceReceiveKey(k: DeviceReceiveKey): Bytes {
  need(typeof k.xwingPubHex === "string" && HEX.test(k.xwingPubHex), "xwingPubHex");
  parseHybridSealPublicKey(bytesOf(k.xwingPubHex));
  return enc.encode([
    TAG_DEVICE_RECEIVE_KEY,
    username(k.username),
    deviceId(k.deviceId),
    hex32(k.devicePubHex, "devicePubHex"),
    k.xwingPubHex,
    String(uint(k.issuedAt, "issuedAt")),
  ].join("|"));
}

export function signDeviceReceiveKey(k: DeviceReceiveKey, deviceKey: MsgSigner): string {
  return signEd(deviceKey, canonicalDeviceReceiveKey(k));
}

/** Signed by the device's own identity key, which the verifier knows from the device record. */
export function verifyDeviceReceiveKey(k: DeviceReceiveKey, signatureHex: string): boolean {
  let msg: Bytes;
  try {
    msg = canonicalDeviceReceiveKey(k);
  } catch {
    return false;
  }
  return verifyEd(signatureHex, msg, k.devicePubHex);
}

// ── Per-server follow-ups ─────────────────────────────────────────────────

export interface CgkRekey {
  serverDomain: string;
  toEpoch: number;
  sealedHex: string;
  issuedAt: number;
}

export function canonicalCgkRekey(c: CgkRekey): Bytes {
  return enc.encode([TAG_CGK_REKEY, domain(c.serverDomain), String(uint(c.toEpoch, "toEpoch")), sealedHex(c.sealedHex), String(uint(c.issuedAt, "issuedAt"))].join("|"));
}

export interface SwkRekey {
  serverDomain: string;
  toEpoch: number;
  oldSwkCommitHex: string;
  sealedHex: string;
  issuedAt: number;
}

export function canonicalSwkRekey(c: SwkRekey): Bytes {
  return enc.encode([
    TAG_SWK_REKEY,
    domain(c.serverDomain),
    String(uint(c.toEpoch, "toEpoch")),
    hex32(c.oldSwkCommitHex, "oldSwkCommitHex"),
    sealedHex(c.sealedHex),
    String(uint(c.issuedAt, "issuedAt")),
  ].join("|"));
}

export interface LuksRekeyConfirm {
  serverDomain: string;
  toEpoch: number;
  sealedKeyDigestHex: string;
  issuedAt: number;
}

export function canonicalLuksRekeyConfirm(c: LuksRekeyConfirm): Bytes {
  return enc.encode([
    TAG_LUKS_REKEY_CONFIRM,
    domain(c.serverDomain),
    String(uint(c.toEpoch, "toEpoch")),
    hex32(c.sealedKeyDigestHex, "sealedKeyDigestHex"),
    String(uint(c.issuedAt, "issuedAt")),
  ].join("|"));
}

/** Signs a follow-up: CGK and SWK re-keys by the admin root, the LUKS confirmation by the new IRK. */
export function signRekey(canonical: Bytes, signer: MsgSigner): string {
  return signEd(signer, canonical);
}

export function verifyRekey(build: () => Bytes, signatureHex: string, signerPubHex: string): boolean {
  let msg: Bytes;
  try {
    msg = build();
  } catch {
    return false;
  }
  return verifyEd(signatureHex, msg, signerPubHex);
}
