// NFC retail-tier pairing — protocol envelopes + crypto helpers.
//
// Implements N-PROTO-1..4 from `docs/v1-operational-tasks.md § N` and the
// design in `docs/nfc-box-pairing.md`. Post-v1 by design; gated on
// hardware Q3 for the manufacturing/companion-MCU side, but the protocol
// envelopes here are unblocked and ship with v1+ for forward-compatibility.
//
// Two parties exchange:
//
//   1. Box, while UNPAIRED, emits `PAIR` (NDEF over NFC or QR on screen)
//      = { v, stkPub, eBoxPub, nonce, sessionId, hint }
//      + `SIG`  = Ed25519_sign(stkPriv, canonical(PAIR))
//   2. Phone reads PAIR + SIG, verifies, generates an X25519 ephemeral,
//      computes ss = ECDH(ePhonePriv, eBoxPub), derives:
//         transcript = canonicalTranscript(stkPub, eBoxPub, ePhonePub,
//                                          nonce, sessionId, v)
//         K_session = HKDF(ss, salt=nonce,
//                          info="flagship/pair/v1|" + transcript)
//         SAS       = HKDF(ss, salt=∅,
//                          info="flagship/pair-sas/v1|" + transcript)[:4]
//   3. The "is this the box in front of me" confirmation surface differs
//      per tier (NFC proximity / LED-SAS / on-screen QR-SAS) but the
//      derivations are identical.
//
// Companion envelopes:
//   - `BoxUnpair` (IRK-signed) — rebind-only owner remote-unpair
//     (locked decision Q4: leaves LUKS data intact).
//   - `WiFiConfig` — sealed inside K_session AEAD post-pair, ships the
//     SSID/PSK/region so the box joins the user's network.

import { gcm } from "@noble/ciphers/aes";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { ed } from "./edSync.js";
import type { Bytes, Keypair, UserId } from "./types.js";

// ────────────────────────────────────────────────────────────────────────
// Constants

export const PAIR_PROTOCOL_VERSION = 1 as const;

/**
 * Session-lock window (design refinement §1): when a phone reads PAIR,
 * the box latches the sessionId for this long; only a claim matching
 * that sessionId can win the first-valid-claim race, and after the
 * window expires with no claim the box rolls a fresh keypair +
 * sessionId. Phones MUST treat a tap older than this as dead and
 * require a re-tap rather than depositing against a rotated session.
 * Single source of truth — the daemon state machine and both mobile
 * cores mirror this value.
 */
export const PAIR_SESSION_LOCK_MS = 30_000;

const TAG_PAIR = "flagship/pair/v1";
const TAG_PAIR_SAS = "flagship/pair-sas/v1";
const TAG_BOX_UNPAIR = "flagship/box-unpair/v1";
const TAG_WIFI_CONFIG = "flagship/wifi-config/v1";

// SAS material derived from HKDF; first 4 bytes = 32 bits, enough for
// either the LED-SAS pattern (18 bits over 3 glances) or a human-
// readable on-screen SAS (we render the first 6 hex chars).
const SAS_BYTES = 4;

// ────────────────────────────────────────────────────────────────────────
// Types

/**
 * Discovery + disambiguation hint embedded in PAIR. mDNS + cloud
 * rendezvous let a phone reach the box over LAN/cloud after the tap;
 * `suffix6` is the last 6 hex of stkPub, used when multiple candidate
 * boxes are visible on the same LAN (closes T2 in the design).
 */
export interface PairHint {
  mdnsName: string;
  cloudRendezvousId: string;
  /** Last 6 hex chars of stkPub — visible code for one-LAN disambiguation. */
  suffix6: string;
}

/**
 * The payload the box emits per boot while UNPAIRED. Re-emitted on
 * every boot until a successful claim latches PAIRED; the only persisted
 * secret across boots is the stk private key from the *winning* PAIR.
 *
 * Ed25519 STK keys and X25519 ephemeral keys are stored raw (32 bytes
 * each); nonce + sessionId are 16 bytes each.
 */
export interface PairPayload {
  v: typeof PAIR_PROTOCOL_VERSION;
  stkPub: Bytes;
  eBoxPub: Bytes;
  nonce: Bytes;
  sessionId: Bytes;
  hint: PairHint;
}

/**
 * Owner-initiated remote unpair. IRK-signed. **Rebind-only** per locked
 * decision Q4 — the box resets to UNPAIRED on next boot but LUKS data
 * stays intact. Wipe-on-resale still requires the physical button hold
 * + the resale-wipe verification flow (N-BOX-9).
 */
