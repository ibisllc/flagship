import Foundation
import CryptoKit

// NFC retail-tier pairing — protocol envelopes + crypto helpers.
//
// Swift mirror of `packages/protocol/src/nfcPair.ts`. Same canonical
// bytes, same HKDF tags, same AES-GCM framing — the cross-language
// golden-vectors test (`Tests/FlagshipMobileTests/NfcPairTests.swift`)
// asserts byte-equality against the TS implementation via
// `test-vectors/canonical-bytes.json`.
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

// ────────────────────────────────────────────────────────────────────────
// Constants

public let PAIR_PROTOCOL_VERSION: Int = 1

/// Session-lock window (design refinement §1) — mirrors
/// `PAIR_SESSION_LOCK_MS` in `@flagship/protocol/nfcPair.ts`. The box
/// latches the tapped sessionId for this long; the phone must land its
/// claim/deposit within the window or re-tap (the box rolls a fresh
/// keypair + sessionId after expiry).
public let PAIR_SESSION_LOCK_MS: Int64 = 30_000

private let TAG_PAIR = "flagship/pair/v1"
private let TAG_PAIR_SAS = "flagship/pair-sas/v1"
private let TAG_BOX_UNPAIR = "flagship/box-unpair/v1"
private let TAG_WIFI_CONFIG = "flagship/wifi-config/v1"

// SAS material derived from HKDF; first 4 bytes = 32 bits, enough for
// either the LED-SAS pattern (18 bits over 3 glances) or a human-
// readable on-screen SAS (we render the first 6 hex chars).
private let SAS_BYTES = 4

// ────────────────────────────────────────────────────────────────────────
// Types

/// Discovery + disambiguation hint embedded in PAIR. mDNS + cloud
/// rendezvous let a phone reach the box over LAN/cloud after the tap;
/// `suffix6` is the last 6 hex of stkPub, used when multiple candidate
/// boxes are visible on the same LAN (closes T2 in the design).
public struct PairHint: Equatable, Sendable {
    public var mdnsName: String
    public var cloudRendezvousId: String
    /// Last 6 hex chars of stkPub — visible code for one-LAN disambiguation.
    public var suffix6: String

    public init(mdnsName: String, cloudRendezvousId: String, suffix6: String) {
        self.mdnsName = mdnsName
        self.cloudRendezvousId = cloudRendezvousId
        self.suffix6 = suffix6
    }
}

/// The payload the box emits per boot while UNPAIRED. Re-emitted on
/// every boot until a successful claim latches PAIRED; the only persisted
/// secret across boots is the stk private key from the *winning* PAIR.
///
/// Ed25519 STK keys and X25519 ephemeral keys are stored raw (32 bytes
/// each); nonce + sessionId are 16 bytes each.
public struct PairPayload: Equatable, Sendable {
    public var v: Int
    public var stkPub: Data
    public var eBoxPub: Data
    public var nonce: Data
    public var sessionId: Data
    public var hint: PairHint

    public init(
        v: Int = PAIR_PROTOCOL_VERSION,
        stkPub: Data,
        eBoxPub: Data,
        nonce: Data,
        sessionId: Data,
        hint: PairHint
    ) {
        self.v = v
        self.stkPub = stkPub
        self.eBoxPub = eBoxPub
        self.nonce = nonce
        self.sessionId = sessionId
        self.hint = hint
    }
}

/// Owner-initiated remote unpair. IRK-signed. **Rebind-only** per locked
/// decision Q4 — the box resets to UNPAIRED on next boot but LUKS data
/// stays intact. Wipe-on-resale still requires the physical button hold
/// + the resale-wipe verification flow (N-BOX-9).
public struct BoxUnpair: Equatable, Sendable {
    public var userId: String
    /// stkPub hex of the box being unpaired.
    public var boxId: String
    public var issuedAt: Int64

