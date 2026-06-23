// NFC retail-tier pairing — protocol envelopes + crypto helpers.
//
// Kotlin mirror of `packages/protocol/src/nfcPair.ts` and
// `apps/mobile/ios/Sources/FlagshipCore/NfcPair.swift`. Same canonical
// bytes, same HKDF tags, same AES-GCM framing — the cross-language
// golden-vectors test (`NfcPairTest.kt`) asserts byte-equality against
// the TS implementation via `test-vectors/canonical-bytes.json`.
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

package com.flagshipserver.app.core

import com.google.crypto.tink.subtle.Ed25519Sign
import com.google.crypto.tink.subtle.Ed25519Verify
import com.google.crypto.tink.subtle.X25519
import java.security.GeneralSecurityException
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

// ────────────────────────────────────────────────────────────────────────
// Constants

/** Wire version pinned to the protocol envelopes. Bump on any breaking
 *  change to canonical-bytes / HKDF tags / transcript shape. */
const val PAIR_PROTOCOL_VERSION: Int = 1

/** Session-lock window (design refinement §1) — mirrors
 *  `PAIR_SESSION_LOCK_MS` in `@flagship/protocol/nfcPair.ts`. The box
 *  latches the tapped sessionId for this long; the phone must land its
 *  claim/deposit within the window or re-tap (the box rolls a fresh
 *  keypair + sessionId after expiry). */
const val PAIR_SESSION_LOCK_MS: Long = 30_000L

private const val TAG_PAIR = "flagship/pair/v1"
private const val TAG_PAIR_SAS = "flagship/pair-sas/v1"
private const val TAG_BOX_UNPAIR = "flagship/box-unpair/v1"
private const val TAG_WIFI_CONFIG = "flagship/wifi-config/v1"

// SAS material derived from HKDF; first 4 bytes = 32 bits, enough for
// either the LED-SAS pattern (18 bits over 3 glances) or a human-
// readable on-screen SAS (we render the first 6 hex chars).
private const val SAS_BYTES = 4

// AES-GCM authentication tag length, in bits. Pinned to match the
// 16-byte tag the TS @noble/ciphers gcm + iOS CryptoKit AES.GCM produce.
private const val GCM_TAG_BITS = 128

// AES-GCM nonce length, in bytes. 12 = NIST SP 800-38D recommended.
private const val GCM_NONCE_BYTES = 12

// ────────────────────────────────────────────────────────────────────────
// Types

/**
 * Discovery + disambiguation hint embedded in PAIR. mDNS + cloud
 * rendezvous let a phone reach the box over LAN/cloud after the tap;
 * `suffix6` is the last 6 hex of stkPub, used when multiple candidate
 * boxes are visible on the same LAN (closes T2 in the design).
 */
data class PairHint(
    val mdnsName: String,
    val cloudRendezvousId: String,
    /** Last 6 hex chars of stkPub — visible code for one-LAN disambiguation. */
    val suffix6: String,
)

/**
 * The payload the box emits per boot while UNPAIRED. Re-emitted on
 * every boot until a successful claim latches PAIRED; the only persisted
 * secret across boots is the stk private key from the *winning* PAIR.
 *
 * Ed25519 STK keys and X25519 ephemeral keys are stored raw (32 bytes
 * each); nonce + sessionId are 16 bytes each.
 */
data class PairPayload(
    val v: Int = PAIR_PROTOCOL_VERSION,
    val stkPub: ByteArray,
    val eBoxPub: ByteArray,
    val nonce: ByteArray,
    val sessionId: ByteArray,
    val hint: PairHint,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is PairPayload) return false
        return v == other.v &&
            stkPub.contentEquals(other.stkPub) &&
            eBoxPub.contentEquals(other.eBoxPub) &&
            nonce.contentEquals(other.nonce) &&
            sessionId.contentEquals(other.sessionId) &&
            hint == other.hint
    }

    override fun hashCode(): Int {
        var h = v
        h = 31 * h + stkPub.contentHashCode()
        h = 31 * h + eBoxPub.contentHashCode()
        h = 31 * h + nonce.contentHashCode()
        h = 31 * h + sessionId.contentHashCode()
        h = 31 * h + hint.hashCode()
        return h
    }
}

