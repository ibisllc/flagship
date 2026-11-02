/**
 * Messages key attestations (docs/voici-and-messages.md §6.3, §9.3): `.com`'s CA vouches that "a Flagship account in
 * good standing" holds a per-page pseudonym key P, naming no account, and binds an abuse tag (the sender's account,
 * sealed to an offline Flagship abuse key) into the signed bytes. A sibling of accountKeyAttestation.ts.
 *
 *   request  flagship/messages-key-attestation-request/v1|<username>|<Ppub>|<renewOfHash or "">|<deviceCheckRef>|<issuedAt>
 *            signed (Ed25519) by an account device key; deviceCheckRef is the platform of the integrity evidence that
 *            rides beside the request: "ios" (App Attest + DeviceCheck), "android" (Play Integrity) or "none"
 *            (unattested tier, §9.5). The evidence itself is over H(request canonical bytes), so it cannot be named
 *            inside them.
 *   answer   flagship/messages-key-attestation/v1|<Ppub>|<abuseEpoch>|<H(abuseTag)>|<issuedAt>|<expiresAt>
 *            signed (Ed25519) by .com's CA key; envelope
 *            {kind:"MessagesKeyAttestation", version:1, pseudonymPub, abuseEpoch, abuseTagHash, abuseTag, issuedAt,
 *             expiresAt, signedBy, signature}; abuseTag is standard base64 of the sealed bytes, H = SHA-256 hex of them.
 *   abuseTag flagship/hybrid-seal/v1 to the abuse key of abuseEpoch, purpose flagship/voici-abuse-tag/v1, context
 *            [UTF-8 of Ppub hex], header senderKeyId = SHA-256(raw Ppub), issuedAt = the attestation's issuedAt;
 *            plaintext canonicalJson({v:1, username, accountCreatedAt, issuedAt}).
 *   abuse key list entry  flagship/abuse-key/v1|<epoch>|<xwingPub>|<notBefore>|<notAfter>, Ed25519 by the cold
 *            ca-track key.
 * renewOfHash = SHA-256 hex of canonicalJson(previous attestation envelope).
 *
 * Exported API: TAG_MESSAGES_KEY_ATTESTATION, TAG_MESSAGES_KEY_ATTESTATION_REQUEST, TAG_VOICI_ABUSE_TAG,
 * TAG_ABUSE_KEY, MESSAGES_ATTESTATION_TTL_MS, MESSAGES_ATTESTATION_RENEW_GRACE_MS, MESSAGES_ATTESTATION_REQUEST_SKEW_MS,
 * DEVICE_CHECK_REFS, DeviceCheckRef, MessagesKeyAttestationRequest, canonicalMessagesKeyAttestationRequest,
 * signMessagesKeyAttestationRequest, verifyMessagesKeyAttestationRequest, MessagesKeyAttestationBody,
 * MessagesKeyAttestation, canonicalMessagesKeyAttestation, signMessagesKeyAttestation, parseMessagesKeyAttestation,
 * messagesAttestationHash, checkMessagesKeyAttestation (+ MessagesAttestationRefusal),
 * verifyCaSignedMessagesKeyAttestation, VoiciAbuseTagPlaintext, sealVoiciAbuseTag, openVoiciAbuseTag, AbuseKeyEntry,
 * canonicalAbuseKeyEntry, signAbuseKeyEntry, verifyAbuseKeyEntry, abuseKeyFor.
 */
import { sha256 } from "@noble/hashes/sha256";
import { hex, validateNoSepCtrl } from "./canonicalBase.js";
import { ed } from "./edSync.js";
import { authorizedCaKeysOrFailClosed, MAINTAINER_PINNED_MANDATE_HASH, type CaArtifactReject, type CaTrustChain } from "./maintainerCa.js";
import { hybridOpen, hybridSealWithRandomness, HYBRID_SEAL_RANDOMNESS_LEN, parseHybridSealPublicKey } from "./pqHybrid.js";
import type { Bytes } from "./types.js";
import { b64Decode, b64Encode, canonicalJson, canonicalJsonBytes, ed25519VerifyHex, hexToBytes, isLowerHex, sha256Hex } from "./webEnvelope.js";

export const TAG_MESSAGES_KEY_ATTESTATION = "flagship/messages-key-attestation/v1";
export const TAG_MESSAGES_KEY_ATTESTATION_REQUEST = "flagship/messages-key-attestation-request/v1";
export const TAG_VOICI_ABUSE_TAG = "flagship/voici-abuse-tag/v1";
export const TAG_ABUSE_KEY = "flagship/abuse-key/v1";