    public init(userId: String, boxId: String, issuedAt: Int64) {
        self.userId = userId
        self.boxId = boxId
        self.issuedAt = issuedAt
    }
}

/// Wi-Fi onboarding payload shipped after the pair latches. Travels
/// inside K_session AEAD (`sealWiFiConfig`/`openWiFiConfig`). Plaintext
/// carries the credentials; sealing keeps a network MitM from learning
/// them even when the rest of the post-pair channel goes over LAN/cloud.
public struct WiFiConfig: Equatable, Sendable {
    public var ssid: String
    public var psk: String
    /// ISO 3166-1 alpha-2 (e.g. "US"). Empty when not set.
    public var regulatoryRegion: String
    public var issuedAt: Int64

    public init(ssid: String, psk: String, regulatoryRegion: String, issuedAt: Int64) {
        self.ssid = ssid
        self.psk = psk
        self.regulatoryRegion = regulatoryRegion
        self.issuedAt = issuedAt
    }
}

public struct SealedWiFiConfig: Equatable, Sendable {
    public var ciphertext: Data
    public var nonce: Data

    public init(ciphertext: Data, nonce: Data) {
        self.ciphertext = ciphertext
        self.nonce = nonce
    }
}

public enum NfcPairError: Error, Equatable {
    case kSessionWrongSize
    case malformedWiFiConfig
}

// ────────────────────────────────────────────────────────────────────────
// Canonical-bytes encoders

private func hex(_ b: Data) -> String {
    var s = ""
    s.reserveCapacity(b.count * 2)
    for x in b { s += String(format: "%02x", x) }
    return s
}

private func hexToData(_ s: String) -> Data {
    var out = Data()
    out.reserveCapacity(s.count / 2)
    var i = s.startIndex
    while i < s.endIndex, let j = s.index(i, offsetBy: 2, limitedBy: s.endIndex) {
        if let byte = UInt8(s[i..<j], radix: 16) { out.append(byte) }
        i = j
    }
    return out
}

/// Canonical-bytes encoders for the three NFC envelopes. Exported so
/// the cross-language golden-vectors test (and any Swift/Kotlin mirror
/// tests) can byte-compare implementations against a recorded fixture
/// without having to re-derive the format.
public func canonicalPair(_ p: PairPayload) -> Data {
    let s = [
        TAG_PAIR,
        String(p.v),
        hex(p.stkPub),
        hex(p.eBoxPub),
        hex(p.nonce),
        hex(p.sessionId),
        p.hint.mdnsName,
        p.hint.cloudRendezvousId,
        p.hint.suffix6,
    ].joined(separator: "|")
    return Data(s.utf8)
}

public func canonicalBoxUnpair(_ u: BoxUnpair) -> Data {
    let s = [TAG_BOX_UNPAIR, u.userId, u.boxId, String(u.issuedAt)].joined(separator: "|")
    return Data(s.utf8)
}

public func canonicalWiFiConfig(_ w: WiFiConfig) -> Data {
    let s = [TAG_WIFI_CONFIG, w.ssid, w.psk, w.regulatoryRegion, String(w.issuedAt)]
        .joined(separator: "|")
    return Data(s.utf8)
}

/// Transcript used as HKDF `info` suffix for K_session + SAS derivation.
/// Binds both peers to the exact same view of the handshake; any
/// substitution of stkPub / eBoxPub / ePhonePub / nonce / sessionId
/// yields different keys, so a MitM cannot interpose without detection.
private func canonicalTranscript(
    v: Int,
    stkPub: Data,
    eBoxPub: Data,
    ePhonePub: Data,
    nonce: Data,
    sessionId: Data
) -> Data {
    let s = [
        String(v),
        hex(stkPub),
        hex(eBoxPub),
        hex(ePhonePub),
        hex(nonce),
        hex(sessionId),
    ].joined(separator: "|")
    return Data(s.utf8)
}