/**
 * Owner-initiated remote unpair. IRK-signed. **Rebind-only** per locked
 * decision Q4 — the box resets to UNPAIRED on next boot but LUKS data
 * stays intact. Wipe-on-resale still requires the physical button hold
 * + the resale-wipe verification flow (N-BOX-9).
 */
data class BoxUnpair(
    val userId: String,
    /** stkPub hex of the box being unpaired. */
    val boxId: String,
    val issuedAt: Long,
)

/**
 * Wi-Fi onboarding payload shipped after the pair latches. Travels
 * inside K_session AEAD (`sealWiFiConfig`/`openWiFiConfig`). Plaintext
 * carries the credentials; sealing keeps a network MitM from learning
 * them even when the rest of the post-pair channel goes over LAN/cloud.
 */
data class WiFiConfig(
    val ssid: String,
    val psk: String,
    /** ISO 3166-1 alpha-2 (e.g. "US"). Empty when not set. */
    val regulatoryRegion: String,
    val issuedAt: Long,
)

data class SealedWiFiConfig(
    val ciphertext: ByteArray,
    val nonce: ByteArray,
) {
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is SealedWiFiConfig) return false
        return ciphertext.contentEquals(other.ciphertext) &&
            nonce.contentEquals(other.nonce)
    }

    override fun hashCode(): Int = ciphertext.contentHashCode() * 31 + nonce.contentHashCode()
}

sealed class NfcPairError(msg: String) : Throwable(msg) {
    object KSessionWrongSize : NfcPairError("kSession must be 32 bytes")
    object MalformedWiFiConfig : NfcPairError("malformed wifi-config plaintext")
}

// ────────────────────────────────────────────────────────────────────────
// Canonical-bytes encoders

private fun hex(b: ByteArray): String {
    val sb = StringBuilder(b.size * 2)
    for (x in b) {
        val v = x.toInt() and 0xff
        sb.append(HEX_CHARS[v ushr 4])
        sb.append(HEX_CHARS[v and 0x0f])
    }
    return sb.toString()
}

private val HEX_CHARS = "0123456789abcdef".toCharArray()

private fun hexToBytes(s: String): ByteArray {
    require(s.length % 2 == 0) { "hex string must have even length" }
    val out = ByteArray(s.length / 2)
    var i = 0
    while (i < s.length) {
        val hi = Character.digit(s[i], 16)
        val lo = Character.digit(s[i + 1], 16)
        require(hi >= 0 && lo >= 0) { "non-hex character in input" }
        out[i / 2] = ((hi shl 4) or lo).toByte()
        i += 2
    }
    return out
}

/**
 * Canonical-bytes encoders for the three NFC envelopes. Exported so
 * the cross-language golden-vectors test (and any Swift/TypeScript
 * mirror tests) can byte-compare implementations against a recorded
 * fixture without having to re-derive the format.
 */
fun canonicalPair(p: PairPayload): ByteArray {
    val s = listOf(
        TAG_PAIR,
        p.v.toString(),
        hex(p.stkPub),
        hex(p.eBoxPub),
        hex(p.nonce),
        hex(p.sessionId),
        p.hint.mdnsName,
        p.hint.cloudRendezvousId,
        p.hint.suffix6,
    ).joinToString("|")
    return s.toByteArray(Charsets.UTF_8)
}

fun canonicalBoxUnpair(u: BoxUnpair): ByteArray {
    val s = listOf(TAG_BOX_UNPAIR, u.userId, u.boxId, u.issuedAt.toString()).joinToString("|")
    return s.toByteArray(Charsets.UTF_8)
}

fun canonicalWiFiConfig(w: WiFiConfig): ByteArray {
    val s = listOf(
        TAG_WIFI_CONFIG,
        w.ssid,
        w.psk,
        w.regulatoryRegion,
        w.issuedAt.toString(),
    ).joinToString("|")
    return s.toByteArray(Charsets.UTF_8)
}

/**
 * Transcript used as HKDF `info` suffix for K_session + SAS derivation.
 * Binds both peers to the exact same view of the handshake; any
 * substitution of stkPub / eBoxPub / ePhonePub / nonce / sessionId
 * yields different keys, so a MitM cannot interpose without detection.
 */