export const MESSAGES_ATTESTATION_TTL_MS = 30 * 86_400_000;
/** A renewal may name an attestation that expired at most this long ago. */
export const MESSAGES_ATTESTATION_RENEW_GRACE_MS = 7 * 86_400_000;
export const MESSAGES_ATTESTATION_REQUEST_SKEW_MS = 10 * 60_000;
/** The abuse tag's sealed bytes are a few hundred bytes over the plaintext; this caps an untrusted one. */
const ABUSE_TAG_MAX_BYTES = 4096;

export const DEVICE_CHECK_REFS = ["ios", "android", "none"] as const;
export type DeviceCheckRef = (typeof DEVICE_CHECK_REFS)[number];

const USERNAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const enc = (s: string): Bytes => new TextEncoder().encode(s);

// ── request ────────────────────────────────────────────────────────────────

export interface MessagesKeyAttestationRequest {
  username: string;
  pseudonymPub: string;
  /** "" for a first attestation. */
  renewOfHash: string;
  deviceCheckRef: DeviceCheckRef;
  issuedAt: number;
}

export function canonicalMessagesKeyAttestationRequest(r: MessagesKeyAttestationRequest): Bytes {
  if (typeof r.username !== "string" || !USERNAME.test(r.username)) throw new Error(`${TAG_MESSAGES_KEY_ATTESTATION_REQUEST}: bad username`);
  if (!isLowerHex(r.pseudonymPub, 32)) throw new Error(`${TAG_MESSAGES_KEY_ATTESTATION_REQUEST}: bad pseudonymPub`);
  if (r.renewOfHash !== "" && !isLowerHex(r.renewOfHash, 32)) throw new Error(`${TAG_MESSAGES_KEY_ATTESTATION_REQUEST}: bad renewOfHash`);
  if (!DEVICE_CHECK_REFS.includes(r.deviceCheckRef)) throw new Error(`${TAG_MESSAGES_KEY_ATTESTATION_REQUEST}: bad deviceCheckRef`);
  if (!isTime(r.issuedAt)) throw new Error(`${TAG_MESSAGES_KEY_ATTESTATION_REQUEST}: bad issuedAt`);
  return enc([TAG_MESSAGES_KEY_ATTESTATION_REQUEST, r.username, r.pseudonymPub, r.renewOfHash, r.deviceCheckRef, String(r.issuedAt)].join("|"));
}

export function signMessagesKeyAttestationRequest(r: MessagesKeyAttestationRequest, deviceSeed: Bytes): string {
  return hex(ed.sign(canonicalMessagesKeyAttestationRequest(r), deviceSeed));
}

export function verifyMessagesKeyAttestationRequest(r: MessagesKeyAttestationRequest, signature: string, devicePub: string): boolean {
  try {
    return ed25519VerifyHex(signature, canonicalMessagesKeyAttestationRequest(r), devicePub);
  } catch {
    return false;
  }
}

// ── answer ─────────────────────────────────────────────────────────────────

export interface MessagesKeyAttestationBody {
  pseudonymPub: string;
  abuseEpoch: number;
  abuseTagHash: string;
  issuedAt: number;
  expiresAt: number;
}

export interface MessagesKeyAttestation extends MessagesKeyAttestationBody {
  kind: "MessagesKeyAttestation";
  version: 1;
  /** Standard base64 of the sealed abuse tag. */
  abuseTag: string;
  signedBy: string;
  signature: string;
}

export function canonicalMessagesKeyAttestation(b: MessagesKeyAttestationBody): Bytes {
  if (!isLowerHex(b.pseudonymPub, 32)) throw new Error(`${TAG_MESSAGES_KEY_ATTESTATION}: bad pseudonymPub`);
  if (!isTime(b.abuseEpoch) || b.abuseEpoch < 1) throw new Error(`${TAG_MESSAGES_KEY_ATTESTATION}: bad abuseEpoch`);
  if (!isLowerHex(b.abuseTagHash, 32)) throw new Error(`${TAG_MESSAGES_KEY_ATTESTATION}: bad abuseTagHash`);
  if (!isTime(b.issuedAt) || !isTime(b.expiresAt) || b.expiresAt <= b.issuedAt) throw new Error(`${TAG_MESSAGES_KEY_ATTESTATION}: bad time`);
  return enc([TAG_MESSAGES_KEY_ATTESTATION, b.pseudonymPub, String(b.abuseEpoch), b.abuseTagHash, String(b.issuedAt), String(b.expiresAt)].join("|"));
}