export interface BoxUnpair {
  userId: UserId;
  /** stkPub hex of the box being unpaired. */
  boxId: string;
  issuedAt: number;
}

/**
 * Wi-Fi onboarding payload shipped after the pair latches. Travels
 * inside K_session AEAD (`sealWiFiConfig`/`openWiFiConfig`). Plaintext
 * carries the credentials; sealing keeps a network MitM from learning
 * them even when the rest of the post-pair channel goes over LAN/cloud.
 */
export interface WiFiConfig {
  ssid: string;
  psk: string;
  /** ISO 3166-1 alpha-2 (e.g. "US"). Empty when not set. */
  regulatoryRegion: string;
  issuedAt: number;
}

// ────────────────────────────────────────────────────────────────────────
// Canonical-bytes encoders

function hex(b: Bytes): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/**
 * Canonical-bytes encoders for the three NFC envelopes. Exported so
 * the cross-language golden-vectors test (and any Swift/Kotlin mirror
 * tests) can byte-compare implementations against a recorded fixture
 * without having to re-derive the format.
 */
export function canonicalPair(p: PairPayload): Bytes {
  return new TextEncoder().encode(
    [
      TAG_PAIR,
      p.v,
      hex(p.stkPub),
      hex(p.eBoxPub),
      hex(p.nonce),
      hex(p.sessionId),
      p.hint.mdnsName,
      p.hint.cloudRendezvousId,
      p.hint.suffix6,
    ].join("|"),
  );
}

export function canonicalBoxUnpair(u: BoxUnpair): Bytes {
  return new TextEncoder().encode(
    [TAG_BOX_UNPAIR, u.userId, u.boxId, u.issuedAt].join("|"),
  );
}

export function canonicalWiFiConfig(w: WiFiConfig): Bytes {
  return new TextEncoder().encode(
    [TAG_WIFI_CONFIG, w.ssid, w.psk, w.regulatoryRegion, w.issuedAt].join("|"),
  );
}

/**
 * Transcript used as HKDF `info` suffix for K_session + SAS derivation.
 * Binds both peers to the exact same view of the handshake; any
 * substitution of stkPub / eBoxPub / ePhonePub / nonce / sessionId
 * yields different keys, so a MitM cannot interpose without detection.
 */
function canonicalTranscript(
  v: number,
  stkPub: Bytes,
  eBoxPub: Bytes,
  ePhonePub: Bytes,
  nonce: Bytes,
  sessionId: Bytes,
): Bytes {
  return new TextEncoder().encode(
    [v, hex(stkPub), hex(eBoxPub), hex(ePhonePub), hex(nonce), hex(sessionId)].join("|"),
  );
}

// ────────────────────────────────────────────────────────────────────────
// N-PROTO-1: PAIR + SIG sign/verify + ECDH-derived K_session + SAS

/** Box-side: sign the PAIR payload with the box's STK private key. */
export function signPair(p: PairPayload, stk: Keypair): Bytes {
  return ed.sign(canonicalPair(p), stk.privateKey);
}

/**
 * Phone-side: verify SIG against PAIR.stkPub. Self-consistency check:
 * "the box vouches that eBoxPub/nonce belong to this identity."
 * Network MitM substituting a different eBoxPub fails this check.
 */
export function verifyPair(p: PairPayload, sig: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalPair(p), p.stkPub);
  } catch {
    return false;
  }
}

/** Phone-side: derive `ss` (ECDH shared secret) from ePhonePriv + box's eBoxPub. */
export function deriveSharedSecret(ePhonePriv: Bytes, eBoxPub: Bytes): Bytes {
  return x25519.getSharedSecret(ePhonePriv, eBoxPub);
}

/**
 * K_session = HKDF(ss, salt=nonce, info="flagship/pair/v1|" + transcript).
 * 32 bytes — used as the AES-GCM key for the post-pair AEAD channel
 * (`sealWiFiConfig`, future post-pair envelopes).
 */
export function deriveSessionKey(args: {
  sharedSecret: Bytes;
  stkPub: Bytes;
  eBoxPub: Bytes;
  ePhonePub: Bytes;
  nonce: Bytes;
  sessionId: Bytes;
  v?: number;
}): Bytes {
  const v = args.v ?? PAIR_PROTOCOL_VERSION;
  const transcript = canonicalTranscript(
    v,
    args.stkPub,
    args.eBoxPub,
    args.ePhonePub,
    args.nonce,
    args.sessionId,
  );
  const info = new Uint8Array(TAG_PAIR.length + 1 + transcript.length);
  info.set(new TextEncoder().encode(TAG_PAIR + "|"), 0);
  info.set(transcript, TAG_PAIR.length + 1);
  return hkdf(sha256, args.sharedSecret, args.nonce, info, 32);
}