private fun canonicalTranscript(
    v: Int,
    stkPub: ByteArray,
    eBoxPub: ByteArray,
    ePhonePub: ByteArray,
    nonce: ByteArray,
    sessionId: ByteArray,
): ByteArray {
    val s = listOf(
        v.toString(),
        hex(stkPub),
        hex(eBoxPub),
        hex(ePhonePub),
        hex(nonce),
        hex(sessionId),
    ).joinToString("|")
    return s.toByteArray(Charsets.UTF_8)
}

// ────────────────────────────────────────────────────────────────────────
// N-PROTO-1: PAIR + SIG sign/verify + ECDH-derived K_session + SAS

/**
 * Box-side: sign the PAIR payload with the box's STK private key
 * (raw 32-byte Ed25519 seed).
 */
fun signPair(p: PairPayload, stkPriv: ByteArray): ByteArray {
    return Ed25519Sign(stkPriv).sign(canonicalPair(p))
}

/**
 * Phone-side: verify SIG against PAIR.stkPub. Self-consistency check:
 * "the box vouches that eBoxPub/nonce belong to this identity."
 * Network MitM substituting a different eBoxPub fails this check.
 */
fun verifyPair(p: PairPayload, sig: ByteArray): Boolean {
    return try {
        Ed25519Verify(p.stkPub).verify(sig, canonicalPair(p))
        true
    } catch (_: GeneralSecurityException) {
        false
    } catch (_: IllegalArgumentException) {
        false
    }
}

/** Phone-side: derive `ss` (ECDH shared secret) from ePhonePriv + box's eBoxPub. */
fun deriveSharedSecret(ePhonePriv: ByteArray, eBoxPub: ByteArray): ByteArray {
    return X25519.computeSharedSecret(ePhonePriv, eBoxPub)
}

/**
 * K_session = HKDF(ss, salt=nonce, info="flagship/pair/v1|" + transcript).
 * 32 bytes — used as the AES-GCM key for the post-pair AEAD channel
 * (`sealWiFiConfig`, future post-pair envelopes).
 */
fun deriveSessionKey(
    sharedSecret: ByteArray,
    stkPub: ByteArray,
    eBoxPub: ByteArray,
    ePhonePub: ByteArray,
    nonce: ByteArray,
    sessionId: ByteArray,
    v: Int = PAIR_PROTOCOL_VERSION,
): ByteArray {
    val transcript = canonicalTranscript(v, stkPub, eBoxPub, ePhonePub, nonce, sessionId)
    val tagBytes = (TAG_PAIR + "|").toByteArray(Charsets.UTF_8)
    val info = ByteArray(tagBytes.size + transcript.size)
    System.arraycopy(tagBytes, 0, info, 0, tagBytes.size)
    System.arraycopy(transcript, 0, info, tagBytes.size, transcript.size)
    return hkdfSha256(ikm = sharedSecret, salt = nonce, info = info, lengthBytes = 32)
}

/**
 * Short Authentication String: HKDF(ss, salt=∅, info="flagship/pair-sas/v1|"
 * + transcript), truncated to 4 bytes. The LED-SAS encoder uses the
 * first 18 bits; on-screen SAS displays the first 6 hex chars.
 */
fun deriveSAS(
    sharedSecret: ByteArray,
    stkPub: ByteArray,
    eBoxPub: ByteArray,
    ePhonePub: ByteArray,
    nonce: ByteArray,
    sessionId: ByteArray,
    v: Int = PAIR_PROTOCOL_VERSION,
): ByteArray {
    val transcript = canonicalTranscript(v, stkPub, eBoxPub, ePhonePub, nonce, sessionId)
    val tagBytes = (TAG_PAIR_SAS + "|").toByteArray(Charsets.UTF_8)
    val info = ByteArray(tagBytes.size + transcript.size)
    System.arraycopy(tagBytes, 0, info, 0, tagBytes.size)
    System.arraycopy(transcript, 0, info, tagBytes.size, transcript.size)
    return hkdfSha256(ikm = sharedSecret, salt = ByteArray(0), info = info, lengthBytes = SAS_BYTES)
}

/**
 * Compute the 6-hex disambiguation suffix from an STK pubkey.
 * Convenience used by the box when building its PairHint, and by the
 * phone when one-LAN matching multiple candidates.
 */