/** `.com`'s side: signs over the tag it sealed itself. */
export function signMessagesKeyAttestation(
  body: { pseudonymPub: string; abuseEpoch: number; issuedAt: number; expiresAt: number },
  abuseTag: Bytes,
  caSeed: Bytes,
): MessagesKeyAttestation {
  const full: MessagesKeyAttestationBody = { ...body, abuseTagHash: sha256Hex(abuseTag) };
  return {
    kind: "MessagesKeyAttestation",
    version: 1,
    pseudonymPub: full.pseudonymPub,
    abuseEpoch: full.abuseEpoch,
    abuseTagHash: full.abuseTagHash,
    abuseTag: b64Encode(abuseTag),
    issuedAt: full.issuedAt,
    expiresAt: full.expiresAt,
    signedBy: hex(ed.getPublicKey(caSeed)),
    signature: hex(ed.sign(canonicalMessagesKeyAttestation(full), caSeed)),
  };
}

const ATTESTATION_KEYS = ["abuseEpoch", "abuseTag", "abuseTagHash", "expiresAt", "issuedAt", "kind", "pseudonymPub", "signature", "signedBy", "version"];

/** Strict shape (exact keys, hex lengths, canonical base64 of at most 4 KiB); no signature check. */
export function parseMessagesKeyAttestation(v: unknown): MessagesKeyAttestation | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const keys = Object.keys(r).sort();
  if (keys.length !== ATTESTATION_KEYS.length || keys.some((k, i) => k !== ATTESTATION_KEYS[i])) return null;
  if (r.kind !== "MessagesKeyAttestation" || r.version !== 1) return null;
  const tag = b64Decode(r.abuseTag);
  if (!tag || tag.length > ABUSE_TAG_MAX_BYTES) return null;
  if (!isLowerHex(r.signedBy, 32) || !isLowerHex(r.signature, 64)) return null;
  const a = r as unknown as MessagesKeyAttestation;
  try {
    canonicalMessagesKeyAttestation(a);
  } catch {
    return null;
  }
  return {
    kind: "MessagesKeyAttestation",
    version: 1,
    pseudonymPub: a.pseudonymPub,
    abuseEpoch: a.abuseEpoch,
    abuseTagHash: a.abuseTagHash,
    abuseTag: a.abuseTag,
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
    signedBy: a.signedBy,
    signature: a.signature,
  };
}

/** What a renewal names: SHA-256 hex of the canonical JSON of the previous attestation. */
export function messagesAttestationHash(a: MessagesKeyAttestation): string {
  return sha256Hex(canonicalJsonBytes(a));
}

export type MessagesAttestationRefusal = "malformed" | "unknown-ca" | "bad-signature" | "bad-abuse-tag" | "wrong-key" | "not-yet-valid" | "expired";

/**
 * Checks an attestation against a list of authorized CA keys (hex; from the maintainer chain, or pinned in an app):
 * shape, signedBy among `caKeys`, the signature, H(abuseTag) = abuseTagHash, pseudonymPub = `pseudonymPub` when
 * given, and `now` inside [issuedAt, expiresAt).
 */
export function checkMessagesKeyAttestation(
  v: unknown,
  o: { caKeys: readonly string[]; now: number; pseudonymPub?: string },
): { ok: true; attestation: MessagesKeyAttestation } | { ok: false; code: MessagesAttestationRefusal } {
  const a = parseMessagesKeyAttestation(v);
  if (!a) return { ok: false, code: "malformed" };
  if (!o.caKeys.includes(a.signedBy)) return { ok: false, code: "unknown-ca" };
  if (!ed25519VerifyHex(a.signature, canonicalMessagesKeyAttestation(a), a.signedBy)) return { ok: false, code: "bad-signature" };
  if (sha256Hex(b64Decode(a.abuseTag)!) !== a.abuseTagHash) return { ok: false, code: "bad-abuse-tag" };
  if (o.pseudonymPub !== undefined && a.pseudonymPub !== o.pseudonymPub) return { ok: false, code: "wrong-key" };
  if (o.now < a.issuedAt) return { ok: false, code: "not-yet-valid" };
  if (o.now >= a.expiresAt) return { ok: false, code: "expired" };
  return { ok: true, attestation: a };
}

/** The full chain (baked maintainer pin, ca-track chain, live lease) as for every CA artifact, then the checks above. */
export function verifyCaSignedMessagesKeyAttestation(
  v: unknown,
  chain: CaTrustChain | null,
  now: number,
  pinnedMandateHash: string = MAINTAINER_PINNED_MANDATE_HASH,
): { ok: true; attestation: MessagesKeyAttestation } | { ok: false; reason: CaArtifactReject | MessagesAttestationRefusal } {
  const gate = authorizedCaKeysOrFailClosed(chain, now, pinnedMandateHash);
  if (!gate.ok) return gate;
  const r = checkMessagesKeyAttestation(v, { caKeys: gate.keys, now });
  return r.ok ? r : { ok: false, reason: r.code };
}

// ── abuse tag ──────────────────────────────────────────────────────────────