// ────────────────────────────────────────────────────────────────────────
// N-PROTO-1: PAIR + SIG sign/verify + ECDH-derived K_session + SAS

/// Box-side: sign the PAIR payload with the box's STK private key.
public func signPair(_ p: PairPayload, stk: Curve25519.Signing.PrivateKey) throws -> Data {
    return try stk.signature(for: canonicalPair(p))
}

/// Phone-side: verify SIG against PAIR.stkPub. Self-consistency check:
/// "the box vouches that eBoxPub/nonce belong to this identity."
/// Network MitM substituting a different eBoxPub fails this check.
public func verifyPair(_ p: PairPayload, signature: Data) -> Bool {
    guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: p.stkPub) else {
        return false
    }
    return pub.isValidSignature(signature, for: canonicalPair(p))
}

/// Phone-side: derive `ss` (ECDH shared secret) from ePhonePriv + box's eBoxPub.
public func deriveSharedSecret(
    ePhonePriv: Curve25519.KeyAgreement.PrivateKey,
    eBoxPub: Data
) throws -> Data {
    let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: eBoxPub)
    let shared = try ePhonePriv.sharedSecretFromKeyAgreement(with: peer)
    return shared.withUnsafeBytes { Data($0) }
}

/// K_session = HKDF(ss, salt=nonce, info="flagship/pair/v1|" + transcript).
/// 32 bytes — used as the AES-GCM key for the post-pair AEAD channel
/// (`sealWiFiConfig`, future post-pair envelopes).
public func deriveSessionKey(
    sharedSecret: Data,
    stkPub: Data,
    eBoxPub: Data,
    ePhonePub: Data,
    nonce: Data,
    sessionId: Data,
    v: Int = PAIR_PROTOCOL_VERSION
) -> Data {
    let transcript = canonicalTranscript(
        v: v,
        stkPub: stkPub,
        eBoxPub: eBoxPub,
        ePhonePub: ePhonePub,
        nonce: nonce,
        sessionId: sessionId
    )
    var info = Data(TAG_PAIR.utf8)
    info.append(UInt8(ascii: "|"))
    info.append(transcript)
    let key = HKDF<SHA256>.deriveKey(
        inputKeyMaterial: SymmetricKey(data: sharedSecret),
        salt: nonce,
        info: info,
        outputByteCount: 32
    )
    return key.withUnsafeBytes { Data($0) }
}

/// Short Authentication String: HKDF(ss, salt=∅, info="flagship/pair-sas/v1|"
/// + transcript), truncated to 4 bytes. The LED-SAS encoder uses the
/// first 18 bits; on-screen SAS displays the first 6 hex chars.
public func deriveSAS(
    sharedSecret: Data,
    stkPub: Data,
    eBoxPub: Data,
    ePhonePub: Data,
    nonce: Data,
    sessionId: Data,
    v: Int = PAIR_PROTOCOL_VERSION
) -> Data {
    let transcript = canonicalTranscript(
        v: v,
        stkPub: stkPub,
        eBoxPub: eBoxPub,
        ePhonePub: ePhonePub,
        nonce: nonce,
        sessionId: sessionId
    )
    var info = Data(TAG_PAIR_SAS.utf8)
    info.append(UInt8(ascii: "|"))
    info.append(transcript)
    let key = HKDF<SHA256>.deriveKey(
        inputKeyMaterial: SymmetricKey(data: sharedSecret),
        salt: Data(),
        info: info,
        outputByteCount: SAS_BYTES
    )
    return key.withUnsafeBytes { Data($0) }
}

/// Compute the 6-hex disambiguation suffix from an STK pubkey.
/// Convenience used by the box when building its PairHint, and by the
/// phone when one-LAN matching multiple candidates.
public func stkPubToSuffix6(_ stkPub: Data) -> String {
    let h = hex(stkPub)
    if h.count <= 6 { return h }
    return String(h.suffix(6))
}