fun stkPubToSuffix6(stkPub: ByteArray): String {
    val h = hex(stkPub)
    return if (h.length <= 6) h else h.substring(h.length - 6)
}

// ────────────────────────────────────────────────────────────────────────
// N-PROTO-2: BoxUnpair envelope (IRK-signed, rebind-only)

fun signBoxUnpair(u: BoxUnpair, irkPriv: ByteArray): ByteArray {
    return Ed25519Sign(irkPriv).sign(canonicalBoxUnpair(u))
}

fun verifyBoxUnpair(u: BoxUnpair, sig: ByteArray, irkPub: ByteArray): Boolean {
    return try {
        Ed25519Verify(irkPub).verify(sig, canonicalBoxUnpair(u))
        true
    } catch (_: GeneralSecurityException) {
        false
    } catch (_: IllegalArgumentException) {
        false
    }
}

// ────────────────────────────────────────────────────────────────────────
// N-PROTO-3: WiFiConfig sealed under K_session AEAD

/**
 * AES-GCM seal of WiFiConfig under K_session. 12-byte random nonce —
 * AAD is empty (the K_session itself is already transcript-bound, so
 * binding-data lives in the key, not the AAD).
 *
 * JCE's AES/GCM/NoPadding emits ciphertext||tag concatenated, which
 * matches the @noble/ciphers gcm + iOS CryptoKit AES.GCM combined
 * shape used by the TS + Swift mirrors.
 */
fun sealWiFiConfig(w: WiFiConfig, kSession: ByteArray): SealedWiFiConfig {
    if (kSession.size != 32) throw NfcPairError.KSessionWrongSize
    val nonce = ByteArray(GCM_NONCE_BYTES).also { SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
        Cipher.ENCRYPT_MODE,
        SecretKeySpec(kSession, "AES"),
        GCMParameterSpec(GCM_TAG_BITS, nonce),
    )
    val ct = cipher.doFinal(canonicalWiFiConfig(w))
    return SealedWiFiConfig(ciphertext = ct, nonce = nonce)
}

/**
 * Box-side: open a sealed WiFiConfig with K_session. Returns parsed
 * WiFiConfig; throws on auth failure (bad tag, wrong key, tampered
 * ciphertext) or on a malformed plaintext envelope.
 */