/**
 * Short Authentication String: HKDF(ss, salt=∅, info="flagship/pair-sas/v1|"
 * + transcript), truncated to 4 bytes. The LED-SAS encoder uses the
 * first 18 bits; on-screen SAS displays the first 6 hex chars.
 */
export function deriveSAS(args: {
  sharedSecret: Bytes;
  stkPub: Bytes;
  eBoxPub: Bytes;
  ePhonePub: Bytes;
  nonce: Bytes;
  sessionId: Bytes;
  v?: number;
}): Bytes {
  const v = args.v ?? PAIR_PROTOCOL_VERSION;
  const transcript = canonicalTranscript(
    v,
    args.stkPub,
    args.eBoxPub,
    args.ePhonePub,
    args.nonce,
    args.sessionId,
  );
  const info = new Uint8Array(TAG_PAIR_SAS.length + 1 + transcript.length);
  info.set(new TextEncoder().encode(TAG_PAIR_SAS + "|"), 0);
  info.set(transcript, TAG_PAIR_SAS.length + 1);
  return hkdf(sha256, args.sharedSecret, new Uint8Array(0), info, SAS_BYTES);
}

/**
 * Compute the 6-hex disambiguation suffix from an STK pubkey.
 * Convenience used by the box when building its PairHint, and by the
 * phone when one-LAN matching multiple candidates.
 */
export function stkPubToSuffix6(stkPub: Bytes): string {
  return hex(stkPub).slice(-6);
}

// ────────────────────────────────────────────────────────────────────────
// N-PROTO-2: BoxUnpair envelope (IRK-signed, rebind-only)

export function signBoxUnpair(u: BoxUnpair, irk: Keypair): Bytes {
  return ed.sign(canonicalBoxUnpair(u), irk.privateKey);
}