// ────────────────────────────────────────────────────────────────────────
// N-PROTO-2: BoxUnpair envelope (IRK-signed, rebind-only)

public func signBoxUnpair(_ u: BoxUnpair, irk: Curve25519.Signing.PrivateKey) throws -> Data {
    return try irk.signature(for: canonicalBoxUnpair(u))
}

public func verifyBoxUnpair(_ u: BoxUnpair, signature: Data, irkPub: Data) -> Bool {
    guard let pub = try? Curve25519.Signing.PublicKey(rawRepresentation: irkPub) else {
        return false
    }
    return pub.isValidSignature(signature, for: canonicalBoxUnpair(u))
}

// ────────────────────────────────────────────────────────────────────────
// N-PROTO-3: WiFiConfig sealed under K_session AEAD

/// AES-GCM seal of WiFiConfig under K_session. 12-byte random nonce —
/// AAD is empty (the K_session itself is already transcript-bound, so
/// binding-data lives in the key, not the AAD).
public func sealWiFiConfig(_ w: WiFiConfig, kSession: Data) throws -> SealedWiFiConfig {
    guard kSession.count == 32 else { throw NfcPairError.kSessionWrongSize }
    var nonceBytes = Data(count: 12)
    nonceBytes.withUnsafeMutableBytes { buf in
        guard let base = buf.baseAddress else { return }
        _ = SecRandomCopyBytes(kSecRandomDefault, 12, base)
    }
    let nonce = try AES.GCM.Nonce(data: nonceBytes)
    let sealed = try AES.GCM.seal(
        canonicalWiFiConfig(w),
        using: SymmetricKey(data: kSession),
        nonce: nonce
    )
    // Mirror the TS shape: ciphertext = encrypted-bytes || authTag.
    // CryptoKit splits ciphertext + tag; concatenate to match @noble/ciphers gcm.
    var ct = Data()
    ct.append(sealed.ciphertext)
    ct.append(sealed.tag)
    return SealedWiFiConfig(ciphertext: ct, nonce: nonceBytes)
}

/// Box-side: open a sealed WiFiConfig with K_session. Returns parsed
/// WiFiConfig; throws on auth failure (bad tag, wrong key, tampered
/// ciphertext).
public func openWiFiConfig(_ blob: SealedWiFiConfig, kSession: Data) throws -> WiFiConfig {
    guard kSession.count == 32 else { throw NfcPairError.kSessionWrongSize }
    // Split combined ciphertext||tag (last 16 bytes are the GCM tag).
    guard blob.ciphertext.count >= 16 else { throw NfcPairError.malformedWiFiConfig }
    let tagStart = blob.ciphertext.count - 16
    let ct = blob.ciphertext.subdata(in: 0..<tagStart)
    let tag = blob.ciphertext.subdata(in: tagStart..<blob.ciphertext.count)
    let nonce = try AES.GCM.Nonce(data: blob.nonce)
    let sealed = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ct, tag: tag)
    let plaintext = try AES.GCM.open(sealed, using: SymmetricKey(data: kSession))
    guard let text = String(data: plaintext, encoding: .utf8) else {
        throw NfcPairError.malformedWiFiConfig
    }
    let parts = text.split(separator: "|", omittingEmptySubsequences: false).map(String.init)
    // Re-validate the tag + version field count so a key collision on a
    // different envelope kind can't be reinterpreted as WiFiConfig.
    guard parts.count == 5, parts[0] == TAG_WIFI_CONFIG else {
        throw NfcPairError.malformedWiFiConfig
    }
    guard let issuedAt = Int64(parts[4]) else {
        throw NfcPairError.malformedWiFiConfig
    }
    return WiFiConfig(
        ssid: parts[1],
        psk: parts[2],
        regulatoryRegion: parts[3],
        issuedAt: issuedAt
    )
}

// ────────────────────────────────────────────────────────────────────────
// N-PROTO-4: SAS derivation + LED-SAS alphabet