export interface VoiciAbuseTagPlaintext {
  v: 1;
  username: string;
  accountCreatedAt: number;
  issuedAt: number;
}

/** `.com` seals the sender's account to the abuse key; `eseed` (64 bytes) only for vectors. */
export function sealVoiciAbuseTag(
  abuseKeyPub: Bytes,
  pseudonymPub: string,
  p: VoiciAbuseTagPlaintext,
  eseed: Bytes = crypto.getRandomValues(new Uint8Array(HYBRID_SEAL_RANDOMNESS_LEN)),
): Bytes {
  if (!USERNAME.test(p.username) || !isTime(p.accountCreatedAt) || !isTime(p.issuedAt) || p.v !== 1) throw new Error(`${TAG_VOICI_ABUSE_TAG}: bad plaintext`);
  if (!isLowerHex(pseudonymPub, 32)) throw new Error(`${TAG_VOICI_ABUSE_TAG}: bad pseudonymPub`);
  return hybridSealWithRandomness(
    parseHybridSealPublicKey(abuseKeyPub),
    { purpose: TAG_VOICI_ABUSE_TAG, senderKeyId: sha256(hexToBytes(pseudonymPub)), issuedAt: p.issuedAt },
    [enc(pseudonymPub)],
    canonicalJsonBytes({ v: 1, username: p.username, accountCreatedAt: p.accountCreatedAt, issuedAt: p.issuedAt }),
    eseed,
  );
}

/** The offline review tool's side (`voici-abuse open-tag`). Throws PqHybridError or on a malformed plaintext. */
export function openVoiciAbuseTag(abuseKeySeed: Bytes, pseudonymPub: string, sealed: Bytes): VoiciAbuseTagPlaintext {
  const { plaintext } = hybridOpen(abuseKeySeed, TAG_VOICI_ABUSE_TAG, [enc(pseudonymPub)], sealed);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(plaintext);
  const r = JSON.parse(text) as Record<string, unknown>;
  const p = { v: r.v, username: r.username, accountCreatedAt: r.accountCreatedAt, issuedAt: r.issuedAt } as VoiciAbuseTagPlaintext;
  if (Object.keys(r).length !== 4 || p.v !== 1 || typeof p.username !== "string" || !USERNAME.test(p.username) || !isTime(p.accountCreatedAt) || !isTime(p.issuedAt)) {
    throw new Error(`${TAG_VOICI_ABUSE_TAG}: malformed plaintext`);
  }
  if (canonicalJson(p) !== text) throw new Error(`${TAG_VOICI_ABUSE_TAG}: plaintext not canonical`);
  return p;
}

// ── abuse key list ─────────────────────────────────────────────────────────

export interface AbuseKeyEntry {
  epoch: number;
  /** X-Wing public key, hex (1216 bytes). */
  xwingPub: string;
  notBefore: number;
  notAfter: number;
}

export function canonicalAbuseKeyEntry(e: AbuseKeyEntry): Bytes {
  if (!isTime(e.epoch) || e.epoch < 1) throw new Error(`${TAG_ABUSE_KEY}: bad epoch`);
  if (!isLowerHex(e.xwingPub, 1216)) throw new Error(`${TAG_ABUSE_KEY}: bad xwingPub`);
  if (!isTime(e.notBefore) || !isTime(e.notAfter) || e.notAfter <= e.notBefore) throw new Error(`${TAG_ABUSE_KEY}: bad window`);
  validateNoSepCtrl("xwingPub", e.xwingPub);
  return enc([TAG_ABUSE_KEY, String(e.epoch), e.xwingPub, String(e.notBefore), String(e.notAfter)].join("|"));
}

export function signAbuseKeyEntry(e: AbuseKeyEntry, caTrackSeed: Bytes): string {
  return hex(ed.sign(canonicalAbuseKeyEntry(e), caTrackSeed));
}

export function verifyAbuseKeyEntry(e: AbuseKeyEntry, signature: string, caTrackPubs: readonly string[]): boolean {
  let bytes: Bytes;
  try {
    bytes = canonicalAbuseKeyEntry(e);
    parseHybridSealPublicKey(hexToBytes(e.xwingPub));
  } catch {
    return false;
  }
  return caTrackPubs.some((k) => ed25519VerifyHex(signature, bytes, k));
}

/** The entry to seal new tags to at `now`: inside [notBefore, notAfter), the highest epoch wins. */
export function abuseKeyFor(entries: readonly AbuseKeyEntry[], now: number): AbuseKeyEntry | null {
  let best: AbuseKeyEntry | null = null;
  for (const e of entries) if (now >= e.notBefore && now < e.notAfter && (!best || e.epoch > best.epoch)) best = e;
  return best;
}