fun openWiFiConfig(blob: SealedWiFiConfig, kSession: ByteArray): WiFiConfig {
    if (kSession.size != 32) throw NfcPairError.KSessionWrongSize
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(
        Cipher.DECRYPT_MODE,
        SecretKeySpec(kSession, "AES"),
        GCMParameterSpec(GCM_TAG_BITS, blob.nonce),
    )
    val plaintext = cipher.doFinal(blob.ciphertext)
    val text = String(plaintext, Charsets.UTF_8)
    val parts = text.split("|")
    // Re-validate the tag + field count so a key collision on a
    // different envelope kind can't be reinterpreted as WiFiConfig.
    if (parts.size != 5 || parts[0] != TAG_WIFI_CONFIG) {
        throw NfcPairError.MalformedWiFiConfig
    }
    val issuedAt = parts[4].toLongOrNull() ?: throw NfcPairError.MalformedWiFiConfig
    return WiFiConfig(
        ssid = parts[1],
        psk = parts[2],
        regulatoryRegion = parts[3],
        issuedAt = issuedAt,
    )
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
val LED_SAS_ALPHABET: CharArray = charArrayOf('R', 'G', 'B', 'Y')

/** Each glance carries this many 2-bit pulses → ~6 bits of SAS material. */
const val LED_SAS_PULSES_PER_GLANCE: Int = 3

/** 3-of-3 confirmation per locked decision §10. User matches 3 glances total. */
const val LED_SAS_GLANCES_REQUIRED: Int = 3

/** Per-pulse on-time (ms). 10 s gives a relaxed match window. */
const val LED_SAS_PULSE_MS: Int = 10_000

/** Retries before the box clears its emit + waits 30 s. */
const val LED_SAS_RETRIES: Int = 3

class LedSasError(val needed: Int) :
    Throwable("encodeLedSas: need at least $needed bytes of SAS")

/**
 * Encode SAS bytes as a sequence of LED symbols. With
 * LED_SAS_PULSES_PER_GLANCE * LED_SAS_GLANCES_REQUIRED = 9 pulses *
 * 2 bits = 18 bits, we consume the first 18 bits of `sas` (= bytes[0],
 * bytes[1], and the top 2 bits of bytes[2]).
 *
 * Returned string is the linear pulse sequence ("RGGBYRBGR"). Renderers
 * group it into glances of LED_SAS_PULSES_PER_GLANCE.
 */
fun encodeLedSas(sas: ByteArray): String {
    val totalPulses = LED_SAS_PULSES_PER_GLANCE * LED_SAS_GLANCES_REQUIRED
    val bitsNeeded = totalPulses * 2
    if (sas.size * 8 < bitsNeeded) {
        throw LedSasError(needed = (bitsNeeded + 7) / 8)
    }
    val out = StringBuilder(totalPulses)
    for (i in 0 until totalPulses) {
        val bitOffset = i * 2
        val byteIdx = bitOffset ushr 3
        val bitIdx = 6 - (bitOffset and 7)
        val byte = sas[byteIdx].toInt() and 0xff
        val symbolIdx = (byte ushr bitIdx) and 0b11
        out.append(LED_SAS_ALPHABET[symbolIdx])
    }
    return out.toString()
}

/**
 * Human-readable SAS for on-screen comparison (DIY tier or "optional
 * SAS glance" per locked decision §10). Hex of the SAS bytes, first
 * `chars` characters. Default 6 chars = 24 bits, comfortable for a
 * one-line comparison.
 */
fun encodeSasForDisplay(sas: ByteArray, chars: Int = 6): String {
    val h = hex(sas)
    return if (h.length <= chars) h else h.substring(0, chars)
}

// ────────────────────────────────────────────────────────────────────────
// N-PHONE-6: LED-SAS capture/decode + match (phone-side verify path)
//
// Kotlin mirror of the TS `verifyLedSas` family in nfcPair.ts. The encode
// half is box-side; this is the phone confirming an observed LED capture
// equals the locally derived expected sequence, glance by glance, under
// the strict 3-of-3 rule (locked decision §10) — a single mismatch aborts
// (the LED-SAS *is* the authenticator on the degraded path). The camera
// frame→symbol decode is the hardware/CV seam; this takes already-decoded
// glance strings, so it stays fully unit-testable without a camera.

enum class LedGlanceVerdict { MATCH, MISMATCH }

class LedSasVerifyError(val expected: Int, val got: Int) :
    Throwable("ledSasGlances: expected $expected pulses, got $got")

/** Split an encoded LED-SAS sequence into per-glance sub-sequences. */
fun ledSasGlances(sequence: String): List<String> {
    val expectedLen = LED_SAS_GLANCES_REQUIRED * LED_SAS_PULSES_PER_GLANCE
    if (sequence.length != expectedLen) {
        throw LedSasVerifyError(expected = expectedLen, got = sequence.length)
    }
    return (0 until LED_SAS_GLANCES_REQUIRED).map { g ->
        val lo = g * LED_SAS_PULSES_PER_GLANCE
        sequence.substring(lo, lo + LED_SAS_PULSES_PER_GLANCE)
    }
}

/** A captured glance is well-formed iff it is exactly the locked pulse
 * count and every symbol is in LED_SAS_ALPHABET. A garbled read is
 * distinct from a mismatch. */
fun isWellFormedGlance(glance: String): Boolean {
    if (glance.length != LED_SAS_PULSES_PER_GLANCE) return false
    return glance.all { LED_SAS_ALPHABET.contains(it) }
}

/** Exact-match a captured glance against the expected one. */
fun verifyLedGlance(observed: String, expected: String): LedGlanceVerdict =
    if (observed == expected) LedGlanceVerdict.MATCH else LedGlanceVerdict.MISMATCH

/**
 * Full phone-side LED-SAS verify: derive the expected sequence from the
 * SAS bytes and require every observed glance to match (3-of-3, strict).
 * Returns false on the first mismatch OR any malformed glance, and on a
 * wrong observed-glance count.
 */
fun verifyLedSas(sas: ByteArray, observedGlances: List<String>): Boolean {
    if (observedGlances.size != LED_SAS_GLANCES_REQUIRED) return false
    val expected = try {
        ledSasGlances(encodeLedSas(sas))
    } catch (_: Throwable) {
        return false
    }
    for (i in 0 until LED_SAS_GLANCES_REQUIRED) {
        val obs = observedGlances[i]
        if (!isWellFormedGlance(obs)) return false
        if (verifyLedGlance(obs, expected[i]) == LedGlanceVerdict.MISMATCH) return false
    }
    return true
}

// ────────────────────────────────────────────────────────────────────────
// Rendezvous deposit blob — ePhonePub || ciphertext
//
// Mirrors `buildWifiDepositBlob` / `parseWifiDepositBlob` in
// `@flagship/protocol/nfcPair.ts`. The cloud drop-box relays one
// opaque blob; the box needs the phone's ephemeral public key to
// derive K_session, so the deposit carries it as a fixed 32-byte
// prefix. Tampering the prefix shifts the box onto a different
// K_session, so the AEAD open fails — no separate MAC needed.

private const val EPHONE_PUB_LEN = 32
private const val MIN_CIPHERTEXT_LEN = 16 // AES-GCM tag alone

sealed class WifiDepositBlobError(message: String) : Throwable(message) {
    data object WrongSizeEphonePub :
        WifiDepositBlobError("ePhonePub must be $EPHONE_PUB_LEN bytes") {
        private fun readResolve(): Any = WrongSizeEphonePub
    }
    data object BlobTooShort :
        WifiDepositBlobError("wifi deposit blob too short") {
        private fun readResolve(): Any = BlobTooShort
    }
}

fun buildWifiDepositBlob(ePhonePub: ByteArray, sealed: SealedWiFiConfig): ByteArray {
    if (ePhonePub.size != EPHONE_PUB_LEN) throw WifiDepositBlobError.WrongSizeEphonePub
    return ePhonePub + sealed.ciphertext
}

class WifiDepositParts(val ePhonePub: ByteArray, val ciphertext: ByteArray)

fun parseWifiDepositBlob(blob: ByteArray): WifiDepositParts {
    if (blob.size < EPHONE_PUB_LEN + MIN_CIPHERTEXT_LEN) throw WifiDepositBlobError.BlobTooShort
    return WifiDepositParts(
        ePhonePub = blob.copyOfRange(0, EPHONE_PUB_LEN),
        ciphertext = blob.copyOfRange(EPHONE_PUB_LEN, blob.size),
    )
}

// ────────────────────────────────────────────────────────────────────────
// Hex helpers (public so tests can round-trip the fixture)

object NfcPairHex {
    fun encode(data: ByteArray): String = hex(data)
    fun decode(s: String): ByteArray = hexToBytes(s)
}

// ────────────────────────────────────────────────────────────────────────
// HKDF-SHA256 (RFC 5869)
//
// Local copy of the QrRelay impl, kept self-contained so the NFC
// pairing module has no compile-time coupling to the QR flow.

private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, lengthBytes: Int): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    // Step 1: extract — HMAC(salt, IKM). HmacSHA256 with a 0-byte key
    // is rejected by the JCE; substitute the RFC 5869 default (HashLen
    // zeros), which produces the byte-identical PRK to @noble/hashes
    // hmac on an empty Uint8Array (both pad to the HMAC block length).
    val saltKey = if (salt.isEmpty()) ByteArray(32) else salt
    mac.init(SecretKeySpec(saltKey, "HmacSHA256"))
    val prk = mac.doFinal(ikm)
    // Step 2: expand — T(i) = HMAC(prk, T(i-1) || info || counter).
    val prkKey = SecretKeySpec(prk, "HmacSHA256")
    val out = ByteArray(lengthBytes)
    var t = ByteArray(0)
    var counter = 1
    var written = 0
    while (written < lengthBytes) {
        mac.init(prkKey)
        mac.update(t)
        mac.update(info)
        mac.update(counter.toByte())
        t = mac.doFinal()
        val toCopy = minOf(t.size, lengthBytes - written)
        System.arraycopy(t, 0, out, written, toCopy)
        written += toCopy
        counter++
    }
    return out
}