/// LED-SAS alphabet — 4 symbols, 2 bits each. Maps cleanly to a 4-color
/// status LED (RGBY) but the alphabet is intentionally abstract: the
/// box-side LED driver picks the physical mapping (e.g. one RGB LED that
/// cycles through 4 explicit colors, or 4 discrete LEDs lit one at a
/// time). Order is fixed at v1; never reorder without bumping
/// PAIR_PROTOCOL_VERSION.
public let LED_SAS_ALPHABET: [Character] = ["R", "G", "B", "Y"]

/// Each glance carries this many 2-bit pulses → ~6 bits of SAS material.
public let LED_SAS_PULSES_PER_GLANCE = 3

/// 3-of-3 confirmation per locked decision §10. User matches 3 glances total.
public let LED_SAS_GLANCES_REQUIRED = 3

/// Per-pulse on-time (ms). 10 s gives a relaxed match window.
public let LED_SAS_PULSE_MS = 10_000

/// Retries before the box clears its emit + waits 30 s.
public let LED_SAS_RETRIES = 3

public enum LedSasError: Error, Equatable {
    case notEnoughSasBytes(needed: Int)
}

/// Encode SAS bytes as a sequence of LED symbols. With
/// LED_SAS_PULSES_PER_GLANCE * LED_SAS_GLANCES_REQUIRED = 9 pulses *
/// 2 bits = 18 bits, we consume the first 18 bits of `sas` (= bytes[0],
/// bytes[1], and the top 2 bits of bytes[2]).
///
/// Returned string is the linear pulse sequence ("RGGBYRBGR"). Renderers
/// group it into glances of LED_SAS_PULSES_PER_GLANCE.
public func encodeLedSas(_ sas: Data) throws -> String {
    let totalPulses = LED_SAS_PULSES_PER_GLANCE * LED_SAS_GLANCES_REQUIRED
    let bitsNeeded = totalPulses * 2
    if sas.count * 8 < bitsNeeded {
        throw LedSasError.notEnoughSasBytes(needed: (bitsNeeded + 7) / 8)
    }
    var out = ""
    out.reserveCapacity(totalPulses)
    for i in 0..<totalPulses {
        let bitOffset = i * 2
        let byteIdx = bitOffset >> 3
        let bitIdx = 6 - (bitOffset & 7)
        let byte = sas[byteIdx]
        let symbolIdx = Int((byte >> bitIdx) & 0b11)
        out.append(LED_SAS_ALPHABET[symbolIdx])
    }
    return out
}

/// Human-readable SAS for on-screen comparison (DIY tier or "optional
/// SAS glance" per locked decision §10). Hex of the SAS bytes, first
/// `chars` characters. Default 6 chars = 24 bits, comfortable for a
/// one-line comparison.
public func encodeSasForDisplay(_ sas: Data, chars: Int = 6) -> String {
    let h = hex(sas)
    if h.count <= chars { return h }
    return String(h.prefix(chars))
}

// ────────────────────────────────────────────────────────────────────────
// N-PHONE-6: LED-SAS capture/decode + match (phone-side verify path)
//
// Swift mirror of the TS `verifyLedSas` family in nfcPair.ts. The encode
// half is box-side; this is the phone confirming an observed LED capture
// equals the locally derived expected sequence, glance by glance, under
// the strict 3-of-3 rule (locked decision §10) — a single mismatch aborts
// (the LED-SAS *is* the authenticator on the degraded path). The camera
// frame→symbol decode is the hardware/CV seam; this takes already-decoded
// glance strings, so it stays fully unit-testable without a camera.

public enum LedGlanceVerdict: Equatable, Sendable {
    case match
    case mismatch
}

public enum LedSasVerifyError: Error, Equatable {
    case wrongSequenceLength(expected: Int, got: Int)
}