export function verifyBoxUnpair(u: BoxUnpair, sig: Bytes, irkPub: Bytes): boolean {
  try {
    return ed.verify(sig, canonicalBoxUnpair(u), irkPub);
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────
// N-PROTO-3: WiFiConfig sealed under K_session AEAD

export interface SealedWiFiConfig {
  ciphertext: Bytes;
  nonce: Bytes;
}

/**
 * AES-GCM seal of WiFiConfig under K_session. 12-byte random nonce —
 * AAD is empty (the K_session itself is already transcript-bound, so
 * binding-data lives in the key, not the AAD).
 */
export function sealWiFiConfig(w: WiFiConfig, kSession: Bytes): SealedWiFiConfig {
  if (kSession.length !== 32) throw new Error("kSession must be 32 bytes");
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ciphertext = gcm(kSession, nonce).encrypt(canonicalWiFiConfig(w));
  return { ciphertext, nonce };
}

/**
 * Box-side: open a sealed WiFiConfig with K_session. Returns parsed
 * WiFiConfig; throws on auth failure (bad tag, wrong key, tampered
 * ciphertext).
 */
export function openWiFiConfig(blob: SealedWiFiConfig, kSession: Bytes): WiFiConfig {
  if (kSession.length !== 32) throw new Error("kSession must be 32 bytes");
  const plaintext = gcm(kSession, blob.nonce).decrypt(blob.ciphertext);
  const text = new TextDecoder().decode(plaintext);
  const parts = text.split("|");
  // Re-validate the tag + version field count so a key collision on a
  // different envelope kind can't be reinterpreted as WiFiConfig.
  if (parts.length !== 5 || parts[0] !== TAG_WIFI_CONFIG) {
    throw new Error("malformed wifi-config plaintext");
  }
  const [, ssid, psk, regulatoryRegion, issuedAtStr] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) {
    throw new Error("malformed wifi-config issuedAt");
  }
  return { ssid, psk, regulatoryRegion, issuedAt };
}

// ────────────────────────────────────────────────────────────────────────
// Rendezvous deposit blob — ePhonePub || ciphertext
//
// The cloud drop-box (`POST /api/nfc/rendezvous/:id/wifi`) relays one
// opaque hex blob from phone to box. The box cannot derive K_session
// without the phone's ephemeral public key, so the deposit carries it
// as a fixed 32-byte prefix ahead of the AEAD ciphertext. The prefix
// needs no separate authentication: ePhonePub is bound into the
// K_session transcript, so tampering it yields a key under which the
// AEAD open fails. The cloud stays format-blind.

const EPHONE_PUB_LEN = 32;
/** AES-GCM tag = 16 bytes; an empty plaintext still produces 16. */
const MIN_CIPHERTEXT_LEN = 16;

export function buildWifiDepositBlob(ePhonePub: Bytes, sealed: SealedWiFiConfig): Bytes {
  if (ePhonePub.length !== EPHONE_PUB_LEN) {
    throw new Error(`ePhonePub must be ${EPHONE_PUB_LEN} bytes`);
  }
  const out = new Uint8Array(EPHONE_PUB_LEN + sealed.ciphertext.length);
  out.set(ePhonePub, 0);
  out.set(sealed.ciphertext, EPHONE_PUB_LEN);
  return out;
}

/**
 * Box-side: split a deposit blob back into ePhonePub + ciphertext.
 * Throws on anything too short to contain both — a foreign/garbage
 * deposit fails here before any key derivation runs.
 */
export function parseWifiDepositBlob(blob: Bytes): { ePhonePub: Bytes; ciphertext: Bytes } {
  if (blob.length < EPHONE_PUB_LEN + MIN_CIPHERTEXT_LEN) {
    throw new Error("wifi deposit blob too short");
  }
  return {
    ePhonePub: blob.slice(0, EPHONE_PUB_LEN),
    ciphertext: blob.slice(EPHONE_PUB_LEN),
  };
}

// ────────────────────────────────────────────────────────────────────────
// N-PROTO-4: SAS derivation + LED-SAS alphabet

/**
 * LED-SAS alphabet — 4 symbols, 2 bits each. Maps cleanly to a 4-color
 * status LED (RGBY) but the alphabet is intentionally abstract: the
 * box-side LED driver picks the physical mapping (e.g. one RGB LED that
 * cycles through 4 explicit colors, or 4 discrete LEDs lit one at a
 * time). Order is fixed at v1; never reorder without bumping
 * PAIR_PROTOCOL_VERSION.
 */
export const LED_SAS_ALPHABET = ["R", "G", "B", "Y"] as const;
export type LedSasSymbol = (typeof LED_SAS_ALPHABET)[number];

/** Each glance carries this many 2-bit pulses → ~6 bits of SAS material. */
export const LED_SAS_PULSES_PER_GLANCE = 3;

/** 3-of-3 confirmation per locked decision §10. User matches 3 glances total. */
export const LED_SAS_GLANCES_REQUIRED = 3;

/** Per-pulse on-time (ms). 10 s gives a relaxed match window. */
export const LED_SAS_PULSE_MS = 10_000;

/** Retries before the box clears its emit + waits 30 s. */
export const LED_SAS_RETRIES = 3;

/**
 * Encode SAS bytes as a sequence of LED symbols. With
 * LED_SAS_PULSES_PER_GLANCE * LED_SAS_GLANCES_REQUIRED = 9 pulses *
 * 2 bits = 18 bits, we consume the first 18 bits of `sas` (= bytes[0],
 * bytes[1], and the top 2 bits of bytes[2]).
 *
 * Returned string is the linear pulse sequence ("RGGBYRBGR"). Renderers
 * group it into glances of LED_SAS_PULSES_PER_GLANCE.
 */
export function encodeLedSas(sas: Bytes): string {
  const totalPulses = LED_SAS_PULSES_PER_GLANCE * LED_SAS_GLANCES_REQUIRED;
  const bitsNeeded = totalPulses * 2;
  if (sas.length * 8 < bitsNeeded) {
    throw new Error(
      `encodeLedSas: need at least ${Math.ceil(bitsNeeded / 8)} bytes of SAS`,
    );
  }
  let out = "";
  for (let i = 0; i < totalPulses; i++) {
    const bitOffset = i * 2;
    const byteIdx = bitOffset >> 3;
    const bitIdx = 6 - (bitOffset & 7);
    // Safe by the length check above; non-null assertion silences
    // noUncheckedIndexedAccess without runtime cost.
    const byte = sas[byteIdx]!;
    const symbolIdx = (byte >> bitIdx) & 0b11;
    out += LED_SAS_ALPHABET[symbolIdx];
  }
  return out;
}

/**
 * Human-readable SAS for on-screen comparison (DIY tier or "optional
 * SAS glance" per locked decision §10). Hex of the SAS bytes, first
 * `chars` characters. Default 6 chars = 24 bits, comfortable for a
 * one-line comparison.
 */
export function encodeSasForDisplay(sas: Bytes, chars = 6): string {
  return hex(sas).slice(0, chars);
}