/// Split an encoded LED-SAS sequence into per-glance sub-sequences.
/// Throws if the sequence isn't exactly the locked glance×pulse length.
public func ledSasGlances(_ sequence: String) throws -> [String] {
    let expectedLen = LED_SAS_GLANCES_REQUIRED * LED_SAS_PULSES_PER_GLANCE
    let chars = Array(sequence)
    guard chars.count == expectedLen else {
        throw LedSasVerifyError.wrongSequenceLength(expected: expectedLen, got: chars.count)
    }
    var out: [String] = []
    out.reserveCapacity(LED_SAS_GLANCES_REQUIRED)
    for g in 0..<LED_SAS_GLANCES_REQUIRED {
        let lo = g * LED_SAS_PULSES_PER_GLANCE
        let hi = lo + LED_SAS_PULSES_PER_GLANCE
        out.append(String(chars[lo..<hi]))
    }
    return out
}

/// A captured glance is well-formed iff it has exactly
/// LED_SAS_PULSES_PER_GLANCE symbols, each in LED_SAS_ALPHABET. A garbled
/// read is distinct from a mismatch.
public func isWellFormedGlance(_ glance: String) -> Bool {
    let chars = Array(glance)
    if chars.count != LED_SAS_PULSES_PER_GLANCE { return false }
    for ch in chars where !LED_SAS_ALPHABET.contains(ch) { return false }
    return true
}

/// Exact-match a captured glance against the expected one.
public func verifyLedGlance(observed: String, expected: String) -> LedGlanceVerdict {
    observed == expected ? .match : .mismatch
}

/// Full phone-side LED-SAS verify: derive the expected sequence from the
/// SAS bytes and require every observed glance to match (3-of-3, strict).
/// Returns false on the first mismatch OR any malformed glance, and on a
/// wrong observed-glance count.
public func verifyLedSas(sas: Data, observedGlances: [String]) -> Bool {
    if observedGlances.count != LED_SAS_GLANCES_REQUIRED { return false }
    guard let seq = try? encodeLedSas(sas),
          let expected = try? ledSasGlances(seq) else {
        return false
    }
    for i in 0..<LED_SAS_GLANCES_REQUIRED {
        let obs = observedGlances[i]
        if !isWellFormedGlance(obs) { return false }
        if verifyLedGlance(observed: obs, expected: expected[i]) == .mismatch { return false }
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

private let EPHONE_PUB_LEN = 32
private let MIN_CIPHERTEXT_LEN = 16  // AES-GCM tag alone

public enum WifiDepositBlobError: Error, Equatable {
    case wrongSizeEphonePub
    case blobTooShort
}

public func buildWifiDepositBlob(ePhonePub: Data, sealed: SealedWiFiConfig) throws -> Data {
    if ePhonePub.count != EPHONE_PUB_LEN {
        throw WifiDepositBlobError.wrongSizeEphonePub
    }
    var out = Data(capacity: EPHONE_PUB_LEN + sealed.ciphertext.count)
    out.append(ePhonePub)
    out.append(sealed.ciphertext)
    return out
}

public func parseWifiDepositBlob(_ blob: Data) throws -> (ePhonePub: Data, ciphertext: Data) {
    if blob.count < EPHONE_PUB_LEN + MIN_CIPHERTEXT_LEN {
        throw WifiDepositBlobError.blobTooShort
    }
    // Re-wrap as fresh Data — slices keep the parent's indices, which
    // bites any consumer that assumes zero-based subscripting.
    return (
        ePhonePub: Data(blob.prefix(EPHONE_PUB_LEN)),
        ciphertext: Data(blob.dropFirst(EPHONE_PUB_LEN))
    )
}

// ────────────────────────────────────────────────────────────────────────
// Hex helpers (public so tests can round-trip the fixture)

public enum NfcPairHex {
    public static func encode(_ data: Data) -> String { hex(data) }
    public static func decode(_ s: String) -> Data { hexToData(s) }
}
